import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {
  STYLE_MODES,
  COLOR_PALETTES,
  CONTEXT_LIMITS,
  DEFAULT_SETTINGS,
  normalizeModelKey,
  normalizeSettings,
  resolveEffectiveContextLimit,
  createSettingsStore,
} from '../lib/settings.mjs';
import {
  extractConversationIdFromPath,
  resolveTranscriptFile,
  createEmptyUsage,
  parseTranscriptFile,
  getConversationUsage,
} from '../lib/transcript-parser.mjs';
import {
  parseDurationSec,
  calculateSpeedExperience,
  extractChatModelTelemetry,
  buildModelCatalogIndex,
  lookupCatalogModel,
  enrichUsageWithTelemetry,
  clearTelemetryCaches,
} from '../lib/ls-telemetry.mjs';
import {
  resolvePricingModelKey,
  estimateTokenCost,
  getUsageHistoryReport,
} from '../lib/usage-history.mjs';
import {
  REHYDRATE_HOOK_NAME,
  getRehydrateStatus,
  setRehydrateEnabled,
  removeRehydrateHook,
} from '../lib/rehydrate-manager.mjs';
import {
  redactSecrets,
  truncateUtf8WithFences,
  runRehydratePayload,
} from '../scripts/rehydrate-hook.mjs';
import {
  PLANNING_HOOK_NAME,
  PENDING_SESSION_TTL_MS,
  buildPlanningHookCommand,
  getPlanningStatus,
  isPlanningActiveFor,
  setPlanningForConversation,
  syncNativePlanPrompt,
  removePlanningHook,
} from '../lib/planning-manager.mjs';
import {
  isPathInsideArtifactDir,
  isSafeReadOnlyCommand,
  classifyToolCall,
  runPlanningHookPayload,
} from '../scripts/planning-hook.mjs';
import {
  injectDebugPortArg,
  removeDebugPortArg,
  patchLinuxDesktopEntry,
  unpatchLinuxDesktopEntry,
  hasOtherCdpPluginsInstalled,
} from '../lib/launcher.mjs';
import {
  isAntigravityHubTarget,
  buildInjectedSource,
} from '../lib/cdp-host.mjs';
import { renderSidecarDashboardHtml } from '../lib/dashboard-ui.mjs';

/**
 * 创建独立的临时测试目录（测试结束后自动清理）
 */
function withTempDir(fn) {
  const baseTemp = fs.existsSync('C:\\CodexTemp') ? 'C:\\CodexTemp' : os.tmpdir();
  fs.mkdirSync(baseTemp, { recursive: true });
  const dir = fs.mkdtempSync(path.join(baseTemp, 'context-ring-test-'));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });
}

test('settings: 3 种精选形态、旧形态平滑回退与按模型上下文上限记忆', async () => {
  await withTempDir((tempDir) => {
    assert.deepEqual(STYLE_MODES, ['bottle', 'caterpillar', 'ring']);

    const store = createSettingsStore(tempDir);
    const initial = store.get();
    assert.deepEqual(initial, normalizeSettings(DEFAULT_SETTINGS));
    assert.equal(initial.contextLimit, 0);
    assert.equal(initial.showFooterQuota, true);
    assert.equal(initial.showFooterSpeed, true);
    assert.equal(initial.showFooterPlanning, true);
    assert.equal(
      store.set({ showFooterQuota: false, showFooterSpeed: false, showFooterPlanning: false }).showFooterQuota,
      false
    );
    assert.equal(store.get().showFooterSpeed, false);
    assert.equal(store.get().showFooterPlanning, false);
    assert.equal(
      store.set({ showFooterQuota: true, showFooterSpeed: true, showFooterPlanning: true }).showFooterPlanning,
      true
    );

    // 验证所有 3 种形态均可合法保存
    for (const styleMode of STYLE_MODES) {
      const saved = store.set({ styleMode });
      assert.equal(saved.styleMode, styleMode);
    }

    // 验证已移除的旧形态（donut / capsule）平滑回退到默认 bottle
    assert.equal(normalizeSettings({ styleMode: 'donut' }).styleMode, 'bottle');
    assert.equal(normalizeSettings({ styleMode: 'capsule' }).styleMode, 'bottle');

    // 验证配色固定为自动告警，任意传入配色均归一化为 auto
    assert.deepEqual(COLOR_PALETTES, ['auto']);
    assert.equal(store.set({ palette: 'ocean' }).palette, 'auto');
    for (const limit of CONTEXT_LIMITS) {
      assert.equal(store.set({ contextLimit: limit }).contextLimit, limit);
    }

    // 验证按模型记忆上下文上限与优先级解析
    assert.equal(normalizeModelKey('Gemini 4 Neon (XHigh)'), 'gemini-4-neon');
    assert.equal(normalizeModelKey('claude-opus-5-5-high'), 'claude-opus-5-5');

    store.set({ contextLimit: 0, setModelContextLimit: { modelName: 'Gemini 4 Neon (High)', limit: 1000000 } });
    const afterCustom = store.get();
    assert.equal(afterCustom.modelContextLimits['gemini-4-neon'], 1000000);

    const customRes = resolveEffectiveContextLimit({
      settings: afterCustom,
      modelName: 'Gemini 4 Neon (XHigh)',
      detectedLimit: 512000,
    });
    assert.equal(customRes.limit, 1000000);
    assert.equal(customRes.source, 'model-custom');
    assert.equal(customRes.auto, false);

    // 未自定义的其他模型在自动模式下优先采用宿主真实探测上限
    const detectedRes = resolveEffectiveContextLimit({
      settings: afterCustom,
      modelName: 'Claude Opus 5.5 (High)',
      detectedLimit: 1000000,
      catalogLimit: 512000,
    });
    assert.equal(detectedRes.limit, 1000000);
    assert.equal(detectedRes.source, 'detected');
    assert.equal(detectedRes.auto, true);

    // 清除单模型自定义上限后恢复自动探测
    store.set({ setModelContextLimit: { modelName: 'Gemini 4 Neon (XHigh)', limit: 0 } });
    assert.equal(store.get().modelContextLimits['gemini-4-neon'], undefined);

    // 验证非法字段自动回退默认值
    const normalized = normalizeSettings({
      enabled: 'yes',
      styleMode: 'unknown-shape',
      palette: 'neon-pink',
      contextLimit: 999,
      placement: 'top',
    });
    assert.equal(normalized.enabled, true);
    assert.equal(normalized.styleMode, DEFAULT_SETTINGS.styleMode);
    assert.equal(normalized.palette, DEFAULT_SETTINGS.palette);
    assert.equal(normalized.contextLimit, DEFAULT_SETTINGS.contextLimit);
    assert.equal(normalized.placement, DEFAULT_SETTINGS.placement);
  });
});

test('transcript-parser: 精确解析扁平与嵌套 Token 字段、缓存命中率与严格会话隔离', async () => {
  await withTempDir((tempDir) => {
    const brainDir = path.join(tempDir, 'brain');
    const cid = '11111111-2222-3333-4444-555555555555';
    const logDir = path.join(brainDir, cid, '.system_generated', 'logs');
    fs.mkdirSync(logDir, { recursive: true });

    const logFile = path.join(logDir, 'transcript.jsonl');
    const sampleLines = [
      JSON.stringify({
        step_index: 1,
        type: 'USER_INPUT',
        content: 'The user changed setting `Model Selection` from None to Gemini 4 Carbon (High).',
      }),
      JSON.stringify({
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        model: 'gemini-4-carbon-high',
        input_tokens: 12000,
        cache_read_tokens: 48000,
        output_tokens: 600,
        created_at: '2026-11-27T04:00:00Z',
      }),
      JSON.stringify({
        step_index: 3,
        type: 'USER_INPUT',
        content: '继续优化',
      }),
      JSON.stringify({
        step_index: 4,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        token_usage: {
          model: 'claude-opus-5-5-high',
          input_tokens: 20000,
          cache_read_tokens: 180000,
          output_tokens: 1400,
        },
        created_at: '2026-11-27T04:05:00Z',
      }),
    ];
    fs.writeFileSync(logFile, sampleLines.join('\n') + '\n', 'utf8');

    assert.equal(extractConversationIdFromPath(logFile), cid);

    const resolved = resolveTranscriptFile(cid, { brainDirs: [brainDir] });
    assert.ok(resolved);
    assert.equal(resolved.conversationId, cid);

    // 查询不存在的会话 ID 时必须返回 null，严禁串台回退到其他会话
    const missing = resolveTranscriptFile('99999999-9999-9999-9999-999999999999', {
      brainDirs: [brainDir],
    });
    assert.equal(missing, null);

    // 严格模式下空会话 ID（新开空白窗口）必须返回 null 与全零统计，绝不带入历史会话
    const strictEmptyResolved = resolveTranscriptFile('', {
      brainDirs: [brainDir],
      allowLatestFallback: false,
    });
    assert.equal(strictEmptyResolved, null);

    const strictEmptyUsage = getConversationUsage('', {
      brainDirs: [brainDir],
      allowLatestFallback: false,
    });
    assert.equal(strictEmptyUsage.conversationId, '');
    assert.equal(strictEmptyUsage.totalTokens, 0);
    assert.equal(strictEmptyUsage.inputTokens, 0);
    assert.equal(strictEmptyUsage.cacheReadTokens, 0);
    assert.equal(strictEmptyUsage.outputTokens, 0);
    assert.equal(strictEmptyUsage.cacheHitRate, 0);
    assert.equal(strictEmptyUsage.turnCount, 0);
    assert.equal(strictEmptyUsage.plannerStepCount, 0);
    assert.deepEqual(strictEmptyUsage.history, []);

    // 默认模式（CLI 统计查询）仍兼容自动定位最近活跃会话
    const latestUsage = getConversationUsage('', { brainDirs: [brainDir] });
    assert.equal(latestUsage.conversationId, cid);
    assert.equal(latestUsage.totalTokens, 201400);

    const emptyDirect = createEmptyUsage();
    assert.equal(emptyDirect.totalTokens, 0);
    assert.equal(emptyDirect.conversationId, '');

    const stats = getConversationUsage(cid, { brainDirs: [brainDir] });
    assert.equal(stats.conversationId, cid);
    assert.equal(stats.modelName, 'claude-opus-5-5-high');
    assert.equal(stats.inputTokens, 20000);
    assert.equal(stats.cacheReadTokens, 180000);
    assert.equal(stats.outputTokens, 1400);
    assert.equal(stats.promptTokens, 200000);
    assert.equal(stats.totalTokens, 201400);
    assert.equal(stats.cumulativeOutputTokens, 2000);
    assert.equal(stats.cacheHitRate, 90);
    assert.equal(stats.turnCount, 2);
    assert.equal(stats.plannerStepCount, 2);
    assert.equal(stats.history.length, 2);
    assert.equal(stats.steps.length, 2);
    assert.equal(stats.steps[0].step, 1);
    assert.equal(stats.steps[1].step, 2);
    assert.equal(stats.steps[1].turn, 2);
    assert.equal(stats.steps[1].cumulativeOutputTokens, 2000);
    assert.equal(stats.steps[1].cacheHitRate, 90);
    assert.equal(stats.steps[1].deltaTokens, stats.steps[1].totalTokens - stats.steps[0].totalTokens);

    // 追加新步骤后验证缓存自动失效并读取最新值
    const appendedLine = JSON.stringify({
      step_index: 5,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      input_tokens: 5000,
      cache_read_tokens: 245000,
      output_tokens: 500,
    });
    fs.appendFileSync(logFile, appendedLine + '\n', 'utf8');
    const updatedStats = parseTranscriptFile(logFile, cid);
    assert.equal(updatedStats.totalTokens, 250500);
    assert.equal(updatedStats.cumulativeOutputTokens, 2500);
    assert.equal(updatedStats.steps.length, 3);
    assert.equal(updatedStats.steps[2].deltaTokens, 250500 - 201400);
    assert.equal(updatedStats.cacheHitRate, 98);
  });
});

test('launcher: 启动参数幂等注入/剥离、Linux .desktop 处理与同伴插件共存保护', async () => {
  assert.equal(injectDebugPortArg(''), '--remote-debugging-port=0');
  assert.equal(
    injectDebugPortArg('--profile-dir=test'),
    '--profile-dir=test --remote-debugging-port=0'
  );
  assert.equal(
    injectDebugPortArg('--remote-debugging-port=9222 --foo'),
    '--remote-debugging-port=9222 --foo'
  );
  assert.equal(
    removeDebugPortArg('--foo --remote-debugging-port=0 --bar'),
    '--foo --bar'
  );

  const desktopSample = [
    '[Desktop Entry]',
    'Name=Antigravity',
    'Exec="/opt/Antigravity/antigravity" %U',
    'Type=Application',
  ].join('\n');

  const patched = patchLinuxDesktopEntry(desktopSample);
  assert.equal(patched.changed, true);
  assert.match(patched.content, /Exec="\/opt\/Antigravity\/antigravity" --remote-debugging-port=0 %U/);

  const patchedAgain = patchLinuxDesktopEntry(patched.content);
  assert.equal(patchedAgain.changed, false);

  const restored = unpatchLinuxDesktopEntry(patched.content);
  assert.equal(restored.changed, true);
  assert.equal(restored.content, desktopSample);

  // 验证同伴 CDP 插件共存检测
  await withTempDir((fakeHome) => {
    assert.equal(hasOtherCdpPluginsInstalled(fakeHome), false);

    const peerDir = path.join(fakeHome, '.gemini', 'config', 'plugins', 'agy-powertools');
    const cfgDir = path.join(fakeHome, '.gemini', 'config');
    fs.mkdirSync(peerDir, { recursive: true });
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(peerDir, 'plugin.json'), '{"name":"agy-powertools"}', 'utf8');
    fs.writeFileSync(
      path.join(cfgDir, 'config.json'),
      JSON.stringify({ plugins: { 'agy-powertools': { enabled: true } } }),
      'utf8'
    );
    assert.equal(hasOtherCdpPluginsInstalled(fakeHome), true);

    fs.writeFileSync(
      path.join(cfgDir, 'config.json'),
      JSON.stringify({ plugins: { 'agy-powertools': { enabled: false } } }),
      'utf8'
    );
    assert.equal(hasOtherCdpPluginsInstalled(fakeHome), false);
  });
});

test('cdp-host & dashboard-ui: 目标识别、注入脚本语法合法性与工坊 HTML 完整性', () => {
  assert.equal(
    isAntigravityHubTarget({
      type: 'page',
      url: 'https://127.0.0.1:51492/c/7812e082-404d-49b7-8af6-25cb1a64beab',
      title: 'workspace - Antigravity',
      webSocketDebuggerUrl: 'ws://127.0.0.1:51490/devtools/page/1',
    }),
    true
  );

  assert.equal(
    isAntigravityHubTarget({
      type: 'page',
      url: 'data:text/html,<html></html>',
      title: 'curtain',
      webSocketDebuggerUrl: 'ws://127.0.0.1:51490/devtools/page/2',
    }),
    false
  );

  // 校验拼接后的前端注入源码无任何 JS 语法错误，且不劫持 querySelectorAll
  const injectedSource = buildInjectedSource(DEFAULT_SETTINGS, '1.0.0');
  assert.doesNotThrow(() => new Function(injectedSource));
  assert.equal(injectedSource.includes('document.querySelectorAll ='), false);
  // 校验悬浮卡片已移除形状选择条，设置页与 Sidecar 已移除配色选择（统一自动告警）
  assert.equal(injectedSource.includes('cr-style-strip'), false);
  assert.equal(injectedSource.includes('data-role="palette-row"'), false);
  assert.ok(injectedSource.includes('open-settings-btn'));
  assert.ok(injectedSource.includes('effort-rail'));
  assert.ok(injectedSource.includes('model-picker-btn'));
  assert.ok(injectedSource.includes('model-menu'));
  assert.ok(injectedSource.includes('pickBestOptionForFamily'));
  assert.ok(injectedSource.includes('commitModelFamilySelection'));
  assert.ok(injectedSource.includes('retrieveUserQuotaSummary'));
  assert.ok(injectedSource.includes('buildQuotaPairVisual'));
  assert.ok(injectedSource.includes('current-model-quota'));
  assert.ok(injectedSource.includes('agy-context-ring-quota-host'));
  assert.ok(injectedSource.includes('agy-context-ring-speed-host'));
  assert.ok(injectedSource.includes('agy-context-ring-planning-host'));
  assert.ok(injectedSource.includes('mountOrUpdateFooterQuota'));
  assert.ok(injectedSource.includes('mountOrUpdateFooterSpeed'));
  assert.ok(injectedSource.includes('mountOrUpdateFooterPlanning'));
  assert.ok(injectedSource.includes('modal-toggle-footer-quota'));
  assert.ok(injectedSource.includes('modal-toggle-footer-speed'));
  assert.ok(injectedSource.includes('modal-toggle-footer-planning'));
  assert.ok(injectedSource.includes('modal-planning-btn'));
  assert.ok(injectedSource.includes('plan-toggle-btn'));
  assert.ok(injectedSource.includes('step-picker'));
  assert.ok(injectedSource.includes('step-menu'));
  assert.ok(injectedSource.includes('step-replay-bar'));
  assert.ok(injectedSource.includes('openStepMenu'));
  assert.ok(injectedSource.includes('stepReplayByOffset'));
  assert.ok(injectedSource.includes('scrollConversationToTurn'));
  assert.ok(injectedSource.includes('scrollConversationToStep'));
  assert.ok(injectedSource.includes('scrollToTextSnippetInChat'));
  assert.ok(injectedSource.includes('findNativeLeftTurnDots'));
  assert.ok(injectedSource.includes('buildTurnDirectoryFromSteps'));
  assert.ok(injectedSource.includes('step-fork-btn'));
  assert.ok(injectedSource.includes('forkConversationFromReplay'));
  assert.ok(injectedSource.includes('resolveForkAtStepIndex'));
  assert.ok(injectedSource.includes('agy-context-ring-quota-tip'));
  assert.ok(injectedSource.includes('showQuotaTip'));
  assert.ok(injectedSource.includes('showPlanningTip'));
  assert.ok(injectedSource.includes('cr-gauge-track'));
  assert.ok(injectedSource.includes('agy-context-ring-settings-modal'));
  assert.ok(injectedSource.includes('getComposerCompactController'));
  assert.ok(injectedSource.includes('executeCompactCommand'));
  assert.ok(injectedSource.includes('__CONTEXT_RING_TRIGGER_COMPACT__'));
  assert.ok(injectedSource.includes('createEmptyWidgetUsage'));
  assert.ok(injectedSource.includes('explicitBlankComposer'));
  assert.equal(injectedSource.includes('Array.from(usageCache.values())[0]'), false);

  const html = renderSidecarDashboardHtml({ version: '1.1.0' });
  assert.equal(html.includes('paletteGroup'), false);
  assert.equal(html.includes('data-style="donut"'), false);
  assert.equal(html.includes('data-style="capsule"'), false);
  assert.equal(injectedSource.includes("id: 'donut'"), false);
  assert.equal(injectedSource.includes("id: 'capsule'"), false);
  assert.ok(injectedSource.includes('speed-bar'));
  assert.ok(injectedSource.includes('modal-rehydrate-btn'));
  assert.ok(injectedSource.includes('hist-hm-grid'));
  for (const mode of STYLE_MODES) {
    assert.ok(html.includes(`data-style="${mode}"`), `缺少样式按钮: ${mode}`);
  }
  assert.ok(html.includes('/api/state'));
  assert.ok(html.includes('/api/history'));
  assert.ok(html.includes('/api/rehydrate'));
  assert.ok(html.includes('/api/planning'));
  assert.ok(html.includes('/api/settings'));
  assert.ok(html.includes('toggleFooterQuotaBtn'));
  assert.ok(html.includes('toggleFooterSpeedBtn'));
  assert.ok(html.includes('toggleFooterPlanningBtn'));
  assert.ok(html.includes('planningToggleBtn'));
  assert.ok(html.includes('/api/compact'));
});

test('composer-widget: 新开空白窗口与切换空白会话严格归零，绝不带入历史上下文', async () => {
  // 构造最小化 DOM 沙箱以直接验证真实渲染脚本的状态隔离与归零行为
  function createMockClassList() {
    const set = new Set();
    return {
      add: (...names) => names.forEach((n) => set.add(n)),
      remove: (...names) => names.forEach((n) => set.delete(n)),
      toggle: (name, force) => {
        if (force === undefined) {
          if (set.has(name)) {
            set.delete(name);
            return false;
          }
          set.add(name);
          return true;
        }
        if (force) set.add(name);
        else set.delete(name);
        return Boolean(force);
      },
      contains: (name) => set.has(name),
      toString: () => Array.from(set).join(' '),
    };
  }

  function createMockElement(tagName = 'div') {
    const attrs = new Map();
    const el = {
      tagName: String(tagName).toUpperCase(),
      nodeType: 1,
      id: '',
      className: '',
      dataset: {},
      style: {},
      textContent: '',
      children: [],
      parentElement: null,
      classList: null,
      _innerHTML: '',
      _listeners: new Map(),
      setAttribute(k, v) {
        attrs.set(k, String(v));
        if (k === 'id') this.id = String(v);
        if (k === 'class') this.className = String(v);
      },
      getAttribute(k) {
        return attrs.has(k) ? attrs.get(k) : null;
      },
      addEventListener(ev, fn) {
        if (!this._listeners.has(ev)) this._listeners.set(ev, new Set());
        this._listeners.get(ev).add(fn);
      },
      removeEventListener(ev, fn) {
        this._listeners.get(ev)?.delete(fn);
      },
      appendChild(child) {
        if (child.parentElement) child.remove();
        child.parentElement = this;
        this.children.push(child);
        return child;
      },
      insertBefore(child, ref) {
        if (child.parentElement) child.remove();
        child.parentElement = this;
        const idx = ref ? this.children.indexOf(ref) : -1;
        if (idx >= 0) this.children.splice(idx, 0, child);
        else this.children.push(child);
        return child;
      },
      remove() {
        if (!this.parentElement) return;
        const siblings = this.parentElement.children;
        const idx = siblings.indexOf(this);
        if (idx >= 0) siblings.splice(idx, 1);
        this.parentElement = null;
      },
      contains(target) {
        if (target === this) return true;
        return this.children.some((c) => c.contains(target));
      },
      getBoundingClientRect() {
        return { left: 100, top: 100, right: 300, bottom: 140, width: 200, height: 40 };
      },
      closest(selector) {
        let cur = this;
        while (cur) {
          if (matchesSelector(cur, selector)) return cur;
          cur = cur.parentElement;
        }
        return null;
      },
      querySelector(selector) {
        for (const child of this.children) {
          if (matchesSelector(child, selector)) return child;
          const nested = child.querySelector(selector);
          if (nested) return nested;
        }
        return null;
      },
      querySelectorAll(selector) {
        const res = [];
        for (const child of this.children) {
          if (matchesSelector(child, selector)) res.push(child);
          res.push(...child.querySelectorAll(selector));
        }
        return res;
      },
      getElementsByClassName(cls) {
        const res = [];
        for (const child of this.children) {
          const classes = String(child.className || '').split(/\s+/);
          if (classes.includes(cls)) res.push(child);
          res.push(...child.getElementsByClassName(cls));
        }
        return res;
      },
    };
    el.classList = createMockClassList();
    Object.defineProperty(el, 'innerHTML', {
      get() {
        return this._innerHTML;
      },
      set(val) {
        this._innerHTML = String(val);
        this.children = [];
        // 解析按钮内部的 .cr-graphic-slot 与 .cr-pct-text 便于校验渲染结果
        if (this._innerHTML.includes('cr-graphic-slot') && this._innerHTML.includes('cr-pct-text')) {
          const slot = createMockElement('span');
          slot.className = 'cr-graphic-slot';
          const pctText = createMockElement('span');
          pctText.className = 'cr-pct-text';
          pctText.textContent = '0%';
          this.appendChild(slot);
          this.appendChild(pctText);
        }
      },
    });
    return el;
  }

  function matchesSelector(el, selector) {
    if (!el || !selector) return false;
    if (selector.startsWith('#')) return el.id === selector.slice(1);
    if (selector.startsWith('.')) {
      const cls = selector.slice(1);
      return String(el.className || '').split(/\s+/).includes(cls) || el.classList.contains(cls);
    }
    if (selector === '[contenteditable="true"]') return el.getAttribute('contenteditable') === 'true';
    if (selector === '[data-testid="model-selector-trigger"]') {
      return el.getAttribute('data-testid') === 'model-selector-trigger';
    }
    return false;
  }

  const head = createMockElement('head');
  const body = createMockElement('body');
  const card = createMockElement('div');
  card.className = 'surface-composer-card';
  const editor = createMockElement('div');
  editor.setAttribute('contenteditable', 'true');
  const footer = createMockElement('div');
  footer.className = 'agy-composer-footer';
  const leftSlot = createMockElement('div');
  const rightSlot = createMockElement('div');
  footer.appendChild(leftSlot);
  footer.appendChild(rightSlot);
  card.appendChild(editor);
  card.appendChild(footer);
  body.appendChild(card);

  const locationObj = { pathname: '/' };
  const rpcCalls = [];
  const docListeners = new Map();
  const winListeners = new Map();

  // 模拟旧会话数据与历史残留种子
  const oldUsage = {
    conversationId: 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb',
    totalTokens: 256000,
    inputTokens: 20000,
    cacheReadTokens: 235000,
    outputTokens: 1000,
    cumulativeOutputTokens: 4000,
    cacheHitRate: 92.2,
    turnCount: 6,
    plannerStepCount: 14,
    history: [],
  };

  const sandbox = {
    console,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Map,
    Set,
    JSON,
    Promise,
    Date,
    setTimeout: (fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return t;
    },
    clearTimeout,
    setInterval: (fn, ms) => {
      const t = setInterval(fn, ms);
      t.unref?.();
      return t;
    },
    clearInterval,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
    location: locationObj,
    navigator: {},
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    getComputedStyle: () => ({ backgroundColor: 'rgb(255, 255, 255)' }),
    document: {
      head,
      body,
      documentElement: createMockElement('html'),
      createElement: (tag) => createMockElement(tag),
      getElementById: (id) => {
        if (head.id === id) return head;
        if (body.id === id) return body;
        return head.querySelector(`#${id}`) || body.querySelector(`#${id}`) || null;
      },
      getElementsByClassName: (cls) => body.getElementsByClassName(cls),
      querySelector: (sel) => body.querySelector(sel),
      querySelectorAll: (sel) => body.querySelectorAll(sel),
      addEventListener: (ev, fn) => {
        if (!docListeners.has(ev)) docListeners.set(ev, new Set());
        docListeners.get(ev).add(fn);
      },
      removeEventListener: (ev, fn) => docListeners.get(ev)?.delete(fn),
      hasFocus: () => true,
    },
    window: null,
  };
  sandbox.window = sandbox;
  sandbox.innerWidth = 1280;
  sandbox.innerHeight = 800;
  sandbox.addEventListener = (ev, fn) => {
    if (!winListeners.has(ev)) winListeners.set(ev, new Set());
    winListeners.get(ev).add(fn);
  };
  sandbox.removeEventListener = (ev, fn) => winListeners.get(ev)?.delete(fn);
  // 注入旧会话种子，模拟热重载/旧窗口残留场景
  sandbox.__CONTEXT_RING_SEED_USAGE__ = oldUsage;
  sandbox.__contextRingHost = (raw) => {
    const req = JSON.parse(raw);
    rpcCalls.push(req);
    const cid = String(req.params?.conversationId || '');
    const usage = cid === oldUsage.conversationId ? oldUsage : createEmptyUsage(cid, '');
    queueMicrotask(() => {
      sandbox.__contextRingResolveRpc({ id: req.id, ok: true, usage });
    });
  };

  // 场景 1：新开空白窗口（URL='/' 且 AgentInputBox.cascadeId=''）
  const ancestorFiber = {
    memoizedProps: { conversationId: oldUsage.conversationId },
    return: null,
  };
  const composerFiber = {
    memoizedProps: { handleSubmit: () => {}, cascadeId: '' },
    return: ancestorFiber,
  };
  editor['__reactFiber$test'] = composerFiber;
  footer['__reactFiber$test'] = composerFiber;

  const source = buildInjectedSource({ ...DEFAULT_SETTINGS, contextLimit: 512000 }, '1.0.0');
  vm.runInNewContext(source, sandbox);
  await new Promise((r) => setTimeout(r, 30));

  const pctEl = footer.querySelector('.cr-pct-text');
  assert.ok(pctEl, '应已挂载上下文百分比标签');
  assert.equal(pctEl.textContent, '0%', '新开空白窗口必须严格显示 0%');
  assert.equal(sandbox.__CONTEXT_RING_ACTIVE_CID__, '', '空白窗口活跃会话 ID 必须为空');
  assert.equal(
    rpcCalls.filter((c) => c.method === 'usage.get').length,
    0,
    '空白窗口不应发送空 conversationId 的 usage.get 请求'
  );

  // 场景 2：即使地址栏仍停留在旧会话 URL，只要输入框控制器显式为空会话（cascadeId=''），也必须保持 0%
  locationObj.pathname = `/c/${oldUsage.conversationId}`;
  for (const fn of winListeners.get('popstate') || []) fn();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(pctEl.textContent, '0%', '显式空白输入框不得从 URL 或祖先 Fiber 继承旧会话');
  assert.equal(rpcCalls.filter((c) => c.method === 'usage.get').length, 0);

  // 场景 3：切入已有历史会话后正常展示 50%
  composerFiber.memoizedProps = { handleSubmit: () => {}, cascadeId: oldUsage.conversationId };
  for (const fn of winListeners.get('popstate') || []) fn();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(pctEl.textContent, '50%', '已有会话应正确展示 256k / 512k = 50%');
  assert.equal(sandbox.__CONTEXT_RING_ACTIVE_CID__, oldUsage.conversationId);

  // 场景 4：从 50% 历史会话切换回新建空白会话时必须立刻归零到 0%
  locationObj.pathname = '/';
  composerFiber.memoizedProps = { handleSubmit: () => {}, cascadeId: '' };
  for (const fn of winListeners.get('popstate') || []) fn();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(pctEl.textContent, '0%', '从历史会话切回空白新会话时必须立即回归 0%');
  assert.equal(sandbox.__CONTEXT_RING_ACTIVE_CID__, '');

  sandbox.__CONTEXT_RING_CLEANUP__();
});

test('ls-telemetry: 实时速度解析、体验评分、模型目录上限与零报错降级', async () => {
  clearTelemetryCaches();
  assert.equal(Number(parseDurationSec('6.569948100s').toFixed(3)), 6.57);
  assert.equal(parseDurationSec('450ms'), 0.45);
  assert.equal(parseDurationSec('1m2.5s'), 62.5);
  assert.equal(parseDurationSec({ seconds: 2, nanos: 500000000 }), 2.5);

  // 小样本不强行造分
  assert.equal(
    calculateSpeedExperience({ outputTokens: 8, ttftSec: 1.0, streamingSec: 0.2, totalDurationSec: 1.2 }).available,
    false
  );

  // 正常流式生成返回合理体验分与等级
  const exp = calculateSpeedExperience({
    outputTokens: 1063,
    totalInputTokens: 200000,
    ttftSec: 6.57,
    streamingSec: 6.79,
    totalDurationSec: 13.36,
    streamSpeed: 156.6,
  });
  assert.equal(exp.available, true);
  assert.ok(exp.score > 70 && exp.score <= 100);
  assert.ok(['S', 'A', 'B'].includes(exp.grade));

  const parsedCm = extractChatModelTelemetry({
    model: 'MODEL_PLACEHOLDER_M535',
    timeToFirstToken: '6.57s',
    streamingDuration: '6.79s',
    usage: {
      inputTokens: '3691',
      cacheReadTokens: '197274',
      outputTokens: '1063',
      thinkingOutputTokens: '334',
      responseOutputTokens: '729',
    },
    chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 512000 } },
  });
  assert.equal(parsedCm.maxContextTokens, 512000);
  assert.equal(parsedCm.speed.thinkingTokens, 334);
  assert.equal(parsedCm.speed.responseTokens, 729);
  assert.ok(parsedCm.speed.displayTps > 150);

  const catalog = buildModelCatalogIndex({
    response: {
      models: {
        'claude-opus-5-5-high': {
          displayName: 'Claude Opus 5.5 (High)',
          maxTokens: 1000000,
          model: 'MODEL_PLACEHOLDER_M402',
        },
      },
    },
  });
  assert.equal(lookupCatalogModel(catalog, 'Claude Opus 5.5 (Low)')?.maxTokens, 1000000);

  // 模拟 Language Server RPC 融合与离线降级
  const fakeFetch = async (url) => {
    if (url.endsWith('/GetCascadeTrajectory')) {
      return { ok: true, json: async () => ({ numTotalGeneratorMetadata: 2 }) };
    }
    if (url.endsWith('/GetCascadeTrajectoryGeneratorMetadata')) {
      return {
        ok: true,
        json: async () => ({
          generatorMetadata: [
            {
              chatModel: {
                model: 'MODEL_PLACEHOLDER_M402',
                timeToFirstToken: '2.0s',
                streamingDuration: '5.0s',
                usage: { outputTokens: 500, thinkingOutputTokens: 200, responseOutputTokens: 300, inputTokens: 10000 },
                chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 1000000 } },
              },
            },
          ],
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        response: { models: { 'claude-opus-5-5-high': { displayName: 'Claude Opus 5.5 (High)', maxTokens: 1000000, model: 'MODEL_PLACEHOLDER_M402' } } },
      }),
    };
  };

  const enriched = await enrichUsageWithTelemetry(
    { conversationId: '11111111-2222-3333-4444-555555555555', modelName: 'Claude Opus 5.5 (High)', outputTokens: 500 },
    { fetchImpl: fakeFetch, env: { ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:9999', ANTIGRAVITY_CSRF_TOKEN: 'tok' } }
  );
  assert.equal(enriched.detectedContextLimit, 1000000);
  assert.equal(enriched.speed.source, 'ls');
  assert.equal(enriched.speed.streamingTps, 100);
  assert.equal(enriched.speed.thinkingTokens, 200);

  // 离线无环境变量时降级为 transcript 估算且绝不抛错
  const fallback = await enrichUsageWithTelemetry(
    { conversationId: '11111111-2222-3333-4444-555555555555', outputTokens: 400, latestThinkingTokens: 150, latestResponseTokens: 250 },
    { env: {} }
  );
  assert.equal(fallback.speed.source, 'transcript');
  assert.equal(fallback.speed.thinkingTokens, 150);
  assert.equal(fallback.speed.responseTokens, 250);
});

test('usage-history: 多周期历史账本、桌面/CLI 统计、84 天热力图与预估 API 费用', async () => {
  assert.equal(resolvePricingModelKey('Gemini 4 Neon (XHigh)'), 'gemini-4-neon');
  assert.equal(resolvePricingModelKey('claude-opus-5-5-high'), 'claude-opus-5-5');

  const cost = estimateTokenCost({
    modelName: 'Gemini 4 Neon (High)',
    inputTokens: 100000,
    cacheReadTokens: 1000000,
    outputTokens: 10000,
  });
  assert.equal(cost.priced, true);
  assert.equal(Number(cost.costUsd.toFixed(2)), 0.6); // 0.3 + 0.15 + 0.15
  assert.ok(cost.cacheSavedUsd > 2.8);

  await withTempDir((tempDir) => {
    const desktopBrain = path.join(tempDir, '.gemini', 'antigravity', 'brain');
    const cliBrain = path.join(tempDir, '.gemini', 'antigravity-cli', 'brain');
    const cacheDir = path.join(tempDir, 'cache');

    const nowMs = new Date('2026-11-27T12:00:00Z').getTime();
    const d1Dir = path.join(desktopBrain, 'sess-desktop-1', '.system_generated', 'logs');
    const c1Dir = path.join(cliBrain, 'sess-cli-1', '.system_generated', 'logs');
    fs.mkdirSync(d1Dir, { recursive: true });
    fs.mkdirSync(c1Dir, { recursive: true });

    fs.writeFileSync(
      path.join(d1Dir, 'transcript.jsonl'),
      [
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          model: 'gemini-4-neon-xhigh',
          input_tokens: 50000,
          cache_read_tokens: 450000,
          output_tokens: 2000,
          created_at: '2026-11-27T08:00:00Z',
        }),
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          model: 'claude-opus-5-5-high',
          input_tokens: 10000,
          cache_read_tokens: 90000,
          output_tokens: 1000,
          created_at: '2026-11-20T08:00:00Z',
        }),
      ].join('\n') + '\n',
      'utf8'
    );

    fs.writeFileSync(
      path.join(c1Dir, 'transcript.jsonl'),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        model: 'gemini-4-neon-high',
        input_tokens: 20000,
        cache_read_tokens: 80000,
        output_tokens: 500,
        created_at: '2026-11-27T09:00:00Z',
      }) + '\n',
      'utf8'
    );

    const todayRep = getUsageHistoryReport({
      period: 'today',
      brainDirs: [desktopBrain, cliBrain],
      cacheDir,
      nowMs,
    });
    assert.equal(todayRep.summary.sessionCount, 2);
    assert.equal(todayRep.summary.desktopCalls, 1);
    assert.equal(todayRep.summary.cliCalls, 1);
    assert.equal(todayRep.summary.totalTokens, 602500);
    assert.ok(todayRep.summary.estimatedCostUsd > 0);
    assert.equal(todayRep.heatmap.days.length, 84);
    assert.equal(todayRep.heatmap.activeDays, 2);

    const rep30d = getUsageHistoryReport({
      period: '30d',
      brainDirs: [desktopBrain, cliBrain],
      cacheDir,
      nowMs,
    });
    assert.equal(rep30d.summary.callCount, 3);
    assert.equal(rep30d.models.length, 2);
    assert.equal(rep30d.models[0].modelKey, 'gemini-4-neon');
    assert.ok(fs.existsSync(path.join(cacheDir, 'usage-history-cache.json')));
  });
});

test('rehydrate: 压缩后防失忆 Hook 提取、脱敏、敏感文件拦截、防重复注入与 hooks.json 安全管理', async () => {
  const redacted = redactSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc12345 and sk-proj-1234567890abcdefghij');
  assert.equal(redacted.includes('eyJhbGci'), false);
  assert.equal(redacted.includes('sk-proj-'), false);

  const fenced = truncateUtf8WithFences('```js\nconst a = 1;\nconst b = 2;\n', 22);
  assert.ok(fenced.endsWith('\n```'));

  await withTempDir((tempDir) => {
    // 1. 测试 hooks.json 启停、外部冲突检测与无痕卸载
    const configDir = path.join(tempDir, '.gemini', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    const hooksPath = path.join(configDir, 'hooks.json');
    fs.writeFileSync(
      hooksPath,
      JSON.stringify({ 'other-hook': { SessionStart: [{ type: 'command', command: 'echo ok' }] } }),
      'utf8'
    );

    const status0 = getRehydrateStatus({ homeDir: tempDir });
    assert.equal(status0.enabled, false);

    const enRes = setRehydrateEnabled(true, { homeDir: tempDir });
    assert.equal(enRes.ok, true);
    assert.equal(enRes.status.enabled, true);

    const savedHooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    assert.ok(savedHooks['other-hook'], '不得破坏已有其他 Hook');
    assert.ok(savedHooks[REHYDRATE_HOOK_NAME]?.PreInvocation?.length === 1);

    // 模拟外部已安装同类 Hook 冲突探测
    savedHooks['post-compact-rehydrate'] = { enabled: true, PreInvocation: [{ type: 'command', command: 'python x.py' }] };
    fs.writeFileSync(hooksPath, JSON.stringify(savedHooks), 'utf8');
    assert.equal(getRehydrateStatus({ homeDir: tempDir }).externalConflict, true);

    const rmRes = removeRehydrateHook({ homeDir: tempDir });
    assert.equal(rmRes.ok, true);
    assert.equal(rmRes.status.enabled, false);
    const afterRm = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    assert.equal(afterRm[REHYDRATE_HOOK_NAME], undefined);
    assert.ok(afterRm['other-hook']);

    // 2. 测试 Hook 运行逻辑：压缩点检测、白名单文件快照、敏感文件拦截与去重
    const wsDir = path.join(tempDir, 'ws');
    const logsDir = path.join(tempDir, 'brain', 'cid-rehydrate-1', '.system_generated', 'logs');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });

    const safeFile = path.join(wsDir, 'app.js');
    const secretFile = path.join(wsDir, '.env');
    fs.writeFileSync(safeFile, 'export const token = "sk-live-secret1234567890abcdef";\nconsole.log("ok");\n', 'utf8');
    fs.writeFileSync(secretFile, 'DB_PASS=super_secret_password\n', 'utf8');

    const transcriptPath = path.join(logsDir, 'transcript.jsonl');
    const lines = [
      JSON.stringify({ step_index: 1, type: 'USER_INPUT', content: '<USER_REQUEST>帮我重构支付模块</USER_REQUEST>' }),
      JSON.stringify({
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        content: '已修改 app.js 并检查配置',
        tool_calls: [
          { name: 'edit_file', arguments: { Path: safeFile }, result: 'ok' },
          { name: 'read_file', arguments: { Path: secretFile }, result: 'ok' },
        ],
      }),
      JSON.stringify({ step_index: 3, type: 'CHECKPOINT', created_at: '2026-11-27T10:00:00Z' }),
    ];
    fs.writeFileSync(transcriptPath, lines.join('\n') + '\n', 'utf8');

    const firstOut = runRehydratePayload({
      transcriptPath,
      conversationId: 'cid-rehydrate-1',
      workspacePaths: [wsDir],
    });
    assert.ok(Array.isArray(firstOut.injectSteps) && firstOut.injectSteps.length === 1);
    const injectedMsg = firstOut.injectSteps[0].systemMessage.systemMessage;
    assert.ok(injectedMsg.includes('帮我重构支付模块'));
    assert.ok(injectedMsg.includes('app.js'));
    assert.equal(injectedMsg.includes('sk-live-secret'), false, '恢复文件中的密钥必须自动脱敏');
    assert.equal(injectedMsg.includes('super_secret_password'), false, '敏感 .env 文件必须被拦截');

    // 第二次重复调用同一压缩点必须直接返回 {} 不重复注入
    const secondOut = runRehydratePayload({
      transcriptPath,
      conversationId: 'cid-rehydrate-1',
      workspacePaths: [wsDir],
    });
    assert.deepEqual(secondOut, {});
  });
});

test('planning-manager: 按会话独立开关、空白新会话预挂起、hooks.json 三态自动同步与卸载清理', async () => {
  await withTempDir((tempDir) => {
    const configDir = path.join(tempDir, '.gemini', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    const hooksPath = path.join(configDir, 'hooks.json');
    fs.writeFileSync(
      hooksPath,
      JSON.stringify({ 'keep-me-hook': { SessionStart: [{ type: 'command', command: 'echo keep' }] } }),
      'utf8'
    );

    const opts = { homeDir: tempDir };
    const cidA = 'aaaaaaaa-1111-2222-3333-000000000001';
    const cidB = 'bbbbbbbb-1111-2222-3333-000000000002';

    const s0 = getPlanningStatus(opts);
    assert.equal(s0.hookRegistered, false);
    assert.equal(s0.hookMode, 'off');
    assert.equal(s0.activeCount, 0);

    // 1. 为会话 A 开启 Planning：应注册 PreInvocation + PreToolUse，且不影响会话 B 与空白新会话
    const enA = setPlanningForConversation({ conversationId: cidA, enabled: true }, opts);
    assert.equal(enA.ok, true);
    assert.equal(enA.status.hookRegistered, true);
    assert.equal(enA.status.hookMode, 'full');
    assert.equal(isPlanningActiveFor(enA.status, cidA), true);
    assert.equal(isPlanningActiveFor(enA.status, cidB), false);
    assert.equal(isPlanningActiveFor(enA.status, ''), false);

    const hooksAfterOn = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    assert.ok(hooksAfterOn['keep-me-hook'], '不得破坏已有其他 Hook');
    assert.equal(hooksAfterOn[PLANNING_HOOK_NAME]?.PreInvocation?.length, 1);
    assert.equal(hooksAfterOn[PLANNING_HOOK_NAME]?.PreToolUse?.length, 1);

    // 验证 Windows Hook 命令格式：真实 node.exe 使用 call 前缀，Electron 外壳必须附加 ELECTRON_RUN_AS_NODE=1
    const winNodeCmd = buildPlanningHookCommand('C:\\tmp\\planning-hook.mjs', {
      platform: 'win32',
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    });
    assert.ok(winNodeCmd.startsWith('call "C:\\Program Files\\nodejs\\node.exe"'), 'Windows node.exe 必须使用 call 避免 cmd /c 引号剥离');
    const winElectronCmd = buildPlanningHookCommand('C:\\tmp\\planning-hook.mjs', {
      platform: 'win32',
      nodePath: 'C:\\Users\\demo\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe',
    });
    assert.ok(winElectronCmd.startsWith('set ELECTRON_RUN_AS_NODE=1&& '), 'Electron 二进制必须注入 ELECTRON_RUN_AS_NODE=1');

    // 2. 从未注入提示就立即关闭会话 A：直接卸载 Hook（零残留）
    const offEarly = setPlanningForConversation({ conversationId: cidA, enabled: false }, opts);
    assert.equal(offEarly.ok, true);
    assert.equal(offEarly.status.hookMode, 'off');
    assert.equal(offEarly.status.hookRegistered, false);
    const hooksAfterEarlyOff = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    assert.equal(hooksAfterEarlyOff[PLANNING_HOOK_NAME], undefined);
    assert.ok(hooksAfterEarlyOff['keep-me-hook']);

    // 3. 空白新会话提前预挂起（pendingNewSession）与 TTL 自动过期
    const baseTime = Date.now();
    const armed = setPlanningForConversation({ conversationId: '', enabled: true }, { ...opts, now: baseTime });
    assert.equal(armed.ok, true);
    assert.equal(armed.status.pendingNewSession, true);
    assert.equal(armed.status.hookMode, 'full');
    assert.equal(isPlanningActiveFor(armed.status, ''), true);
    assert.equal(isPlanningActiveFor(armed.status, cidB), false);

    const afterExpire = getPlanningStatus({ ...opts, now: baseTime + PENDING_SESSION_TTL_MS + 5000 });
    assert.equal(afterExpire.pendingNewSession, false);

    // 4. 非法 conversationId 被安全拒绝
    const badRes = setPlanningForConversation({ conversationId: '../bad/id', enabled: true }, opts);
    assert.equal(badRes.ok, false);

    // 5. 卸载清理无痕移除 Hook 与状态，保留外部 Hook
    const cleaned = removePlanningHook(opts);
    assert.equal(cleaned.ok, true);
    assert.equal(cleaned.status.hookMode, 'off');
    const hooksFinal = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    assert.equal(hooksFinal[PLANNING_HOOK_NAME], undefined);
    assert.ok(hooksFinal['keep-me-hook']);

    // 6. hooks.json 损坏时 fail-closed，绝不假显示开启
    fs.writeFileSync(hooksPath, '{ broken json', 'utf8');
    const corruptRes = setPlanningForConversation({ conversationId: cidA, enabled: true }, opts);
    assert.equal(corruptRes.ok, false);
    assert.equal(isPlanningActiveFor(corruptRes.status, cidA), false);
  });
});

test('planning-hook: 原生 /plan 复用、缓存防重复、空白新会话晋升、只读护栏与退出自动卸载', async () => {
  await withTempDir((tempDir) => {
    const opts = { homeDir: tempDir };
    const wsDir = path.join(tempDir, 'workspace');
    const artifactDir = path.join(tempDir, 'artifacts', 'session-a');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.mkdirSync(artifactDir, { recursive: true });

    const cidA = 'cccccccc-1111-2222-3333-00000000000a';
    const cidB = 'dddddddd-1111-2222-3333-00000000000b';
    const cidNew = 'eeeeeeee-1111-2222-3333-00000000000c';
    const hooksPath = path.join(tempDir, '.gemini', 'config', 'hooks.json');

    // 1. 路径边界与只读命令判定单测
    assert.equal(isPathInsideArtifactDir(path.join(artifactDir, 'implementation_plan.md'), artifactDir, wsDir), true);
    assert.equal(isPathInsideArtifactDir(path.join(artifactDir, 'evil.mjs'), artifactDir, wsDir), false);
    assert.equal(isPathInsideArtifactDir(path.join(artifactDir, '..', 'workspace', 'hack.md'), artifactDir, wsDir), false);
    assert.equal(isPathInsideArtifactDir(path.join(wsDir, 'README.md'), artifactDir, wsDir), false);

    assert.equal(isSafeReadOnlyCommand('git status'), true);
    assert.equal(isSafeReadOnlyCommand('git log --oneline -n 10'), true);
    assert.equal(isSafeReadOnlyCommand('rg -i planning lib'), true);
    assert.equal(isSafeReadOnlyCommand('git status && rm -rf .'), false);
    assert.equal(isSafeReadOnlyCommand('git diff --output=dump.txt'), false);
    assert.equal(isSafeReadOnlyCommand('npm install lodash'), false);
    assert.equal(isSafeReadOnlyCommand('echo hi > file.txt'), false);

    // 2. 缓存宿主原生 /plan 文本并开启会话 A 的 Planning 模式
    const syncRes = syncNativePlanPrompt('<PLAN>Official Native AGY Plan Spec</PLAN>', opts);
    assert.equal(syncRes.ok, true);
    assert.equal(syncRes.updated, true);

    assert.equal(setPlanningForConversation({ conversationId: cidA, enabled: true }, opts).ok, true);

    const transcriptA = path.join(tempDir, 'transcript-a.jsonl');
    fs.writeFileSync(transcriptA, JSON.stringify({ type: 'USER_INPUT', content: '重构认证' }) + '\n', 'utf8');

    // 首次 PreInvocation 注入原生 /plan 规范
    const inv1 = runPlanningHookPayload(
      {
        hookEventName: 'PreInvocation',
        conversationId: cidA,
        artifactDirectoryPath: artifactDir,
        transcriptPath: transcriptA,
        invocationNum: 1,
        initialNumSteps: 1,
      },
      opts
    );
    assert.equal(inv1.injectSteps?.length, 1);
    const msg1 = inv1.injectSteps[0].systemMessage.systemMessage;
    assert.ok(msg1.includes('Official Native AGY Plan Spec'), '应优先复用缓存的原生 /plan 规范');
    assert.ok(msg1.includes('PreToolUse'));

    // 同一会话第二次 PreInvocation 不重复注入（保护 Prompt Cache）
    const inv2 = runPlanningHookPayload(
      {
        hookEventName: 'PreInvocation',
        conversationId: cidA,
        artifactDirectoryPath: artifactDir,
        transcriptPath: transcriptA,
        invocationNum: 2,
        initialNumSteps: 1,
      },
      opts
    );
    assert.deepEqual(inv2, {});

    // 发生 CHECKPOINT 压缩后自动补注一次规划提示
    fs.appendFileSync(transcriptA, JSON.stringify({ type: 'CHECKPOINT', created_at: '2026-11-27T12:00:00Z' }) + '\n');
    const invAfterCompact = runPlanningHookPayload(
      {
        hookEventName: 'PreInvocation',
        conversationId: cidA,
        artifactDirectoryPath: artifactDir,
        transcriptPath: transcriptA,
        invocationNum: 1,
        initialNumSteps: 12,
      },
      opts
    );
    assert.equal(invAfterCompact.injectSteps?.length, 1);

    // 3. PreToolUse 只读护栏：会话 A 放行只读工具与 Artifact 规划文档，硬拦截工作区写入
    const baseToolPayloadA = {
      hookEventName: 'PreToolUse',
      conversationId: cidA,
      artifactDirectoryPath: artifactDir,
      cwd: wsDir,
      workspacePaths: [wsDir],
    };

    assert.equal(
      runPlanningHookPayload({ ...baseToolPayloadA, toolCall: { name: 'read_file', args: { Path: path.join(wsDir, 'a.js') } } }, opts).decision,
      'allow'
    );
    assert.equal(
      runPlanningHookPayload({ ...baseToolPayloadA, toolCall: { name: 'mcp_agy-fast_fast_batch_search', args: {} } }, opts).decision,
      'allow'
    );
    assert.equal(
      runPlanningHookPayload({ ...baseToolPayloadA, toolCall: { name: 'invoke_subagent', args: { TypeName: 'research' } } }, opts).decision,
      'allow'
    );
    assert.equal(
      runPlanningHookPayload({ ...baseToolPayloadA, toolCall: { name: 'run_command', args: { CommandLine: 'git status' } } }, opts).decision,
      'allow'
    );
    assert.equal(
      runPlanningHookPayload(
        { ...baseToolPayloadA, toolCall: { name: 'write_file', args: { Path: path.join(artifactDir, 'implementation_plan.md') } } },
        opts
      ).decision,
      'allow',
      'Artifact 目录内的规划文档必须放行'
    );

    assert.equal(
      runPlanningHookPayload(
        { ...baseToolPayloadA, toolCall: { name: 'edit_file', args: { Path: path.join(wsDir, 'index.js') } } },
        opts
      ).decision,
      'deny',
      '工作区代码编辑必须被硬拦截'
    );
    assert.equal(
      runPlanningHookPayload(
        {
          ...baseToolPayloadA,
          toolCall: {
            name: 'mcp_agy-fast_fast_apply_edits',
            args: { cwd: wsDir, edits: [{ path: 'lib/settings.mjs', hunks: [] }] },
          },
        },
        opts
      ).decision,
      'deny'
    );
    assert.equal(
      runPlanningHookPayload(
        { ...baseToolPayloadA, toolCall: { name: 'run_command', args: { CommandLine: 'npm test && rm -rf dist' } } },
        opts
      ).decision,
      'deny'
    );
    assert.equal(
      runPlanningHookPayload(
        { ...baseToolPayloadA, toolCall: { name: 'invoke_subagent', args: { TypeName: 'self' } } },
        opts
      ).decision,
      'deny'
    );
    assert.equal(classifyToolCall({ name: 'delete_file', args: { Path: path.join(wsDir, 'a.js') } }, baseToolPayloadA).decision, 'deny');

    // 未开启 Planning 的会话 B 完全不受影响
    assert.equal(
      runPlanningHookPayload(
        {
          hookEventName: 'PreToolUse',
          conversationId: cidB,
          artifactDirectoryPath: artifactDir,
          cwd: wsDir,
          toolCall: { name: 'edit_file', args: { Path: path.join(wsDir, 'index.js') } },
        },
        opts
      ).decision,
      'allow',
      '其他会话必须完全放行'
    );

    // 4. 关闭会话 A：hooks.json 立即降级为 exit-only（零 PreToolUse），工具立刻放行，下轮自动投递退出通知并注销 Hook
    const offA = setPlanningForConversation({ conversationId: cidA, enabled: false }, opts);
    assert.equal(offA.ok, true);
    assert.equal(offA.status.hookMode, 'exit-only');
    const hooksExitOnly = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    assert.equal(hooksExitOnly[PLANNING_HOOK_NAME]?.PreInvocation?.length, 1);
    assert.equal(hooksExitOnly[PLANNING_HOOK_NAME]?.PreToolUse, undefined, '关闭后应立即剥离 PreToolUse 消除写工具延迟');

    assert.equal(
      runPlanningHookPayload(
        { ...baseToolPayloadA, toolCall: { name: 'edit_file', args: { Path: path.join(wsDir, 'index.js') } } },
        opts
      ).decision,
      'allow'
    );

    const exitInv = runPlanningHookPayload(
      { hookEventName: 'PreInvocation', conversationId: cidA, invocationNum: 1, initialNumSteps: 15 },
      opts
    );
    assert.equal(exitInv.injectSteps?.length, 1);
    assert.ok(exitInv.injectSteps[0].systemMessage.systemMessage.includes('Planning Mode EXITED'));
    const hooksAfterExit = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    assert.equal(hooksAfterExit[PLANNING_HOOK_NAME], undefined, '投递完退出通知且全机空闲后应自动注销 Hook');

    // 5. 空白新会话预挂起晋升：老会话不可误领，全新会话精准认领
    assert.equal(setPlanningForConversation({ conversationId: '', enabled: true }, opts).ok, true);
    const oldTranscript = path.join(tempDir, 'transcript-old.jsonl');
    fs.writeFileSync(oldTranscript, JSON.stringify({ type: 'PLANNER_RESPONSE', content: 'old' }) + '\n', 'utf8');

    const oldClaimAttempt = runPlanningHookPayload(
      {
        hookEventName: 'PreInvocation',
        conversationId: cidB,
        transcriptPath: oldTranscript,
        invocationNum: 1,
        initialNumSteps: 8,
      },
      opts
    );
    assert.deepEqual(oldClaimAttempt, {}, '老会话绝不得误领 pendingNewSession');
    assert.equal(getPlanningStatus(opts).pendingNewSession, true);

    const newClaim = runPlanningHookPayload(
      {
        hookEventName: 'PreInvocation',
        conversationId: cidNew,
        artifactDirectoryPath: artifactDir,
        invocationNum: 1,
        initialNumSteps: 1,
      },
      opts
    );
    assert.equal(newClaim.injectSteps?.length, 1);
    const stAfterClaim = getPlanningStatus(opts);
    assert.equal(stAfterClaim.pendingNewSession, false);
    assert.equal(isPlanningActiveFor(stAfterClaim, cidNew), true);

    // 6. 对话内容/工具参数中出现 "CHECKPOINT" 字样不得误触发重复注入
    const cidProceed = 'ffffffff-1111-2222-3333-00000000000d';
    const transcriptProceed = path.join(tempDir, 'transcript-proceed.jsonl');
    fs.writeFileSync(
      transcriptProceed,
      [
        JSON.stringify({ type: 'USER_INPUT', content: '<USER_REQUEST>先帮我规划认证重构</USER_REQUEST>' }),
        JSON.stringify({ type: 'PLANNER_RESPONSE', content: '这里只是正文里提到了 "CHECKPOINT" 字样，并非真实压缩点' }),
      ].join('\n') + '\n',
      'utf8'
    );
    assert.equal(setPlanningForConversation({ conversationId: cidProceed, enabled: true }, opts).ok, true);
    const pInv1 = runPlanningHookPayload(
      {
        hookEventName: 'PreInvocation',
        conversationId: cidProceed,
        transcriptPath: transcriptProceed,
        artifactDirectoryPath: artifactDir,
        lastUserInput: '先帮我规划认证重构',
        invocationNum: 1,
        initialNumSteps: 1,
      },
      opts
    );
    assert.equal(pInv1.injectSteps?.length, 1);

    // 追加一条正文包含 "CHECKPOINT" 的 PLANNER_RESPONSE，验证不会重复注入
    fs.appendFileSync(
      transcriptProceed,
      JSON.stringify({ type: 'PLANNER_RESPONSE', content: '再次检索 "CHECKPOINT" 关键词' }) + '\n',
      'utf8'
    );
    const pInv2 = runPlanningHookPayload(
      {
        hookEventName: 'PreInvocation',
        conversationId: cidProceed,
        transcriptPath: transcriptProceed,
        artifactDirectoryPath: artifactDir,
        lastUserInput: '先帮我规划认证重构',
        invocationNum: 2,
        initialNumSteps: 1,
      },
      opts
    );
    assert.deepEqual(pInv2, {}, '正文中包含 "CHECKPOINT" 字样不得误判为压缩点重复注入');

    // 用户仅回复修改意见（不含原生 Proceed 批准句）→ 必须保持 Planning 只读拦截
    const reviewMsg = 'Comments on artifact URI: file:///plan.md\n请把第二步拆得更细一点';
    fs.appendFileSync(transcriptProceed, JSON.stringify({ type: 'USER_INPUT', content: reviewMsg }) + '\n', 'utf8');
    const pReview = runPlanningHookPayload(
      {
        hookEventName: 'PreInvocation',
        conversationId: cidProceed,
        transcriptPath: transcriptProceed,
        lastUserInput: reviewMsg,
        invocationNum: 1,
        initialNumSteps: 4,
      },
      opts
    );
    assert.deepEqual(pReview, {});
    assert.equal(isPlanningActiveFor(getPlanningStatus(opts), cidProceed), true);
    assert.equal(
      runPlanningHookPayload(
        {
          hookEventName: 'PreToolUse',
          conversationId: cidProceed,
          artifactDirectoryPath: artifactDir,
          cwd: wsDir,
          toolCall: { name: 'edit_file', args: { Path: path.join(wsDir, 'auth.js') } },
        },
        opts
      ).decision,
      'deny'
    );

    // 用户点击原生 Proceed 批准计划 → 自动退出 Planning、解除 PreToolUse 护栏并投递退出提示
    const proceedMsg =
      'Comments on artifact URI: file:///c%3A/artifacts/implementation_plan.md\n\nThe user has approved this document.\n\n<USER_REQUEST>\n\n</USER_REQUEST>';
    fs.appendFileSync(transcriptProceed, JSON.stringify({ type: 'USER_INPUT', content: proceedMsg }) + '\n', 'utf8');
    const pApproved = runPlanningHookPayload(
      {
        hookEventName: 'PreInvocation',
        conversationId: cidProceed,
        transcriptPath: transcriptProceed,
        lastUserInput: proceedMsg,
        invocationNum: 1,
        initialNumSteps: 6,
      },
      opts
    );
    assert.equal(pApproved.injectSteps?.length, 1);
    assert.ok(pApproved.injectSteps[0].systemMessage.systemMessage.includes('Proceed'));
    assert.ok(pApproved.injectSteps[0].systemMessage.systemMessage.includes('Planning Mode EXITED'));
    assert.equal(isPlanningActiveFor(getPlanningStatus(opts), cidProceed), false, '点击 Proceed 后该会话必须自动退出 Planning');
    assert.equal(
      runPlanningHookPayload(
        {
          hookEventName: 'PreToolUse',
          conversationId: cidProceed,
          artifactDirectoryPath: artifactDir,
          cwd: wsDir,
          toolCall: { name: 'edit_file', args: { Path: path.join(wsDir, 'auth.js') } },
        },
        opts
      ).decision,
      'allow',
      '点击 Proceed 后必须立刻放行工作区代码编辑'
    );

    // 更早之前已有历史 Proceed，随后重新开启 Planning 并发送新请求时，绝不得被旧 Proceed 误退出
    const newReqAfterOldProceed = '<USER_REQUEST>再规划第二个模块</USER_REQUEST>';
    fs.appendFileSync(
      transcriptProceed,
      JSON.stringify({ type: 'USER_INPUT', content: newReqAfterOldProceed }) + '\n',
      'utf8'
    );
    assert.equal(setPlanningForConversation({ conversationId: cidProceed, enabled: true }, opts).ok, true);
    const pReenter = runPlanningHookPayload(
      {
        hookEventName: 'PreInvocation',
        conversationId: cidProceed,
        transcriptPath: transcriptProceed,
        lastUserInput: '再规划第二个模块',
        invocationNum: 1,
        initialNumSteps: 9,
      },
      opts
    );
    assert.equal(pReenter.injectSteps?.length, 1);
    assert.ok(pReenter.injectSteps[0].systemMessage.systemMessage.includes('Planning Mode ACTIVE'));
    assert.equal(isPlanningActiveFor(getPlanningStatus(opts), cidProceed), true);
  });
});

test('composer-widget (planning): 底栏 Planning 胶囊按会话隔离、原生 /plan 采样、隐藏开关与无痕卸载', async () => {
  function createMockClassList() {
    const set = new Set();
    return {
      add: (...names) => names.forEach((n) => set.add(n)),
      remove: (...names) => names.forEach((n) => set.delete(n)),
      toggle: (name, force) => {
        if (force === undefined) {
          if (set.has(name)) { set.delete(name); return false; }
          set.add(name); return true;
        }
        if (force) set.add(name);
        else set.delete(name);
        return Boolean(force);
      },
      contains: (name) => set.has(name),
      toString: () => Array.from(set).join(' '),
    };
  }

  function createMockEl(tagName = 'div') {
    const attrs = new Map();
    const el = {
      tagName: String(tagName).toUpperCase(),
      nodeType: 1,
      id: '',
      className: '',
      dataset: {},
      style: {},
      textContent: '',
      disabled: false,
      children: [],
      parentElement: null,
      classList: createMockClassList(),
      _innerHTML: '',
      _listeners: new Map(),
      setAttribute(k, v) {
        attrs.set(k, String(v));
        if (k === 'id') this.id = String(v);
        if (k === 'class') this.className = String(v);
      },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
      hasAttribute(k) { return attrs.has(k); },
      addEventListener(ev, fn) {
        if (!this._listeners.has(ev)) this._listeners.set(ev, new Set());
        this._listeners.get(ev).add(fn);
      },
      removeEventListener(ev, fn) { this._listeners.get(ev)?.delete(fn); },
      dispatchEvent(evName, evObj = {}) {
        for (const fn of this._listeners.get(evName) || []) fn(evObj);
      },
      appendChild(child) {
        if (child.parentElement) child.remove();
        child.parentElement = this;
        this.children.push(child);
        return child;
      },
      insertBefore(child, ref) {
        if (child.parentElement) child.remove();
        child.parentElement = this;
        const idx = ref ? this.children.indexOf(ref) : -1;
        if (idx >= 0) this.children.splice(idx, 0, child);
        else this.children.push(child);
        return child;
      },
      remove() {
        if (!this.parentElement) return;
        const idx = this.parentElement.children.indexOf(this);
        if (idx >= 0) this.parentElement.children.splice(idx, 1);
        this.parentElement = null;
      },
      contains(target) { return target === this || this.children.some((c) => c.contains(target)); },
      getBoundingClientRect() { return { left: 100, top: 100, right: 300, bottom: 140, width: 200, height: 40 }; },
      closest(sel) {
        let cur = this;
        while (cur) {
          if (matches(cur, sel)) return cur;
          cur = cur.parentElement;
        }
        return null;
      },
      querySelector(sel) {
        for (const c of this.children) {
          if (matches(c, sel)) return c;
          const n = c.querySelector(sel);
          if (n) return n;
        }
        return null;
      },
      querySelectorAll(sel) {
        const res = [];
        for (const c of this.children) {
          if (matches(c, sel)) res.push(c);
          res.push(...c.querySelectorAll(sel));
        }
        return res;
      },
      getElementsByClassName(cls) {
        const res = [];
        for (const c of this.children) {
          if (String(c.className || '').split(/\s+/).includes(cls)) res.push(c);
          res.push(...c.getElementsByClassName(cls));
        }
        return res;
      },
    };
    Object.defineProperty(el, 'innerHTML', {
      get() { return this._innerHTML; },
      set(val) {
        this._innerHTML = String(val);
        this.children = [];
        if (this._innerHTML.includes('cr-graphic-slot') && this._innerHTML.includes('cr-pct-text')) {
          const s = createMockEl('span'); s.className = 'cr-graphic-slot';
          const p = createMockEl('span'); p.className = 'cr-pct-text'; p.textContent = '0%';
          this.appendChild(s); this.appendChild(p);
        } else if (this._innerHTML.includes('cr-plan-pill-label')) {
          const lbl = createMockEl('span'); lbl.className = 'cr-plan-pill-label'; lbl.textContent = 'Planning';
          this.appendChild(lbl);
        }
      },
    });
    return el;
  }

  function matches(el, sel) {
    if (!el || !sel) return false;
    if (sel.startsWith('#')) return el.id === sel.slice(1);
    if (sel.startsWith('.')) {
      const cls = sel.slice(1);
      return String(el.className || '').split(/\s+/).includes(cls) || el.classList.contains(cls);
    }
    if (sel === '[contenteditable="true"]') return el.getAttribute('contenteditable') === 'true';
    if (sel === '[data-testid="model-selector-trigger"]') return el.getAttribute('data-testid') === 'model-selector-trigger';
    return false;
  }

  const head = createMockEl('head');
  const body = createMockEl('body');
  const card = createMockEl('div');
  card.className = 'surface-composer-card';
  const editor = createMockEl('div');
  editor.setAttribute('contenteditable', 'true');
  const footer = createMockEl('div');
  footer.className = 'agy-composer-footer';
  const leftSlot = createMockEl('div');
  const rightSlot = createMockEl('div');
  footer.appendChild(leftSlot);
  footer.appendChild(rightSlot);
  card.appendChild(editor);
  card.appendChild(footer);
  body.appendChild(card);

  const cidA = '11111111-aaaa-bbbb-cccc-000000000001';
  const cidB = '22222222-aaaa-bbbb-cccc-000000000002';
  const winListeners = new Map();
  const rpcCalls = [];
  let activeSessions = [];
  let pendingNew = false;

  const composerFiber = {
    memoizedProps: {
      handleSubmit: () => {},
      cascadeId: cidA,
      slashCommandItems: [
        { title: 'plan', info: { name: 'plan', modelFacingText: '<PLAN>Host Native Plan</PLAN>' } },
      ],
    },
    return: null,
  };
  editor['__reactFiber$test'] = composerFiber;
  footer['__reactFiber$test'] = composerFiber;

  const sandbox = {
    console, Math, Number, String, Boolean, Array, Object, Map, Set, JSON, Promise, Date,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
    clearTimeout,
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); return t; },
    clearInterval,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
    location: { pathname: `/c/${cidA}` },
    navigator: {},
    MutationObserver: class { observe() {} disconnect() {} },
    getComputedStyle: () => ({ backgroundColor: 'rgb(255, 255, 255)', display: 'flex' }),
    document: {
      head, body,
      documentElement: createMockEl('html'),
      createElement: (t) => createMockEl(t),
      getElementById: (id) => head.querySelector(`#${id}`) || body.querySelector(`#${id}`) || null,
      getElementsByClassName: (cls) => body.getElementsByClassName(cls),
      querySelector: (sel) => body.querySelector(sel),
      querySelectorAll: (sel) => body.querySelectorAll(sel),
      addEventListener: () => {},
      removeEventListener: () => {},
      hasFocus: () => true,
    },
    window: null,
  };
  sandbox.window = sandbox;
  sandbox.innerWidth = 1280;
  sandbox.innerHeight = 800;
  sandbox.addEventListener = (ev, fn) => {
    if (!winListeners.has(ev)) winListeners.set(ev, new Set());
    winListeners.get(ev).add(fn);
  };
  sandbox.removeEventListener = (ev, fn) => winListeners.get(ev)?.delete(fn);
  sandbox.__contextRingHost = (raw) => {
    const req = JSON.parse(raw);
    rpcCalls.push(req);
    let resp = { id: req.id, ok: true };
    if (req.method === 'usage.get') {
      resp.usage = createEmptyUsage(req.params?.conversationId || '', '');
      resp.planning = { activeSessionIds: activeSessions.slice(), activeCount: activeSessions.length, pendingNewSession: pendingNew, error: '' };
    } else if (req.method === 'planning.set') {
      const targetCid = String(req.params?.conversationId || '');
      if (targetCid) {
        activeSessions = req.params.enabled
          ? Array.from(new Set([...activeSessions, targetCid]))
          : activeSessions.filter((x) => x !== targetCid);
      } else {
        pendingNew = Boolean(req.params.enabled);
      }
      resp.planning = { activeSessionIds: activeSessions.slice(), activeCount: activeSessions.length, pendingNewSession: pendingNew, error: '' };
    } else if (req.method === 'planning.get') {
      resp.planning = { activeSessionIds: activeSessions.slice(), activeCount: activeSessions.length, pendingNewSession: pendingNew, error: '' };
    }
    queueMicrotask(() => sandbox.__contextRingResolveRpc(resp));
  };

  const source = buildInjectedSource(DEFAULT_SETTINGS, '1.1.0');
  vm.runInNewContext(source, sandbox);
  await new Promise((r) => setTimeout(r, 35));

  const planHost = footer.querySelector('.agy-context-ring-planning-host');
  assert.ok(planHost, '底栏应自动挂载 Planning 切换胶囊');
  const planBtn = planHost.querySelector('.cr-plan-pill-btn');
  assert.equal(planBtn.getAttribute('data-active'), '0');
  assert.equal(planHost.querySelector('.cr-plan-pill-label').textContent, 'Planning');

  // 点击底栏胶囊为会话 A 开启 Planning，并自动携带采样到的原生 /plan 文本
  planBtn.dispatchEvent('click', { stopPropagation() {} });
  await new Promise((r) => setTimeout(r, 35));
  const setCall = rpcCalls.find((c) => c.method === 'planning.set');
  assert.ok(setCall, '点击底栏胶囊应发起 planning.set RPC');
  assert.equal(setCall.params.conversationId, cidA);
  assert.equal(setCall.params.enabled, true);
  assert.equal(setCall.params.nativePlanText, '<PLAN>Host Native Plan</PLAN>');
  assert.equal(planBtn.getAttribute('data-active'), '1');
  assert.equal(planHost.querySelector('.cr-plan-pill-label').textContent, 'Planning');

  // 切换到会话 B：按钮必须立刻切回未开启态（按会话隔离）
  composerFiber.memoizedProps = { ...composerFiber.memoizedProps, cascadeId: cidB };
  sandbox.location.pathname = `/c/${cidB}`;
  for (const fn of winListeners.get('popstate') || []) fn();
  await new Promise((r) => setTimeout(r, 35));
  assert.equal(planBtn.getAttribute('data-active'), '0', '切换到未开启 Planning 的会话 B 时必须显示未开启');

  // 关闭底栏 Planning 显示开关后应立即移除底栏节点
  sandbox.__contextRingReceiveSettings({ ...DEFAULT_SETTINGS, showFooterPlanning: false });
  assert.equal(footer.querySelector('.agy-context-ring-planning-host'), null);

  // 重新显示后，卸载清理函数必须无痕移除
  sandbox.__contextRingReceiveSettings({ ...DEFAULT_SETTINGS, showFooterPlanning: true });
  assert.ok(footer.querySelector('.agy-context-ring-planning-host'));
  sandbox.__CONTEXT_RING_CLEANUP__();
  assert.equal(footer.querySelector('.agy-context-ring-planning-host'), null);
});

test('composer-widget (replay-fork): 选中历史步骤点击「分支继续」精确截断工具边界并跳转新分支会话', async () => {
  function createMockClassList() {
    const set = new Set();
    return {
      add: (...names) => names.forEach((n) => set.add(n)),
      remove: (...names) => names.forEach((n) => set.delete(n)),
      toggle: (name, force) => {
        if (force === undefined) {
          if (set.has(name)) { set.delete(name); return false; }
          set.add(name); return true;
        }
        if (force) set.add(name);
        else set.delete(name);
        return Boolean(force);
      },
      contains: (name) => set.has(name),
      toString: () => Array.from(set).join(' '),
    };
  }

  function createMockEl(tagName = 'div') {
    const attrs = new Map();
    const el = {
      tagName: String(tagName).toUpperCase(),
      nodeType: 1,
      id: '',
      className: '',
      dataset: {},
      style: {},
      textContent: '',
      title: '',
      disabled: false,
      children: [],
      parentElement: null,
      classList: createMockClassList(),
      _innerHTML: '',
      _listeners: new Map(),
      setAttribute(k, v) {
        attrs.set(k, String(v));
        if (k === 'id') this.id = String(v);
        if (k === 'class') this.className = String(v);
      },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
      hasAttribute(k) { return attrs.has(k); },
      addEventListener(ev, fn) {
        if (!this._listeners.has(ev)) this._listeners.set(ev, new Set());
        this._listeners.get(ev).add(fn);
      },
      removeEventListener(ev, fn) { this._listeners.get(ev)?.delete(fn); },
      dispatchEvent(evName, evObj = {}) {
        for (const fn of this._listeners.get(evName) || []) fn(evObj);
      },
      appendChild(child) {
        if (child.parentElement) child.remove();
        child.parentElement = this;
        this.children.push(child);
        return child;
      },
      insertBefore(child, ref) {
        if (child.parentElement) child.remove();
        child.parentElement = this;
        const idx = ref ? this.children.indexOf(ref) : -1;
        if (idx >= 0) this.children.splice(idx, 0, child);
        else this.children.push(child);
        return child;
      },
      remove() {
        if (!this.parentElement) return;
        const idx = this.parentElement.children.indexOf(this);
        if (idx >= 0) this.parentElement.children.splice(idx, 1);
        this.parentElement = null;
      },
      contains(target) { return target === this || this.children.some((c) => c.contains(target)); },
      getBoundingClientRect() { return { left: 100, top: 100, right: 300, bottom: 140, width: 200, height: 40 }; },
      closest(sel) {
        let cur = this;
        while (cur) {
          if (matches(cur, sel)) return cur;
          cur = cur.parentElement;
        }
        return null;
      },
      querySelector(sel) {
        for (const c of this.children) {
          if (matches(c, sel)) return c;
          const n = c.querySelector(sel);
          if (n) return n;
        }
        return null;
      },
      querySelectorAll(sel) {
        const res = [];
        for (const c of this.children) {
          if (matches(c, sel)) res.push(c);
          res.push(...c.querySelectorAll(sel));
        }
        return res;
      },
      getElementsByClassName(cls) {
        const res = [];
        for (const c of this.children) {
          if (String(c.className || '').split(/\s+/).includes(cls)) res.push(c);
          res.push(...c.getElementsByClassName(cls));
        }
        return res;
      },
    };
    Object.defineProperty(el, 'innerHTML', {
      get() { return this._innerHTML; },
      set(val) {
        this._innerHTML = String(val);
        this.children = [];
        const html = this._innerHTML;
        if (html.includes('cr-graphic-slot') && html.includes('cr-pct-text')) {
          const s = createMockEl('span'); s.className = 'cr-graphic-slot';
          const p = createMockEl('span'); p.className = 'cr-pct-text'; p.textContent = '0%';
          this.appendChild(s); this.appendChild(p);
        } else if (html.includes('cr-plan-pill-label')) {
          const lbl = createMockEl('span'); lbl.className = 'cr-plan-pill-label'; lbl.textContent = 'Planning';
          this.appendChild(lbl);
        } else if (html.includes('data-role="step-replay-bar"')) {
          const roles = [
            ['span', 'pct'], ['span', 'summary'], ['button', 'val-steps'], ['div', 'step-menu'],
            ['button', 'open-settings-btn'], ['div', 'seg-cache'], ['div', 'seg-input'], ['div', 'seg-output'],
            ['div', 'chip-cache'], ['div', 'val-cache'], ['div', 'chip-input'], ['div', 'val-input'],
            ['div', 'chip-output'], ['div', 'val-output'], ['div', 'step-replay-bar'], ['span', 'step-replay-info'],
            ['button', 'step-prev-btn'], ['button', 'step-next-btn'], ['button', 'step-fork-btn'], ['button', 'step-live-btn'],
            ['div', 'speed-bar'], ['span', 'speed-tps'], ['span', 'speed-grade'], ['span', 'speed-meta'],
            ['div', 'effort-box'], ['span', 'effort-caption'], ['div', 'model-picker'], ['button', 'model-picker-btn'],
            ['span', 'current-model-quota'], ['span', 'effort-model'], ['div', 'model-menu'], ['div', 'effort-rail'],
            ['div', 'effort-energy'], ['div', 'effort-pill'], ['div', 'effort-grid'], ['div', 'plan-bar'],
            ['span', 'plan-bar-sub'], ['button', 'plan-toggle-btn'], ['div', 'limit-group'],
            ['button', 'compact-btn'], ['span', 'compact-label'], ['span', 'rehydrate-dot'],
          ];
          for (const [tag, role] of roles) {
            const child = createMockEl(tag);
            child.setAttribute('data-role', role);
            if (role === 'val-steps') {
              const txt = createMockEl('span');
              txt.setAttribute('data-role', 'val-steps-text');
              child.appendChild(txt);
            }
            this.appendChild(child);
          }
        } else if (html.includes('data-step="latest"')) {
          const opt1 = createMockEl('button');
          opt1.className = 'cr-step-option';
          opt1.setAttribute('data-step', '1');
          opt1.setAttribute('data-turn', '1');
          opt1.setAttribute('data-total-turns', '2');
          this.appendChild(opt1);
        }
      },
    });
    return el;
  }

  function matches(el, sel) {
    if (!el || !sel) return false;
    if (sel.startsWith('#')) return el.id === sel.slice(1);
    if (sel.startsWith('.')) {
      const cls = sel.slice(1);
      return String(el.className || '').split(/\s+/).includes(cls) || el.classList.contains(cls);
    }
    const roleM = sel.match(/^\[data-role="([^"]+)"\]$/);
    if (roleM) return el.getAttribute('data-role') === roleM[1];
    if (sel === '[contenteditable="true"]') return el.getAttribute('contenteditable') === 'true';
    if (sel === '[data-testid="model-selector-trigger"]') return el.getAttribute('data-testid') === 'model-selector-trigger';
    return false;
  }

  const head = createMockEl('head');
  const body = createMockEl('body');
  const card = createMockEl('div');
  card.className = 'surface-composer-card';
  const editor = createMockEl('div');
  editor.setAttribute('contenteditable', 'true');
  const footer = createMockEl('div');
  footer.className = 'agy-composer-footer';
  footer.appendChild(createMockEl('div'));
  footer.appendChild(createMockEl('div'));
  card.appendChild(editor);
  card.appendChild(footer);
  body.appendChild(card);

  const sourceCid = '11111111-1111-1111-1111-111111111111';
  const forkedCid = '99999999-9999-9999-9999-999999999999';
  const forkCalls = [];
  const navCalls = [];

  const mockLsClient = {
    retrieveUserQuotaSummary: async () => ({}),
    getCascadeTrajectory: async () => ({
    trajectory: {
      steps: [
        { metadata: { stepIndex: 0 }, step: { case: 'userInput' } },
        { metadata: { stepIndex: 1 }, step: { case: 'plannerResponse' } },
        { metadata: { stepIndex: 2 }, step: { case: 'generic' } },
        { metadata: { stepIndex: 3 }, step: { case: 'generic' } },
        { metadata: { stepIndex: 4 }, step: { case: 'plannerResponse' } },
        { metadata: { stepIndex: 5 }, step: { case: 'userInput' } },
        { metadata: { stepIndex: 6 }, step: { case: 'plannerResponse' } },
        { metadata: { stepIndex: 7 }, step: { case: 'plannerResponse' } },
      ],
    },
  }),
  forkConversation: async (req) => {
    forkCalls.push(req);
    return { newCascadeId: forkedCid };
  },
  };
  const mockRouter = {
    buildRouteTree: () => ({}),
    navigate: async (opts) => { navCalls.push(opts); },
  };
  const composerFiber = {
    memoizedProps: { handleSubmit: () => {}, cascadeId: sourceCid, lsClient: mockLsClient, router: mockRouter },
    return: null,
  };
  editor['__reactFiber$test'] = composerFiber;
  footer['__reactFiber$test'] = composerFiber;

  const usageObj = {
    ...createEmptyUsage(sourceCid, ''),
    turnCount: 2,
    plannerStepCount: 4,
    totalTokens: 90000,
    steps: [
      { step: 1, turn: 1, stepIndex: 1, inputTokens: 10000, cacheReadTokens: 20000, outputTokens: 500, totalTokens: 30500, deltaTokens: 30500, cacheHitRate: 66.7, promptSnippet: '第一轮提问' },
      { step: 2, turn: 1, stepIndex: 4, inputTokens: 1000, cacheReadTokens: 39000, outputTokens: 500, totalTokens: 40500, deltaTokens: 10000, cacheHitRate: 97.5, promptSnippet: '第一轮提问' },
      { step: 3, turn: 2, stepIndex: 6, inputTokens: 2000, cacheReadTokens: 60000, outputTokens: 600, totalTokens: 62600, deltaTokens: 22100, cacheHitRate: 96.8, promptSnippet: '第二轮提问' },
      { step: 4, turn: 2, stepIndex: 7, inputTokens: 5000, cacheReadTokens: 84000, outputTokens: 1000, totalTokens: 90000, deltaTokens: 27400, cacheHitRate: 94.4, promptSnippet: '第二轮提问' },
    ],
  };

  const sandbox = {
    console, Math, Number, String, Boolean, Array, Object, Map, Set, JSON, Promise, Date, Event,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
    clearTimeout,
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); return t; },
    clearInterval,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
    location: { pathname: `/c/${sourceCid}` },
    navigator: {},
    MutationObserver: class { observe() {} disconnect() {} },
    getComputedStyle: () => ({ backgroundColor: 'rgb(255, 255, 255)', display: 'flex' }),
    document: {
      head, body,
      documentElement: createMockEl('html'),
      createElement: (t) => createMockEl(t),
      getElementById: (id) => head.querySelector(`#${id}`) || body.querySelector(`#${id}`) || null,
      getElementsByClassName: (cls) => body.getElementsByClassName(cls),
      querySelector: (sel) => body.querySelector(sel),
      querySelectorAll: (sel) => body.querySelectorAll(sel),
      addEventListener: () => {},
      removeEventListener: () => {},
      hasFocus: () => true,
    },
    window: null,
  };
  sandbox.window = sandbox;
  sandbox.innerWidth = 1280;
  sandbox.innerHeight = 800;
  sandbox.addEventListener = () => {};
  sandbox.removeEventListener = () => {};
  sandbox.__contextRingHost = (raw) => {
    const req = JSON.parse(raw);
    const resp = { id: req.id, ok: true };
    if (req.method === 'usage.get') resp.usage = usageObj;
    queueMicrotask(() => sandbox.__contextRingResolveRpc(resp));
  };

  const source = buildInjectedSource({ ...DEFAULT_SETTINGS, contextLimit: 512000 }, '1.1.0');
  vm.runInNewContext(source, sandbox);
  await new Promise((r) => setTimeout(r, 35));

  // 打开悬浮卡片，验证默认按「轮」切换：从第 2 轮（step 4）点一次 ‹ 应直接跳到第 1 轮轮末（step 2）
  footer.querySelector('.cr-trigger-btn').dispatchEvent('click', { stopPropagation() {} });
  const pop = body.querySelector('#agy-context-ring-popover');
  pop.querySelector('[data-role="val-steps"]').dispatchEvent('click', { stopPropagation() {} });
  const stepMenu = pop.querySelector('[data-role="step-menu"]');
  const opt1 = stepMenu.querySelector('.cr-step-option');
  stepMenu.dispatchEvent('click', { stopPropagation() {}, target: opt1 });

  // 从第 1 轮点 › 应直接跳到第 2 轮轮末（step 4），再点 ‹ 直接回到第 1 轮轮末（step 2）
  const nextBtn = pop.querySelector('[data-role="step-next-btn"]');
  const prevBtn = pop.querySelector('[data-role="step-prev-btn"]');
  nextBtn.dispatchEvent('click', { stopPropagation() {} });
  assert.equal(pop.querySelector('[data-role="val-steps-text"]').textContent, '第 2 / 2 轮');
  assert.ok(pop.querySelector('[data-role="step-replay-info"]').innerHTML.includes('回放 第 2 轮'));

  prevBtn.dispatchEvent('click', { stopPropagation() {} });
  assert.equal(pop.querySelector('[data-role="val-steps-text"]').textContent, '第 1 / 2 轮');
  assert.ok(pop.querySelector('[data-role="step-replay-info"]').innerHTML.includes('回放 第 1 轮'));
  assert.equal(prevBtn.disabled, true, '第 1 轮时 ‹ 必须禁用');

  // 点击「分支继续」按钮
  const forkBtn = pop.querySelector('[data-role="step-fork-btn"]');
  forkBtn.dispatchEvent('click', { stopPropagation() {}, currentTarget: forkBtn });
  await new Promise((r) => setTimeout(r, 40));

  assert.equal(forkCalls.length, 1, '应调用一次原生 forkConversation');
  assert.equal(forkCalls[0].sourceCascadeId, sourceCid);
  assert.equal(forkCalls[0].forkAtStepIndex, 4, '按轮分支应完整保留第 1 轮全部步骤，截断到第 2 轮 userInput 之前 (stepIndex 4)');
  assert.equal(navCalls.length, 1, '分支成功后应调用原生路由跳转到新会话');
  assert.equal(navCalls[0].to, `/c/${forkedCid}`);

  sandbox.__CONTEXT_RING_CLEANUP__();
});

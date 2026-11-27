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
  normalizeSettings,
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

test('settings: 默认值校验、非法值兜底与原子持久化读写', async () => {
  await withTempDir((tempDir) => {
    const store = createSettingsStore(tempDir);
    const initial = store.get();
    assert.deepEqual(initial, DEFAULT_SETTINGS);

    // 验证所有 5 种形态均可合法保存
    for (const styleMode of STYLE_MODES) {
      const saved = store.set({ styleMode });
      assert.equal(saved.styleMode, styleMode);
    }

    // 验证配色固定为自动告警，任意传入配色均归一化为 auto
    assert.deepEqual(COLOR_PALETTES, ['auto']);
    assert.equal(store.set({ palette: 'ocean' }).palette, 'auto');
    for (const limit of CONTEXT_LIMITS) {
      assert.equal(store.set({ contextLimit: limit }).contextLimit, limit);
    }

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
  assert.ok(injectedSource.includes('agy-context-ring-quota-tip'));
  assert.ok(injectedSource.includes('showQuotaTip'));
  assert.ok(injectedSource.includes('cr-gauge-track'));
  assert.ok(injectedSource.includes('agy-context-ring-settings-modal'));
  assert.ok(injectedSource.includes('getComposerCompactController'));
  assert.ok(injectedSource.includes('executeCompactCommand'));
  assert.ok(injectedSource.includes('__CONTEXT_RING_TRIGGER_COMPACT__'));
  assert.ok(injectedSource.includes('createEmptyWidgetUsage'));
  assert.ok(injectedSource.includes('explicitBlankComposer'));
  assert.equal(injectedSource.includes('Array.from(usageCache.values())[0]'), false);

  const html = renderSidecarDashboardHtml({ version: '1.0.0' });
  assert.equal(html.includes('paletteGroup'), false);
  for (const mode of STYLE_MODES) {
    assert.ok(html.includes(`data-style="${mode}"`), `缺少样式按钮: ${mode}`);
  }
  assert.ok(html.includes('/api/state'));
  assert.ok(html.includes('/api/settings'));
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

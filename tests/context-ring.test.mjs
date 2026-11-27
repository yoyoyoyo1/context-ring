import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
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
  assert.ok(injectedSource.includes('cr-gauge-track'));
  assert.ok(injectedSource.includes('agy-context-ring-settings-modal'));

  const html = renderSidecarDashboardHtml({ version: '1.0.0' });
  assert.equal(html.includes('paletteGroup'), false);
  for (const mode of STYLE_MODES) {
    assert.ok(html.includes(`data-style="${mode}"`), `缺少样式按钮: ${mode}`);
  }
  assert.ok(html.includes('/api/state'));
  assert.ok(html.includes('/api/settings'));
});

/**
 * Context Ring — 无侵入多形态输入框上下文监控组件
 *
 * 特点：
 * 1. 零 DOM 原型污染（不修改 document.querySelectorAll），与其他插件安全共存；
 * 2. 通过 CDP Runtime.addBinding ('__contextRingHost') 零端口获取实时会话数据与同步设置；
 * 3. 悬浮卡片内置「思考等级星云滑块」，真实联动 Antigravity 当前模型的 Low/Medium/High/XHigh 思考等级；
 * 4. 悬浮卡片右上角提供「设置」按钮，点击打开专属样式与监控设置页面，自由定制 5 种形态、配色、上限与挂载位置。
 */
(function installContextRingWidget() {
  const WIDGET_VERSION = window.__CONTEXT_RING_EXPECTED_VERSION__ || '1.0.0';
  const forceReload = Boolean(window.__CONTEXT_RING_FORCE_RELOAD__);
  window.__CONTEXT_RING_FORCE_RELOAD__ = false;

  // 若同版本已安装且未要求重载，直接同步最新引导配置后退出
  if (!forceReload && window.__CONTEXT_RING_INSTALLED__ && window.__CONTEXT_RING_VERSION__ === WIDGET_VERSION) {
    if (window.__CONTEXT_RING_BOOT_SETTINGS__ && typeof window.__contextRingReceiveSettings === 'function') {
      window.__contextRingReceiveSettings(window.__CONTEXT_RING_BOOT_SETTINGS__);
    }
    return;
  }

  // 若存在旧版本实例，先干净卸载旧节点、事件与定时器
  if (typeof window.__CONTEXT_RING_CLEANUP__ === 'function') {
    try {
      window.__CONTEXT_RING_CLEANUP__();
    } catch {
      // 忽略旧版清理异常
    }
  }

  window.__CONTEXT_RING_INSTALLED__ = true;
  window.__CONTEXT_RING_VERSION__ = WIDGET_VERSION;
  window.__CONTEXT_RING_MOUNTED_COUNT__ = 0;
  window.__CONTEXT_RING_ACTIVE_CID__ = '';

  const STYLE_TAG_ID = 'agy-context-ring-styles';
  const POPOVER_ID = 'agy-context-ring-popover';
  const SETTINGS_MODAL_ID = 'agy-context-ring-settings-modal';
  const HOST_CLASS = 'agy-context-ring-host';

  const STYLE_OPTIONS = [
    { id: 'bottle', label: '玻璃瓶装水', desc: '双层波浪液面与上升气泡' },
    { id: 'caterpillar', label: '盘圈毛毛虫', desc: '圆珠身体沿圆环爬行生长' },
    { id: 'donut', label: '双层甜甜圈', desc: '外圈占用进度 + 内圈缓存率' },
    { id: 'ring', label: '极简细环', desc: '清爽细圆环 + 呼吸光点' },
    { id: 'capsule', label: '液态胶囊', desc: '横向玻璃胶囊高光液柱' },
  ];

  const PALETTE_OPTIONS = [
    { id: 'auto', label: '自动告警', dots: ['#10b981', '#f59e0b', '#ef4444'] },
    { id: 'ocean', label: '极光冰蓝', dots: ['#0ea5e9', '#38bdf8'] },
    { id: 'emerald', label: '翡翠森林', dots: ['#10b981', '#2dd4bf'] },
    { id: 'sunset', label: '霓虹落日', dots: ['#8b5cf6', '#ec4899'] },
  ];

  const LIMIT_OPTIONS = [
    { value: 256000, label: '256k' },
    { value: 512000, label: '512k' },
    { value: 1000000, label: '1M' },
  ];

  // 标准思考等级排序与 Antigravity 融合色阶（蓝青 -> 主题蓝 -> 靛蓝 -> 星云紫）
  const EFFORT_META = {
    minimal: { rank: 0, short: 'Min', display: 'Minimal', color: '#64748b', gradient: 'linear-gradient(90deg, #94a3b8, #64748b)' },
    low: { rank: 1, short: 'Low', display: 'Low', color: '#0284c7', gradient: 'linear-gradient(90deg, #7dd3fc, #38bdf8)' },
    medium: { rank: 2, short: 'Med', display: 'Medium', color: '#2f75c3', gradient: 'linear-gradient(90deg, #60a5fa, #2f75c3)' },
    high: { rank: 3, short: 'High', display: 'High', color: '#4f46e5', gradient: 'linear-gradient(90deg, #2f75c3, #4f46e5)' },
    xhigh: { rank: 4, short: 'XHigh', display: 'XHigh', color: '#6d5df6', gradient: 'linear-gradient(90deg, #2f75c3, #4f46e5, #7c3aed)' },
    'extra high': { rank: 4, short: 'XHigh', display: 'XHigh', color: '#6d5df6', gradient: 'linear-gradient(90deg, #2f75c3, #4f46e5, #7c3aed)' },
    max: { rank: 5, short: 'Max', display: 'Max', color: '#7c3aed', gradient: 'linear-gradient(90deg, #2f75c3, #6366f1, #7c3aed)' },
    ultra: { rank: 6, short: 'Ultra', display: 'Ultra', color: '#8b5cf6', gradient: 'linear-gradient(90deg, #2f75c3, #6366f1, #9333ea)' },
  };

  // 当前运行态配置与会话统计缓存
  let currentSettings = Object.assign(
    {
      enabled: true,
      styleMode: 'bottle',
      palette: 'auto',
      contextLimit: 512000,
      showPercentText: true,
      animateEffects: true,
      placement: 'right',
    },
    window.__CONTEXT_RING_BOOT_SETTINGS__ || {}
  );

  const usageCache = new Map();
  const pendingRpc = new Map();
  let rpcSeq = 0;
  let uidCounter = 0;

  let activeFooterEl = null;
  let lastOpenedFooterEl = null;
  let popoverPinned = false;
  let hidePopoverTimer = null;
  let lastPopoverFingerprint = '';
  let lastModalSvgSig = '';
  let lastModalTrendSig = '';
  let previewRafId = 0;
  let settingsPreviewPct = null;

  /**
   * 比较两份设置对象是否完全一致（避免同值广播触发冗余重绘）
   */
  function isSameSettings(a, b) {
    if (!a || !b) return false;
    return (
      a.enabled === b.enabled &&
      a.styleMode === b.styleMode &&
      a.palette === b.palette &&
      Number(a.contextLimit) === Number(b.contextLimit) &&
      a.showPercentText === b.showPercentText &&
      a.animateEffects === b.animateEffects &&
      a.placement === b.placement
    );
  }

  /**
   * 接收来自 Node 侧 CDP 宿主的 RPC 响应
   */
  window.__contextRingResolveRpc = function resolveRpc(payload) {
    if (!payload || !pendingRpc.has(payload.id)) return;
    const item = pendingRpc.get(payload.id);
    clearTimeout(item.timer);
    pendingRpc.delete(payload.id);
    item.resolve(payload);
  };

  /**
   * 接收来自右侧 Sidecar 面板或其他窗口广播的设置变更
   */
  window.__contextRingReceiveSettings = function receiveSettings(nextSettings) {
    if (!nextSettings || typeof nextSettings !== 'object') return;
    const merged = Object.assign({}, currentSettings, nextSettings);
    if (isSameSettings(currentSettings, merged)) return;
    currentSettings = merged;
    lastPopoverFingerprint = '';
    syncAllComposerFooters(false);
    if (activeFooterEl) {
      renderPopoverData(activeFooterEl, true);
    }
    if (isSettingsModalOpen()) {
      renderSettingsPageContent();
    }
  };

  /**
   * 通过 CDP Runtime.addBinding 调用本地 Node 宿主方法
   */
  function callHostRpc(method, params) {
    return new Promise((resolve) => {
      if (typeof window.__contextRingHost !== 'function') {
        resolve({ ok: false, error: 'host-binding-unavailable' });
        return;
      }
      const id = ++rpcSeq;
      const timer = setTimeout(() => {
        pendingRpc.delete(id);
        resolve({ ok: false, error: 'rpc-timeout' });
      }, 4500);

      pendingRpc.set(id, { resolve, timer });
      try {
        window.__contextRingHost(JSON.stringify({ id, method, params: params || {} }));
      } catch {
        clearTimeout(timer);
        pendingRpc.delete(id);
        resolve({ ok: false, error: 'rpc-send-failed' });
      }
    });
  }

  /**
   * 统一更新本地设置并异步持久化到 settings.json
   */
  function applySettingPatch(patch) {
    const merged = Object.assign({}, currentSettings, patch);
    if (isSameSettings(currentSettings, merged)) return;
    currentSettings = merged;
    lastPopoverFingerprint = '';
    syncAllComposerFooters(false);
    if (activeFooterEl) {
      renderPopoverData(activeFooterEl, true);
    }
    if (isSettingsModalOpen()) {
      renderSettingsPageContent();
    }
    void callHostRpc('settings.set', { patch });
  }

  /**
   * 检测当前页面是否为深色主题
   */
  function isDarkTheme() {
    const root = document.documentElement;
    const body = document.body;
    if (
      root?.classList.contains('dark') ||
      body?.classList.contains('dark') ||
      body?.classList.contains('theme-dark')
    ) {
      return true;
    }
    if (body?.classList.contains('theme-light')) {
      return false;
    }
    try {
      return getComputedStyle(root).colorScheme === 'dark';
    } catch {
      return true;
    }
  }

  /**
   * 根据占用百分比与所选配色主题计算主色、辅色与告警等级
   */
  function resolveThemeColors(pct) {
    const level = pct >= 85 ? 'danger' : pct >= 60 ? 'warn' : 'ok';

    // 达到 90% 高危阈值时强制使用醒目红橙色提醒，防止爆窗
    if (pct >= 90 || currentSettings.palette === 'auto') {
      if (level === 'danger') {
        return { main: '#ef4444', soft: '#fca5a5', deep: '#dc2626', level };
      }
      if (level === 'warn') {
        return { main: '#f59e0b', soft: '#fcd34d', deep: '#d97706', level };
      }
      return { main: '#10b981', soft: '#6ee7b7', deep: '#059669', level };
    }

    if (currentSettings.palette === 'ocean') {
      return { main: '#0ea5e9', soft: '#7dd3fc', deep: '#0284c7', level };
    }
    if (currentSettings.palette === 'emerald') {
      return { main: '#10b981', soft: '#5eead4', deep: '#0d9488', level };
    }
    if (currentSettings.palette === 'sunset') {
      return { main: '#8b5cf6', soft: '#f472b6', deep: '#db2777', level };
    }

    return { main: '#10b981', soft: '#6ee7b7', deep: '#059669', level };
  }

  /**
   * 格式化紧凑 Token 数字（例如 316867 -> 317k）
   */
  function formatCompactTokens(value) {
    const num = Number(value || 0);
    if (num >= 1000000) {
      const m = (num / 1000000).toFixed(num % 1000000 === 0 ? 0 : 1);
      return (m.endsWith('.0') ? m.slice(0, -2) : m) + 'M';
    }
    if (num >= 1000) {
      const k = (num / 1000).toFixed(num >= 100000 ? 0 : 1);
      return (k.endsWith('.0') ? k.slice(0, -2) : k) + 'k';
    }
    return String(num);
  }

  /**
   * 格式化带千分位的精确数字
   */
  function formatExactNumber(value) {
    return Number(value || 0).toLocaleString();
  }

  /**
   * 注入组件、悬浮卡片（含星云思考滑块）及独立设置页面的全部样式
   */
  function ensureStylesInjected() {
    if (document.getElementById(STYLE_TAG_ID)) return;
    const styleEl = document.createElement('style');
    styleEl.id = STYLE_TAG_ID;
    styleEl.textContent = `
      .${HOST_CLASS} {
        display: inline-flex;
        align-items: center;
        flex-shrink: 0;
        margin: 0 2px;
        position: relative;
        user-select: none;
      }
      .cr-trigger-btn {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        height: 28px;
        padding: 0 7px;
        border-radius: 9999px;
        border: 1px solid transparent;
        background: transparent;
        color: var(--secondary-foreground, #64748b);
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 11.5px;
        font-weight: 600;
        line-height: 1;
        cursor: pointer;
        outline: none;
        transition: background-color 0.16s ease, border-color 0.16s ease, color 0.16s ease;
      }
      .cr-trigger-btn:hover,
      .cr-trigger-btn.is-open {
        background: var(--secondary, rgba(148, 163, 184, 0.14));
        color: var(--foreground, #0f172a);
      }
      .cr-trigger-btn[data-level="warn"] .cr-pct-text { color: #d97706; }
      .dark .cr-trigger-btn[data-level="warn"] .cr-pct-text { color: #fbbf24; }
      .cr-trigger-btn[data-level="danger"] .cr-pct-text { color: #dc2626; }
      .dark .cr-trigger-btn[data-level="danger"] .cr-pct-text { color: #f87171; }
      .cr-graphic-slot {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      }
      .cr-pct-text {
        font-variant-numeric: tabular-nums;
        letter-spacing: -0.02em;
      }
      @container input-footer (max-width: 430px) {
        .cr-pct-text { display: none !important; }
        .cr-trigger-btn { padding: 0 5px; }
      }

      /* 玻璃水瓶波浪与气泡动画 */
      @keyframes cr-wave-shift {
        0% { transform: translateX(0); }
        100% { transform: translateX(-14px); }
      }
      @keyframes cr-bubble-up {
        0% { transform: translateY(0) scale(0.85); opacity: 0; }
        25% { opacity: 0.85; }
        100% { transform: translateY(-7px) scale(1.1); opacity: 0; }
      }
      /* 环形毛毛虫节段呼吸蠕动动画 */
      @keyframes cr-bug-pulse {
        0%, 100% { transform: scale(0.93); }
        50% { transform: scale(1.08); }
      }
      /* 中心呼吸光点 */
      @keyframes cr-core-pulse {
        0%, 100% { opacity: 0.72; transform: scale(0.95); }
        50% { opacity: 1; transform: scale(1.12); }
      }
      /* 星云滑块微星闪烁 */
      @keyframes cr-star-twinkle {
        0%, 100% { opacity: 0.45; transform: scale(0.85); }
        50% { opacity: 1; transform: scale(1.15); }
      }

      .cr-anim-on .cr-wave-front { animation: cr-wave-shift 2.2s linear infinite; }
      .cr-anim-on .cr-wave-back { animation: cr-wave-shift 3.4s linear infinite reverse; }
      .cr-anim-on .cr-bubble-1 { animation: cr-bubble-up 2.4s ease-in infinite; }
      .cr-anim-on .cr-bubble-2 { animation: cr-bubble-up 2.9s ease-in 1.1s infinite; }
      .cr-anim-on .cr-bug-seg {
        transform-box: fill-box;
        transform-origin: center;
        animation: cr-bug-pulse 1.6s ease-in-out infinite;
      }
      .cr-anim-on .cr-ring-core {
        transform-origin: center;
        animation: cr-core-pulse 2.2s ease-in-out infinite;
      }

      /* 悬浮详情卡片（原生 Antigravity 卡片材质 + 统一凹槽与浮块语言） */
      #${POPOVER_ID} {
        position: fixed;
        left: 0;
        top: 0;
        z-index: 99995;
        width: 296px;
        padding: 13px 14px 12px;
        border-radius: 16px;
        background: var(--card, #ffffff);
        color: var(--foreground, #0a0a0c);
        box-shadow: 0 0 0 1px rgba(10, 10, 12, 0.08), 0 12px 28px -4px rgba(10, 10, 12, 0.12), 0 2px 6px rgba(10, 10, 12, 0.04);
        contain: layout style paint;
        font-family: "Google Sans Flex", "Google Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        font-size: 12px;
        opacity: 0;
        pointer-events: none;
        transform: translateY(5px) scale(0.985);
        transition: opacity 0.15s ease, transform 0.15s cubic-bezier(0.16, 1, 0.3, 1);
      }
      #${POPOVER_ID}.is-dark {
        background: var(--card, #181a20);
        color: var(--foreground, #f4f4f5);
        box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.09), 0 16px 36px rgba(0, 0, 0, 0.52), 0 3px 8px rgba(0, 0, 0, 0.28);
      }
      #${POPOVER_ID}.is-open {
        opacity: 1;
        pointer-events: auto;
        transform: translateY(0) scale(1);
      }
      .cr-pop-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 10px;
      }
      .cr-pop-hero {
        display: flex;
        align-items: baseline;
        gap: 7px;
        min-width: 0;
      }
      .cr-pop-pct {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 18px;
        font-weight: 800;
        letter-spacing: -0.03em;
        line-height: 1;
      }
      .cr-pop-cap {
        font-size: 11px;
        color: var(--muted-foreground, #71717a);
        white-space: nowrap;
      }
      .cr-pop-head-right {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        flex-shrink: 0;
      }
      .cr-pop-steps-tag {
        font-size: 10.5px;
        color: var(--muted-foreground, #71717a);
        padding: 2px 6px;
        border-radius: 999px;
        background: var(--muted, rgba(10, 10, 12, 0.04));
      }
      #${POPOVER_ID}.is-dark .cr-pop-steps-tag {
        background: rgba(255, 255, 255, 0.06);
      }
      .cr-open-settings-btn {
        width: 25px;
        height: 25px;
        padding: 0;
        border: none;
        border-radius: 8px;
        background: transparent;
        color: var(--muted-foreground, #71717a);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: color 0.14s ease, background-color 0.14s ease, transform 0.2s ease;
      }
      .cr-open-settings-btn:hover {
        color: var(--foreground, #0a0a0c);
        background: var(--secondary, rgba(10, 10, 12, 0.06));
        transform: rotate(28deg);
      }
      #${POPOVER_ID}.is-dark .cr-open-settings-btn:hover {
        color: #f4f4f5;
        background: rgba(255, 255, 255, 0.09);
      }

      /* 原创微刻度分段胶囊用量槽 */
      .cr-gauge-track {
        position: relative;
        display: flex;
        align-items: stretch;
        gap: 2px;
        height: 10px;
        padding: 2px;
        border-radius: 999px;
        background: var(--muted, rgba(10, 10, 12, 0.045));
        box-shadow: inset 0 1px 2px rgba(10, 10, 12, 0.06);
        margin-bottom: 9px;
        overflow: hidden;
      }
      #${POPOVER_ID}.is-dark .cr-gauge-track {
        background: rgba(255, 255, 255, 0.06);
        box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.35);
      }
      .cr-gauge-mark {
        position: absolute;
        top: 1px;
        bottom: 1px;
        width: 1px;
        background: rgba(10, 10, 12, 0.08);
        pointer-events: none;
      }
      #${POPOVER_ID}.is-dark .cr-gauge-mark {
        background: rgba(255, 255, 255, 0.09);
      }
      .cr-seg-cache,
      .cr-seg-input,
      .cr-seg-output {
        height: 100%;
        border-radius: 999px;
        transition: width 0.28s cubic-bezier(0.22, 1, 0.36, 1);
      }
      .cr-seg-cache { background: #10b981; }
      .cr-seg-input { background: var(--primary, #2f75c3); }
      .cr-seg-output { background: #7c6af6; }

      /* 三列紧凑指标胶囊 */
      .cr-stat-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 6px;
        margin-bottom: 11px;
      }
      .cr-stat-chip {
        padding: 6px 8px;
        border-radius: 10px;
        background: var(--muted, rgba(10, 10, 12, 0.038));
      }
      #${POPOVER_ID}.is-dark .cr-stat-chip {
        background: rgba(255, 255, 255, 0.045);
      }
      .cr-stat-label {
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 10px;
        color: var(--muted-foreground, #71717a);
        margin-bottom: 2px;
      }
      .cr-dot { width: 6px; height: 6px; border-radius: 999px; flex-shrink: 0; }
      .cr-stat-val {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 11.5px;
        font-weight: 700;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      /* 融合式磁吸思考深度滑轨（单行一体化，支持点击与拖拽） */
      .cr-effort-box {
        margin-bottom: 11px;
      }
      .cr-effort-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 6px;
      }
      .cr-effort-caption {
        font-size: 11px;
        font-weight: 600;
        color: var(--muted-foreground, #71717a);
      }
      .cr-effort-model {
        max-width: 165px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 10.5px;
        color: var(--muted-foreground, #71717a);
      }
      .cr-effort-rail {
        position: relative;
        height: 32px;
        padding: 3px;
        border-radius: 11px;
        background: var(--muted, rgba(10, 10, 12, 0.045));
        box-shadow: inset 0 0 0 1px rgba(10, 10, 12, 0.055);
        cursor: pointer;
        touch-action: none;
        overflow: hidden;
      }
      #${POPOVER_ID}.is-dark .cr-effort-rail {
        background: rgba(255, 255, 255, 0.055);
        box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.07);
      }
      .cr-effort-rail.is-single {
        cursor: default;
        opacity: 0.8;
      }
      /* 底部精致能量进度光带 */
      .cr-effort-energy {
        position: absolute;
        left: 3px;
        bottom: 0;
        height: 2.5px;
        border-radius: 999px;
        background: linear-gradient(90deg, #2f75c3, #4f46e5);
        pointer-events: none;
        transition: width 0.2s cubic-bezier(0.22, 1, 0.36, 1), background 0.2s ease;
      }
      /* 磁吸纯白/深灰浮块 */
      .cr-effort-pill {
        position: absolute;
        top: 3px;
        bottom: 3px;
        left: 3px;
        border-radius: 8px;
        background: #ffffff;
        box-shadow: 0 1px 3px rgba(10, 10, 12, 0.1), 0 0 0 1px rgba(10, 10, 12, 0.05);
        pointer-events: none;
        transition: transform 0.18s cubic-bezier(0.22, 1, 0.36, 1), width 0.18s ease;
      }
      #${POPOVER_ID}.is-dark .cr-effort-pill {
        background: #282c37;
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.36), 0 0 0 1px rgba(255, 255, 255, 0.08);
      }
      .cr-effort-rail.is-dragging .cr-effort-pill,
      .cr-effort-rail.is-dragging .cr-effort-energy {
        transition: none;
      }
      .cr-effort-grid {
        position: relative;
        z-index: 1;
        display: grid;
        height: 100%;
      }
      .cr-effort-step {
        border: none;
        background: transparent;
        color: var(--muted-foreground, #71717a);
        font-size: 11px;
        font-weight: 600;
        padding: 0 2px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        cursor: pointer;
        user-select: none;
        transition: color 0.15s ease;
      }
      .cr-effort-step:hover {
        color: var(--foreground, #0a0a0c);
      }
      #${POPOVER_ID}.is-dark .cr-effort-step:hover {
        color: #f4f4f5;
      }
      .cr-effort-step.is-active {
        color: var(--foreground, #0a0a0c);
        font-weight: 700;
      }
      #${POPOVER_ID}.is-dark .cr-effort-step.is-active {
        color: #ffffff;
      }
      .cr-effort-dot {
        width: 5px;
        height: 5px;
        border-radius: 999px;
        opacity: 0.35;
        transition: opacity 0.15s ease, transform 0.15s ease;
      }
      .cr-effort-step.is-active .cr-effort-dot {
        opacity: 1;
        transform: scale(1.15);
      }

      /* 底部统一风格分段栏 */
      .cr-pop-foot {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .cr-limit-group {
        display: inline-flex;
        gap: 2px;
        padding: 2px;
        border-radius: 9px;
        background: var(--muted, rgba(10, 10, 12, 0.045));
        box-shadow: inset 0 0 0 1px rgba(10, 10, 12, 0.045);
      }
      #${POPOVER_ID}.is-dark .cr-limit-group {
        background: rgba(255, 255, 255, 0.055);
        box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06);
      }
      .cr-limit-btn {
        border: none;
        background: transparent;
        color: var(--muted-foreground, #71717a);
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 10.5px;
        font-weight: 600;
        padding: 4px 8px;
        border-radius: 7px;
        cursor: pointer;
        transition: color 0.14s ease, background-color 0.14s ease, box-shadow 0.14s ease;
      }
      .cr-limit-btn:hover {
        color: var(--foreground, #0a0a0c);
      }
      #${POPOVER_ID}.is-dark .cr-limit-btn:hover {
        color: #f4f4f5;
      }
      .cr-limit-btn.is-active {
        background: #ffffff;
        color: var(--foreground, #0a0a0c);
        box-shadow: 0 1px 2px rgba(10, 10, 12, 0.1), 0 0 0 1px rgba(10, 10, 12, 0.04);
      }
      #${POPOVER_ID}.is-dark .cr-limit-btn.is-active {
        background: #282c37;
        color: #ffffff;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.32);
      }
      .cr-compact-btn {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        border: 1px solid rgba(10, 10, 12, 0.1);
        background: transparent;
        color: var(--secondary-foreground, #3f3f46);
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 10.5px;
        font-weight: 600;
        padding: 4px 9px;
        border-radius: 8px;
        cursor: pointer;
        transition: background-color 0.14s ease, color 0.14s ease;
      }
      #${POPOVER_ID}.is-dark .cr-compact-btn {
        border-color: rgba(255, 255, 255, 0.12);
        color: #d4d4d8;
      }
      .cr-compact-btn:hover {
        background: var(--secondary, rgba(10, 10, 12, 0.06));
        color: var(--foreground, #0a0a0c);
      }
      #${POPOVER_ID}.is-dark .cr-compact-btn:hover {
        background: rgba(255, 255, 255, 0.09);
        color: #ffffff;
      }

      /* 独立样式与监控设置页面（无全屏模糊，确保 60fps 流畅切换） */
      #${SETTINGS_MODAL_ID} {
        position: fixed;
        inset: 0;
        z-index: 99998;
        display: none;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background: rgba(15, 23, 42, 0.42);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      }
      #${SETTINGS_MODAL_ID}.is-dark {
        background: rgba(0, 0, 0, 0.56);
      }
      #${SETTINGS_MODAL_ID}:not(.is-open) * {
        animation: none !important;
      }
      #${SETTINGS_MODAL_ID}.is-open {
        display: flex;
      }
      .cr-page-shell {
        width: min(760px, 100%);
        max-height: min(86vh, 720px);
        overflow-y: auto;
        border-radius: 18px;
        border: 1px solid rgba(148, 163, 184, 0.25);
        background: #f8fafc;
        color: #0f172a;
        box-shadow: 0 24px 64px rgba(15, 23, 42, 0.24);
        padding: 20px 22px 22px;
        contain: layout style paint;
      }
      #${SETTINGS_MODAL_ID}.is-dark .cr-page-shell {
        border-color: rgba(148, 163, 184, 0.18);
        background: #121721;
        color: #f1f5f9;
        box-shadow: 0 28px 72px rgba(0, 0, 0, 0.62);
      }
      .cr-page-topbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding-bottom: 14px;
        margin-bottom: 16px;
        border-bottom: 1px solid rgba(148, 163, 184, 0.2);
      }
      .cr-page-title-wrap {
        display: flex;
        align-items: center;
        gap: 9px;
      }
      .cr-page-title {
        font-size: 16px;
        font-weight: 800;
        letter-spacing: -0.02em;
      }
      .cr-page-badge {
        font-size: 11px;
        font-weight: 600;
        padding: 2px 8px;
        border-radius: 999px;
        background: rgba(14, 165, 233, 0.14);
        color: #0284c7;
      }
      #${SETTINGS_MODAL_ID}.is-dark .cr-page-badge {
        background: rgba(56, 189, 248, 0.18);
        color: #7dd3fc;
      }
      .cr-page-close-btn {
        border: 1px solid rgba(148, 163, 184, 0.28);
        background: transparent;
        color: inherit;
        font-size: 12px;
        font-weight: 600;
        padding: 5px 12px;
        border-radius: 9px;
        cursor: pointer;
        transition: background-color 0.15s ease;
      }
      .cr-page-close-btn:hover {
        background: rgba(148, 163, 184, 0.16);
      }
      .cr-page-sec {
        background: #ffffff;
        border: 1px solid rgba(148, 163, 184, 0.2);
        border-radius: 14px;
        padding: 15px 16px;
        margin-bottom: 14px;
      }
      #${SETTINGS_MODAL_ID}.is-dark .cr-page-sec {
        background: #18202c;
        border-color: rgba(148, 163, 184, 0.14);
      }
      .cr-page-sec-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 10px;
        margin-bottom: 12px;
      }
      .cr-page-sec-title {
        font-size: 13.5px;
        font-weight: 700;
      }
      .cr-preview-ctrl {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        font-size: 11.5px;
        opacity: 0.85;
      }
      .cr-preview-ctrl input[type="range"] {
        width: 110px;
        accent-color: #0ea5e9;
        cursor: pointer;
      }
      .cr-shape-grid {
        display: grid;
        grid-template-columns: repeat(5, minmax(0, 1fr));
        gap: 10px;
      }
      @media (max-width: 680px) {
        .cr-shape-grid {
          grid-template-columns: repeat(3, minmax(0, 1fr));
        }
      }
      .cr-shape-card {
        position: relative;
        border: 1.5px solid rgba(148, 163, 184, 0.24);
        background: rgba(248, 250, 252, 0.65);
        color: inherit;
        border-radius: 13px;
        padding: 13px 8px 11px;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 7px;
        cursor: pointer;
        text-align: center;
        transition: border-color 0.16s ease, background-color 0.16s ease, transform 0.14s ease;
      }
      #${SETTINGS_MODAL_ID}.is-dark .cr-shape-card {
        background: rgba(15, 23, 42, 0.45);
        border-color: rgba(148, 163, 184, 0.16);
      }
      .cr-shape-card:hover {
        border-color: #0ea5e9;
        transform: translateY(-1px);
      }
      .cr-shape-card.is-active {
        border-color: #0ea5e9;
        background: rgba(14, 165, 233, 0.1);
        box-shadow: 0 0 0 2px rgba(14, 165, 233, 0.16);
      }
      .cr-shape-preview {
        width: 54px;
        height: 54px;
        display: flex;
        align-items: center;
        justify-content: center;
        contain: layout style paint;
      }
      .cr-shape-name {
        font-size: 12.5px;
        font-weight: 700;
      }
      .cr-shape-desc {
        font-size: 10.5px;
        opacity: 0.68;
        line-height: 1.3;
      }
      .cr-pref-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 10px;
        padding: 9px 0;
        border-top: 1px solid rgba(148, 163, 184, 0.15);
      }
      .cr-pref-row:first-of-type {
        border-top: none;
        padding-top: 2px;
      }
      .cr-pref-label {
        font-size: 12.5px;
        font-weight: 600;
      }
      .cr-pill-row {
        display: inline-flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .cr-page-pill {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        border: 1px solid rgba(148, 163, 184, 0.28);
        background: transparent;
        color: inherit;
        font-size: 11.5px;
        font-weight: 600;
        padding: 5px 11px;
        border-radius: 999px;
        cursor: pointer;
        transition: border-color 0.14s ease, background-color 0.14s ease;
      }
      .cr-page-pill:hover {
        border-color: #0ea5e9;
      }
      .cr-page-pill.is-active {
        border-color: #0ea5e9;
        background: rgba(14, 165, 233, 0.15);
        color: #0284c7;
      }
      #${SETTINGS_MODAL_ID}.is-dark .cr-page-pill.is-active {
        color: #7dd3fc;
      }
      .cr-swatch-dots {
        display: inline-flex;
        gap: 2px;
      }
      .cr-swatch-dot {
        width: 7px;
        height: 7px;
        border-radius: 999px;
      }
      .cr-trend-bars {
        display: flex;
        align-items: flex-end;
        gap: 4px;
        height: 70px;
        padding-top: 6px;
      }
      .cr-trend-col {
        flex: 1;
        min-width: 4px;
        height: 100%;
        display: flex;
        flex-direction: column;
        justify-content: flex-end;
        border-radius: 3px;
        overflow: hidden;
        background: rgba(148, 163, 184, 0.12);
      }
      .cr-trend-in { background: #0ea5e9; }
      .cr-trend-ca { background: #10b981; }
    `;
    document.head.appendChild(styleEl);
  }

  /**
   * 渲染 5 种形态的矢量 SVG（支持传入 size 控制底栏小图标或设置页大号预览）
   */
  function buildShapeSvg(styleMode, pct, cacheHitRate, colors, uid, size = 20) {
    const clamped = Math.max(0, Math.min(100, pct));
    const dark = isDarkTheme();
    const trackStroke = dark ? 'rgba(148, 163, 184, 0.25)' : 'rgba(100, 116, 139, 0.22)';

    // 1. 极简细环（Ring）
    if (styleMode === 'ring') {
      const r = 7;
      const c = 2 * Math.PI * r;
      const offset = c * (1 - clamped / 100);
      return `
        <svg width="${size}" height="${size}" viewBox="0 0 18 18" fill="none" aria-hidden="true">
          <circle cx="9" cy="9" r="${r}" stroke="${trackStroke}" stroke-width="1.9"/>
          <circle cx="9" cy="9" r="${r}" stroke="${colors.main}" stroke-width="2.1"
            stroke-linecap="round" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"
            transform="rotate(-90 9 9)"/>
          <circle class="cr-ring-core" cx="9" cy="9" r="2.0" fill="${colors.main}"/>
        </svg>
      `;
    }

    // 2. 双层甜甜圈（Donut：外层总上下文 + 内层缓存命中率翠绿环）
    if (styleMode === 'donut') {
      const outerR = 6.3;
      const outerC = 2 * Math.PI * outerR;
      const outerOff = outerC * (1 - clamped / 100);
      const innerR = 3.4;
      const innerC = 2 * Math.PI * innerR;
      const cacheClamped = Math.max(0, Math.min(100, Number(cacheHitRate || 0)));
      const innerOff = innerC * (1 - cacheClamped / 100);
      return `
        <svg width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <circle cx="10" cy="10" r="${outerR}" stroke="${trackStroke}" stroke-width="3.5"/>
          <circle cx="10" cy="10" r="${outerR}" stroke="${colors.main}" stroke-width="3.5"
            stroke-linecap="round" stroke-dasharray="${outerC.toFixed(2)}" stroke-dashoffset="${outerOff.toFixed(2)}"
            transform="rotate(-90 10 10)"/>
          <circle cx="10" cy="10" r="${innerR}" stroke="${trackStroke}" stroke-width="1.4" stroke-opacity="0.6"/>
          <circle cx="10" cy="10" r="${innerR}" stroke="#10b981" stroke-width="1.5"
            stroke-linecap="round" stroke-dasharray="${innerC.toFixed(2)}" stroke-dashoffset="${innerOff.toFixed(2)}"
            transform="rotate(-90 10 10)"/>
        </svg>
      `;
    }

    // 3. 盘圈环形毛毛虫（Caterpillar：圆珠身体沿圆周逐节生长 + 触角眨眼虫头沿圆弧爬行）
    if (styleMode === 'caterpillar') {
      const cx = 11;
      const cy = 11;
      const orbitR = 6.9;
      const maxSweep = Math.PI * 2 * 0.9;
      const sweep = (clamped / 100) * maxSweep;
      const headAngle = -Math.PI / 2 + sweep;
      const sepStroke = dark ? '#181d27' : '#ffffff';
      const eyeColor = dark ? '#0f172a' : '#ffffff';

      const trackDots = [];
      const slotCount = 10;
      for (let i = 0; i < slotCount; i++) {
        const offset = (i / slotCount) * Math.PI * 2;
        if (offset > sweep + 0.34 && offset < Math.PI * 2 - 0.22) {
          const a = -Math.PI / 2 + offset;
          const tx = cx + orbitR * Math.cos(a);
          const ty = cy + orbitR * Math.sin(a);
          trackDots.push(`<circle cx="${tx.toFixed(2)}" cy="${ty.toFixed(2)}" r="0.95" fill="${trackStroke}"/>`);
        }
      }

      const bodyNodes = [];
      const usableArc = Math.max(0, sweep - 0.38);
      if (sweep > 0.28) {
        const segStep = 0.5;
        const segCount = Math.max(1, Math.floor(usableArc / segStep) + 1);
        for (let i = 0; i < segCount; i++) {
          const ratio = segCount === 1 ? 0 : i / (segCount - 1);
          const segOffset = segCount === 1 ? 0 : ratio * usableArc;
          const a = -Math.PI / 2 + segOffset;
          const bx = cx + orbitR * Math.cos(a);
          const by = cy + orbitR * Math.sin(a);
          const br = 1.75 + 0.45 * ratio;
          const delay = (i * 0.11).toFixed(2);
          bodyNodes.push(
            `<circle class="cr-bug-seg" style="animation-delay:${delay}s" cx="${bx.toFixed(2)}" cy="${by.toFixed(2)}" r="${br.toFixed(2)}" fill="${colors.main}" stroke="${sepStroke}" stroke-width="0.6"/>`
          );
        }
      }

      const hx = cx + orbitR * Math.cos(headAngle);
      const hy = cy + orbitR * Math.sin(headAngle);
      const headDeg = (headAngle * 180) / Math.PI + 90;

      return `
        <svg width="${size}" height="${size}" viewBox="0 0 22 22" fill="none" aria-hidden="true">
          ${trackDots.join('')}
          ${bodyNodes.join('')}
          <g transform="translate(${hx.toFixed(2)} ${hy.toFixed(2)}) rotate(${headDeg.toFixed(1)})">
            <path d="M 1.3 -1.5 Q 2.9 -3.0 3.8 -2.1" stroke="${colors.main}" stroke-width="1.1" stroke-linecap="round"/>
            <path d="M 1.6 1.1 Q 3.1 2.2 3.8 1.3" stroke="${colors.main}" stroke-width="1.1" stroke-linecap="round"/>
            <circle cx="0" cy="0" r="2.6" fill="${colors.main}" stroke="${sepStroke}" stroke-width="0.55"/>
            <circle cx="0.85" cy="-0.45" r="0.85" fill="${eyeColor}"/>
          </g>
        </svg>
      `;
    }

    // 4. 胶囊液态条（Capsule）
    if (styleMode === 'capsule') {
      const capW = Math.round(size * 1.4);
      const capH = Math.round(size * 0.72);
      const innerWidth = Math.max(clamped > 0 ? 2.5 : 0, (24 * clamped) / 100);
      const clipId = `cr-cap-${uid}`;
      return `
        <svg width="${capW}" height="${capH}" viewBox="0 0 28 14" fill="none" aria-hidden="true">
          <defs>
            <clipPath id="${clipId}">
              <rect x="2" y="2.5" width="24" height="9" rx="4.5"/>
            </clipPath>
          </defs>
          <rect x="1.25" y="1.75" width="25.5" height="10.5" rx="5.25" stroke="${trackStroke}" stroke-width="1.3"/>
          <g clip-path="url(#${clipId})">
            <rect x="2" y="2.5" width="${innerWidth.toFixed(2)}" height="9" rx="4.5" fill="${colors.main}"/>
            <rect x="3" y="3.6" width="${Math.max(0, innerWidth - 2).toFixed(2)}" height="2" rx="1" fill="#ffffff" fill-opacity="0.32"/>
          </g>
        </svg>
      `;
    }

    // 5. 默认经典款：玻璃水瓶装水（Bottle）
    const btlW = Math.round(size * 0.9);
    const clipId = `cr-btl-${uid}`;
    const gradId = `cr-liq-${uid}`;
    const liquidTopY = 17.5 - (11.5 * clamped) / 100;
    const glassStroke = dark ? 'rgba(203, 213, 225, 0.52)' : 'rgba(71, 85, 105, 0.45)';
    const corkColor = dark ? '#d97706' : '#b45309';
    const showBubbles = clamped >= 10;

    return `
      <svg width="${btlW}" height="${size}" viewBox="0 0 18 20" fill="none" aria-hidden="true">
        <defs>
          <clipPath id="${clipId}">
            <rect x="3.1" y="5.8" width="11.8" height="12.0" rx="4.6"/>
          </clipPath>
          <linearGradient id="${gradId}" x1="9" y1="6" x2="9" y2="18" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stop-color="${colors.soft}"/>
            <stop offset="100%" stop-color="${colors.main}"/>
          </linearGradient>
        </defs>
        <rect x="6.7" y="1.0" width="4.6" height="2.1" rx="0.8" fill="${corkColor}"/>
        <path d="M6.2 3.1 H11.8 V5.4 H6.2 Z" stroke="${glassStroke}" stroke-width="1.15" fill="rgba(148,163,184,0.08)"/>
        <g clip-path="url(#${clipId})">
          <rect x="3" y="5.6" width="12" height="12.5" fill="rgba(148, 163, 184, 0.08)"/>
          ${
            clamped > 0.4
              ? `
            <path class="cr-wave-back" d="M -4 ${liquidTopY.toFixed(2)} Q -0.5 ${(liquidTopY - 1.3).toFixed(2)} 3 ${liquidTopY.toFixed(2)} T 10 ${liquidTopY.toFixed(2)} T 17 ${liquidTopY.toFixed(2)} T 24 ${liquidTopY.toFixed(2)} T 31 ${liquidTopY.toFixed(2)} V 20 H -4 Z"
              fill="${colors.soft}" fill-opacity="0.45"/>
            <path class="cr-wave-front" d="M -4 ${(liquidTopY + 0.35).toFixed(2)} Q -0.5 ${(liquidTopY + 1.5).toFixed(2)} 3 ${(liquidTopY + 0.35).toFixed(2)} T 10 ${(liquidTopY + 0.35).toFixed(2)} T 17 ${(liquidTopY + 0.35).toFixed(2)} T 24 ${(liquidTopY + 0.35).toFixed(2)} T 31 ${(liquidTopY + 0.35).toFixed(2)} V 20 H -4 Z"
              fill="url(#${gradId})"/>
          `
              : ''
          }
          ${
            showBubbles
              ? `
            <circle class="cr-bubble-1" cx="7.3" cy="15.8" r="0.9" fill="#ffffff" fill-opacity="0.72"/>
            <circle class="cr-bubble-2" cx="10.9" cy="16.4" r="0.7" fill="#ffffff" fill-opacity="0.65"/>
          `
              : ''
          }
        </g>
        <rect x="2.6" y="5.3" width="12.8" height="13.0" rx="5.0" stroke="${glassStroke}" stroke-width="1.25"/>
        <path d="M5.0 7.6 C4.4 9.2 4.4 13.0 5.0 15.2" stroke="#ffffff" stroke-opacity="${dark ? '0.42' : '0.68'}" stroke-width="1.05" stroke-linecap="round"/>
      </svg>
    `;
  }

  /**
   * 解析模型名称中的系列名与思考等级后缀（例如 "Gemini 4 Neon (XHigh)"）
   */
  function parseModelFamilyAndEffort(label) {
    const raw = String(label || '').trim();
    const match = raw.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
    if (!match) {
      return { family: raw, effortKey: '', meta: null };
    }
    const family = match[1].trim();
    const effortKey = match[2].trim().toLowerCase();
    return { family, effortKey, meta: EFFORT_META[effortKey] || null };
  }

  /**
   * 从当前输入框的模型选择器 React Fiber 读取可用思考等级列表与原生切换回调
   */
  function getThinkingEffortController(footerEl) {
    const card = footerEl?.closest?.('.surface-composer-card');
    const triggerBtn =
      (card && card.querySelector('[data-testid="model-selector-trigger"]')) ||
      document.querySelector('[data-testid="model-selector-trigger"]');
    if (!triggerBtn) return null;

    const fiberKey = Object.keys(triggerBtn).find(
      (key) => key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')
    );
    if (!fiberKey) return null;

    let cursor = triggerBtn[fiberKey];
    let depth = 0;
    while (cursor && depth < 32) {
      const props = cursor.memoizedProps;
      if (props && typeof props.setSelectedModel === 'function' && Array.isArray(props.modelOptions)) {
        const selected = props.selectedModel || null;
        const selectedInfo = parseModelFamilyAndEffort(selected?.label || '');
        if (!selectedInfo.family) return null;

        const levelMap = new Map();
        for (const opt of props.modelOptions) {
          if (!opt || opt.disabled) continue;
          const info = parseModelFamilyAndEffort(opt.label);
          if (info.family === selectedInfo.family && info.meta) {
            if (!levelMap.has(info.meta.rank)) {
              levelMap.set(info.meta.rank, {
                rank: info.meta.rank,
                short: info.meta.short,
                display: info.meta.display,
                color: info.meta.color,
                gradient: info.meta.gradient,
                option: opt,
              });
            }
          }
        }

        const levels = Array.from(levelMap.values()).sort((a, b) => a.rank - b.rank);
        const currentIdx = levels.findIndex(
          (item) =>
            (selected?.value !== undefined && item.option.value === selected.value) ||
            item.option.label === selected?.label
        );

        return {
          family: selectedInfo.family,
          selectedLabel: selected?.label || '',
          levels,
          currentIdx: currentIdx >= 0 ? currentIdx : 0,
          setSelectedModel: props.setSelectedModel,
        };
      }
      cursor = cursor.return;
      depth++;
    }
    return null;
  }

  /**
   * 从输入框节点向上提取当前会话 ID 与模型名称（React Fiber + URL 兜底）
   */
  function extractComposerContext(footerEl) {
    let conversationId = '';
    let modelLabel = '';

    if (footerEl) {
      const fiberKey = Object.keys(footerEl).find(
        (key) => key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')
      );
      if (fiberKey) {
        let cursor = footerEl[fiberKey];
        let depth = 0;
        while (cursor && depth < 36) {
          const props = cursor.memoizedProps;
          if (props && typeof props === 'object') {
            if (!conversationId) {
              if (typeof props.cascadeId === 'string' && props.cascadeId.length >= 8) {
                conversationId = props.cascadeId;
              } else if (typeof props.conversationId === 'string' && props.conversationId.length >= 8) {
                conversationId = props.conversationId;
              }
            }
            if (!modelLabel && props.currentModelConfig && typeof props.currentModelConfig.label === 'string') {
              modelLabel = props.currentModelConfig.label;
            }
          }
          if (conversationId && modelLabel) break;
          cursor = cursor.return;
          depth++;
        }
      }
    }

    if (!conversationId) {
      const pathMatch = String(location.pathname || '').match(/^\/c\/([a-zA-Z0-9_-]{8,128})/);
      if (pathMatch) conversationId = pathMatch[1];
    }

    if (!modelLabel && footerEl) {
      const card = footerEl.closest('.surface-composer-card');
      const modelBtn = card ? card.querySelector('[data-testid="model-selector-trigger"]') : null;
      if (modelBtn && modelBtn.textContent) {
        modelLabel = modelBtn.textContent.trim();
      }
    }

    return { conversationId, modelLabel };
  }

  /**
   * 更新融合式磁吸思考深度滑轨的浮块位置与底部能量光带
   */
  function updateEffortSliderVisual(pop, levels, idx) {
    const level = levels[idx] || levels[0];
    if (!level) return;

    const count = Math.max(1, levels.length);
    const rail = pop.querySelector('[data-role="effort-rail"]');
    const pill = pop.querySelector('[data-role="effort-pill"]');
    const energy = pop.querySelector('[data-role="effort-energy"]');

    const innerWidth = Math.max(40, (rail?.clientWidth || 268) - 6);
    const segWidth = innerWidth / count;

    if (pill) {
      pill.style.width = `${segWidth.toFixed(1)}px`;
      pill.style.transform = `translateX(${(idx * segWidth).toFixed(1)}px)`;
    }
    if (energy) {
      energy.style.width = `${((idx + 1) * segWidth).toFixed(1)}px`;
      energy.style.background = level.gradient;
    }
    for (const stepBtn of pop.querySelectorAll('.cr-effort-step')) {
      stepBtn.classList.toggle('is-active', Number(stepBtn.dataset.idx) === idx);
    }
  }

  /**
   * 渲染悬浮卡片中的融合式思考深度滑轨
   */
  function renderThinkingEffortControl(pop, footerEl) {
    const box = pop.querySelector('[data-role="effort-box"]');
    if (!box) return;

    const controller = getThinkingEffortController(footerEl);
    box._effortController = controller;

    if (!controller || controller.levels.length === 0) {
      box.style.display = 'none';
      return;
    }

    box.style.display = '';
    const isSingle = controller.levels.length < 2;
    const rail = pop.querySelector('[data-role="effort-rail"]');
    rail.classList.toggle('is-single', isSingle);

    const modelEl = pop.querySelector('[data-role="effort-model"]');
    if (modelEl) modelEl.textContent = controller.family;

    const gridEl = pop.querySelector('[data-role="effort-grid"]');
    const sig = controller.levels.map((l) => l.short).join('|');
    if (gridEl.dataset.sig !== sig) {
      gridEl.dataset.sig = sig;
      gridEl.style.gridTemplateColumns = `repeat(${controller.levels.length}, minmax(0, 1fr))`;
      gridEl.innerHTML = controller.levels
        .map(
          (item, idx) =>
            `<button type="button" class="cr-effort-step" data-idx="${idx}"><span class="cr-effort-dot" style="background:${item.color}"></span><span>${item.short}</span></button>`
        )
        .join('');
    }

    updateEffortSliderVisual(pop, controller.levels, controller.currentIdx);
  }

  /**
   * 执行原生思考等级切换并刷新卡片显示
   */
  function commitThinkingEffortIndex(pop, targetIdx) {
    const box = pop.querySelector('[data-role="effort-box"]');
    const controller = box?._effortController;
    if (!controller || !controller.levels[targetIdx]) return;

    const picked = controller.levels[targetIdx];
    updateEffortSliderVisual(pop, controller.levels, targetIdx);

    if (targetIdx === controller.currentIdx) return;
    try {
      controller.setSelectedModel(picked.option);
      controller.currentIdx = targetIdx;
      lastPopoverFingerprint = '';
      setTimeout(() => {
        if (activeFooterEl) renderPopoverData(activeFooterEl, true);
      }, 90);
    } catch {
      // 忽略模型切换异常
    }
  }

  /**
   * 创建或获取全局唯一的悬浮详情卡片（原生 Antigravity 精密仪表卡风格）
   */
  function getOrCreatePopover() {
    let pop = document.getElementById(POPOVER_ID);
    if (pop) return pop;

    pop = document.createElement('div');
    pop.id = POPOVER_ID;
    pop.className = 'no-focus-agent-input';
    pop.innerHTML = `
      <div class="cr-pop-head">
        <div class="cr-pop-hero">
          <span class="cr-pop-pct" data-role="pct">0.0%</span>
          <span class="cr-pop-cap" data-role="summary">0 / 512k</span>
        </div>
        <div class="cr-pop-head-right">
          <span class="cr-pop-steps-tag" data-role="val-steps">0 轮 · 0 步</span>
          <button type="button" class="cr-open-settings-btn" data-role="open-settings-btn" title="打开样式与监控设置页面" aria-label="打开 Context Ring 设置">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3.2"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.08a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.08a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.08a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
          </button>
        </div>
      </div>

      <div class="cr-gauge-track">
        <div class="cr-seg-cache" data-role="seg-cache" style="width:0%"></div>
        <div class="cr-seg-input" data-role="seg-input" style="width:0%"></div>
        <div class="cr-seg-output" data-role="seg-output" style="width:0%"></div>
        <span class="cr-gauge-mark" style="left:60%"></span>
        <span class="cr-gauge-mark" style="left:85%"></span>
      </div>

      <div class="cr-stat-grid">
        <div class="cr-stat-chip" data-role="chip-cache">
          <div class="cr-stat-label"><span class="cr-dot" style="background:#10b981"></span><span>缓存命中</span></div>
          <div class="cr-stat-val" data-role="val-cache">0%</div>
        </div>
        <div class="cr-stat-chip" data-role="chip-input">
          <div class="cr-stat-label"><span class="cr-dot" style="background:var(--primary, #2f75c3)"></span><span>新增输入</span></div>
          <div class="cr-stat-val" data-role="val-input">0</div>
        </div>
        <div class="cr-stat-chip" data-role="chip-output">
          <div class="cr-stat-label"><span class="cr-dot" style="background:#7c6af6"></span><span>累计输出</span></div>
          <div class="cr-stat-val" data-role="val-output">0</div>
        </div>
      </div>

      <div class="cr-effort-box" data-role="effort-box">
        <div class="cr-effort-head">
          <span class="cr-effort-caption">思考深度</span>
          <span class="cr-effort-model" data-role="effort-model">Model</span>
        </div>
        <div class="cr-effort-rail" data-role="effort-rail">
          <div class="cr-effort-energy" data-role="effort-energy"></div>
          <div class="cr-effort-pill" data-role="effort-pill"></div>
          <div class="cr-effort-grid" data-role="effort-grid"></div>
        </div>
      </div>

      <div class="cr-pop-foot">
        <div class="cr-limit-group" data-role="limit-group">
          ${LIMIT_OPTIONS.map((opt) => `<button type="button" class="cr-limit-btn" data-limit="${opt.value}">${opt.label}</button>`).join('')}
        </div>
        <button type="button" class="cr-compact-btn" data-role="compact-btn" title="复制 /compact 命令压缩上下文">/compact</button>
      </div>
    `;

    pop.addEventListener('mouseenter', () => {
      if (hidePopoverTimer) {
        clearTimeout(hidePopoverTimer);
        hidePopoverTimer = null;
      }
    });

    pop.addEventListener('mouseleave', () => {
      if (!popoverPinned) {
        schedulePopoverHide();
      }
    });

    // 右上角设置按钮：关闭小卡片并打开专属样式设置页面
    pop.querySelector('[data-role="open-settings-btn"]').addEventListener('click', (e) => {
      e.stopPropagation();
      lastOpenedFooterEl = activeFooterEl || lastOpenedFooterEl;
      closePopoverNow();
      openSettingsPage();
    });

    // 融合式磁吸思考深度滑轨：同时支持点击任意档位与水平滑动拖拽
    const effortRail = pop.querySelector('[data-role="effort-rail"]');
    let draggingEffort = false;
    let dragPickedIdx = 0;

    function calcIdxFromClientX(clientX) {
      const box = pop.querySelector('[data-role="effort-box"]');
      const ctrl = box?._effortController;
      if (!ctrl || ctrl.levels.length < 2) return 0;
      const rect = effortRail.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(0.9999, (clientX - rect.left) / Math.max(1, rect.width)));
      return Math.min(ctrl.levels.length - 1, Math.floor(ratio * ctrl.levels.length));
    }

    effortRail.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      const box = pop.querySelector('[data-role="effort-box"]');
      const ctrl = box?._effortController;
      if (!ctrl || ctrl.levels.length < 2) return;
      draggingEffort = true;
      popoverPinned = true;
      effortRail.classList.add('is-dragging');
      effortRail.setPointerCapture?.(e.pointerId);
      dragPickedIdx = calcIdxFromClientX(e.clientX);
      updateEffortSliderVisual(pop, ctrl.levels, dragPickedIdx);
    });

    effortRail.addEventListener('pointermove', (e) => {
      if (!draggingEffort) return;
      const box = pop.querySelector('[data-role="effort-box"]');
      const ctrl = box?._effortController;
      if (!ctrl || ctrl.levels.length < 2) return;
      dragPickedIdx = calcIdxFromClientX(e.clientX);
      updateEffortSliderVisual(pop, ctrl.levels, dragPickedIdx);
    });

    function finishEffortDrag(e) {
      if (!draggingEffort) return;
      draggingEffort = false;
      effortRail.classList.remove('is-dragging');
      try {
        effortRail.releasePointerCapture?.(e.pointerId);
      } catch {}
      commitThinkingEffortIndex(pop, dragPickedIdx);
    }

    effortRail.addEventListener('pointerup', finishEffortDrag);
    effortRail.addEventListener('pointercancel', finishEffortDrag);

    // 切换 256k / 512k / 1M 上限并同步持久化
    pop.querySelector('[data-role="limit-group"]').addEventListener('click', (e) => {
      e.stopPropagation();
      const btn = e.target.closest('.cr-limit-btn');
      if (!btn) return;
      const nextLimit = Number(btn.getAttribute('data-limit'));
      if (!nextLimit) return;
      applySettingPatch({ contextLimit: nextLimit });
    });

    // 复制 /compact 指令
    pop.querySelector('[data-role="compact-btn"]').addEventListener('click', (e) => {
      e.stopPropagation();
      const btn = e.currentTarget;
      navigator.clipboard?.writeText('/compact').catch(() => {});
      btn.textContent = '✓ 已复制';
      setTimeout(() => {
        btn.textContent = '/compact';
      }, 1300);
    });

    document.body.appendChild(pop);
    return pop;
  }

  /**
   * 填充并定位悬浮详情卡片
   */
  function renderPopoverData(footerEl, forceRender) {
    const pop = getOrCreatePopover();
    pop.classList.toggle('is-dark', isDarkTheme());

    const { conversationId, modelLabel } = extractComposerContext(footerEl);
    const cacheKey = conversationId || '__empty__';
    const data = usageCache.get(cacheKey) || {
      totalTokens: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      cumulativeOutputTokens: 0,
      cacheHitRate: 0,
      turnCount: 0,
      plannerStepCount: 0,
      modelName: modelLabel || 'Model',
    };

    const limit = Number(currentSettings.contextLimit || 512000);
    const total = Number(data.totalTokens || 0);
    const cacheRead = Number(data.cacheReadTokens || 0);
    const freshInput = Number(data.inputTokens || 0);
    const outTokens = Number(data.outputTokens || 0);
    const cumOut = Number(data.cumulativeOutputTokens || 0);
    const hitRate = Number(data.cacheHitRate || 0);
    const pct = limit > 0 ? (total / limit) * 100 : 0;
    const colors = resolveThemeColors(pct);

    const fingerprint = [
      total,
      cacheRead,
      freshInput,
      outTokens,
      cumOut,
      limit,
      currentSettings.palette,
      modelLabel || data.modelName,
      isDarkTheme() ? 1 : 0,
    ].join('|');

    if (forceRender || fingerprint !== lastPopoverFingerprint) {
      lastPopoverFingerprint = fingerprint;

      const pctEl = pop.querySelector('[data-role="pct"]');
      pctEl.textContent = `${pct.toFixed(1)}%`;
      pctEl.style.color = colors.main;

      pop.querySelector('[data-role="summary"]').textContent =
        `${formatCompactTokens(total)} / ${formatCompactTokens(limit)}`;

      const denom = Math.max(limit, total, 1);
      const cachePct = Math.min(100, (cacheRead / denom) * 100);
      const inputPct = Math.min(100, (freshInput / denom) * 100);
      const outPct = Math.min(100, (outTokens / denom) * 100);

      const segCache = pop.querySelector('[data-role="seg-cache"]');
      const segInput = pop.querySelector('[data-role="seg-input"]');
      const segOut = pop.querySelector('[data-role="seg-output"]');
      segCache.style.width = `${cachePct.toFixed(2)}%`;
      segCache.style.display = cachePct > 0.1 ? '' : 'none';
      segInput.style.width = `${inputPct.toFixed(2)}%`;
      segInput.style.display = inputPct > 0.1 ? '' : 'none';
      segOut.style.width = `${outPct.toFixed(2)}%`;
      segOut.style.display = outPct > 0.1 ? '' : 'none';

      pop.querySelector('[data-role="val-cache"]').textContent = `${hitRate.toFixed(1)}%`;
      pop.querySelector('[data-role="chip-cache"]').title = `缓存命中: ${formatExactNumber(cacheRead)} tokens (${hitRate.toFixed(1)}%)`;

      pop.querySelector('[data-role="val-input"]').textContent = formatCompactTokens(freshInput);
      pop.querySelector('[data-role="chip-input"]').title = `本轮新增输入: ${formatExactNumber(freshInput)} tokens`;

      pop.querySelector('[data-role="val-output"]').textContent = formatCompactTokens(cumOut || outTokens);
      pop.querySelector('[data-role="chip-output"]').title = `本轮输出 ${formatExactNumber(outTokens)} / 累计输出 ${formatExactNumber(cumOut)}`;

      pop.querySelector('[data-role="val-steps"]').textContent = `${Number(data.turnCount || 0)} 轮 · ${Number(data.plannerStepCount || 0)} 步`;

      for (const btn of pop.querySelectorAll('.cr-limit-btn')) {
        btn.classList.toggle('is-active', Number(btn.getAttribute('data-limit')) === limit);
      }

      renderThinkingEffortControl(pop, footerEl);
    }

    // 紧贴触发按钮上方居中对齐，并做视口边界防溢出裁剪
    const hostEl = footerEl?.querySelector(`.${HOST_CLASS}`);
    if (hostEl) {
      const rect = hostEl.getBoundingClientRect();
      const popWidth = 292;
      const popHeight = pop.offsetHeight || 274;
      let left = rect.left + rect.width / 2 - popWidth / 2;
      left = Math.max(10, Math.min(window.innerWidth - popWidth - 10, left));
      let top = rect.top - popHeight - 8;
      if (top < 10) {
        top = rect.bottom + 8;
      }
      pop.style.left = `${Math.round(left)}px`;
      pop.style.top = `${Math.round(top)}px`;
    }
  }

  /**
   * 检查独立样式设置页面当前是否处于打开状态
   */
  function isSettingsModalOpen() {
    const modal = document.getElementById(SETTINGS_MODAL_ID);
    return Boolean(modal && modal.classList.contains('is-open'));
  }

  /**
   * 创建或获取独立样式与监控设置页面视图
   */
  function getOrCreateSettingsModal() {
    let modal = document.getElementById(SETTINGS_MODAL_ID);
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = SETTINGS_MODAL_ID;
    modal.className = 'no-focus-agent-input';
    modal.innerHTML = `
      <div class="cr-page-shell" role="dialog" aria-modal="true" aria-label="Context Ring 样式与监控设置">
        <div class="cr-page-topbar">
          <div class="cr-page-title-wrap">
            <span class="cr-page-title">Context Ring 样式与设置</span>
            <span class="cr-page-badge">v${WIDGET_VERSION}</span>
          </div>
          <button type="button" class="cr-page-close-btn" data-role="close-settings-btn">← 返回会话</button>
        </div>

        <div class="cr-page-sec">
          <div class="cr-page-sec-head">
            <span class="cr-page-sec-title">选择外观形状（点击即时同步到输入框）</span>
            <div class="cr-preview-ctrl">
              <span data-role="preview-pct-label">实时水位</span>
              <input type="range" min="0" max="100" step="1" data-role="preview-range" />
              <button type="button" class="cr-page-pill" data-role="preview-reset-btn" style="padding:2px 8px;font-size:10.5px;">实时</button>
            </div>
          </div>
          <div class="cr-shape-grid" data-role="shape-grid">
            ${STYLE_OPTIONS.map(
              (opt) => `
              <button type="button" class="cr-shape-card" data-style="${opt.id}">
                <div class="cr-shape-preview" data-preview-style="${opt.id}"></div>
                <div class="cr-shape-name">${opt.label}</div>
                <div class="cr-shape-desc">${opt.desc}</div>
              </button>`
            ).join('')}
          </div>
        </div>

        <div class="cr-page-sec">
          <div class="cr-page-sec-head" style="margin-bottom:6px;">
            <span class="cr-page-sec-title">配色与显示偏好</span>
          </div>

          <div class="cr-pref-row">
            <span class="cr-pref-label">配色方案</span>
            <div class="cr-pill-row" data-role="palette-row">
              ${PALETTE_OPTIONS.map(
                (p) => `
                <button type="button" class="cr-page-pill" data-palette="${p.id}">
                  <span class="cr-swatch-dots">${p.dots.map((d) => `<span class="cr-swatch-dot" style="background:${d}"></span>`).join('')}</span>
                  <span>${p.label}</span>
                </button>`
              ).join('')}
            </div>
          </div>

          <div class="cr-pref-row">
            <span class="cr-pref-label">上下文窗口上限</span>
            <div class="cr-pill-row" data-role="modal-limit-row">
              ${LIMIT_OPTIONS.map((opt) => `<button type="button" class="cr-page-pill" data-limit="${opt.value}">${opt.label}</button>`).join('')}
            </div>
          </div>

          <div class="cr-pref-row">
            <span class="cr-pref-label">挂载位置与动效</span>
            <div class="cr-pill-row">
              <button type="button" class="cr-page-pill" data-role="modal-toggle-pct">显示百分比</button>
              <button type="button" class="cr-page-pill" data-role="modal-toggle-anim">动态效果</button>
              <button type="button" class="cr-page-pill" data-role="modal-toggle-place">输入框靠右</button>
            </div>
          </div>
        </div>

        <div class="cr-page-sec" style="margin-bottom:0;">
          <div class="cr-page-sec-head" style="margin-bottom:6px;">
            <span class="cr-page-sec-title">当前会话近 30 步上下文趋势（绿=缓存 / 蓝=新增输入）</span>
            <span style="font-size:11.5px;opacity:0.7;" data-role="modal-session-meta">--</span>
          </div>
          <div class="cr-trend-bars" data-role="modal-trend-bars"></div>
        </div>
      </div>
    `;

    // 点击遮罩或返回按钮关闭设置页
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        closeSettingsPage();
      }
    });
    modal.querySelector('[data-role="close-settings-btn"]').addEventListener('click', () => {
      closeSettingsPage();
    });

    // 选择 5 种形状
    modal.querySelector('[data-role="shape-grid"]').addEventListener('click', (e) => {
      const card = e.target.closest('.cr-shape-card');
      if (!card) return;
      const nextStyle = card.getAttribute('data-style');
      if (nextStyle) applySettingPatch({ styleMode: nextStyle });
    });

    // 预览水位滑块（经 rAF 合帧限频，避免拖动高频重建 SVG）
    modal.querySelector('[data-role="preview-range"]').addEventListener('input', (e) => {
      settingsPreviewPct = Number(e.target.value);
      if (previewRafId) return;
      previewRafId = requestAnimationFrame(() => {
        previewRafId = 0;
        renderSettingsPageContent();
      });
    });
    modal.querySelector('[data-role="preview-reset-btn"]').addEventListener('click', () => {
      settingsPreviewPct = null;
      renderSettingsPageContent();
    });

    // 配色切换
    modal.querySelector('[data-role="palette-row"]').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-palette]');
      if (btn) applySettingPatch({ palette: btn.getAttribute('data-palette') });
    });

    // 上限切换
    modal.querySelector('[data-role="modal-limit-row"]').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-limit]');
      if (btn) applySettingPatch({ contextLimit: Number(btn.getAttribute('data-limit')) });
    });

    // 显示开关与位置切换
    modal.querySelector('[data-role="modal-toggle-pct"]').addEventListener('click', () => {
      applySettingPatch({ showPercentText: !currentSettings.showPercentText });
    });
    modal.querySelector('[data-role="modal-toggle-anim"]').addEventListener('click', () => {
      applySettingPatch({ animateEffects: !currentSettings.animateEffects });
    });
    modal.querySelector('[data-role="modal-toggle-place"]').addEventListener('click', () => {
      applySettingPatch({ placement: currentSettings.placement === 'left' ? 'right' : 'left' });
    });

    document.body.appendChild(modal);
    return modal;
  }

  /**
   * 渲染独立样式设置页面内的 5 种动态大号形状卡片与趋势图
   */
  function renderSettingsPageContent() {
    const modal = getOrCreateSettingsModal();
    modal.classList.toggle('is-dark', isDarkTheme());

    const footerRef = lastOpenedFooterEl || document.body.getElementsByClassName('agy-composer-footer')[0] || null;
    const { conversationId } = extractComposerContext(footerRef);
    const data = usageCache.get(conversationId || '__empty__') || Array.from(usageCache.values())[0] || {};
    const limit = Number(currentSettings.contextLimit || 512000);
    const realPct = limit > 0 ? Math.min(100, (Number(data.totalTokens || 0) / limit) * 100) : 0;
    const previewPct = settingsPreviewPct === null ? realPct : settingsPreviewPct;
    const hitRate = Number(data.cacheHitRate || 88);
    const colors = resolveThemeColors(previewPct);

    const rangeEl = modal.querySelector('[data-role="preview-range"]');
    rangeEl.value = String(Math.round(previewPct));
    modal.querySelector('[data-role="preview-pct-label"]').textContent =
      settingsPreviewPct === null ? `实时 ${realPct.toFixed(1)}%` : `预览 ${Math.round(previewPct)}%`;

    const grid = modal.querySelector('[data-role="shape-grid"]');
    grid.classList.toggle('cr-anim-on', Boolean(currentSettings.animateEffects));

    // 仅切换高亮状态 class，不销毁卡片 DOM；仅在水位/配色/深浅模式变化时增量更新 SVG
    for (const card of grid.querySelectorAll('.cr-shape-card')) {
      card.classList.toggle('is-active', card.getAttribute('data-style') === currentSettings.styleMode);
    }

    const svgSig = [
      Math.round(previewPct),
      Math.round(hitRate),
      currentSettings.palette,
      isDarkTheme() ? 1 : 0,
    ].join('|');

    if (svgSig !== lastModalSvgSig) {
      lastModalSvgSig = svgSig;
      for (const opt of STYLE_OPTIONS) {
        const slot = grid.querySelector(`[data-preview-style="${opt.id}"]`);
        if (slot) {
          slot.innerHTML = buildShapeSvg(opt.id, previewPct, hitRate, colors, `modal-${opt.id}`, 44);
        }
      }
    }

    for (const btn of modal.querySelectorAll('[data-palette]')) {
      btn.classList.toggle('is-active', btn.getAttribute('data-palette') === currentSettings.palette);
    }
    for (const btn of modal.querySelectorAll('[data-role="modal-limit-row"] [data-limit]')) {
      btn.classList.toggle('is-active', Number(btn.getAttribute('data-limit')) === limit);
    }

    const pctBtn = modal.querySelector('[data-role="modal-toggle-pct"]');
    pctBtn.classList.toggle('is-active', Boolean(currentSettings.showPercentText));
    pctBtn.textContent = currentSettings.showPercentText ? '显示百分比：开' : '显示百分比：关';

    const animBtn = modal.querySelector('[data-role="modal-toggle-anim"]');
    animBtn.classList.toggle('is-active', Boolean(currentSettings.animateEffects));
    animBtn.textContent = currentSettings.animateEffects ? '动态效果：开' : '动态效果：关';

    const placeBtn = modal.querySelector('[data-role="modal-toggle-place"]');
    placeBtn.classList.toggle('is-active', true);
    placeBtn.textContent = currentSettings.placement === 'left' ? '位置：输入框靠左' : '位置：输入框靠右';

    modal.querySelector('[data-role="modal-session-meta"]').textContent =
      `${formatCompactTokens(data.totalTokens || 0)} / ${formatCompactTokens(limit)} · 缓存命中 ${(data.cacheHitRate || 0).toFixed(1)}%`;

    const hist = Array.isArray(data.history) ? data.history : [];
    const lastHist = hist.length ? hist[hist.length - 1] : null;
    const trendSig = `${limit}|${hist.length}|${lastHist?.step || 0}|${lastHist?.totalTokens || 0}`;
    if (trendSig !== lastModalTrendSig) {
      lastModalTrendSig = trendSig;
      const maxStep = Math.max(limit * 0.25, ...hist.map((x) => Number(x.totalTokens || 0)), 1);
      modal.querySelector('[data-role="modal-trend-bars"]').innerHTML = hist.length
        ? hist
            .map((step) => {
              const caH = Math.max(2, Math.round(((step.cacheReadTokens || 0) / maxStep) * 62));
              const inH = Math.max(1, Math.round(((step.inputTokens || 0) / maxStep) * 62));
              return `<div class="cr-trend-col" title="步 #${step.step}: ${formatCompactTokens(step.totalTokens)}"><div class="cr-trend-in" style="height:${inH}px"></div><div class="cr-trend-ca" style="height:${caH}px"></div></div>`;
            })
            .join('')
        : '<div style="opacity:0.6;font-size:12px;margin:auto;">暂无历史步数记录</div>';
    }
  }

  /**
   * 打开独立样式与监控设置页面
   */
  function openSettingsPage() {
    settingsPreviewPct = null;
    const modal = getOrCreateSettingsModal();
    renderSettingsPageContent();
    modal.classList.add('is-open');
  }

  /**
   * 关闭独立样式与监控设置页面
   */
  function closeSettingsPage() {
    const modal = document.getElementById(SETTINGS_MODAL_ID);
    if (modal) modal.classList.remove('is-open');
  }

  /**
   * 展开指定输入框对应的详情卡片
   */
  function openPopover(footerEl, pinOpen) {
    if (hidePopoverTimer) {
      clearTimeout(hidePopoverTimer);
      hidePopoverTimer = null;
    }
    activeFooterEl = footerEl;
    lastOpenedFooterEl = footerEl;
    if (pinOpen) popoverPinned = true;

    const pop = getOrCreatePopover();
    renderPopoverData(footerEl, true);
    pop.classList.add('is-open');

    const btn = footerEl?.querySelector('.cr-trigger-btn');
    if (btn) btn.classList.add('is-open');
  }

  /**
   * 立即关闭悬浮详情卡片
   */
  function closePopoverNow() {
    if (hidePopoverTimer) {
      clearTimeout(hidePopoverTimer);
      hidePopoverTimer = null;
    }
    popoverPinned = false;
    const pop = document.getElementById(POPOVER_ID);
    if (pop) pop.classList.remove('is-open');
    for (const btn of document.getElementsByClassName('cr-trigger-btn')) {
      btn.classList.remove('is-open');
    }
    activeFooterEl = null;
  }

  /**
   * 鼠标移出后延迟收起卡片，方便光标平滑移入卡片内部操作按钮
   */
  function schedulePopoverHide() {
    if (hidePopoverTimer) clearTimeout(hidePopoverTimer);
    hidePopoverTimer = setTimeout(() => {
      if (!popoverPinned) closePopoverNow();
    }, 180);
  }

  /**
   * 在单个 .agy-composer-footer 内挂载或更新监控按钮
   */
  function mountOrUpdateFooter(footerEl, usageData) {
    let hostEl = footerEl.querySelector(`.${HOST_CLASS}`);

    if (!currentSettings.enabled) {
      if (hostEl) hostEl.remove();
      return false;
    }

    if (!hostEl) {
      hostEl = document.createElement('div');
      hostEl.className = `${HOST_CLASS} no-focus-agent-input`;
      hostEl.dataset.uid = String(++uidCounter);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cr-trigger-btn';
      btn.setAttribute('data-testid', 'context-ring-trigger');
      btn.setAttribute('aria-label', 'Context Ring 上下文占用');
      btn.innerHTML = `<span class="cr-graphic-slot"></span><span class="cr-pct-text">0%</span>`;
      hostEl.appendChild(btn);

      btn.addEventListener('mouseenter', () => {
        openPopover(footerEl, false);
      });
      btn.addEventListener('mouseleave', () => {
        if (!popoverPinned) schedulePopoverHide();
      });
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const pop = document.getElementById(POPOVER_ID);
        if (pop?.classList.contains('is-open') && popoverPinned && activeFooterEl === footerEl) {
          closePopoverNow();
        } else {
          openPopover(footerEl, true);
        }
      });
    }

    const children = footerEl.children;
    const targetContainer =
      currentSettings.placement === 'left' && children[0]
        ? children[0]
        : children[children.length - 1] || footerEl;

    if (hostEl.parentElement !== targetContainer) {
      if (currentSettings.placement === 'left') {
        targetContainer.appendChild(hostEl);
      } else {
        targetContainer.insertBefore(hostEl, targetContainer.firstChild || null);
      }
    }

    const limit = Number(currentSettings.contextLimit || 512000);
    const total = Number(usageData?.totalTokens || 0);
    const hitRate = Number(usageData?.cacheHitRate || 0);
    const pct = limit > 0 ? (total / limit) * 100 : 0;
    const colors = resolveThemeColors(pct);

    const btn = hostEl.querySelector('.cr-trigger-btn');
    btn.dataset.level = colors.level;
    btn.classList.toggle('cr-anim-on', Boolean(currentSettings.animateEffects));

    const uid = hostEl.dataset.uid || '1';
    const renderSig = [
      currentSettings.styleMode,
      currentSettings.palette,
      currentSettings.showPercentText ? 1 : 0,
      currentSettings.animateEffects ? 1 : 0,
      pct.toFixed(1),
      hitRate.toFixed(0),
      isDarkTheme() ? 1 : 0,
    ].join('|');

    if (hostEl.dataset.renderSig !== renderSig) {
      hostEl.dataset.renderSig = renderSig;
      const slot = btn.querySelector('.cr-graphic-slot');
      const pctText = btn.querySelector('.cr-pct-text');
      slot.innerHTML = buildShapeSvg(currentSettings.styleMode, pct, hitRate, colors, uid, 20);
      pctText.textContent = pct >= 10 ? `${Math.round(pct)}%` : `${pct.toFixed(1)}%`;
      pctText.style.display = currentSettings.showPercentText ? '' : 'none';
    }

    return true;
  }

  /**
   * 扫描页面上全部输入框底栏并刷新上下文统计（使用 getElementsByClassName 规避其他插件对 querySelectorAll 的劫持）
   */
  async function syncAllComposerFooters(fetchRemote = true) {
    if (!document.body) return;
    ensureStylesInjected();

    const footers = Array.from(document.body.getElementsByClassName('agy-composer-footer'));
    let mountedCount = 0;
    let detectedCid = '';

    for (const footerEl of footers) {
      const { conversationId } = extractComposerContext(footerEl);
      if (conversationId && !detectedCid) {
        detectedCid = conversationId;
      }
      const cacheKey = conversationId || '__empty__';

      if (fetchRemote && currentSettings.enabled) {
        const resp = await callHostRpc('usage.get', { conversationId });
        if (resp && resp.ok && resp.usage) {
          usageCache.set(cacheKey, resp.usage);
          if (resp.settings) {
            currentSettings = Object.assign({}, currentSettings, resp.settings);
          }
        } else if (!usageCache.has(cacheKey) && window.__CONTEXT_RING_SEED_USAGE__) {
          const seed = window.__CONTEXT_RING_SEED_USAGE__;
          if (!conversationId || !seed.conversationId || seed.conversationId === conversationId) {
            usageCache.set(cacheKey, seed);
          }
        }
      }

      const cachedUsage = usageCache.get(cacheKey) || null;
      if (mountOrUpdateFooter(footerEl, cachedUsage)) {
        mountedCount++;
      }
    }

    if (!detectedCid) {
      const match = String(location.pathname || '').match(/^\/c\/([a-zA-Z0-9_-]{8,128})/);
      if (match) detectedCid = match[1];
    }

    window.__CONTEXT_RING_MOUNTED_COUNT__ = mountedCount;
    window.__CONTEXT_RING_ACTIVE_CID__ = detectedCid;

    if (activeFooterEl && document.body.contains(activeFooterEl)) {
      renderPopoverData(activeFooterEl, false);
    }
    if (isSettingsModalOpen() && settingsPreviewPct === null) {
      renderSettingsPageContent();
    }
  }

  // 点击外部空白处关闭已固定的详情卡片
  function onDocumentPointerDown(e) {
    const pop = document.getElementById(POPOVER_ID);
    if (!pop || !pop.classList.contains('is-open')) return;
    if (pop.contains(e.target) || e.target.closest(`.${HOST_CLASS}`)) return;
    closePopoverNow();
  }

  // 按 Esc 快速退出设置页或悬浮卡片
  function onDocumentKeyDown(e) {
    if (e.key !== 'Escape') return;
    if (isSettingsModalOpen()) {
      closeSettingsPage();
      return;
    }
    if (activeFooterEl) {
      closePopoverNow();
    }
  }

  document.addEventListener('pointerdown', onDocumentPointerDown);
  document.addEventListener('keydown', onDocumentKeyDown);

  let domSyncTimer = null;
  const domObserver = new MutationObserver((records) => {
    // 忽略本插件自身弹窗、卡片和按钮内部的 DOM 变动，避免连锁触发全页扫描
    const hasExternalMutation = records.some((rec) => {
      const target = rec.target;
      if (!target || target.nodeType !== 1) return false;
      if (
        target.closest?.(`#${SETTINGS_MODAL_ID}`) ||
        target.closest?.(`#${POPOVER_ID}`) ||
        target.closest?.(`.${HOST_CLASS}`)
      ) {
        return false;
      }
      return true;
    });
    if (!hasExternalMutation || domSyncTimer) return;
    domSyncTimer = setTimeout(() => {
      domSyncTimer = null;
      void syncAllComposerFooters(false);
    }, 180);
  });

  if (document.body) {
    domObserver.observe(document.body, { childList: true, subtree: true });
  }

  const pollInterval = setInterval(() => {
    void syncAllComposerFooters(true);
  }, 2600);

  void syncAllComposerFooters(true);

  /**
   * 完整清理函数（供热更新或插件卸载时无痕剥离所有 DOM 与事件）
   */
  window.__CONTEXT_RING_CLEANUP__ = function cleanupContextRing() {
    clearInterval(pollInterval);
    if (domSyncTimer) clearTimeout(domSyncTimer);
    if (hidePopoverTimer) clearTimeout(hidePopoverTimer);
    if (previewRafId) cancelAnimationFrame(previewRafId);
    domObserver.disconnect();
    document.removeEventListener('pointerdown', onDocumentPointerDown);
    document.removeEventListener('keydown', onDocumentKeyDown);

    for (const item of pendingRpc.values()) {
      clearTimeout(item.timer);
    }
    pendingRpc.clear();

    document.getElementById(SETTINGS_MODAL_ID)?.remove();
    document.getElementById(POPOVER_ID)?.remove();
    document.getElementById(STYLE_TAG_ID)?.remove();
    if (document.body) {
      for (const el of Array.from(document.body.getElementsByClassName(HOST_CLASS))) {
        el.remove();
      }
    }

    window.__CONTEXT_RING_INSTALLED__ = false;
    window.__CONTEXT_RING_MOUNTED_COUNT__ = 0;
  };
})();

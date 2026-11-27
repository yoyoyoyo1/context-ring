/**
 * Context Ring — 无侵入多形态输入框上下文监控组件
 *
 * 特点：
 * 1. 零 DOM 原型污染（不修改 document.querySelectorAll），与其他插件安全共存；
 * 2. 通过 CDP Runtime.addBinding ('__contextRingHost') 零端口获取实时会话数据与同步设置；
 * 3. 悬浮卡片内置「思考等级星云滑块」，真实联动 Antigravity 当前模型的 Low/Medium/High/XHigh 思考等级；
 * 4. 悬浮卡片右上角提供「设置」按钮，点击打开双页签设置与用量看板，自由定制 3 种精选形态、按模型上限、压缩后防失忆 Hook，并查看历史用量热力图与预估 API 费用。
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
  const QUOTA_TIP_ID = 'agy-context-ring-quota-tip';
  const SETTINGS_MODAL_ID = 'agy-context-ring-settings-modal';
  const HOST_CLASS = 'agy-context-ring-host';
  const QUOTA_HOST_CLASS = 'agy-context-ring-quota-host';

  const STYLE_OPTIONS = [
    { id: 'bottle', label: '玻璃瓶装水', desc: '双层波浪液面与上升气泡' },
    { id: 'caterpillar', label: '盘圈毛毛虫', desc: '圆珠身体沿圆环爬行生长' },
    { id: 'ring', label: '极简细环', desc: '清爽细圆环 + 呼吸光点' },
  ];

  const LIMIT_OPTIONS = [
    { value: 0, label: '自动' },
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

  function normalizeModelKey(rawModelName) {
    return String(rawModelName || '')
      .trim()
      .replace(/\s*\((?:minimal|min|low|medium|med|high|xhigh|extra\s*high|max|ultra|thinking|adaptive|preview)\)\s*$/i, '')
      .replace(/[-_\s]+(?:minimal|low|medium|high|xhigh|extra[-_\s]?high|max|ultra)$/i, '')
      .trim()
      .toLowerCase()
      .replace(/[.]+/g, '-')
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80);
  }

  function normalizeWidgetStyle(rawStyle) {
    return ['bottle', 'caterpillar', 'ring'].includes(rawStyle) ? rawStyle : 'bottle';
  }

  // 当前运行态配置与会话统计缓存
  let currentSettings = Object.assign(
    {
      enabled: true,
      styleMode: 'bottle',
      palette: 'auto',
      contextLimit: 0,
      modelContextLimits: {},
      showPercentText: true,
      animateEffects: true,
      placement: 'right',
    },
    window.__CONTEXT_RING_BOOT_SETTINGS__ || {}
  );
  currentSettings.styleMode = normalizeWidgetStyle(currentSettings.styleMode);
  if (!currentSettings.modelContextLimits || typeof currentSettings.modelContextLimits !== 'object') {
    currentSettings.modelContextLimits = {};
  }

  let rehydrateStatus = {
    enabled: false,
    registered: false,
    externalConflict: false,
    externalHookName: '',
    error: '',
  };
  let activeSettingsTab = 'appearance';
  let historyPeriod = '30d';
  let historyReport = null;
  let historyLoading = false;
  const clientModelCatalogLimits = new Map();
  let clientCatalogFetchedAt = 0;
  let clientCatalogPromise = null;

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
   * 计算当前模型实际生效的上下文上限（优先级：按模型自定义 > 全局手动 > 宿主真实探测 > 模型目录 > 512k）
   */
  function resolveEffectiveLimitForUi(usageData, fallbackModelLabel = '') {
    const modelName = String(fallbackModelLabel || usageData?.modelName || '').trim();
    const modelKey = normalizeModelKey(modelName);
    const customMap = currentSettings.modelContextLimits || {};
    if (modelKey && Number(customMap[modelKey]) > 0) {
      return { limit: Number(customMap[modelKey]), source: '自定', auto: false, modelKey, modelName };
    }
    if (Number(currentSettings.contextLimit || 0) > 0) {
      return { limit: Number(currentSettings.contextLimit), source: '全局', auto: false, modelKey, modelName };
    }
    const detected = Number(usageData?.detectedContextLimit || 0);
    if (detected >= 16000) {
      return { limit: detected, source: '自动', auto: true, modelKey, modelName, detected };
    }
    const catalog =
      Number(usageData?.catalogContextLimit || 0) ||
      (modelKey ? Number(clientModelCatalogLimits.get(modelKey) || 0) : 0) ||
      (modelName ? Number(clientModelCatalogLimits.get(modelName.toLowerCase()) || 0) : 0);
    if (catalog >= 16000) {
      return { limit: catalog, source: '自动', auto: true, modelKey, modelName, detected: catalog };
    }
    return { limit: 512000, source: '自动', auto: true, modelKey, modelName, detected: 0 };
  }

  /**
   * 比较两份设置对象是否完全一致（避免同值广播触发冗余重绘）
   */
  function isSameSettings(a, b) {
    if (!a || !b) return false;
    return (
      a.enabled === b.enabled &&
      normalizeWidgetStyle(a.styleMode) === normalizeWidgetStyle(b.styleMode) &&
      a.palette === b.palette &&
      Number(a.contextLimit) === Number(b.contextLimit) &&
      JSON.stringify(a.modelContextLimits || {}) === JSON.stringify(b.modelContextLimits || {}) &&
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
    const merged = Object.assign({}, currentSettings, nextSettings, {
      styleMode: normalizeWidgetStyle(nextSettings.styleMode ?? currentSettings.styleMode),
      modelContextLimits:
        nextSettings.modelContextLimits && typeof nextSettings.modelContextLimits === 'object'
          ? Object.assign({}, nextSettings.modelContextLimits)
          : Object.assign({}, currentSettings.modelContextLimits || {}),
    });
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
   * 接收来自宿主的压缩后防失忆 Hook 状态广播
   */
  window.__contextRingReceiveRehydrate = function receiveRehydrate(nextStatus) {
    if (!nextStatus || typeof nextStatus !== 'object') return;
    rehydrateStatus = Object.assign({}, rehydrateStatus, nextStatus);
    lastPopoverFingerprint = '';
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
      }, 6500);

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
   * 统一更新本地设置并异步持久化到 settings.json（支持按模型上限增量乐观更新）
   */
  function applySettingPatch(patch) {
    const nextLimits = Object.assign({}, currentSettings.modelContextLimits || {});
    if (patch.modelContextLimits && typeof patch.modelContextLimits === 'object') {
      Object.keys(nextLimits).forEach((k) => delete nextLimits[k]);
      Object.assign(nextLimits, patch.modelContextLimits);
    }
    if (patch.setModelContextLimit && typeof patch.setModelContextLimit === 'object') {
      const targetKey = normalizeModelKey(
        patch.setModelContextLimit.modelKey || patch.setModelContextLimit.modelName || ''
      );
      const targetLim = Number(patch.setModelContextLimit.limit);
      if (targetKey) {
        if (!targetLim || targetLim <= 0) delete nextLimits[targetKey];
        else nextLimits[targetKey] = Math.round(targetLim);
      }
    }
    const merged = Object.assign({}, currentSettings, patch, {
      styleMode: normalizeWidgetStyle(patch.styleMode ?? currentSettings.styleMode),
      modelContextLimits: nextLimits,
    });
    delete merged.setModelContextLimit;
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
   * 统一采用绿 / 琥珀 / 红三级自动语义告警配色（<60% 绿，60%-85% 琥珀，>=85% 红）
   */
  function resolveThemeColors(pct) {
    if (pct >= 85) {
      return { main: '#ef4444', soft: '#fca5a5', deep: '#dc2626', level: 'danger' };
    }
    if (pct >= 60) {
      return { main: '#f59e0b', soft: '#fcd34d', deep: '#d97706', level: 'warn' };
    }
    return { main: '#10b981', soft: '#6ee7b7', deep: '#059669', level: 'ok' };
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
      .${QUOTA_HOST_CLASS} {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        height: 24px;
        padding: 0 5px;
        margin-left: 2px;
        border-radius: 9999px;
        flex-shrink: 0;
        cursor: pointer;
        user-select: none;
        transition: background-color 0.16s ease, opacity 0.16s ease;
      }
      .${QUOTA_HOST_CLASS}:empty {
        display: none;
      }
      .${QUOTA_HOST_CLASS}:hover {
        background: var(--secondary, rgba(148, 163, 184, 0.14));
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
        width: 306px;
        padding: 13px 14px 12px;
        border-radius: 16px;
        background: var(--card, #ffffff);
        color: var(--foreground, #0a0a0c);
        box-shadow: 0 0 0 1px rgba(10, 10, 12, 0.08), 0 12px 28px -4px rgba(10, 10, 12, 0.12), 0 2px 6px rgba(10, 10, 12, 0.04);
        contain: layout style;
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

      /* 紧凑单行生成速度体检条（有数据时自动显现） */
      .cr-speed-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        padding: 5px 8px;
        margin-bottom: 10px;
        border-radius: 9px;
        background: var(--muted, rgba(10, 10, 12, 0.036));
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 10.5px;
        line-height: 1.25;
      }
      #${POPOVER_ID}.is-dark .cr-speed-bar {
        background: rgba(255, 255, 255, 0.045);
      }
      .cr-speed-bar.is-hidden {
        display: none;
      }
      .cr-speed-left {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        font-weight: 700;
        color: var(--foreground, #0a0a0c);
        white-space: nowrap;
      }
      #${POPOVER_ID}.is-dark .cr-speed-left {
        color: #f4f4f5;
      }
      .cr-speed-grade {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 15px;
        height: 15px;
        padding: 0 4px;
        border-radius: 5px;
        font-size: 9.5px;
        font-weight: 800;
        color: #ffffff;
        background: #10b981;
      }
      .cr-speed-grade.is-S { background: #059669; }
      .cr-speed-grade.is-A { background: #0ea5e9; }
      .cr-speed-grade.is-B { background: #6366f1; }
      .cr-speed-grade.is-C { background: #f59e0b; }
      .cr-speed-grade.is-D { background: #ef4444; }
      .cr-speed-meta {
        color: var(--muted-foreground, #71717a);
        font-size: 10px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #${POPOVER_ID}.is-dark .cr-speed-meta {
        color: #a1a1aa;
      }
      .cr-rehydrate-dot {
        display: none;
        width: 6px;
        height: 6px;
        border-radius: 999px;
        background: #10b981;
        box-shadow: 0 0 0 2px rgba(16, 185, 129, 0.25);
        flex-shrink: 0;
      }
      .cr-rehydrate-dot.is-on {
        display: inline-block;
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
        flex-shrink: 0;
      }
      /* 右侧按系列去重的紧凑模型切换器（左侧带周额度与 5h 额度双圆环） */
      .cr-model-picker {
        position: relative;
        max-width: 210px;
        min-width: 0;
      }
      .cr-effort-model-btn {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        max-width: 100%;
        padding: 2px 6px 2px 6px;
        border: 1px solid transparent;
        border-radius: 7px;
        background: transparent;
        color: var(--muted-foreground, #71717a);
        font-family: inherit;
        font-size: 10.5px;
        font-weight: 500;
        line-height: 1.35;
        cursor: pointer;
        transition: color 0.14s ease, background-color 0.14s ease, border-color 0.14s ease;
      }
      .cr-effort-model-btn:hover,
      .cr-effort-model-btn.is-open {
        color: var(--foreground, #0a0a0c);
        background: var(--secondary, rgba(10, 10, 12, 0.055));
        border-color: rgba(10, 10, 12, 0.08);
      }
      #${POPOVER_ID}.is-dark .cr-effort-model-btn:hover,
      #${POPOVER_ID}.is-dark .cr-effort-model-btn.is-open {
        color: #f4f4f5;
        background: rgba(255, 255, 255, 0.08);
        border-color: rgba(255, 255, 255, 0.11);
      }
      .cr-effort-model-btn.is-static {
        cursor: default;
        padding-right: 4px;
      }
      .cr-effort-model-btn.is-static:hover {
        color: var(--muted-foreground, #71717a);
        background: transparent;
        border-color: transparent;
      }
      .cr-effort-model-btn.is-static .cr-model-caret {
        display: none;
      }
      .cr-model-btn-label {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .cr-model-caret {
        width: 10px;
        height: 10px;
        flex-shrink: 0;
        opacity: 0.72;
        transition: transform 0.16s ease, opacity 0.14s ease;
      }
      .cr-effort-model-btn.is-open .cr-model-caret {
        transform: rotate(180deg);
        opacity: 1;
      }
      .cr-quota-pair {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        flex-shrink: 0;
      }
      .cr-quota-pair:empty {
        display: none;
      }
      .cr-quota-ring-svg {
        display: block;
        flex-shrink: 0;
      }
      /* 悬停秒出迷你额度气泡（独立挂于顶层避免被下拉菜单滚动容器裁切） */
      #${QUOTA_TIP_ID} {
        position: fixed;
        z-index: 2147483647;
        pointer-events: none;
        padding: 6px 9px;
        border-radius: 10px;
        background: var(--card, #ffffff);
        color: var(--foreground, #0a0a0c);
        box-shadow: 0 0 0 1px rgba(10, 10, 12, 0.09), 0 10px 24px -4px rgba(10, 10, 12, 0.16), 0 2px 6px rgba(10, 10, 12, 0.05);
        font-family: "Google Sans Flex", "Google Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        font-size: 10.5px;
        line-height: 1.35;
        display: flex;
        flex-direction: column;
        gap: 3px;
        opacity: 0;
        transform: translateY(3px) scale(0.98);
        transition: opacity 0.1s ease, transform 0.12s cubic-bezier(0.16, 1, 0.3, 1);
      }
      #${QUOTA_TIP_ID}.is-dark {
        background: var(--card, #1d2028);
        color: #f4f4f5;
        box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.12), 0 14px 30px rgba(0, 0, 0, 0.56);
      }
      #${QUOTA_TIP_ID}.is-open {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
      .cr-qtip-row {
        display: flex;
        align-items: center;
        gap: 6px;
        white-space: nowrap;
      }
      .cr-qtip-dot {
        width: 6px;
        height: 6px;
        border-radius: 999px;
        flex-shrink: 0;
      }
      .cr-qtip-name {
        color: var(--muted-foreground, #71717a);
        font-weight: 500;
        min-width: 34px;
      }
      #${QUOTA_TIP_ID}.is-dark .cr-qtip-name {
        color: #a1a1aa;
      }
      .cr-qtip-pct {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        min-width: 28px;
      }
      .cr-qtip-reset {
        color: var(--muted-foreground, #71717a);
        font-size: 10px;
      }
      #${QUOTA_TIP_ID}.is-dark .cr-qtip-reset {
        color: #a1a1aa;
      }
      /* 模型系列下拉浮层（默认向上展开避免触碰窗口底边） */
      .cr-model-menu {
        position: absolute;
        right: 0;
        bottom: calc(100% + 6px);
        z-index: 30;
        width: 256px;
        max-height: 256px;
        overflow-y: auto;
        padding: 4px;
        border-radius: 12px;
        background: var(--card, #ffffff);
        color: var(--foreground, #0a0a0c);
        box-shadow: 0 0 0 1px rgba(10, 10, 12, 0.09), 0 12px 26px -4px rgba(10, 10, 12, 0.16), 0 2px 6px rgba(10, 10, 12, 0.06);
        opacity: 0;
        pointer-events: none;
        transform: translateY(4px) scale(0.985);
        transition: opacity 0.12s ease, transform 0.14s cubic-bezier(0.16, 1, 0.3, 1);
        scrollbar-width: thin;
      }
      .cr-model-menu.is-down {
        top: calc(100% + 6px);
        bottom: auto;
        transform: translateY(-4px) scale(0.985);
      }
      .cr-model-menu.is-open {
        opacity: 1;
        pointer-events: auto;
        transform: translateY(0) scale(1);
      }
      #${POPOVER_ID}.is-dark .cr-model-menu {
        background: var(--card, #1d2028);
        color: #f4f4f5;
        box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.11), 0 16px 34px rgba(0, 0, 0, 0.56);
      }
      .cr-model-menu::-webkit-scrollbar {
        width: 5px;
      }
      .cr-model-menu::-webkit-scrollbar-thumb {
        border-radius: 999px;
        background: rgba(113, 113, 122, 0.28);
      }
      .cr-model-option {
        width: 100%;
        border: none;
        border-radius: 8px;
        background: transparent;
        color: inherit;
        font-family: inherit;
        font-size: 11.5px;
        font-weight: 500;
        padding: 6px 8px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        text-align: left;
        cursor: pointer;
        transition: background-color 0.12s ease, color 0.12s ease;
      }
      .cr-model-option:hover {
        background: var(--muted, rgba(10, 10, 12, 0.055));
      }
      #${POPOVER_ID}.is-dark .cr-model-option:hover {
        background: rgba(255, 255, 255, 0.08);
      }
      .cr-model-option.is-active {
        background: rgba(47, 117, 195, 0.11);
        color: var(--primary, #2f75c3);
        font-weight: 650;
      }
      #${POPOVER_ID}.is-dark .cr-model-option.is-active {
        background: rgba(96, 165, 250, 0.16);
        color: #93c5fd;
      }
      .cr-model-menu-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 3px 8px 4px;
        margin-bottom: 2px;
        border-bottom: 1px solid rgba(113, 113, 122, 0.12);
        font-size: 9.5px;
        font-weight: 600;
        color: var(--muted-foreground, #71717a);
        opacity: 0.85;
        user-select: none;
      }
      #${POPOVER_ID}.is-dark .cr-model-menu-head {
        border-bottom-color: rgba(255, 255, 255, 0.08);
      }
      .cr-model-option-left {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
        flex: 1;
      }
      .cr-model-option-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        min-width: 0;
      }
      .cr-model-option-right {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        flex-shrink: 0;
      }
      .cr-model-option-meta {
        font-size: 10px;
        font-weight: 500;
        color: var(--muted-foreground, #71717a);
        opacity: 0.85;
      }
      .cr-model-option.is-active .cr-model-option-meta {
        color: inherit;
        opacity: 0.8;
      }
      .cr-model-option-check {
        width: 12px;
        height: 12px;
        opacity: 0;
        flex-shrink: 0;
      }
      .cr-model-option.is-active .cr-model-option-check {
        opacity: 1;
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
        padding: 4px 6.5px;
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
        border: 1px solid rgba(47, 117, 195, 0.24);
        background: rgba(47, 117, 195, 0.08);
        color: #1d5ca3;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 10.5px;
        font-weight: 600;
        padding: 4px 9px;
        border-radius: 8px;
        cursor: pointer;
        transition: background-color 0.14s ease, border-color 0.14s ease, color 0.14s ease;
      }
      #${POPOVER_ID}.is-dark .cr-compact-btn {
        border-color: rgba(96, 165, 250, 0.28);
        background: rgba(96, 165, 250, 0.12);
        color: #93c5fd;
      }
      .cr-compact-btn:hover:not(:disabled) {
        background: rgba(47, 117, 195, 0.15);
        border-color: rgba(47, 117, 195, 0.38);
        color: #164984;
      }
      #${POPOVER_ID}.is-dark .cr-compact-btn:hover:not(:disabled) {
        background: rgba(96, 165, 250, 0.2);
        border-color: rgba(96, 165, 250, 0.44);
        color: #dbeafe;
      }
      .cr-compact-btn:disabled {
        opacity: 0.65;
        cursor: wait;
      }
      .cr-compact-btn.is-done {
        border-color: rgba(16, 185, 129, 0.34);
        background: rgba(16, 185, 129, 0.12);
        color: #059669;
      }
      #${POPOVER_ID}.is-dark .cr-compact-btn.is-done {
        border-color: rgba(52, 211, 153, 0.38);
        background: rgba(16, 185, 129, 0.18);
        color: #6ee7b7;
      }
      .cr-compact-btn.is-warn {
        border-color: rgba(217, 119, 6, 0.34);
        background: rgba(217, 119, 6, 0.12);
        color: #b45309;
      }
      #${POPOVER_ID}.is-dark .cr-compact-btn.is-warn {
        border-color: rgba(251, 191, 36, 0.36);
        background: rgba(217, 119, 6, 0.18);
        color: #fcd34d;
      }
      .cr-compact-btn svg {
        width: 11px;
        height: 11px;
        flex-shrink: 0;
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
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 12px;
      }
      .cr-page-tabs {
        display: inline-flex;
        gap: 4px;
        padding: 3px;
        border-radius: 10px;
        background: rgba(148, 163, 184, 0.14);
      }
      #${SETTINGS_MODAL_ID}.is-dark .cr-page-tabs {
        background: rgba(255, 255, 255, 0.06);
      }
      .cr-page-tab {
        border: none;
        background: transparent;
        color: inherit;
        opacity: 0.72;
        font-size: 12px;
        font-weight: 700;
        padding: 5px 12px;
        border-radius: 8px;
        cursor: pointer;
        transition: background-color 0.15s ease, opacity 0.15s ease;
      }
      .cr-page-tab:hover { opacity: 0.95; }
      .cr-page-tab.is-active {
        opacity: 1;
        background: #ffffff;
        color: #0f172a;
        box-shadow: 0 1px 3px rgba(15, 23, 42, 0.12);
      }
      #${SETTINGS_MODAL_ID}.is-dark .cr-page-tab.is-active {
        background: #243042;
        color: #f8fafc;
      }
      .cr-tab-pane { display: none; }
      .cr-tab-pane.is-active { display: block; }
      .cr-custom-limits {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 6px;
      }
      .cr-custom-limits:empty { display: none; }
      .cr-limit-tag {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        font-size: 11px;
        padding: 3px 9px;
        border-radius: 999px;
        border: 1px solid rgba(148, 163, 184, 0.28);
        background: rgba(148, 163, 184, 0.08);
      }
      .cr-limit-tag button {
        border: none;
        background: transparent;
        color: inherit;
        opacity: 0.7;
        cursor: pointer;
        font-weight: 700;
        padding: 0 2px;
      }
      .cr-rehydrate-desc {
        font-size: 11.5px;
        opacity: 0.75;
        line-height: 1.45;
        margin-top: 4px;
      }
      .cr-rehydrate-alert {
        margin-top: 7px;
        padding: 6px 10px;
        border-radius: 8px;
        background: rgba(245, 158, 11, 0.13);
        color: #b45309;
        font-size: 11.5px;
      }
      #${SETTINGS_MODAL_ID}.is-dark .cr-rehydrate-alert {
        color: #fcd34d;
      }
      .cr-page-pill.is-ok {
        border-color: rgba(16, 185, 129, 0.45);
        background: rgba(16, 185, 129, 0.14);
        color: #059669;
      }
      #${SETTINGS_MODAL_ID}.is-dark .cr-page-pill.is-ok {
        color: #6ee7b7;
      }
      .cr-hist-kpi-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 10px;
      }
      @media (max-width: 680px) {
        .cr-hist-kpi-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      }
      .cr-hist-kpi {
        padding: 10px 12px;
        border-radius: 11px;
        border: 1px solid rgba(148, 163, 184, 0.2);
        background: rgba(148, 163, 184, 0.05);
      }
      .cr-hist-kpi-label {
        font-size: 11px;
        opacity: 0.7;
      }
      .cr-hist-kpi-val {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 16px;
        font-weight: 800;
        margin-top: 3px;
      }
      .cr-hist-kpi-sub {
        font-size: 10.5px;
        opacity: 0.65;
        margin-top: 2px;
      }
      .cr-hm-grid {
        display: grid;
        grid-template-columns: repeat(12, minmax(0, 1fr));
        gap: 5px;
      }
      .cr-hm-week {
        display: grid;
        grid-template-rows: repeat(7, 1fr);
        gap: 5px;
      }
      .cr-hm-cell {
        width: 100%;
        aspect-ratio: 1 / 1;
        border-radius: 3px;
        background: rgba(148, 163, 184, 0.16);
      }
      .cr-hm-cell.l1 { background: #bbf7d0; }
      .cr-hm-cell.l2 { background: #4ade80; }
      .cr-hm-cell.l3 { background: #16a34a; }
      .cr-hm-cell.l4 { background: #15803d; }
      #${SETTINGS_MODAL_ID}.is-dark .cr-hm-cell { background: rgba(148, 163, 184, 0.12); }
      #${SETTINGS_MODAL_ID}.is-dark .cr-hm-cell.l1 { background: #14532d; }
      #${SETTINGS_MODAL_ID}.is-dark .cr-hm-cell.l2 { background: #166534; }
      #${SETTINGS_MODAL_ID}.is-dark .cr-hm-cell.l3 { background: #22c55e; }
      #${SETTINGS_MODAL_ID}.is-dark .cr-hm-cell.l4 { background: #4ade80; }
      .cr-hm-foot {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-top: 8px;
        font-size: 11px;
        opacity: 0.72;
      }
      .cr-hist-models {
        display: flex;
        flex-direction: column;
        gap: 9px;
      }
      .cr-hist-model-row {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .cr-hist-model-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        font-size: 12px;
      }
      .cr-hist-model-name { font-weight: 700; }
      .cr-hist-model-val {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 11px;
        opacity: 0.74;
      }
      .cr-hist-model-bar {
        height: 5px;
        border-radius: 999px;
        background: rgba(148, 163, 184, 0.18);
        overflow: hidden;
      }
      .cr-hist-model-fill {
        height: 100%;
        border-radius: 999px;
        background: linear-gradient(90deg, #0ea5e9, #10b981);
      }
      .cr-hist-disclaimer {
        margin-top: 9px;
        font-size: 11px;
        opacity: 0.65;
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
   * 渲染 3 种精选形态的矢量 SVG（玻璃水瓶装水 / 盘圈毛毛虫 / 极简细环）
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
          ${
            clamped > 0
              ? `<circle cx="9" cy="9" r="${r}" stroke="${colors.main}" stroke-width="2.1"
            stroke-linecap="round" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"
            transform="rotate(-90 9 9)"/>`
              : ''
          }
          <circle class="cr-ring-core" cx="9" cy="9" r="2.0" fill="${colors.main}"/>
        </svg>
      `;
    }

    // 2. 盘圈环形毛毛虫（Caterpillar：圆珠身体沿圆周逐节生长 + 触角眨眼虫头沿圆弧爬行）
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

    // 3. 默认经典款：玻璃水瓶装水（Bottle）
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
   * 对插入 HTML 的纯文本做安全转义，避免特殊模型名称破坏 DOM 结构
   */
  function escapeHtml(text) {
    return String(text ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // 原生 LanguageServer 配额查询缓存（直接复用页面内已认证 RPC 客户端，零子进程开销）
  const QUOTA_CACHE_TTL_MS = 25000;
  let cachedLsClient = null;
  let quotaGroupsCache = [];
  let quotaFetchedAt = 0;
  let quotaFetchPromise = null;
  let quotaCacheVersion = 0;

  /**
   * 在对象及其浅层属性中递归检索包含 retrieveUserQuotaSummary 方法的客户端实例
   */
  function inspectObjectForQuotaClient(obj, depth) {
    if (!obj || (typeof obj !== 'object' && typeof obj !== 'function') || depth > 2) {
      return null;
    }
    if (obj === window || obj === document || obj.nodeType) {
      return null;
    }
    if (typeof obj.retrieveUserQuotaSummary === 'function') {
      return obj;
    }
    const proto = Object.getPrototypeOf(obj);
    if (proto && typeof proto.retrieveUserQuotaSummary === 'function') {
      return obj;
    }
    for (const key of Object.keys(obj)) {
      let val;
      try {
        val = obj[key];
      } catch {
        continue;
      }
      if (!val || (typeof val !== 'object' && typeof val !== 'function')) continue;
      if (typeof val.retrieveUserQuotaSummary === 'function') {
        return val;
      }
      if (depth < 2) {
        const nested = inspectObjectForQuotaClient(val, depth + 1);
        if (nested) return nested;
      }
    }
    return null;
  }

  /**
   * 从输入框模型选择器 React Fiber 树向上定位并缓存原生 LanguageServer 客户端
   */
  function getLanguageServerClient(footerEl) {
    if (cachedLsClient && typeof cachedLsClient.retrieveUserQuotaSummary === 'function') {
      return cachedLsClient;
    }

    const card = footerEl?.closest?.('.surface-composer-card');
    const anchor =
      (card && card.querySelector('[data-testid="model-selector-trigger"]')) ||
      document.querySelector('[data-testid="model-selector-trigger"]') ||
      footerEl;
    if (!anchor) return null;

    const fiberKey = Object.keys(anchor).find(
      (key) => key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')
    );
    if (!fiberKey) return null;

    let cursor = anchor[fiberKey];
    let steps = 0;
    while (cursor && steps < 60) {
      steps++;
      let found = inspectObjectForQuotaClient(cursor.memoizedProps, 0);
      if (!found && cursor.dependencies?.firstContext) {
        let ctx = cursor.dependencies.firstContext;
        let ctxSteps = 0;
        while (ctx && ctxSteps < 30 && !found) {
          found = inspectObjectForQuotaClient(ctx.memoizedValue, 0);
          ctx = ctx.next;
          ctxSteps++;
        }
      }
      if (found) {
        cachedLsClient = found;
        return found;
      }
      cursor = cursor.return;
    }
    return null;
  }

  /**
   * 兼容解析 Protobuf Timestamp 对象与 ISO 字符串为毫秒时间戳
   */
  function parseQuotaResetTimeMs(resetTime) {
    if (!resetTime) return NaN;
    if (typeof resetTime === 'string') return Date.parse(resetTime);
    if (typeof resetTime === 'number') return resetTime;
    if (typeof resetTime === 'object' && resetTime.seconds !== undefined) {
      const sec = Number(resetTime.seconds);
      const nanos = Number(resetTime.nanos || 0);
      if (Number.isFinite(sec) && sec > 0) {
        return sec * 1000 + Math.floor(nanos / 1e6);
      }
    }
    return NaN;
  }

  /**
   * 格式化配额重置剩余倒计时文案
   */
  function formatQuotaResetCountdown(resetMs) {
    if (!Number.isFinite(resetMs)) return '';
    const diffMs = resetMs - Date.now();
    if (diffMs <= 0) return '即将重置';
    const totalMin = Math.ceil(diffMs / 60000);
    const days = Math.floor(totalMin / (24 * 60));
    const hours = Math.floor((totalMin % (24 * 60)) / 60);
    const mins = totalMin % 60;
    if (days > 0) {
      return hours > 0 ? `${days}天${hours}小时后重置` : `${days}天后重置`;
    }
    if (hours > 0) {
      return mins > 0 ? `${hours}小时${mins}分后重置` : `${hours}小时后重置`;
    }
    return `${Math.max(1, mins)}分钟后重置`;
  }

  /**
   * 解析单个 QuotaSummaryBucket（兼容 Protobuf oneof remaining 与扁平 remainingFraction）
   */
  function parseQuotaSummaryBucket(bucket) {
    if (!bucket || typeof bucket !== 'object') return null;
    const hint = `${bucket.bucketId || ''} ${bucket.displayName || ''} ${bucket.window || ''}`.toLowerCase();
    let windowType = '';
    if (bucket.window === 'weekly' || /week/.test(hint)) {
      windowType = 'weekly';
    } else if (bucket.window === '5h' || /5h|five|hour/.test(hint)) {
      windowType = '5h';
    }
    if (!windowType) return null;

    const resetMs = parseQuotaResetTimeMs(bucket.resetTime);
    let fraction = null;
    if (typeof bucket.remainingFraction === 'number' && Number.isFinite(bucket.remainingFraction)) {
      fraction = bucket.remainingFraction;
    } else if (
      bucket.remaining &&
      bucket.remaining.case === 'remainingFraction' &&
      typeof bucket.remaining.value === 'number'
    ) {
      fraction = bucket.remaining.value;
    } else if (bucket.disabled === true || (Number.isFinite(resetMs) && resetMs > Date.now())) {
      fraction = 0;
    }
    if (fraction === null) return null;

    const clamped = Math.max(0, Math.min(1, fraction));
    const pct = Math.round(clamped * 100);
    const resetText = clamped < 0.9995 ? formatQuotaResetCountdown(resetMs) : '';
    return { window: windowType, pct, resetMs, resetText };
  }

  /**
   * 将原生 RetrieveUserQuotaSummary 响应解析为模型池映射表（优先采用官方分组描述中的模型清单）
   */
  function parseQuotaGroupsFromSummary(rawSummary) {
    const resp = rawSummary?.response || rawSummary;
    if (!resp || typeof resp !== 'object') return [];

    let rawGroups = Array.isArray(resp.groups) ? resp.groups : [];
    if (rawGroups.length === 0 && Array.isArray(resp.buckets) && resp.buckets.length > 0) {
      rawGroups = [{ displayName: 'All Models', description: '', buckets: resp.buckets }];
    }

    const parsedGroups = [];
    for (const group of rawGroups) {
      const buckets = Array.isArray(group?.buckets) ? group.buckets : [];
      let weekly = null;
      let fiveHour = null;
      for (const b of buckets) {
        const parsed = parseQuotaSummaryBucket(b);
        if (!parsed) continue;
        if (parsed.window === 'weekly') weekly = parsed;
        else if (parsed.window === '5h') fiveHour = parsed;
      }
      if (!weekly && !fiveHour) continue;

      const exactModels = new Set();
      const desc = String(group?.description || '');
      const listMatch = desc.match(/models within this group:\s*([^\n.]+(?:\.\d+[^\n.]*)*)/i) ||
        desc.match(/models within this group:\s*(.+)$/i);
      if (listMatch && listMatch[1]) {
        for (const token of listMatch[1].split(',')) {
          const cleanName = token.replace(/\.$/, '').trim().toLowerCase();
          if (cleanName) exactModels.add(cleanName);
        }
      }

      const headerText = `${group?.displayName || ''} ${desc}`.toLowerCase();
      let keywords = [];
      if (headerText.includes('gemini')) {
        keywords = ['gemini', 'orchestrator', 'neon', 'carbon', 'argon', 'hydrogen', 'flash'];
      } else if (headerText.includes('claude') || headerText.includes('gpt') || headerText.includes('3p')) {
        keywords = ['claude', 'opus', 'sonnet', 'haiku', 'gpt', 'oss', 'o1', 'o3', 'o4'];
      }

      parsedGroups.push({
        title: String(group?.displayName || '模型池'),
        exactModels,
        keywords,
        weekly,
        fiveHour,
      });
    }
    return parsedGroups;
  }

  /**
   * 异步刷新模型池周额度与 5 小时额度缓存（带并发去重与 25s TTL）
   */
  async function ensureQuotaSummaryFresh(force = false, footerEl = null) {
    const now = Date.now();
    if (!force && quotaGroupsCache.length > 0 && now - quotaFetchedAt < QUOTA_CACHE_TTL_MS) {
      return quotaGroupsCache;
    }
    if (quotaFetchPromise) return quotaFetchPromise;

    const client = getLanguageServerClient(footerEl || activeFooterEl || lastOpenedFooterEl);
    if (!client) return quotaGroupsCache;

    quotaFetchPromise = Promise.resolve()
      .then(() => client.retrieveUserQuotaSummary({}))
      .then((raw) => {
        const parsed = parseQuotaGroupsFromSummary(raw);
        if (parsed.length > 0) {
          quotaGroupsCache = parsed;
          quotaFetchedAt = Date.now();
          quotaCacheVersion++;
          lastPopoverFingerprint = '';
          if (activeFooterEl && document.body.contains(activeFooterEl)) {
            renderPopoverData(activeFooterEl, true);
          }
          refreshAllFooterQuotaBadges();
        }
        return quotaGroupsCache;
      })
      .catch(() => quotaGroupsCache)
      .finally(() => {
        quotaFetchPromise = null;
      });

    return quotaFetchPromise;
  }

  /**
   * 异步拉取宿主可用模型目录以缓存各模型官方真实上下文上限（60s TTL，供自动上限模式使用）
   */
  async function ensureAvailableModelsFresh(footerEl = null) {
    const now = Date.now();
    if (clientModelCatalogLimits.size > 0 && now - clientCatalogFetchedAt < 60000) {
      return clientModelCatalogLimits;
    }
    if (clientCatalogPromise) return clientCatalogPromise;

    const client = getLanguageServerClient(footerEl || activeFooterEl || lastOpenedFooterEl);
    if (!client || typeof client.getAvailableModels !== 'function') {
      return clientModelCatalogLimits;
    }

    clientCatalogPromise = Promise.resolve()
      .then(() => client.getAvailableModels({}))
      .then((raw) => {
        const modelsObj = raw?.response?.models || raw?.models || {};
        if (modelsObj && typeof modelsObj === 'object') {
          for (const [id, info] of Object.entries(modelsObj)) {
            const maxTok = Number(info?.maxTokens || info?.maxContextTokens || 0);
            if (!Number.isFinite(maxTok) || maxTok < 16000) continue;
            const rounded = Math.round(maxTok);
            const display = String(info?.displayName || '').trim();
            const keys = [
              id.toLowerCase(),
              display.toLowerCase(),
              normalizeModelKey(display || id),
              normalizeModelKey(id),
            ].filter(Boolean);
            for (const k of keys) {
              clientModelCatalogLimits.set(k, rounded);
            }
          }
          clientCatalogFetchedAt = Date.now();
          lastPopoverFingerprint = '';
          if (activeFooterEl && document.body.contains(activeFooterEl)) {
            renderPopoverData(activeFooterEl, true);
          }
        }
        return clientModelCatalogLimits;
      })
      .catch(() => clientModelCatalogLimits)
      .finally(() => {
        clientCatalogPromise = null;
      });

    return clientCatalogPromise;
  }

  /**
   * 根据模型系列名称匹配所属配额池的周额度与 5 小时额度
   */
  function resolveQuotaPairForFamily(familyName) {
    if (!familyName || quotaGroupsCache.length === 0) return null;
    const lower = String(familyName).trim().toLowerCase();

    for (const group of quotaGroupsCache) {
      if (group.exactModels.has(lower)) {
        return { weekly: group.weekly, fiveHour: group.fiveHour };
      }
    }
    for (const group of quotaGroupsCache) {
      for (const exact of group.exactModels) {
        if (lower.startsWith(exact) || exact.startsWith(lower)) {
          return { weekly: group.weekly, fiveHour: group.fiveHour };
        }
      }
    }
    for (const group of quotaGroupsCache) {
      if (group.keywords.some((kw) => lower.includes(kw))) {
        return { weekly: group.weekly, fiveHour: group.fiveHour };
      }
    }
    return quotaGroupsCache.length === 1
      ? { weekly: quotaGroupsCache[0].weekly, fiveHour: quotaGroupsCache[0].fiveHour }
      : null;
  }

  /**
   * 根据剩余额度百分比返回自动告警颜色（充裕绿 -> 偏低琥珀黄 -> 告急/耗尽红）
   */
  function resolveQuotaRingColor(pct) {
    if (pct >= 40) return '#10b981';
    if (pct >= 15) return '#f59e0b';
    return '#ef4444';
  }

  /**
   * 绘制单个表盘风微型剩余额度圆环 SVG（中心内嵌 W / 5 微标，0% 时淡红底环 + 红字警示）
   */
  function buildSingleQuotaRingSvg(bucket, badge, sizePx, dark) {
    if (!bucket) return '';
    const pct = Math.max(0, Math.min(100, Number(bucket.pct || 0)));
    const color = resolveQuotaRingColor(pct);
    const r = 7.1;
    const c = 2 * Math.PI * r;
    const trackColor =
      pct <= 0
        ? 'rgba(239, 68, 68, 0.36)'
        : dark
          ? 'rgba(255, 255, 255, 0.16)'
          : 'rgba(113, 113, 122, 0.22)';
    const textColor =
      pct < 15
        ? '#ef4444'
        : dark
          ? '#e4e4e7'
          : '#3f3f46';
    const fontSize = badge === 'W' ? '6.4' : '6.8';
    const badgeText = `<text x="9" y="9" dy="0.35em" text-anchor="middle" fill="${textColor}" font-size="${fontSize}" font-weight="750" font-family="ui-sans-serif, system-ui, -apple-system, sans-serif">${badge}</text>`;

    if (pct <= 0) {
      return `<svg class="cr-quota-ring-svg" width="${sizePx}" height="${sizePx}" viewBox="0 0 18 18" fill="none" aria-hidden="true"><circle cx="9" cy="9" r="${r}" stroke="${trackColor}" stroke-width="1.9"/>${badgeText}</svg>`;
    }

    const dash = ((pct / 100) * c).toFixed(2);
    return `<svg class="cr-quota-ring-svg" width="${sizePx}" height="${sizePx}" viewBox="0 0 18 18" fill="none" aria-hidden="true"><circle cx="9" cy="9" r="${r}" stroke="${trackColor}" stroke-width="1.9"/><circle cx="9" cy="9" r="${r}" stroke="${color}" stroke-width="1.9" stroke-dasharray="${dash} ${c.toFixed(2)}" stroke-linecap="round" transform="rotate(-90 9 9)"/>${badgeText}</svg>`;
  }

  /**
   * 生成模型名左侧的「W 周额度 + H 五小时额度」双圆环 HTML 与悬停说明文案
   */
  function buildQuotaPairVisual(familyName, sizePx, dark) {
    const pair = resolveQuotaPairForFamily(familyName);
    if (!pair || (!pair.weekly && !pair.fiveHour)) {
      return { html: '', tooltip: '', pair: null };
    }

    const weeklySvg = buildSingleQuotaRingSvg(pair.weekly, 'W', sizePx, dark);
    const fiveHourSvg = buildSingleQuotaRingSvg(pair.fiveHour, 'H', sizePx, dark);
    const tipParts = [];
    if (pair.weekly) {
      tipParts.push(
        `周额度剩余 ${pair.weekly.pct}%${pair.weekly.resetText ? `（${pair.weekly.resetText}）` : ''}`
      );
    }
    if (pair.fiveHour) {
      tipParts.push(
        `5小时额度剩余 ${pair.fiveHour.pct}%${pair.fiveHour.resetText ? `（${pair.fiveHour.resetText}）` : ''}`
      );
    }

    return {
      html: `${weeklySvg}${fiveHourSvg}`,
      tooltip: tipParts.join(' | '),
      pair,
    };
  }

  /**
   * 获取或创建全局唯一的悬停秒出额度迷你气泡
   */
  function getOrCreateQuotaTip() {
    let tip = document.getElementById(QUOTA_TIP_ID);
    if (tip) return tip;
    tip = document.createElement('div');
    tip.id = QUOTA_TIP_ID;
    tip.setAttribute('role', 'tooltip');
    document.body.appendChild(tip);
    return tip;
  }

  /**
   * 立即隐藏迷你额度气泡
   */
  function hideQuotaTip() {
    const tip = document.getElementById(QUOTA_TIP_ID);
    if (tip) tip.classList.remove('is-open');
  }

  /**
   * 悬停模型名称时秒出展示周额度与 5 小时额度明细气泡（下拉项优先靠左防遮挡，按钮默认居中在上方）
   */
  function showQuotaTip(anchorEl, familyName) {
    const pair = resolveQuotaPairForFamily(familyName);
    if (!anchorEl || !pair || (!pair.weekly && !pair.fiveHour)) {
      hideQuotaTip();
      return;
    }

    const tip = getOrCreateQuotaTip();
    tip.classList.toggle('is-dark', isDarkTheme());

    const rows = [];
    if (pair.weekly) {
      const wColor = resolveQuotaRingColor(pair.weekly.pct);
      const pctStyle = pair.weekly.pct < 15 ? ` style="color:${wColor}"` : '';
      rows.push(
        `<div class="cr-qtip-row"><span class="cr-qtip-dot" style="background:${wColor}"></span><span class="cr-qtip-name">周额度</span><span class="cr-qtip-pct"${pctStyle}>${pair.weekly.pct}%</span>${pair.weekly.resetText ? `<span class="cr-qtip-reset">${escapeHtml(pair.weekly.resetText)}</span>` : ''}</div>`
      );
    }
    if (pair.fiveHour) {
      const hColor = resolveQuotaRingColor(pair.fiveHour.pct);
      const pctStyle = pair.fiveHour.pct < 15 ? ` style="color:${hColor}"` : '';
      rows.push(
        `<div class="cr-qtip-row"><span class="cr-qtip-dot" style="background:${hColor}"></span><span class="cr-qtip-name">5h额度</span><span class="cr-qtip-pct"${pctStyle}>${pair.fiveHour.pct}%</span>${pair.fiveHour.resetText ? `<span class="cr-qtip-reset">${escapeHtml(pair.fiveHour.resetText)}</span>` : ''}</div>`
      );
    }

    tip.innerHTML = rows.join('');
    tip.classList.add('is-open');

    const rect = anchorEl.getBoundingClientRect();
    const tipW = tip.offsetWidth || 180;
    const tipH = tip.offsetHeight || 46;
    const isMenuOption = anchorEl.classList.contains('cr-model-option');

    let left;
    let top;
    if (isMenuOption && rect.left - tipW - 10 >= 8) {
      // 下拉列表中优先贴齐该行左侧弹出，避免遮挡上下相邻的模型名称
      left = rect.left - tipW - 10;
      top = Math.max(8, Math.min(window.innerHeight - tipH - 8, rect.top + rect.height / 2 - tipH / 2));
    } else {
      left = rect.left + rect.width / 2 - tipW / 2;
      left = Math.max(8, Math.min(window.innerWidth - tipW - 8, left));
      top = rect.top - tipH - 7;
      if (top < 8) {
        top = rect.bottom + 7;
      }
    }
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  }

  /**
   * 解析模型名称中的系列名与思考等级后缀（仅识别标准思考等级，保留 Orchestrator (Neon) 等独立变体名）
   */
  function parseModelFamilyAndEffort(label) {
    const raw = String(label || '').trim();
    const match = raw.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
    if (match) {
      const effortKey = match[2].trim().toLowerCase();
      const meta = EFFORT_META[effortKey] || null;
      if (meta) {
        return { family: match[1].trim(), effortKey, meta };
      }
    }
    return { family: raw, effortKey: '', meta: null };
  }

  /**
   * 从当前输入框的模型选择器 React Fiber 读取去重模型系列、思考等级列表与原生切换回调
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

        // 按原生出现顺序聚合去重模型系列，并整理每个系列下的思考等级档位
        const familyMap = new Map();
        for (const opt of props.modelOptions) {
          if (!opt || opt.disabled) continue;
          const info = parseModelFamilyAndEffort(opt.label);
          if (!info.family) continue;

          let entry = familyMap.get(info.family);
          if (!entry) {
            entry = {
              family: info.family,
              levelMap: new Map(),
              defaultOption: opt,
              tagTitle: opt.tagTitle || '',
            };
            familyMap.set(info.family, entry);
          }

          if (info.meta) {
            if (!entry.levelMap.has(info.meta.rank)) {
              entry.levelMap.set(info.meta.rank, {
                rank: info.meta.rank,
                short: info.meta.short,
                display: info.meta.display,
                color: info.meta.color,
                gradient: info.meta.gradient,
                option: opt,
              });
            }
          } else {
            entry.defaultOption = opt;
          }
        }

        const families = Array.from(familyMap.values()).map((entry) => ({
          family: entry.family,
          levels: Array.from(entry.levelMap.values()).sort((a, b) => a.rank - b.rank),
          defaultOption: entry.defaultOption,
          tagTitle: entry.tagTitle,
        }));

        const currentFamilyEntry = families.find((item) => item.family === selectedInfo.family) || null;
        const levels = currentFamilyEntry ? currentFamilyEntry.levels : [];
        const currentIdx = levels.findIndex(
          (item) =>
            (selected?.value !== undefined && item.option.value === selected.value) ||
            item.option.label === selected?.label
        );

        return {
          family: selectedInfo.family,
          selectedLabel: selected?.label || '',
          currentRank: selectedInfo.meta ? selectedInfo.meta.rank : null,
          levels,
          currentIdx: currentIdx >= 0 ? currentIdx : 0,
          families,
          setSelectedModel: props.setSelectedModel,
        };
      }
      cursor = cursor.return;
      depth++;
    }
    return null;
  }

  /**
   * 切换模型系列时挑选最匹配的思考深度档位（优先同档位，次选最接近档位，无分级则返回默认项）
   */
  function pickBestOptionForFamily(targetFamily, preferredRank) {
    if (!targetFamily) return null;
    const levels = targetFamily.levels || [];
    if (levels.length === 0) {
      return targetFamily.defaultOption || null;
    }

    if (typeof preferredRank === 'number') {
      const exact = levels.find((item) => item.rank === preferredRank);
      if (exact) return exact.option;

      // 优先选择与当前思考深度最接近的档位（同距离优先偏高档位）
      let best = levels[0];
      let bestDist = Math.abs(best.rank - preferredRank);
      for (let i = 1; i < levels.length; i++) {
        const dist = Math.abs(levels[i].rank - preferredRank);
        if (dist < bestDist || (dist === bestDist && levels[i].rank > best.rank)) {
          best = levels[i];
          bestDist = dist;
        }
      }
      return best.option;
    }

    const medium = levels.find((item) => item.rank === 2);
    if (medium) return medium.option;
    const high = levels.find((item) => item.rank === 3);
    if (high) return high.option;
    return levels[0].option;
  }

  let compactSubmitting = false;

  /**
   * 从当前输入框 React Fiber 读取原生 AgentInputBox 提交控制器与 /compact 指令定义
   */
  function getComposerCompactController(footerEl) {
    const card = footerEl?.closest?.('.surface-composer-card');
    const candidates = [
      card?.querySelector?.('[contenteditable="true"]'),
      footerEl,
      document.querySelector('.surface-composer-card [contenteditable="true"]'),
    ].filter(Boolean);

    for (const node of candidates) {
      const fiberKey = Object.keys(node).find(
        (key) => key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')
      );
      if (!fiberKey) continue;

      let cursor = node[fiberKey];
      let depth = 0;
      while (cursor && depth < 42) {
        const props = cursor.memoizedProps;
        if (props && typeof props.handleSubmit === 'function') {
          const slashItems = Array.isArray(props.slashCommandItems) ? props.slashCommandItems : [];
          const compactItem =
            slashItems.find((item) => item?.info?.name === 'compact' || item?.title === 'compact') || null;

          return {
            handleSubmit: props.handleSubmit,
            cascadeId: typeof props.cascadeId === 'string' ? props.cascadeId : '',
            isRunning: Boolean(props.isRunning),
            canQueue: props.canQueue !== false,
            compactItem,
          };
        }
        cursor = cursor.return;
        depth++;
      }
    }

    return null;
  }

  /**
   * 直接触发当前会话的原生 /compact 上下文压缩（保留输入框草稿；失败时优雅降级为复制指令）
   */
  async function executeCompactCommand(footerEl) {
    if (compactSubmitting) {
      return { ok: false, busy: true, message: '压缩中...' };
    }

    const ctrl = getComposerCompactController(footerEl);
    if (!ctrl) {
      navigator.clipboard?.writeText('/compact').catch(() => {});
      return { ok: false, fallbackCopied: true, message: '已复制 /compact' };
    }

    // 空白新会话没有历史消息，避免误触发空会话提交
    if (!ctrl.cascadeId) {
      return { ok: false, warn: true, message: '暂无会话历史' };
    }

    // 运行中且不支持排队时提示等待本轮完成
    if (ctrl.isRunning && !ctrl.canQueue) {
      return { ok: false, warn: true, message: '运行中，请稍候' };
    }

    // 优先复用客户端实时下发的 SlashCommandInfo 原生 protobuf 对象
    const slashInfo = ctrl.compactItem?.info || {
      $typeName: 'exa.codeium_common_pb.SlashCommandInfo',
      name: 'compact',
      modelFacingText: '',
      type: 1,
      icon: 'collapse_all',
      displayName: '',
      logo: '',
    };

    const items = [
      {
        $typeName: 'exa.codeium_common_pb.TextOrScopeItem',
        chunk: {
          case: 'item',
          value: {
            $typeName: 'exa.codeium_common_pb.ContextScopeItem',
            scopeItem: {
              case: 'slashCommand',
              value: {
                $typeName: 'exa.codeium_common_pb.SlashCommandScopeItem',
                info: slashInfo,
                argumentValues: {},
              },
            },
          },
        },
      },
    ];

    compactSubmitting = true;
    try {
      // 传入空操作 clearEditor，避免清空用户当前正在输入的未发送草稿
      await ctrl.handleSubmit(items, [], () => {});
      return {
        ok: true,
        queued: ctrl.isRunning,
        message: ctrl.isRunning ? '✓ 已排队压缩' : '✓ 已执行压缩',
      };
    } catch {
      navigator.clipboard?.writeText('/compact').catch(() => {});
      return { ok: false, fallbackCopied: true, message: '已复制 /compact' };
    } finally {
      compactSubmitting = false;
    }
  }

  /**
   * 构造严格归零的空白会话统计对象
   */
  function createEmptyWidgetUsage(modelName = '') {
    return {
      conversationId: '',
      totalTokens: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      cumulativeOutputTokens: 0,
      cacheHitRate: 0,
      turnCount: 0,
      plannerStepCount: 0,
      history: [],
      modelName: modelName || 'Model',
    };
  }

  /**
   * 判断输入框节点当前是否在视口布局中可见（用于区分活跃输入框与后台隐藏节点）
   */
  function isElementVisible(el) {
    if (!el || !document.body || !document.body.contains(el)) return false;
    try {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    } catch {
      return false;
    }
  }

  /**
   * 从输入框节点向上提取当前会话 ID 与模型名称（严格以当前输入框控制器为准，避免空白新会话串台）
   */
  function extractComposerContext(footerEl) {
    let conversationId = '';
    let modelLabel = '';
    let explicitBlankComposer = false;

    const card = footerEl?.closest?.('.surface-composer-card') || null;
    const fiberNodes = [];
    const editorEl = card?.querySelector?.('[contenteditable="true"]') || null;
    if (editorEl) fiberNodes.push(editorEl);
    if (footerEl && footerEl !== editorEl) fiberNodes.push(footerEl);

    for (const node of fiberNodes) {
      const fiberKey = Object.keys(node).find(
        (key) => key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')
      );
      if (!fiberKey) continue;

      let cursor = node[fiberKey];
      let depth = 0;
      let hitBlankController = false;

      while (cursor && depth < 36) {
        const props = cursor.memoizedProps;
        if (props && typeof props === 'object') {
          const isComposerController = typeof props.handleSubmit === 'function';
          const hasCidProp =
            Object.prototype.hasOwnProperty.call(props, 'cascadeId') ||
            Object.prototype.hasOwnProperty.call(props, 'conversationId');

          if (!conversationId && !explicitBlankComposer && !hitBlankController) {
            const rawCascadeId = typeof props.cascadeId === 'string' ? props.cascadeId.trim() : '';
            const rawConversationId = typeof props.conversationId === 'string' ? props.conversationId.trim() : '';
            const rawCid = rawCascadeId.length >= 8 ? rawCascadeId : rawConversationId;

            if (rawCid.length >= 8) {
              conversationId = rawCid;
            } else if (isComposerController && hasCidProp) {
              // 当前 AgentInputBox 显式声明无会话 ID（空白新会话），禁止继续向上层组件或 URL 拾取旧会话
              hitBlankController = true;
              explicitBlankComposer = true;
            }
          }

          if (!modelLabel && props.currentModelConfig && typeof props.currentModelConfig.label === 'string') {
            modelLabel = props.currentModelConfig.label;
          }
        }
        if ((conversationId || explicitBlankComposer || hitBlankController) && modelLabel) break;
        cursor = cursor.return;
        depth++;
      }

      if ((conversationId || explicitBlankComposer) && modelLabel) break;
    }

    if (!conversationId && !explicitBlankComposer) {
      const pathMatch = String(location.pathname || '').match(/^\/c\/([a-zA-Z0-9_-]{8,128})/);
      if (pathMatch) conversationId = pathMatch[1];
    }

    if (!modelLabel && card) {
      const modelBtn = card.querySelector('[data-testid="model-selector-trigger"]');
      if (modelBtn && modelBtn.textContent) {
        modelLabel = modelBtn.textContent.trim();
      }
    }

    return { conversationId, modelLabel, explicitBlankComposer };
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
   * 关闭悬浮卡片内的模型系列下拉菜单
   */
  function closeModelMenu(pop) {
    hideQuotaTip();
    if (!pop) return;
    const btn = pop.querySelector('[data-role="model-picker-btn"]');
    const menu = pop.querySelector('[data-role="model-menu"]');
    if (btn) {
      btn.classList.remove('is-open');
      btn.setAttribute('aria-expanded', 'false');
    }
    if (menu) {
      menu.classList.remove('is-open');
    }
  }

  /**
   * 打开悬浮卡片内的模型系列下拉菜单，并按视口剩余空间自动选择向上或向下展开
   */
  function openModelMenu(pop) {
    if (!pop) return;
    const box = pop.querySelector('[data-role="effort-box"]');
    const controller = box?._effortController;
    if (!controller || controller.families.length <= 1) return;

    const btn = pop.querySelector('[data-role="model-picker-btn"]');
    const menu = pop.querySelector('[data-role="model-menu"]');
    if (!btn || !menu) return;

    // 展开菜单期间锁定悬浮卡片，并异步确保额度快照处于最新状态
    popoverPinned = true;
    void ensureQuotaSummaryFresh(false, activeFooterEl || lastOpenedFooterEl);
    const rect = btn.getBoundingClientRect();
    const shouldOpenDown = rect.top < 268 && window.innerHeight - rect.bottom > rect.top;
    menu.classList.toggle('is-down', shouldOpenDown);

    btn.classList.add('is-open');
    btn.setAttribute('aria-expanded', 'true');
    menu.classList.add('is-open');

    const activeOpt = menu.querySelector('.cr-model-option.is-active');
    if (activeOpt) {
      activeOpt.scrollIntoView({ block: 'nearest' });
    }
  }

  /**
   * 切换模型系列下拉菜单的展开/收起状态
   */
  function toggleModelMenu(pop) {
    if (!pop) return;
    const menu = pop.querySelector('[data-role="model-menu"]');
    if (menu?.classList.contains('is-open')) {
      closeModelMenu(pop);
    } else {
      openModelMenu(pop);
    }
  }

  /**
   * 渲染悬浮卡片中的模型切换器（含周/5h 额度双圆环）与融合式思考深度滑轨
   */
  function renderThinkingEffortControl(pop, footerEl) {
    const box = pop.querySelector('[data-role="effort-box"]');
    if (!box) return;

    const controller = getThinkingEffortController(footerEl);
    box._effortController = controller;

    if (!controller || controller.families.length === 0) {
      closeModelMenu(pop);
      box.style.display = 'none';
      return;
    }

    box.style.display = '';
    const dark = isDarkTheme();
    const hasLevels = controller.levels.length > 0;
    const isSingle = controller.levels.length < 2;

    const captionEl = pop.querySelector('[data-role="effort-caption"]');
    if (captionEl) captionEl.textContent = hasLevels ? '思考深度' : '当前模型';

    const modelEl = pop.querySelector('[data-role="effort-model"]');
    if (modelEl) modelEl.textContent = controller.family;

    const currentQuota = buildQuotaPairVisual(controller.family, 15, dark);
    const currentQuotaSlot = pop.querySelector('[data-role="current-model-quota"]');
    if (currentQuotaSlot && currentQuotaSlot.innerHTML !== currentQuota.html) {
      currentQuotaSlot.innerHTML = currentQuota.html;
    }

    const pickerBtn = pop.querySelector('[data-role="model-picker-btn"]');
    if (pickerBtn) {
      const canSwitchModel = controller.families.length > 1;
      pickerBtn.classList.toggle('is-static', !canSwitchModel);
      pickerBtn.disabled = !canSwitchModel;
      pickerBtn.setAttribute('data-quota-family', controller.family);
      pickerBtn.removeAttribute('title');
      pickerBtn.setAttribute(
        'aria-label',
        `${controller.selectedLabel || controller.family}${currentQuota.tooltip ? ` (${currentQuota.tooltip})` : ''}`
      );
    }

    // 增量渲染去重后的模型系列列表（整行悬停即可秒出周/5h额度气泡）
    const menuEl = pop.querySelector('[data-role="model-menu"]');
    if (menuEl) {
      const familiesSig = [
        dark ? 1 : 0,
        quotaCacheVersion,
        ...controller.families.map((f) => `${f.family}:${f.levels.length}`),
      ].join('|');
      if (menuEl.dataset.sig !== familiesSig) {
        menuEl.dataset.sig = familiesSig;
        const headHtml =
          quotaGroupsCache.length > 0
            ? `<div class="cr-model-menu-head"><span>W 周 / H 五小时</span><span>档位</span></div>`
            : '';
        menuEl.innerHTML =
          headHtml +
          controller.families
            .map((item) => {
              const levelHint = item.levels.length > 1 ? `${item.levels.length}档` : '';
              const safeFamily = escapeHtml(item.family);
              const qVis = buildQuotaPairVisual(item.family, 16, dark);
              return `
                <button type="button" class="cr-model-option" role="option" data-family="${safeFamily}" data-quota-family="${safeFamily}">
                  <span class="cr-model-option-left">
                    <span class="cr-quota-pair">${qVis.html}</span>
                    <span class="cr-model-option-name">${safeFamily}</span>
                  </span>
                  <span class="cr-model-option-right">
                    ${levelHint ? `<span class="cr-model-option-meta">${levelHint}</span>` : ''}
                    <svg class="cr-model-option-check" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M2.5 6.2L5 8.6L9.5 3.6" />
                    </svg>
                  </span>
                </button>
              `;
            })
            .join('');
      }
      for (const optBtn of menuEl.querySelectorAll('.cr-model-option')) {
        const isActive = optBtn.getAttribute('data-family') === controller.family;
        optBtn.classList.toggle('is-active', isActive);
        optBtn.setAttribute('aria-selected', isActive ? 'true' : 'false');
      }
    }

    const rail = pop.querySelector('[data-role="effort-rail"]');
    if (!hasLevels) {
      if (rail) rail.style.display = 'none';
      return;
    }

    if (rail) {
      rail.style.display = '';
      rail.classList.toggle('is-single', isSingle);
    }

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
   * 执行原生模型系列切换（自动匹配最接近思考等级）并刷新卡片显示
   */
  function commitModelFamilySelection(pop, targetFamilyName) {
    const box = pop.querySelector('[data-role="effort-box"]');
    const controller = box?._effortController;
    closeModelMenu(pop);
    if (!controller || !targetFamilyName) return;
    if (targetFamilyName === controller.family) return;

    const targetFamily = controller.families.find((item) => item.family === targetFamilyName);
    const pickedOption = pickBestOptionForFamily(targetFamily, controller.currentRank);
    if (!pickedOption) return;

    try {
      controller.setSelectedModel(pickedOption);
      lastPopoverFingerprint = '';
      setTimeout(() => {
        if (activeFooterEl) renderPopoverData(activeFooterEl, true);
        refreshAllFooterQuotaBadges();
      }, 90);
      setTimeout(() => {
        if (activeFooterEl) renderPopoverData(activeFooterEl, true);
        refreshAllFooterQuotaBadges();
      }, 240);
    } catch {
      // 忽略模型切换异常
    }
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

      <div class="cr-speed-bar is-hidden" data-role="speed-bar">
        <span class="cr-speed-left">
          <span data-role="speed-tps">⚡ --</span>
          <span class="cr-speed-grade" data-role="speed-grade" style="display:none;">A</span>
        </span>
        <span class="cr-speed-meta" data-role="speed-meta">--</span>
      </div>

      <div class="cr-effort-box" data-role="effort-box">
        <div class="cr-effort-head">
          <span class="cr-effort-caption" data-role="effort-caption">思考深度</span>
          <div class="cr-model-picker" data-role="model-picker">
            <button type="button" class="cr-effort-model-btn" data-role="model-picker-btn" aria-haspopup="listbox" aria-expanded="false" title="点击切换模型系列">
              <span class="cr-quota-pair" data-role="current-model-quota"></span>
              <span class="cr-model-btn-label" data-role="effort-model">Model</span>
              <svg class="cr-model-caret" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M3 4.5L6 7.5L9 4.5" />
              </svg>
            </button>
            <div class="cr-model-menu" data-role="model-menu" role="listbox" aria-label="选择模型系列"></div>
          </div>
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
        <button type="button" class="cr-compact-btn" data-role="compact-btn" title="点击直接执行 /compact 压缩当前会话上下文">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M5 3.5L8 6.5L11 3.5" />
            <path d="M5 12.5L8 9.5L11 12.5" />
            <path d="M2.5 8H13.5" />
          </svg>
          <span data-role="compact-label">/compact</span>
          <span class="cr-rehydrate-dot" data-role="rehydrate-dot" title="已开启压缩后防失忆"></span>
        </button>
      </div>
    `;

    pop.addEventListener('mouseenter', () => {
      if (hidePopoverTimer) {
        clearTimeout(hidePopoverTimer);
        hidePopoverTimer = null;
      }
    });

    pop.addEventListener('mouseleave', () => {
      hideQuotaTip();
      if (!popoverPinned) {
        schedulePopoverHide();
      }
    });

    // 悬停当前模型按钮或下拉列表任意一行模型名时秒出迷你额度气泡
    pop.addEventListener('mouseover', (e) => {
      const targetEl = e.target.closest?.('[data-quota-family]');
      if (!targetEl) return;
      // 展开模型菜单时悬停底部触发按钮不重复弹气泡，避免遮挡展开中的菜单
      if (targetEl.getAttribute('data-role') === 'model-picker-btn') {
        const menu = pop.querySelector('[data-role="model-menu"]');
        if (menu?.classList.contains('is-open')) return;
      }
      const familyName = targetEl.getAttribute('data-quota-family');
      if (familyName) showQuotaTip(targetEl, familyName);
    });
    pop.addEventListener('mouseout', (e) => {
      const targetEl = e.target.closest?.('[data-quota-family]');
      if (!targetEl) return;
      if (e.relatedTarget && targetEl.contains(e.relatedTarget)) return;
      hideQuotaTip();
    });

    // 点击卡片内部非模型选择器区域时，自动收起展开的模型系列下拉菜单
    pop.addEventListener('pointerdown', (e) => {
      if (!e.target.closest('[data-role="model-picker"]')) {
        closeModelMenu(pop);
      }
    });

    // 右上角设置按钮：关闭小卡片并打开专属样式设置页面
    pop.querySelector('[data-role="open-settings-btn"]').addEventListener('click', (e) => {
      e.stopPropagation();
      lastOpenedFooterEl = activeFooterEl || lastOpenedFooterEl;
      closePopoverNow();
      openSettingsPage();
    });

    // 模型系列切换按钮：展开/收起去重模型系列浮层
    pop.querySelector('[data-role="model-picker-btn"]').addEventListener('click', (e) => {
      e.stopPropagation();
      hideQuotaTip();
      toggleModelMenu(pop);
    });

    // 模型系列列表项点击与滚动处理
    const modelMenuEl = pop.querySelector('[data-role="model-menu"]');
    modelMenuEl.addEventListener('scroll', hideQuotaTip, { passive: true });
    modelMenuEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const optionBtn = e.target.closest('.cr-model-option');
      if (!optionBtn) return;
      const familyName = optionBtn.getAttribute('data-family');
      if (!familyName) return;
      commitModelFamilySelection(pop, familyName);
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

    // 切换 自动 / 256k / 512k / 1M 上限并按当前模型记忆持久化
    pop.querySelector('[data-role="limit-group"]').addEventListener('click', (e) => {
      e.stopPropagation();
      const btn = e.target.closest('.cr-limit-btn');
      if (!btn) return;
      const nextLimit = Number(btn.getAttribute('data-limit'));
      if (!Number.isFinite(nextLimit) || nextLimit < 0) return;
      const targetFooter = activeFooterEl || lastOpenedFooterEl;
      const ctx = extractComposerContext(targetFooter);
      const cached = ctx.conversationId ? usageCache.get(ctx.conversationId) : null;
      const activeModel = ctx.modelLabel || cached?.modelName || '';
      if (activeModel && activeModel !== 'Model') {
        applySettingPatch({
          contextLimit: 0,
          setModelContextLimit: { modelName: activeModel, limit: nextLimit },
        });
      } else {
        applySettingPatch({ contextLimit: nextLimit });
      }
    });

    // 点击直接执行 /compact 压缩当前会话（不可用时自动降级复制）
    let compactResetTimer = null;
    pop.querySelector('[data-role="compact-btn"]').addEventListener('click', async (e) => {
      e.stopPropagation();
      const btn = e.currentTarget;
      const labelEl = btn.querySelector('[data-role="compact-label"]') || btn;
      if (btn.disabled) return;

      if (compactResetTimer) {
        clearTimeout(compactResetTimer);
        compactResetTimer = null;
      }

      btn.disabled = true;
      btn.classList.remove('is-done', 'is-warn');
      labelEl.textContent = '压缩中...';

      const targetFooter = activeFooterEl || lastOpenedFooterEl;
      const result = await executeCompactCommand(targetFooter);

      btn.disabled = false;
      labelEl.textContent = result.message || '/compact';
      if (result.ok) {
        btn.classList.add('is-done');
        compactResetTimer = setTimeout(() => {
          btn.classList.remove('is-done', 'is-warn');
          labelEl.textContent = '/compact';
          closePopoverNow();
        }, 720);
      } else {
        if (result.warn) btn.classList.add('is-warn');
        compactResetTimer = setTimeout(() => {
          btn.classList.remove('is-done', 'is-warn');
          labelEl.textContent = '/compact';
        }, 1600);
      }
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
    const data =
      (conversationId ? usageCache.get(conversationId) : null) || createEmptyWidgetUsage(modelLabel);

    const resolvedLimit = resolveEffectiveLimitForUi(data, modelLabel);
    const limit = resolvedLimit.limit;
    const total = Number(data.totalTokens || 0);
    const cacheRead = Number(data.cacheReadTokens || 0);
    const freshInput = Number(data.inputTokens || 0);
    const outTokens = Number(data.outputTokens || 0);
    const cumOut = Number(data.cumulativeOutputTokens || 0);
    const hitRate = Number(data.cacheHitRate || 0);
    const pct = limit > 0 ? (total / limit) * 100 : 0;
    const colors = resolveThemeColors(pct);
    const sp = data.speed || null;

    const fingerprint = [
      conversationId,
      total,
      cacheRead,
      freshInput,
      outTokens,
      cumOut,
      hitRate,
      Number(data.turnCount || 0),
      Number(data.plannerStepCount || 0),
      limit,
      resolvedLimit.auto ? 1 : 0,
      resolvedLimit.source,
      currentSettings.palette,
      modelLabel || data.modelName,
      quotaCacheVersion,
      rehydrateStatus.enabled ? 1 : 0,
      sp ? `${sp.displayTps || ''}:${sp.ttftSec || ''}:${sp.grade || ''}:${sp.thinkingTokens || 0}:${sp.responseTokens || 0}` : '',
      isDarkTheme() ? 1 : 0,
    ].join('|');

    if (forceRender || fingerprint !== lastPopoverFingerprint) {
      lastPopoverFingerprint = fingerprint;

      const pctEl = pop.querySelector('[data-role="pct"]');
      pctEl.textContent = `${pct.toFixed(1)}%`;
      pctEl.style.color = colors.main;

      const summaryEl = pop.querySelector('[data-role="summary"]');
      summaryEl.textContent = `${formatCompactTokens(total)} / ${formatCompactTokens(limit)} · ${resolvedLimit.source}`;
      summaryEl.title = resolvedLimit.auto
        ? `自动识别上下文上限：${formatExactNumber(limit)} tokens`
        : `当前模型自定义/手动上限：${formatExactNumber(limit)} tokens`;

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

      // 实时生成速度体检条
      const speedBar = pop.querySelector('[data-role="speed-bar"]');
      if (speedBar) {
        if (sp && (sp.displayTps || sp.ttftSec !== null || sp.outputTokens > 0)) {
          speedBar.classList.remove('is-hidden');
          const tpsEl = pop.querySelector('[data-role="speed-tps"]');
          const gradeEl = pop.querySelector('[data-role="speed-grade"]');
          const metaEl = pop.querySelector('[data-role="speed-meta"]');

          tpsEl.textContent = sp.displayTps
            ? `⚡ ${sp.displayTps.toFixed(1)} tok/s`
            : sp.phase === 'warming'
              ? '⚡ 预热中'
              : `⚡ 输出 ${formatCompactTokens(sp.outputTokens)}`;

          if (sp.grade) {
            gradeEl.style.display = 'inline-flex';
            gradeEl.className = `cr-speed-grade is-${sp.grade}`;
            gradeEl.textContent = sp.grade;
          } else {
            gradeEl.style.display = 'none';
          }

          const metaParts = [];
          if (sp.ttftSec !== null && sp.ttftSec !== undefined) {
            metaParts.push(`TTFT ${sp.ttftSec.toFixed(1)}s`);
          }
          if (sp.thinkingTokens > 0 || sp.responseTokens > 0) {
            metaParts.push(`思 ${formatCompactTokens(sp.thinkingTokens)} · 文 ${formatCompactTokens(sp.responseTokens)}`);
          }
          metaEl.textContent = metaParts.join(' · ') || '--';

          const tipLines = [];
          if (sp.streamingTps) tipLines.push(`流式速度: ${sp.streamingTps} tok/s`);
          if (sp.tps) tipLines.push(`端到端速度: ${sp.tps} tok/s`);
          if (sp.ttftSec !== null && sp.ttftSec !== undefined) tipLines.push(`首字延迟 TTFT: ${sp.ttftSec}s`);
          if (sp.durationSec !== null && sp.durationSec !== undefined) tipLines.push(`总耗时: ${sp.durationSec}s`);
          if (sp.thinkingTokens > 0 || sp.responseTokens > 0) {
            tipLines.push(`输出拆分: 思考 ${formatExactNumber(sp.thinkingTokens)} / 正文 ${formatExactNumber(sp.responseTokens)}`);
          }
          if (sp.score !== null && sp.score !== undefined) {
            tipLines.push(`响应体验分: ${sp.score} (${sp.grade || ''}${sp.gradeLabel ? ' · ' + sp.gradeLabel : ''})`);
          }
          speedBar.title = tipLines.join('\n');
        } else {
          speedBar.classList.add('is-hidden');
        }
      }

      for (const btn of pop.querySelectorAll('.cr-limit-btn')) {
        const val = Number(btn.getAttribute('data-limit'));
        btn.classList.toggle('is-active', resolvedLimit.auto ? val === 0 : val === limit);
      }

      const compactBtn = pop.querySelector('[data-role="compact-btn"]');
      const rhDot = pop.querySelector('[data-role="rehydrate-dot"]');
      if (rhDot) rhDot.classList.toggle('is-on', Boolean(rehydrateStatus.enabled));
      if (compactBtn) {
        compactBtn.title = rehydrateStatus.enabled
          ? '点击直接执行 /compact 压缩当前会话（已开启防失忆自动恢复）'
          : '点击直接执行 /compact 压缩当前会话上下文';
      }

      renderThinkingEffortControl(pop, footerEl);
    }

    // 紧贴触发按钮上方居中对齐，并做视口边界防溢出裁剪
    const hostEl = footerEl?.querySelector(`.${HOST_CLASS}`);
    if (hostEl) {
      const rect = hostEl.getBoundingClientRect();
      const popWidth = 306;
      const popHeight = pop.offsetHeight || 296;
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

  function formatUsd(val) {
    const n = Number(val || 0);
    if (n <= 0) return '$0.00';
    if (n < 0.01) return '<$0.01';
    return '$' + n.toFixed(n >= 100 ? 1 : 2);
  }

  /**
   * 拉取指定周期的历史用量与费用报告并渲染到设置页「历史用量与费用」页签
   */
  async function loadHistoryReportIntoModal(period = historyPeriod) {
    historyPeriod = period || '30d';
    historyLoading = true;
    renderHistoryTabContent();
    const resp = await callHostRpc('history.get', { period: historyPeriod });
    historyLoading = false;
    if (resp && resp.ok && resp.report) {
      historyReport = resp.report;
    }
    if (isSettingsModalOpen()) {
      renderHistoryTabContent();
    }
  }

  function renderHistoryTabContent() {
    const modal = document.getElementById(SETTINGS_MODAL_ID);
    if (!modal) return;

    for (const b of modal.querySelectorAll('[data-role="hist-period-row"] [data-period]')) {
      b.classList.toggle('is-active', b.getAttribute('data-period') === historyPeriod);
    }

    const report = historyReport;
    if (!report) {
      modal.querySelector('[data-role="hist-total"]').textContent = historyLoading ? '加载中...' : '--';
      return;
    }

    const sum = report.summary || {};
    modal.querySelector('[data-role="hist-total"]').textContent = formatCompactTokens(sum.totalTokens || 0);
    modal.querySelector('[data-role="hist-total-sub"]').textContent =
      `新输入 ${formatCompactTokens(sum.inputTokens || 0)} · 输出 ${formatCompactTokens(sum.outputTokens || 0)}`;
    modal.querySelector('[data-role="hist-cost"]').textContent = formatUsd(sum.estimatedCostUsd || 0);
    modal.querySelector('[data-role="hist-saved"]').textContent = `缓存已省 ${formatUsd(sum.cacheSavedUsd || 0)}`;
    modal.querySelector('[data-role="hist-cache"]').textContent = `${Number(sum.cacheHitRate || 0).toFixed(1)}%`;
    modal.querySelector('[data-role="hist-cache-sub"]').textContent =
      `缓存读取 ${formatCompactTokens(sum.cacheReadTokens || 0)}`;
    modal.querySelector('[data-role="hist-sessions"]').textContent =
      `${sum.sessionCount || 0} / ${sum.callCount || 0}`;
    modal.querySelector('[data-role="hist-channels"]').textContent =
      `桌面 ${sum.desktopCalls || 0} · CLI ${sum.cliCalls || 0}`;

    const hm = report.heatmap || {};
    const days = Array.isArray(hm.days) ? hm.days : [];
    modal.querySelector('[data-role="hist-hm-meta"]').textContent =
      `活跃 ${hm.activeDays || 0} 天 · 峰值 ${formatCompactTokens(hm.maxDayTokens || 0)}`;

    let hmHtml = '';
    for (let w = 0; w < 12; w++) {
      let col = '<div class="cr-hm-week">';
      for (let d = 0; d < 7; d++) {
        const item = days[w * 7 + d];
        if (!item) {
          col += '<div class="cr-hm-cell"></div>';
        } else {
          const lvl = item.level > 0 ? ` l${item.level}` : '';
          const tip = `${item.date} · ${formatCompactTokens(item.totalTokens)} tokens · ${item.calls} 次 · ${formatUsd(item.costUsd)}`;
          col += `<div class="cr-hm-cell${lvl}" title="${escapeHtml(tip)}"></div>`;
        }
      }
      col += '</div>';
      hmHtml += col;
    }
    modal.querySelector('[data-role="hist-hm-grid"]').innerHTML = hmHtml;

    const models = Array.isArray(report.models) ? report.models : [];
    modal.querySelector('[data-role="hist-models"]').innerHTML = models.length
      ? models
          .map(
            (m) => `
          <div class="cr-hist-model-row">
            <div class="cr-hist-model-top">
              <span class="cr-hist-model-name">${escapeHtml(m.displayName)}</span>
              <span class="cr-hist-model-val">${formatCompactTokens(m.totalTokens)} · 命中 ${m.cacheHitRate}% · ${
                m.priced ? formatUsd(m.estimatedCostUsd) : '未定价'
              }</span>
            </div>
            <div class="cr-hist-model-bar">
              <div class="cr-hist-model-fill" style="width:${Math.max(2, Math.min(100, m.sharePct || 0))}%"></div>
            </div>
          </div>`
          )
          .join('')
      : '<div style="opacity:0.65;font-size:12px;">该周期暂无记录的会话 Token 消耗</div>';
  }

  /**
   * 创建或获取独立样式与监控设置页面视图（双页签：外观与设置 / 历史用量与费用）
   */
  function getOrCreateSettingsModal() {
    let modal = document.getElementById(SETTINGS_MODAL_ID);
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = SETTINGS_MODAL_ID;
    modal.className = 'no-focus-agent-input';
    modal.innerHTML = `
      <div class="cr-page-shell" role="dialog" aria-modal="true" aria-label="Context Ring 样式与用量看板">
        <div class="cr-page-topbar">
          <div class="cr-page-title-wrap">
            <span class="cr-page-title">Context Ring</span>
            <span class="cr-page-badge">v${WIDGET_VERSION}</span>
          </div>
          <div class="cr-page-tabs" data-role="page-tabs">
            <button type="button" class="cr-page-tab is-active" data-tab="appearance">外观与设置</button>
            <button type="button" class="cr-page-tab" data-tab="history">历史用量与费用</button>
          </div>
          <button type="button" class="cr-page-close-btn" data-role="close-settings-btn">← 返回会话</button>
        </div>

        <div class="cr-tab-pane is-active" data-pane="appearance">
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
              <span class="cr-page-sec-title">模型上下文上限与显示偏好</span>
              <span style="font-size:11.5px;opacity:0.7;" data-role="modal-model-tag">--</span>
            </div>

            <div class="cr-pref-row">
              <span class="cr-pref-label">当前模型窗口上限</span>
              <div class="cr-pill-row" data-role="modal-limit-row">
                ${LIMIT_OPTIONS.map((opt) => `<button type="button" class="cr-page-pill" data-limit="${opt.value}">${opt.label}</button>`).join('')}
              </div>
            </div>
            <div class="cr-custom-limits" data-role="modal-custom-limits"></div>

            <div class="cr-pref-row">
              <span class="cr-pref-label">挂载位置与动效</span>
              <div class="cr-pill-row">
                <button type="button" class="cr-page-pill" data-role="modal-toggle-pct">显示百分比</button>
                <button type="button" class="cr-page-pill" data-role="modal-toggle-anim">动态效果</button>
                <button type="button" class="cr-page-pill" data-role="modal-toggle-place">输入框靠右</button>
              </div>
            </div>

            <div class="cr-pref-row">
              <div style="flex:1;min-width:200px;">
                <div class="cr-pref-label">压缩后防失忆（Post-Compact Rehydration）</div>
                <div class="cr-rehydrate-desc">纯 Node.js 零依赖 <code>PreInvocation</code> Hook：执行 <code>/compact</code> 压缩后自动恢复用户需求时间线、近期摘要与工作区活跃文件。</div>
                <div class="cr-rehydrate-alert" data-role="modal-rehydrate-alert" style="display:none;"></div>
              </div>
              <button type="button" class="cr-page-pill" data-role="modal-rehydrate-btn">未开启 · 启用</button>
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

        <div class="cr-tab-pane" data-pane="history">
          <div class="cr-page-sec">
            <div class="cr-page-sec-head">
              <span class="cr-page-sec-title">多周期 Token 消耗与预估 API 费用</span>
              <div class="cr-pill-row" data-role="hist-period-row">
                <button type="button" class="cr-page-pill" data-period="today">今日</button>
                <button type="button" class="cr-page-pill" data-period="7d">近 7 天</button>
                <button type="button" class="cr-page-pill is-active" data-period="30d">近 30 天</button>
                <button type="button" class="cr-page-pill" data-period="all">全部</button>
                <button type="button" class="cr-page-pill" data-role="hist-refresh-btn">刷新</button>
              </div>
            </div>
            <div class="cr-hist-kpi-grid">
              <div class="cr-hist-kpi">
                <div class="cr-hist-kpi-label">总 Token 消耗</div>
                <div class="cr-hist-kpi-val" data-role="hist-total">--</div>
                <div class="cr-hist-kpi-sub" data-role="hist-total-sub">--</div>
              </div>
              <div class="cr-hist-kpi">
                <div class="cr-hist-kpi-label">预估 API 费用</div>
                <div class="cr-hist-kpi-val" data-role="hist-cost">--</div>
                <div class="cr-hist-kpi-sub" data-role="hist-saved">缓存已省 --</div>
              </div>
              <div class="cr-hist-kpi">
                <div class="cr-hist-kpi-label">全局缓存命中率</div>
                <div class="cr-hist-kpi-val" data-role="hist-cache">--</div>
                <div class="cr-hist-kpi-sub" data-role="hist-cache-sub">--</div>
              </div>
              <div class="cr-hist-kpi">
                <div class="cr-hist-kpi-label">会话 / 调用</div>
                <div class="cr-hist-kpi-val" data-role="hist-sessions">--</div>
                <div class="cr-hist-kpi-sub" data-role="hist-channels">--</div>
              </div>
            </div>
            <div class="cr-hist-disclaimer">基于本地会话日志与公开 Developer API 参考费率估算，不代表实际订阅扣费。</div>
          </div>

          <div class="cr-page-sec">
            <div class="cr-page-sec-head" style="margin-bottom:8px;">
              <span class="cr-page-sec-title">近 12 周活跃热力图</span>
              <span style="font-size:11.5px;opacity:0.72;" data-role="hist-hm-meta">--</span>
            </div>
            <div class="cr-hm-grid" data-role="hist-hm-grid"></div>
            <div class="cr-hm-foot">
              <span>悬停任意方块可查看当日消耗与估算费用</span>
              <span>低 ▫️ 🟩 深绿 高</span>
            </div>
          </div>

          <div class="cr-page-sec" style="margin-bottom:0;">
            <div class="cr-page-sec-head" style="margin-bottom:8px;">
              <span class="cr-page-sec-title">模型消耗与参考费用排行</span>
            </div>
            <div class="cr-hist-models" data-role="hist-models">
              <div style="opacity:0.65;font-size:12px;">切换到本页签即可自动加载</div>
            </div>
          </div>
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

    // 双页签切换
    modal.querySelector('[data-role="page-tabs"]').addEventListener('click', (e) => {
      const tabBtn = e.target.closest('[data-tab]');
      if (!tabBtn) return;
      activeSettingsTab = tabBtn.getAttribute('data-tab') || 'appearance';
      for (const b of modal.querySelectorAll('[data-role="page-tabs"] [data-tab]')) {
        b.classList.toggle('is-active', b.getAttribute('data-tab') === activeSettingsTab);
      }
      for (const pane of modal.querySelectorAll('.cr-tab-pane')) {
        pane.classList.toggle('is-active', pane.getAttribute('data-pane') === activeSettingsTab);
      }
      if (activeSettingsTab === 'history') {
        void loadHistoryReportIntoModal(historyPeriod);
      }
    });

    // 历史用量周期切换与刷新
    modal.querySelector('[data-role="hist-period-row"]').addEventListener('click', (e) => {
      const refreshBtn = e.target.closest('[data-role="hist-refresh-btn"]');
      if (refreshBtn) {
        void loadHistoryReportIntoModal(historyPeriod);
        return;
      }
      const periodBtn = e.target.closest('[data-period]');
      if (!periodBtn) return;
      void loadHistoryReportIntoModal(periodBtn.getAttribute('data-period') || '30d');
    });

    // 选择 3 种精选形状
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

    // 上限切换（按当前模型记忆或全局回退）
    modal.querySelector('[data-role="modal-limit-row"]').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-limit]');
      if (!btn) return;
      const nextLimit = Number(btn.getAttribute('data-limit'));
      const allFooters = Array.from(document.body.getElementsByClassName('agy-composer-footer'));
      const footerRef =
        (activeFooterEl && isElementVisible(activeFooterEl) ? activeFooterEl : null) ||
        (lastOpenedFooterEl && isElementVisible(lastOpenedFooterEl) ? lastOpenedFooterEl : null) ||
        allFooters.find((el) => isElementVisible(el)) ||
        allFooters[0] ||
        null;
      const ctx = extractComposerContext(footerRef);
      const cached = ctx.conversationId ? usageCache.get(ctx.conversationId) : null;
      const activeModel = ctx.modelLabel || cached?.modelName || '';
      if (activeModel && activeModel !== 'Model') {
        applySettingPatch({
          contextLimit: 0,
          setModelContextLimit: { modelName: activeModel, limit: nextLimit },
        });
      } else {
        applySettingPatch({ contextLimit: nextLimit });
      }
    });

    // 清除单模型自定义上限
    modal.querySelector('[data-role="modal-custom-limits"]').addEventListener('click', (e) => {
      const clearBtn = e.target.closest('[data-clear-model]');
      if (!clearBtn) return;
      applySettingPatch({
        setModelContextLimit: { modelKey: clearBtn.getAttribute('data-clear-model'), limit: 0 },
      });
    });

    // 压缩后防失忆一键启停
    modal.querySelector('[data-role="modal-rehydrate-btn"]').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const nextEnabled = !rehydrateStatus.enabled;
      btn.disabled = true;
      btn.textContent = nextEnabled ? '启用中...' : '关闭中...';
      try {
        const resp = await callHostRpc('rehydrate.set', { enabled: nextEnabled });
        if (resp && resp.rehydrate) {
          rehydrateStatus = Object.assign({}, rehydrateStatus, resp.rehydrate);
        }
      } finally {
        btn.disabled = false;
        lastPopoverFingerprint = '';
        renderSettingsPageContent();
      }
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
   * 渲染独立样式设置页面内的 3 种动态大号形状卡片、防失忆状态与趋势图
   */
  function renderSettingsPageContent() {
    const modal = getOrCreateSettingsModal();
    modal.classList.toggle('is-dark', isDarkTheme());

    const allFooters = Array.from(document.body.getElementsByClassName('agy-composer-footer'));
    const footerRef =
      (activeFooterEl && isElementVisible(activeFooterEl) ? activeFooterEl : null) ||
      (lastOpenedFooterEl && isElementVisible(lastOpenedFooterEl) ? lastOpenedFooterEl : null) ||
      allFooters.find((el) => isElementVisible(el)) ||
      allFooters[0] ||
      null;
    const { conversationId, modelLabel } = extractComposerContext(footerRef);
    const data =
      (conversationId ? usageCache.get(conversationId) : null) || createEmptyWidgetUsage(modelLabel);
    const resolvedLimit = resolveEffectiveLimitForUi(data, modelLabel);
    const limit = resolvedLimit.limit;
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

    modal.querySelector('[data-role="modal-model-tag"]').textContent =
      `${resolvedLimit.modelName || '全局默认'} · 当前 ${formatCompactTokens(limit)} (${resolvedLimit.source})`;

    for (const btn of modal.querySelectorAll('[data-role="modal-limit-row"] [data-limit]')) {
      const val = Number(btn.getAttribute('data-limit'));
      btn.classList.toggle('is-active', resolvedLimit.auto ? val === 0 : val === limit);
    }

    const customEntries = Object.entries(currentSettings.modelContextLimits || {});
    modal.querySelector('[data-role="modal-custom-limits"]').innerHTML = customEntries.length
      ? customEntries
          .map(
            ([k, v]) =>
              `<span class="cr-limit-tag"><span>${escapeHtml(k)}: ${formatCompactTokens(v)}</span><button type="button" data-clear-model="${escapeHtml(k)}" title="恢复自动上限">×</button></span>`
          )
          .join('')
      : '';

    const rhBtn = modal.querySelector('[data-role="modal-rehydrate-btn"]');
    if (rhBtn) {
      rhBtn.classList.toggle('is-ok', Boolean(rehydrateStatus.enabled));
      rhBtn.textContent = rehydrateStatus.enabled ? '✓ 已开启 · 点击停用' : '未开启 · 一键启用';
    }
    const rhAlert = modal.querySelector('[data-role="modal-rehydrate-alert"]');
    if (rhAlert) {
      if (rehydrateStatus.error) {
        rhAlert.style.display = 'block';
        rhAlert.textContent = `状态异常：${rehydrateStatus.error}`;
      } else if (rehydrateStatus.externalConflict) {
        rhAlert.style.display = 'block';
        rhAlert.textContent = `检测到 hooks.json 已启用同类 Hook (${rehydrateStatus.externalHookName})，建议仅开启其一以避免重复注入。`;
      } else {
        rhAlert.style.display = 'none';
      }
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

    const sp = data.speed;
    const speedSuffix = sp?.displayTps ? ` · ${sp.displayTps.toFixed(1)} tok/s` : '';
    modal.querySelector('[data-role="modal-session-meta"]').textContent =
      `${formatCompactTokens(data.totalTokens || 0)} / ${formatCompactTokens(limit)} · 缓存命中 ${(data.cacheHitRate || 0).toFixed(1)}%${speedSuffix}`;

    const hist = Array.isArray(data.history) ? data.history : [];
    const lastHist = hist.length ? hist[hist.length - 1] : null;
    const trendSig = `${conversationId}|${limit}|${hist.length}|${lastHist?.step || 0}|${lastHist?.totalTokens || 0}`;
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
    void callHostRpc('rehydrate.status', {}).then((resp) => {
      if (resp && resp.ok && resp.rehydrate) {
        rehydrateStatus = Object.assign({}, rehydrateStatus, resp.rehydrate);
        if (isSettingsModalOpen()) renderSettingsPageContent();
      }
    });
    if (activeSettingsTab === 'history') {
      void loadHistoryReportIntoModal(historyPeriod);
    }
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
    void ensureQuotaSummaryFresh(false, footerEl);
    void ensureAvailableModelsFresh(footerEl);
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
    if (pop) {
      closeModelMenu(pop);
      pop.classList.remove('is-open');
    }
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
   * 提取当前输入框对应的纯净模型系列名（优先使用 React 控制器，兜底去除末尾思考等级词）
   */
  function resolveFooterModelFamily(footerEl, fallbackModelLabel = '') {
    const controller = getThinkingEffortController(footerEl);
    if (controller && controller.family) return controller.family;
    const parsed = parseModelFamilyAndEffort(fallbackModelLabel);
    const raw = String(parsed.family || fallbackModelLabel || '').trim();
    if (!raw) return '';
    return raw.replace(/\s+(?:minimal|low|med|medium|high|xhigh|extra\s+high|max|ultra)$/i, '').trim();
  }

  /**
   * 在单个 .agy-composer-footer 模型选择器右侧挂载或更新 W / H 双圆环额度徽章
   */
  function mountOrUpdateFooterQuota(footerEl, fallbackModelLabel = '') {
    let quotaHostEl = footerEl.querySelector(`.${QUOTA_HOST_CLASS}`);

    if (!currentSettings.enabled) {
      if (quotaHostEl) quotaHostEl.remove();
      return;
    }

    const leftGroup = footerEl.children[0] || footerEl;
    if (!leftGroup) return;

    const modelBtn =
      footerEl.querySelector('[data-testid="model-selector-trigger"]') ||
      footerEl.closest?.('.surface-composer-card')?.querySelector?.('[data-testid="model-selector-trigger"]') ||
      null;

    // 向上寻找包含模型选择器的第一层横向 flex 容器（如与第三方测速组件共享的容器），把双圆环紧贴模型按钮右侧插入
    let anchor = modelBtn;
    let targetContainer = leftGroup;
    while (anchor && anchor.parentElement && anchor.parentElement !== leftGroup) {
      const parent = anchor.parentElement;
      const parentDisplay =
        typeof getComputedStyle === 'function' ? String(getComputedStyle(parent)?.display || '') : '';
      if (parentDisplay.includes('flex')) {
        targetContainer = parent;
        break;
      }
      anchor = parent;
    }

    if (!quotaHostEl) {
      quotaHostEl = document.createElement('div');
      quotaHostEl.className = `${QUOTA_HOST_CLASS} cr-quota-pair no-focus-agent-input`;
      quotaHostEl.setAttribute('data-testid', 'context-ring-quota-badges');
      quotaHostEl.setAttribute('role', 'button');
      quotaHostEl.setAttribute('tabindex', '-1');

      quotaHostEl.addEventListener('mouseenter', () => {
        const fam = quotaHostEl.dataset.quotaFamily || '';
        if (fam) showQuotaTip(quotaHostEl, fam);
      });
      quotaHostEl.addEventListener('mouseleave', () => {
        hideQuotaTip();
      });
      quotaHostEl.addEventListener('click', (e) => {
        e.stopPropagation();
        void ensureQuotaSummaryFresh(true, footerEl).then(() => {
          const fam = quotaHostEl.dataset.quotaFamily || '';
          if (fam && quotaHostEl.matches?.(':hover')) {
            showQuotaTip(quotaHostEl, fam);
          }
        });
      });
    }

    if (anchor && anchor.parentElement === targetContainer) {
      const childrenArr = Array.from(targetContainer.children || []);
      const anchorIdx = childrenArr.indexOf(anchor);
      const nextSibling = anchorIdx >= 0 ? childrenArr[anchorIdx + 1] || null : null;
      if (quotaHostEl.parentElement !== targetContainer || nextSibling !== quotaHostEl) {
        targetContainer.insertBefore(quotaHostEl, nextSibling);
      }
    } else if (quotaHostEl.parentElement !== targetContainer) {
      targetContainer.appendChild(quotaHostEl);
    }

    const familyName = resolveFooterModelFamily(footerEl, fallbackModelLabel);
    const dark = isDarkTheme();
    const renderSig = `${familyName}|${quotaCacheVersion}|${dark ? 1 : 0}`;
    if (quotaHostEl.dataset.renderSig !== renderSig) {
      quotaHostEl.dataset.renderSig = renderSig;
      quotaHostEl.dataset.quotaFamily = familyName;
      const qVis = buildQuotaPairVisual(familyName, 16, dark);
      quotaHostEl.innerHTML = qVis.html;
      quotaHostEl.setAttribute(
        'aria-label',
        qVis.tooltip ? `${familyName} ${qVis.tooltip}` : `${familyName || '当前模型'} 额度`
      );
    }
  }

  /**
   * 刷新页面上全部输入框底栏中的 W / H 额度双圆环
   */
  function refreshAllFooterQuotaBadges() {
    if (!document.body) return;
    const footers = Array.from(document.body.getElementsByClassName('agy-composer-footer'));
    for (const footerEl of footers) {
      if (!document.body.contains(footerEl)) continue;
      mountOrUpdateFooterQuota(footerEl);
    }
  }

  /**
   * 在单个 .agy-composer-footer 内挂载或更新监控按钮
   */
  function mountOrUpdateFooter(footerEl, usageData, activeModelLabel = '') {
    let hostEl = footerEl.querySelector(`.${HOST_CLASS}`);

    if (!currentSettings.enabled) {
      if (hostEl) hostEl.remove();
      mountOrUpdateFooterQuota(footerEl, activeModelLabel);
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

    const resolvedLimit = resolveEffectiveLimitForUi(usageData, usageData?.modelName || '');
    const limit = resolvedLimit.limit;
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
      pctText.textContent = pct <= 0 ? '0%' : pct >= 10 ? `${Math.round(pct)}%` : `${pct.toFixed(1)}%`;
      pctText.style.display = currentSettings.showPercentText ? '' : 'none';
    }

    mountOrUpdateFooterQuota(footerEl, activeModelLabel || usageData?.modelName || '');

    return true;
  }

  /**
   * 扫描页面上全部输入框底栏并刷新上下文统计（使用 getElementsByClassName 规避其他插件对 querySelectorAll 的劫持）
   */
  let remoteFetchInFlight = false;
  async function syncAllComposerFooters(fetchRemote = true) {
    if (!document.body) return;
    ensureStylesInjected();

    const footers = Array.from(document.body.getElementsByClassName('agy-composer-footer'));
    let mountedCount = 0;
    let visibleDetectedCid = '';
    let hasVisibleFooter = false;
    let fallbackDetectedCid = '';
    let needsImmediateRemoteFetch = false;

    for (const footerEl of footers) {
      if (!document.body.contains(footerEl)) continue;
      const initialCtx = extractComposerContext(footerEl);
      let activeCid = initialCtx.conversationId;
      let activeModel = initialCtx.modelLabel;

      if (activeCid) {
        if (fetchRemote && currentSettings.enabled) {
          const resp = await callHostRpc('usage.get', { conversationId: activeCid, modelName: activeModel });
          if (resp && resp.ok && resp.usage) {
            const respCid = String(resp.usage.conversationId || '').trim();
            if (!respCid || respCid === activeCid) {
              usageCache.set(activeCid, resp.usage);
            }
            if (resp.settings) {
              currentSettings = Object.assign({}, currentSettings, resp.settings, {
                styleMode: normalizeWidgetStyle(resp.settings.styleMode ?? currentSettings.styleMode),
                modelContextLimits:
                  resp.settings.modelContextLimits && typeof resp.settings.modelContextLimits === 'object'
                    ? Object.assign({}, resp.settings.modelContextLimits)
                    : Object.assign({}, currentSettings.modelContextLimits || {}),
              });
            }
            if (resp.rehydrate && typeof resp.rehydrate === 'object') {
              rehydrateStatus = Object.assign({}, rehydrateStatus, resp.rehydrate);
            }
          } else if (!usageCache.has(activeCid) && window.__CONTEXT_RING_SEED_USAGE__) {
            const seed = window.__CONTEXT_RING_SEED_USAGE__;
            if (seed && seed.conversationId && seed.conversationId === activeCid) {
              usageCache.set(activeCid, seed);
            }
          }

          // RPC 异步返回后重新核验当前输入框会话 ID，防止切换会话瞬间旧请求回写覆盖新空白窗口
          if (!document.body.contains(footerEl)) continue;
          const latestCtx = extractComposerContext(footerEl);
          activeCid = latestCtx.conversationId;
          activeModel = latestCtx.modelLabel || activeModel;
        } else if (currentSettings.enabled && !usageCache.has(activeCid)) {
          needsImmediateRemoteFetch = true;
        }
      }

      const visible = isElementVisible(footerEl);
      if (visible) {
        if (!hasVisibleFooter) {
          hasVisibleFooter = true;
          visibleDetectedCid = activeCid;
        } else if (!visibleDetectedCid && activeCid) {
          visibleDetectedCid = activeCid;
        }
      } else if (!fallbackDetectedCid && activeCid) {
        fallbackDetectedCid = activeCid;
      }

      // 空白新会话（activeCid 为空）严格渲染 0%，绝不读取任何缓存或历史会话
      const renderUsage = activeCid
        ? usageCache.get(activeCid) || createEmptyWidgetUsage(activeModel)
        : createEmptyWidgetUsage(activeModel);
      if (mountOrUpdateFooter(footerEl, renderUsage, activeModel)) {
        mountedCount++;
      }
      if (fetchRemote && currentSettings.enabled) {
        void ensureQuotaSummaryFresh(false, footerEl);
      }
    }

    let detectedCid = hasVisibleFooter ? visibleDetectedCid : fallbackDetectedCid;
    if (!detectedCid && !hasVisibleFooter) {
      const match = String(location.pathname || '').match(/^\/c\/([a-zA-Z0-9_-]{8,128})/);
      if (match) detectedCid = match[1];
    }

    window.__CONTEXT_RING_MOUNTED_COUNT__ = mountedCount;
    window.__CONTEXT_RING_ACTIVE_CID__ = detectedCid;

    if (activeFooterEl && !document.body.contains(activeFooterEl)) {
      closePopoverNow();
    } else if (activeFooterEl) {
      renderPopoverData(activeFooterEl, false);
    }
    if (isSettingsModalOpen() && settingsPreviewPct === null) {
      renderSettingsPageContent();
    }

    if (needsImmediateRemoteFetch && !fetchRemote && !remoteFetchInFlight) {
      remoteFetchInFlight = true;
      void syncAllComposerFooters(true).finally(() => {
        remoteFetchInFlight = false;
      });
    }
  }

  // 点击外部空白处关闭已固定的详情卡片
  function onDocumentPointerDown(e) {
    const pop = document.getElementById(POPOVER_ID);
    if (!pop || !pop.classList.contains('is-open')) return;
    if (pop.contains(e.target) || e.target.closest(`.${HOST_CLASS}`)) return;
    closePopoverNow();
  }

  // 按 Esc 快速退出设置页、模型下拉菜单或悬浮卡片
  function onDocumentKeyDown(e) {
    if (e.key !== 'Escape') return;
    if (isSettingsModalOpen()) {
      closeSettingsPage();
      return;
    }
    const pop = document.getElementById(POPOVER_ID);
    const modelMenu = pop?.querySelector('[data-role="model-menu"]');
    if (modelMenu?.classList.contains('is-open')) {
      closeModelMenu(pop);
      return;
    }
    if (activeFooterEl) {
      closePopoverNow();
    }
  }

  function onRouteNavigation() {
    void syncAllComposerFooters(true);
  }

  document.addEventListener('pointerdown', onDocumentPointerDown);
  document.addEventListener('keydown', onDocumentKeyDown);
  window.addEventListener('popstate', onRouteNavigation);
  window.addEventListener('hashchange', onRouteNavigation);

  let domSyncTimer = null;
  const domObserver = new MutationObserver((records) => {
    // 忽略本插件自身弹窗、卡片和按钮内部的 DOM 变动，避免连锁触发全页扫描
    const hasExternalMutation = records.some((rec) => {
      const target = rec.target;
      if (!target || target.nodeType !== 1) return false;
      if (
        target.closest?.(`#${SETTINGS_MODAL_ID}`) ||
        target.closest?.(`#${POPOVER_ID}`) ||
        target.closest?.(`.${HOST_CLASS}`) ||
        target.closest?.(`.${QUOTA_HOST_CLASS}`)
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
  setTimeout(() => {
    const firstFooter = document.body && document.body.getElementsByClassName('agy-composer-footer')[0];
    if (firstFooter) {
      void ensureQuotaSummaryFresh(false, firstFooter);
      void ensureAvailableModelsFresh(firstFooter);
    }
  }, 400);

  /**
   * 暴露给 Sidecar 面板远程调用的一键执行 /compact 入口
   */
  window.__CONTEXT_RING_TRIGGER_COMPACT__ = async function triggerCompactFromHost() {
    const targetFooter =
      activeFooterEl ||
      lastOpenedFooterEl ||
      (document.body && document.body.getElementsByClassName('agy-composer-footer')[0]) ||
      null;
    return executeCompactCommand(targetFooter);
  };

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
    window.removeEventListener('popstate', onRouteNavigation);
    window.removeEventListener('hashchange', onRouteNavigation);

    for (const item of pendingRpc.values()) {
      clearTimeout(item.timer);
    }
    pendingRpc.clear();

    document.getElementById(SETTINGS_MODAL_ID)?.remove();
    document.getElementById(QUOTA_TIP_ID)?.remove();
    document.getElementById(POPOVER_ID)?.remove();
    document.getElementById(STYLE_TAG_ID)?.remove();
    if (document.body) {
      for (const el of Array.from(document.body.getElementsByClassName(HOST_CLASS))) {
        el.remove();
      }
      for (const el of Array.from(document.body.getElementsByClassName(QUOTA_HOST_CLASS))) {
        el.remove();
      }
    }

    delete window.__CONTEXT_RING_TRIGGER_COMPACT__;
    delete window.__contextRingReceiveRehydrate;
    window.__CONTEXT_RING_INSTALLED__ = false;
    window.__CONTEXT_RING_MOUNTED_COUNT__ = 0;
  };
})();

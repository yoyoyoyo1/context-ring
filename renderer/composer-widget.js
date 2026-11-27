/**
 * Context Ring — 无侵入多形态输入框上下文监控组件
 *
 * 特点：
 * 1. 零 DOM 原型污染（不修改 document.querySelectorAll），与其他插件安全共存；
 * 2. 通过 CDP Runtime.addBinding ('__contextRingHost') 零端口获取实时会话数据与同步设置；
 * 3. 内置 5 种可切换形态：ring（细环）、donut（甜甜圈）、caterpillar（毛毛虫）、bottle（玻璃水瓶装水）、capsule（液态胶囊）；
 * 4. 内置悬停/点击详情浮窗：支持查看缓存命中率、切换形态、切换 256k/512k/1M 上限及一键复制 /compact。
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
  const HOST_CLASS = 'agy-context-ring-host';

  const STYLE_OPTIONS = [
    { id: 'ring', label: '细环' },
    { id: 'donut', label: '甜甜圈' },
    { id: 'caterpillar', label: '毛毛虫' },
    { id: 'bottle', label: '玻璃瓶' },
    { id: 'capsule', label: '胶囊' },
  ];

  const LIMIT_OPTIONS = [
    { value: 256000, label: '256k' },
    { value: 512000, label: '512k' },
    { value: 1000000, label: '1M' },
  ];

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
  let popoverPinned = false;
  let hidePopoverTimer = null;
  let lastPopoverFingerprint = '';

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
    currentSettings = Object.assign({}, currentSettings, nextSettings);
    lastPopoverFingerprint = '';
    syncAllComposerFooters(false);
    if (activeFooterEl) {
      renderPopoverData(activeFooterEl, true);
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
   * 注入组件与详情浮窗所需的全部样式与动画关键帧
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
        transition: background-color 0.16s ease, border-color 0.16s ease, color 0.16s ease, transform 0.12s ease;
      }
      .cr-trigger-btn:hover,
      .cr-trigger-btn.is-open {
        background: var(--secondary, rgba(148, 163, 184, 0.14));
        color: var(--foreground, #0f172a);
      }
      .cr-trigger-btn[data-level="warn"] .cr-pct-text {
        color: #d97706;
      }
      .dark .cr-trigger-btn[data-level="warn"] .cr-pct-text {
        color: #fbbf24;
      }
      .cr-trigger-btn[data-level="danger"] .cr-pct-text {
        color: #dc2626;
      }
      .dark .cr-trigger-btn[data-level="danger"] .cr-pct-text {
        color: #f87171;
      }
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
        .cr-pct-text {
          display: none !important;
        }
        .cr-trigger-btn {
          padding: 0 5px;
        }
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

      .cr-anim-on .cr-wave-front {
        animation: cr-wave-shift 2.2s linear infinite;
      }
      .cr-anim-on .cr-wave-back {
        animation: cr-wave-shift 3.4s linear infinite reverse;
      }
      .cr-anim-on .cr-bubble-1 {
        animation: cr-bubble-up 2.4s ease-in infinite;
      }
      .cr-anim-on .cr-bubble-2 {
        animation: cr-bubble-up 2.9s ease-in 1.1s infinite;
      }
      .cr-anim-on .cr-bug-seg {
        transform-box: fill-box;
        transform-origin: center;
        animation: cr-bug-pulse 1.6s ease-in-out infinite;
      }
      .cr-anim-on .cr-ring-core {
        transform-origin: center;
        animation: cr-core-pulse 2.2s ease-in-out infinite;
      }

      /* 悬浮详情卡片 */
      #${POPOVER_ID} {
        position: fixed;
        left: 0;
        top: 0;
        z-index: 99995;
        width: 288px;
        padding: 12px 13px;
        border-radius: 14px;
        border: 1px solid rgba(148, 163, 184, 0.24);
        background: rgba(255, 255, 255, 0.97);
        color: #0f172a;
        box-shadow: 0 14px 34px rgba(15, 23, 42, 0.14), 0 3px 10px rgba(15, 23, 42, 0.06);
        backdrop-filter: blur(14px);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        font-size: 12px;
        opacity: 0;
        pointer-events: none;
        transform: translateY(5px) scale(0.985);
        transition: opacity 0.15s ease, transform 0.15s cubic-bezier(0.16, 1, 0.3, 1);
      }
      #${POPOVER_ID}.is-dark {
        border-color: rgba(148, 163, 184, 0.2);
        background: rgba(20, 24, 33, 0.96);
        color: #f1f5f9;
        box-shadow: 0 16px 38px rgba(0, 0, 0, 0.5), 0 3px 10px rgba(0, 0, 0, 0.3);
      }
      #${POPOVER_ID}.is-open {
        opacity: 1;
        pointer-events: auto;
        transform: translateY(0) scale(1);
      }
      .cr-pop-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        margin-bottom: 4px;
      }
      .cr-pop-title {
        font-size: 12.5px;
        font-weight: 700;
        letter-spacing: -0.01em;
      }
      .cr-pop-pct {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 15px;
        font-weight: 700;
      }
      .cr-pop-sub {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        font-size: 11px;
        opacity: 0.78;
        margin-bottom: 9px;
      }
      .cr-pop-model {
        max-width: 132px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        padding: 1px 6px;
        border-radius: 999px;
        background: rgba(148, 163, 184, 0.16);
        font-size: 10.5px;
      }
      .cr-pop-bar {
        display: flex;
        height: 6px;
        width: 100%;
        border-radius: 999px;
        overflow: hidden;
        background: rgba(148, 163, 184, 0.2);
        margin-bottom: 10px;
      }
      .cr-seg-cache { background: #10b981; transition: width 0.28s ease; }
      .cr-seg-input { background: #0ea5e9; transition: width 0.28s ease; }
      .cr-seg-output { background: #8b5cf6; transition: width 0.28s ease; }
      .cr-pop-rows {
        display: grid;
        grid-template-columns: 10px 1fr auto;
        align-items: center;
        row-gap: 5px;
        column-gap: 6px;
        font-size: 11.5px;
        margin-bottom: 10px;
      }
      .cr-dot {
        width: 7px;
        height: 7px;
        border-radius: 999px;
      }
      .cr-row-val {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 11px;
        font-weight: 600;
      }
      .cr-style-strip {
        display: grid;
        grid-template-columns: repeat(5, 1fr);
        gap: 3px;
        padding: 3px;
        border-radius: 9px;
        background: rgba(148, 163, 184, 0.13);
        margin-bottom: 8px;
      }
      .cr-style-btn {
        border: none;
        background: transparent;
        color: inherit;
        opacity: 0.72;
        font-size: 10.5px;
        font-weight: 600;
        padding: 4px 2px;
        border-radius: 6px;
        cursor: pointer;
        transition: background-color 0.14s ease, opacity 0.14s ease;
      }
      .cr-style-btn:hover {
        opacity: 1;
      }
      .cr-style-btn.is-active {
        opacity: 1;
        background: rgba(14, 165, 233, 0.18);
        color: #0284c7;
      }
      #${POPOVER_ID}.is-dark .cr-style-btn.is-active {
        background: rgba(56, 189, 248, 0.22);
        color: #7dd3fc;
      }
      .cr-pop-foot {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
      }
      .cr-limit-group {
        display: inline-flex;
        gap: 2px;
        padding: 2px;
        border-radius: 7px;
        background: rgba(148, 163, 184, 0.14);
      }
      .cr-limit-btn {
        border: none;
        background: transparent;
        color: inherit;
        opacity: 0.7;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 10.5px;
        font-weight: 600;
        padding: 3px 7px;
        border-radius: 5px;
        cursor: pointer;
      }
      .cr-limit-btn.is-active {
        opacity: 1;
        background: rgba(16, 185, 129, 0.2);
        color: #059669;
      }
      #${POPOVER_ID}.is-dark .cr-limit-btn.is-active {
        background: rgba(16, 185, 129, 0.26);
        color: #6ee7b7;
      }
      .cr-compact-btn {
        border: 1px solid rgba(148, 163, 184, 0.28);
        background: transparent;
        color: inherit;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 10.5px;
        font-weight: 600;
        padding: 3px 8px;
        border-radius: 7px;
        cursor: pointer;
        transition: background-color 0.14s ease;
      }
      .cr-compact-btn:hover {
        background: rgba(148, 163, 184, 0.16);
      }
    `;
    document.head.appendChild(styleEl);
  }

  /**
   * 渲染 5 种形态的矢量 SVG 图形字符串
   */
  function buildShapeSvg(styleMode, pct, cacheHitRate, colors, uid) {
    const clamped = Math.max(0, Math.min(100, pct));
    const dark = isDarkTheme();
    const trackStroke = dark ? 'rgba(148, 163, 184, 0.25)' : 'rgba(100, 116, 139, 0.22)';

    // 1. 极简细环（Ring）
    if (styleMode === 'ring') {
      const r = 7;
      const c = 2 * Math.PI * r;
      const offset = c * (1 - clamped / 100);
      return `
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
          <circle cx="9" cy="9" r="${r}" stroke="${trackStroke}" stroke-width="1.9"/>
          <circle cx="9" cy="9" r="${r}" stroke="${colors.main}" stroke-width="2.1"
            stroke-linecap="round" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"
            transform="rotate(-90 9 9)"/>
          <circle class="cr-ring-core" cx="9" cy="9" r="2.0" fill="${colors.main}"/>
        </svg>
      `;
    }

    // 2. 双层甜甜圈（Donut：外层总上下文糖霜 + 内层缓存命中率翠绿环）
    if (styleMode === 'donut') {
      const outerR = 6.3;
      const outerC = 2 * Math.PI * outerR;
      const outerOff = outerC * (1 - clamped / 100);
      const innerR = 3.4;
      const innerC = 2 * Math.PI * innerR;
      const cacheClamped = Math.max(0, Math.min(100, Number(cacheHitRate || 0)));
      const innerOff = innerC * (1 - cacheClamped / 100);
      return `
        <svg width="19" height="19" viewBox="0 0 20 20" fill="none" aria-hidden="true">
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

      // 未走到的圆弧区域绘制轻柔圆点轨道，保持完整圆环视觉
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

      // 从虫尾到虫颈依次叠画圆润身体节段（越靠近虫头越饱满）
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
        <svg width="20" height="20" viewBox="0 0 22 22" fill="none" aria-hidden="true">
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
      const innerWidth = Math.max(clamped > 0 ? 2.5 : 0, (24 * clamped) / 100);
      const clipId = `cr-cap-${uid}`;
      return `
        <svg width="28" height="14" viewBox="0 0 28 14" fill="none" aria-hidden="true">
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

    // 5. 默认经典款：玻璃水瓶装水（Bottle：透明瓶身 + 双层晃动波浪液面 + 上升小气泡 + 玻璃折射高光）
    const clipId = `cr-btl-${uid}`;
    const gradId = `cr-liq-${uid}`;
    // 瓶内有效液面高度范围：y 从 17.5（空瓶）到 6.0（满瓶）
    const liquidTopY = 17.5 - (11.5 * clamped) / 100;
    const glassStroke = dark ? 'rgba(203, 213, 225, 0.52)' : 'rgba(71, 85, 105, 0.45)';
    const corkColor = dark ? '#d97706' : '#b45309';
    const showBubbles = clamped >= 10;

    return `
      <svg width="18" height="20" viewBox="0 0 18 20" fill="none" aria-hidden="true">
        <defs>
          <clipPath id="${clipId}">
            <rect x="3.1" y="5.8" width="11.8" height="12.0" rx="4.6"/>
          </clipPath>
          <linearGradient id="${gradId}" x1="9" y1="6" x2="9" y2="18" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stop-color="${colors.soft}"/>
            <stop offset="100%" stop-color="${colors.main}"/>
          </linearGradient>
        </defs>
        <!-- 软木瓶塞与瓶颈 -->
        <rect x="6.7" y="1.0" width="4.6" height="2.1" rx="0.8" fill="${corkColor}"/>
        <path d="M6.2 3.1 H11.8 V5.4 H6.2 Z" stroke="${glassStroke}" stroke-width="1.15" fill="rgba(148,163,184,0.08)"/>
        <!-- 瓶内晃动液体与气泡 -->
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
        <!-- 玻璃瓶外轮廓与左侧高光折射条 -->
        <rect x="2.6" y="5.3" width="12.8" height="13.0" rx="5.0" stroke="${glassStroke}" stroke-width="1.25"/>
        <path d="M5.0 7.6 C4.4 9.2 4.4 13.0 5.0 15.2" stroke="#ffffff" stroke-opacity="${dark ? '0.42' : '0.68'}" stroke-width="1.05" stroke-linecap="round"/>
      </svg>
    `;
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

    // URL 路径兜底提取 /c/<conversationId>
    if (!conversationId) {
      const pathMatch = String(location.pathname || '').match(/^\/c\/([a-zA-Z0-9_-]{8,128})/);
      if (pathMatch) {
        conversationId = pathMatch[1];
      }
    }

    // 模型触发器文本兜底
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
   * 创建或获取全局唯一的悬浮详情卡片
   */
  function getOrCreatePopover() {
    let pop = document.getElementById(POPOVER_ID);
    if (pop) return pop;

    pop = document.createElement('div');
    pop.id = POPOVER_ID;
    pop.className = 'no-focus-agent-input';
    pop.innerHTML = `
      <div class="cr-pop-head">
        <span class="cr-pop-title">Context Ring 上下文窗口</span>
        <span class="cr-pop-pct" data-role="pct">0.0%</span>
      </div>
      <div class="cr-pop-sub">
        <span data-role="summary">0 / 512k tokens</span>
        <span class="cr-pop-model" data-role="model">Model</span>
      </div>
      <div class="cr-pop-bar">
        <div class="cr-seg-cache" data-role="seg-cache" style="width:0%"></div>
        <div class="cr-seg-input" data-role="seg-input" style="width:0%"></div>
        <div class="cr-seg-output" data-role="seg-output" style="width:0%"></div>
      </div>
      <div class="cr-pop-rows">
        <span class="cr-dot" style="background:#10b981"></span>
        <span>缓存命中</span>
        <span class="cr-row-val" data-role="val-cache">0 (0%)</span>

        <span class="cr-dot" style="background:#0ea5e9"></span>
        <span>本轮新增输入</span>
        <span class="cr-row-val" data-role="val-input">0</span>

        <span class="cr-dot" style="background:#8b5cf6"></span>
        <span>本轮 / 累计输出</span>
        <span class="cr-row-val" data-role="val-output">0 / 0</span>

        <span class="cr-dot" style="background:#94a3b8"></span>
        <span>对话轮次 / 步数</span>
        <span class="cr-row-val" data-role="val-steps">0 轮 · 0 步</span>
      </div>
      <div class="cr-style-strip" data-role="style-strip">
        ${STYLE_OPTIONS.map((opt) => `<button type="button" class="cr-style-btn" data-style="${opt.id}">${opt.label}</button>`).join('')}
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

    // 在浮窗中一键切换 5 种视觉样式并同步持久化
    pop.querySelector('[data-role="style-strip"]').addEventListener('click', (e) => {
      e.stopPropagation();
      const btn = e.target.closest('.cr-style-btn');
      if (!btn) return;
      const nextStyle = btn.getAttribute('data-style');
      if (!nextStyle) return;
      currentSettings = Object.assign({}, currentSettings, { styleMode: nextStyle });
      lastPopoverFingerprint = '';
      syncAllComposerFooters(false);
      if (activeFooterEl) renderPopoverData(activeFooterEl, true);
      void callHostRpc('settings.set', { patch: { styleMode: nextStyle } });
    });

    // 在浮窗中切换 256k / 512k / 1M 上限并同步持久化
    pop.querySelector('[data-role="limit-group"]').addEventListener('click', (e) => {
      e.stopPropagation();
      const btn = e.target.closest('.cr-limit-btn');
      if (!btn) return;
      const nextLimit = Number(btn.getAttribute('data-limit'));
      if (!nextLimit) return;
      currentSettings = Object.assign({}, currentSettings, { contextLimit: nextLimit });
      lastPopoverFingerprint = '';
      syncAllComposerFooters(false);
      if (activeFooterEl) renderPopoverData(activeFooterEl, true);
      void callHostRpc('settings.set', { patch: { contextLimit: nextLimit } });
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
      currentSettings.styleMode,
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
        `${formatCompactTokens(total)} / ${formatCompactTokens(limit)} tokens`;
      pop.querySelector('[data-role="model"]').textContent =
        modelLabel || data.modelName || 'Model';

      const denom = Math.max(limit, total, 1);
      pop.querySelector('[data-role="seg-cache"]').style.width = `${Math.min(100, (cacheRead / denom) * 100).toFixed(2)}%`;
      pop.querySelector('[data-role="seg-input"]').style.width = `${Math.min(100, (freshInput / denom) * 100).toFixed(2)}%`;
      pop.querySelector('[data-role="seg-output"]').style.width = `${Math.min(100, (outTokens / denom) * 100).toFixed(2)}%`;

      pop.querySelector('[data-role="val-cache"]').textContent = `${formatExactNumber(cacheRead)} (${hitRate.toFixed(1)}%)`;
      pop.querySelector('[data-role="val-input"]').textContent = formatExactNumber(freshInput);
      pop.querySelector('[data-role="val-output"]').textContent = `${formatCompactTokens(outTokens)} / ${formatCompactTokens(cumOut)}`;
      pop.querySelector('[data-role="val-steps"]').textContent = `${Number(data.turnCount || 0)} 轮 · ${Number(data.plannerStepCount || 0)} 步`;

      for (const btn of pop.querySelectorAll('.cr-style-btn')) {
        btn.classList.toggle('is-active', btn.getAttribute('data-style') === currentSettings.styleMode);
      }
      for (const btn of pop.querySelectorAll('.cr-limit-btn')) {
        btn.classList.toggle('is-active', Number(btn.getAttribute('data-limit')) === limit);
      }
    }

    // 紧贴触发按钮上方居中对齐，并做视口边界防溢出裁剪
    const hostEl = footerEl?.querySelector(`.${HOST_CLASS}`);
    if (hostEl) {
      const rect = hostEl.getBoundingClientRect();
      const popWidth = 288;
      const popHeight = pop.offsetHeight || 226;
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
   * 展开指定输入框对应的详情卡片
   */
  function openPopover(footerEl, pinOpen) {
    if (hidePopoverTimer) {
      clearTimeout(hidePopoverTimer);
      hidePopoverTimer = null;
    }
    activeFooterEl = footerEl;
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

    // 若插件被设置为禁用，移除已挂载节点
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

    // 选择左侧或右侧工具容器挂载，避免打乱发送/录音按钮顺序
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
      slot.innerHTML = buildShapeSvg(currentSettings.styleMode, pct, hitRate, colors, uid);
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
  }

  // 点击外部空白处关闭已固定的详情卡片
  function onDocumentPointerDown(e) {
    const pop = document.getElementById(POPOVER_ID);
    if (!pop || !pop.classList.contains('is-open')) return;
    if (pop.contains(e.target) || e.target.closest(`.${HOST_CLASS}`)) return;
    closePopoverNow();
  }

  document.addEventListener('pointerdown', onDocumentPointerDown);

  // 监听会话切换或新建输入框 DOM 变动，防抖挂载
  let domSyncTimer = null;
  const domObserver = new MutationObserver(() => {
    if (domSyncTimer) return;
    domSyncTimer = setTimeout(() => {
      domSyncTimer = null;
      void syncAllComposerFooters(false);
    }, 180);
  });

  if (document.body) {
    domObserver.observe(document.body, { childList: true, subtree: true });
  }

  // 定时向 Node 宿主同步最新 transcript 增量数据
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
    domObserver.disconnect();
    document.removeEventListener('pointerdown', onDocumentPointerDown);

    for (const item of pendingRpc.values()) {
      clearTimeout(item.timer);
    }
    pendingRpc.clear();

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

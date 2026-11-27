/**
 * 生成右侧 Sidecar 实时监控与可视化样式工坊页面 HTML
 */
export function renderSidecarDashboardHtml(options = {}) {
  const version = options.version || '1.0.0';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Context Ring 上下文工坊</title>
  <script src="/preload.js"></script>
  <style>
    :root {
      --bg: #f8fafc;
      --card: #ffffff;
      --border: rgba(148, 163, 184, 0.24);
      --text: #0f172a;
      --muted: #64748b;
      --accent: #0ea5e9;
      --accent-soft: rgba(14, 165, 233, 0.12);
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0f131a;
        --card: #171d27;
        --border: rgba(148, 163, 184, 0.16);
        --text: #f1f5f9;
        --muted: #94a3b8;
        --accent: #38bdf8;
        --accent-soft: rgba(56, 189, 248, 0.16);
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 14px;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      font-size: 13px;
      line-height: 1.5;
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 15px;
      font-weight: 700;
    }
    .ver {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 7px;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent);
    }
    .banner {
      padding: 10px 12px;
      border-radius: 11px;
      border: 1px solid var(--border);
      background: var(--card);
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      display: inline-block;
      margin-right: 6px;
      background: #10b981;
    }
    .status-dot.warn { background: #f59e0b; }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 13px;
      padding: 13px;
      margin-bottom: 12px;
    }
    .card-title {
      font-size: 12.5px;
      font-weight: 700;
      margin: 0 0 10px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .hero-stage {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 8px 4px 12px;
    }
    .preview-box {
      width: 84px;
      height: 84px;
      border-radius: 18px;
      background: var(--accent-soft);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .hero-metrics {
      flex: 1;
      min-width: 0;
    }
    .big-pct {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 26px;
      font-weight: 800;
      line-height: 1.1;
    }
    .sub-line {
      color: var(--muted);
      font-size: 12px;
      margin-top: 4px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .stack-bar {
      display: flex;
      height: 8px;
      border-radius: 999px;
      overflow: hidden;
      background: rgba(148, 163, 184, 0.2);
      margin-top: 10px;
    }
    .seg-cache { background: #10b981; transition: width 0.3s ease; }
    .seg-input { background: #0ea5e9; transition: width 0.3s ease; }
    .seg-output { background: #8b5cf6; transition: width 0.3s ease; }
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 8px;
      margin-top: 10px;
    }
    .kpi {
      padding: 8px 10px;
      border-radius: 10px;
      border: 1px solid var(--border);
    }
    .kpi-label {
      font-size: 11px;
      color: var(--muted);
    }
    .kpi-val {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 14px;
      font-weight: 700;
      margin-top: 2px;
    }
    .style-grid {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      gap: 6px;
      margin-bottom: 12px;
    }
    .opt-btn {
      border: 1px solid var(--border);
      background: transparent;
      color: var(--text);
      padding: 8px 4px;
      border-radius: 10px;
      font-size: 11.5px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      transition: border-color 0.15s ease, background-color 0.15s ease;
    }
    .opt-btn:hover {
      border-color: var(--accent);
    }
    .opt-btn.active {
      border-color: var(--accent);
      background: var(--accent-soft);
      color: var(--accent);
    }
    .row-ctrl {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 7px 0;
      border-top: 1px solid var(--border);
      gap: 8px;
    }
    .pill-group {
      display: inline-flex;
      gap: 4px;
    }
    .pill-btn {
      border: 1px solid var(--border);
      background: transparent;
      color: var(--text);
      font-size: 11px;
      font-weight: 600;
      padding: 4px 9px;
      border-radius: 999px;
      cursor: pointer;
    }
    .pill-btn.active {
      border-color: var(--accent);
      background: var(--accent-soft);
      color: var(--accent);
    }
    .chart-bars {
      display: flex;
      align-items: flex-end;
      gap: 3px;
      height: 76px;
      padding-top: 8px;
    }
    .bar-col {
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
    .bar-in { background: #0ea5e9; }
    .bar-ca { background: #10b981; }
    .hint-code {
      display: block;
      margin-top: 6px;
      padding: 6px 8px;
      border-radius: 7px;
      background: rgba(148, 163, 184, 0.14);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11px;
      word-break: break-all;
    }
    @keyframes waveSlide {
      0% { transform: translateX(0); }
      100% { transform: translateX(-28px); }
    }
    .anim-wave { animation: waveSlide 2.4s linear infinite; }
  </style>
</head>
<body>
  <div class="header">
    <div class="brand">
      <span>Context Ring 工坊</span>
      <span class="ver">v${version}</span>
    </div>
    <button class="pill-btn" id="copyCompactBtn" type="button">执行 /compact</button>
  </div>

  <div class="banner" id="cdpBanner">
    <div>
      <span class="status-dot" id="statusDot"></span>
      <strong id="statusTitle">正在检查输入框连接...</strong>
      <div id="statusDesc" style="font-size:11.5px;color:var(--muted);margin-top:2px;"></div>
    </div>
    <button class="pill-btn" id="fixShortcutBtn" type="button" style="display:none;flex-shrink:0;">修复快捷方式</button>
  </div>

  <div class="card">
    <div class="card-title">
      <span>实时上下文预览</span>
      <span id="modelTag" style="font-size:11px;color:var(--muted);font-weight:500;">--</span>
    </div>
    <div class="hero-stage">
      <div class="preview-box" id="bigPreview"></div>
      <div class="hero-metrics">
        <div class="big-pct" id="bigPct">0.0%</div>
        <div class="sub-line" id="tokenSummary">0 / 512k tokens</div>
        <div class="stack-bar">
          <div class="seg-cache" id="barCache" style="width:0%"></div>
          <div class="seg-input" id="barInput" style="width:0%"></div>
          <div class="seg-output" id="barOutput" style="width:0%"></div>
        </div>
      </div>
    </div>
    <div class="kpi-grid">
      <div class="kpi">
        <div class="kpi-label">缓存命中率</div>
        <div class="kpi-val" id="kpiCache">0%</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">本轮新增输入</div>
        <div class="kpi-val" id="kpiInput">0</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">累计模型输出</div>
        <div class="kpi-val" id="kpiOutput">0</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">轮次 / 步数</div>
        <div class="kpi-val" id="kpiSteps">0 / 0</div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-title">
      <span>样式定制（点击即时同步到输入框）</span>
    </div>
    <div class="style-grid" id="styleGrid">
      <button type="button" class="opt-btn" data-style="ring"><span>⭕</span><span>细环</span></button>
      <button type="button" class="opt-btn" data-style="donut"><span>🍩</span><span>甜甜圈</span></button>
      <button type="button" class="opt-btn" data-style="caterpillar"><span>🐛</span><span>毛毛虫</span></button>
      <button type="button" class="opt-btn" data-style="bottle"><span>🧪</span><span>玻璃瓶</span></button>
      <button type="button" class="opt-btn" data-style="capsule"><span>💊</span><span>胶囊</span></button>
    </div>

    <div class="row-ctrl">
      <span>上下文窗口上限</span>
      <div class="pill-group" id="limitGroup">
        <button type="button" class="pill-btn" data-limit="256000">256k</button>
        <button type="button" class="pill-btn" data-limit="512000">512k</button>
        <button type="button" class="pill-btn" data-limit="1000000">1M</button>
      </div>
    </div>

    <div class="row-ctrl">
      <span>挂载位置与显示</span>
      <div class="pill-group">
        <button type="button" class="pill-btn" id="togglePctBtn">显示百分比</button>
        <button type="button" class="pill-btn" id="toggleAnimBtn">动态波浪</button>
        <button type="button" class="pill-btn" id="togglePlaceBtn">靠右</button>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-title">
      <span>近 30 步上下文趋势（绿=缓存 / 蓝=新输入）</span>
    </div>
    <div class="chart-bars" id="historyChart"></div>
  </div>

  <script>
    const urlParams = new URLSearchParams(location.search);
    const uiToken = urlParams.get('token') || '';
    let latestState = null;

    function apiUrl(p) {
      return uiToken ? p + (p.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(uiToken) : p;
    }

    function apiHeaders(extra) {
      const h = Object.assign({ 'Content-Type': 'application/json' }, extra || {});
      if (uiToken) h['x-sidecar-token'] = uiToken;
      return h;
    }

    function fmtCompact(n) {
      const v = Number(n || 0);
      if (v >= 1e6) return (v / 1e6).toFixed(v % 1e6 === 0 ? 0 : 1).replace(/\\.0$/, '') + 'M';
      if (v >= 1e3) return (v / 1e3).toFixed(v >= 1e5 ? 0 : 1).replace(/\\.0$/, '') + 'k';
      return String(v);
    }

    function pickColor(pct) {
      if (pct >= 85) return { main: '#ef4444', soft: '#fca5a5' };
      if (pct >= 60) return { main: '#f59e0b', soft: '#fcd34d' };
      return { main: '#10b981', soft: '#6ee7b7' };
    }

    function renderBigGraphic(styleMode, pct, hitRate, colors, animate) {
      const clamped = Math.max(0, Math.min(100, pct));
      if (styleMode === 'ring') {
        const r = 24, c = 2 * Math.PI * r;
        return '<svg width="62" height="62" viewBox="0 0 64 64" fill="none">' +
          '<circle cx="32" cy="32" r="24" stroke="rgba(148,163,184,0.25)" stroke-width="5"/>' +
          '<circle cx="32" cy="32" r="24" stroke="' + colors.main + '" stroke-width="5.5" stroke-linecap="round" stroke-dasharray="' + c.toFixed(1) + '" stroke-dashoffset="' + (c * (1 - clamped / 100)).toFixed(1) + '" transform="rotate(-90 32 32)"/>' +
          '<circle cx="32" cy="32" r="6" fill="' + colors.main + '"/></svg>';
      }
      if (styleMode === 'donut') {
        const r1 = 22, c1 = 2 * Math.PI * r1, r2 = 12, c2 = 2 * Math.PI * r2;
        return '<svg width="62" height="62" viewBox="0 0 64 64" fill="none">' +
          '<circle cx="32" cy="32" r="22" stroke="rgba(148,163,184,0.24)" stroke-width="10"/>' +
          '<circle cx="32" cy="32" r="22" stroke="' + colors.main + '" stroke-width="10" stroke-linecap="round" stroke-dasharray="' + c1.toFixed(1) + '" stroke-dashoffset="' + (c1 * (1 - clamped / 100)).toFixed(1) + '" transform="rotate(-90 32 32)"/>' +
          '<circle cx="32" cy="32" r="12" stroke="#10b981" stroke-width="4.5" stroke-linecap="round" stroke-dasharray="' + c2.toFixed(1) + '" stroke-dashoffset="' + (c2 * (1 - Math.min(100, hitRate) / 100)).toFixed(1) + '" transform="rotate(-90 32 32)"/></svg>';
      }
      if (styleMode === 'caterpillar') {
        const cx = 34, cy = 34, R = 21.5;
        const maxSweep = Math.PI * 2 * 0.9;
        const sweep = (clamped / 100) * maxSweep;
        const headAngle = -Math.PI / 2 + sweep;
        let dots = '';
        for (let i = 0; i < 10; i++) {
          const off = (i / 10) * Math.PI * 2;
          if (off > sweep + 0.34 && off < Math.PI * 2 - 0.22) {
            const a = -Math.PI / 2 + off;
            dots += '<circle cx="' + (cx + R * Math.cos(a)).toFixed(1) + '" cy="' + (cy + R * Math.sin(a)).toFixed(1) + '" r="2.8" fill="rgba(148,163,184,0.28)"/>';
          }
        }
        let body = '';
        const usable = Math.max(0, sweep - 0.38);
        if (sweep > 0.28) {
          const cnt = Math.max(1, Math.floor(usable / 0.5) + 1);
          for (let i = 0; i < cnt; i++) {
            const rt = cnt === 1 ? 0 : i / (cnt - 1);
            const a = -Math.PI / 2 + (cnt === 1 ? 0 : rt * usable);
            const br = 5.4 + 1.4 * rt;
            body += '<circle cx="' + (cx + R * Math.cos(a)).toFixed(1) + '" cy="' + (cy + R * Math.sin(a)).toFixed(1) + '" r="' + br.toFixed(1) + '" fill="' + colors.main + '" stroke="var(--card)" stroke-width="1.8"/>';
          }
        }
        const hx = cx + R * Math.cos(headAngle), hy = cy + R * Math.sin(headAngle);
        const deg = (headAngle * 180) / Math.PI + 90;
        return '<svg width="64" height="64" viewBox="0 0 68 68" fill="none">' + dots + body +
          '<g transform="translate(' + hx.toFixed(1) + ' ' + hy.toFixed(1) + ') rotate(' + deg.toFixed(1) + ')">' +
          '<path d="M 4 -4.6 Q 9 -9.2 11.8 -6.4" stroke="' + colors.main + '" stroke-width="2.6" stroke-linecap="round"/>' +
          '<path d="M 4.8 3.4 Q 9.5 6.8 11.8 4.0" stroke="' + colors.main + '" stroke-width="2.6" stroke-linecap="round"/>' +
          '<circle cx="0" cy="0" r="8.0" fill="' + colors.main + '" stroke="var(--card)" stroke-width="1.6"/>' +
          '<circle cx="2.6" cy="-1.4" r="2.4" fill="#fff"/></g></svg>';
      }
      if (styleMode === 'capsule') {
        const w = Math.max(clamped > 0 ? 6 : 0, 52 * clamped / 100);
        return '<svg width="66" height="36" viewBox="0 0 68 36" fill="none">' +
          '<rect x="4" y="8" width="60" height="20" rx="10" stroke="rgba(148,163,184,0.38)" stroke-width="2.5"/>' +
          '<rect x="8" y="12" width="' + w.toFixed(1) + '" height="12" rx="6" fill="' + colors.main + '"/></svg>';
      }
      const topY = 52 - (32 * clamped) / 100;
      return '<svg width="56" height="62" viewBox="0 0 56 64" fill="none">' +
        '<defs><clipPath id="pBtl"><rect x="11" y="18" width="34" height="35" rx="13"/></clipPath></defs>' +
        '<rect x="21" y="4" width="14" height="6" rx="2.5" fill="#d97706"/>' +
        '<rect x="19" y="10" width="18" height="7" stroke="rgba(148,163,184,0.5)" stroke-width="2.4"/>' +
        '<g clip-path="url(#pBtl)">' +
        (clamped > 0.4 ? '<path class="' + (animate ? 'anim-wave' : '') + '" d="M -10 ' + topY.toFixed(1) + ' Q -3 ' + (topY - 3.5).toFixed(1) + ' 4 ' + topY.toFixed(1) + ' T 18 ' + topY.toFixed(1) + ' T 32 ' + topY.toFixed(1) + ' T 46 ' + topY.toFixed(1) + ' T 60 ' + topY.toFixed(1) + ' T 74 ' + topY.toFixed(1) + ' V 60 H -10 Z" fill="' + colors.main + '"/>' : '') +
        '</g>' +
        '<rect x="9.5" y="17" width="37" height="37" rx="14" stroke="rgba(148,163,184,0.55)" stroke-width="2.8"/>' +
        '<path d="M16 24 C14.5 29 14.5 40 16 46" stroke="#fff" stroke-opacity="0.55" stroke-width="2.4" stroke-linecap="round"/></svg>';
    }

    async function patchSettings(patch) {
      const resp = await fetch(apiUrl('/api/settings'), {
        method: 'POST',
        headers: apiHeaders(),
        body: JSON.stringify(patch),
      });
      if (resp.ok) {
        await refreshState();
      }
    }

    async function refreshState() {
      try {
        const resp = await fetch(apiUrl('/api/state'), { headers: apiHeaders() });
        if (!resp.ok) return;
        const state = await resp.json();
        latestState = state;
        const s = state.settings || {};
        const u = state.usage || {};
        const h = state.health || {};

        const dot = document.getElementById('statusDot');
        const stTitle = document.getElementById('statusTitle');
        const stDesc = document.getElementById('statusDesc');
        const fixBtn = document.getElementById('fixShortcutBtn');

        if (h.healthy) {
          dot.className = 'status-dot';
          stTitle.textContent = '已无侵入挂载到 Antigravity 输入框';
          stDesc.textContent = '已连接 ' + h.connectedWindows + ' 个窗口 · 零 app.asar 修改';
          fixBtn.style.display = 'none';
        } else {
          dot.className = 'status-dot warn';
          stTitle.textContent = '尚未连接到客户端本地调试端口';
          stDesc.innerHTML = '请完全退出客户端后从桌面/开始菜单快捷方式重新打开，或运行：<code class="hint-code">' + (state.manualLaunchHint || 'antigravity --remote-debugging-port=0') + '</code>';
          fixBtn.style.display = '';
        }

        const limit = Number(s.contextLimit || 512000);
        const total = Number(u.totalTokens || 0);
        const cache = Number(u.cacheReadTokens || 0);
        const input = Number(u.inputTokens || 0);
        const cumOut = Number(u.cumulativeOutputTokens || 0);
        const out = Number(u.outputTokens || 0);
        const hitRate = Number(u.cacheHitRate || 0);
        const pct = limit > 0 ? (total / limit) * 100 : 0;
        const colors = pickColor(pct, s.palette || 'auto');

        document.getElementById('bigPct').textContent = pct.toFixed(1) + '%';
        document.getElementById('bigPct').style.color = colors.main;
        document.getElementById('tokenSummary').textContent = fmtCompact(total) + ' / ' + fmtCompact(limit) + ' tokens';
        document.getElementById('modelTag').textContent = u.modelName || '等待会话请求';

        const denom = Math.max(limit, total, 1);
        document.getElementById('barCache').style.width = Math.min(100, (cache / denom) * 100).toFixed(1) + '%';
        document.getElementById('barInput').style.width = Math.min(100, (input / denom) * 100).toFixed(1) + '%';
        document.getElementById('barOutput').style.width = Math.min(100, (out / denom) * 100).toFixed(1) + '%';

        document.getElementById('kpiCache').textContent = hitRate.toFixed(1) + '%';
        document.getElementById('kpiInput').textContent = fmtCompact(input);
        document.getElementById('kpiOutput').textContent = fmtCompact(cumOut);
        document.getElementById('kpiSteps').textContent = (u.turnCount || 0) + ' / ' + (u.plannerStepCount || 0);

        document.getElementById('bigPreview').innerHTML = renderBigGraphic(
          s.styleMode || 'bottle',
          pct,
          hitRate,
          colors,
          s.animateEffects !== false
        );

        for (const btn of document.querySelectorAll('#styleGrid .opt-btn')) {
          btn.classList.toggle('active', btn.dataset.style === s.styleMode);
        }
        for (const btn of document.querySelectorAll('#limitGroup .pill-btn')) {
          btn.classList.toggle('active', Number(btn.dataset.limit) === limit);
        }

        const pctBtn = document.getElementById('togglePctBtn');
        pctBtn.classList.toggle('active', s.showPercentText !== false);
        pctBtn.textContent = s.showPercentText !== false ? '显示百分比: 开' : '显示百分比: 关';

        const animBtn = document.getElementById('toggleAnimBtn');
        animBtn.classList.toggle('active', s.animateEffects !== false);
        animBtn.textContent = s.animateEffects !== false ? '动态波浪: 开' : '动态波浪: 关';

        const placeBtn = document.getElementById('togglePlaceBtn');
        placeBtn.classList.toggle('active', true);
        placeBtn.textContent = s.placement === 'left' ? '位置: 靠左' : '位置: 靠右';

        const hist = Array.isArray(u.history) ? u.history : [];
        const maxStep = Math.max(limit * 0.25, ...hist.map((x) => Number(x.totalTokens || 0)), 1);
        document.getElementById('historyChart').innerHTML = hist.length
          ? hist.map((step) => {
              const caH = Math.max(2, Math.round(((step.cacheReadTokens || 0) / maxStep) * 68));
              const inH = Math.max(1, Math.round(((step.inputTokens || 0) / maxStep) * 68));
              return '<div class="bar-col" title="步 #' + step.step + ': ' + fmtCompact(step.totalTokens) + '">' +
                '<div class="bar-in" style="height:' + inH + 'px"></div>' +
                '<div class="bar-ca" style="height:' + caH + 'px"></div></div>';
            }).join('')
          : '<div style="color:var(--muted);font-size:12px;margin:auto;">暂无历史步数记录</div>';
      } catch {}
    }

    document.getElementById('styleGrid').addEventListener('click', (e) => {
      const btn = e.target.closest('.opt-btn');
      if (btn) patchSettings({ styleMode: btn.dataset.style });
    });

    document.getElementById('limitGroup').addEventListener('click', (e) => {
      const btn = e.target.closest('.pill-btn');
      if (btn) patchSettings({ contextLimit: Number(btn.dataset.limit) });
    });

    document.getElementById('togglePctBtn').addEventListener('click', () => {
      const cur = latestState?.settings?.showPercentText !== false;
      patchSettings({ showPercentText: !cur });
    });

    document.getElementById('toggleAnimBtn').addEventListener('click', () => {
      const cur = latestState?.settings?.animateEffects !== false;
      patchSettings({ animateEffects: !cur });
    });

    document.getElementById('togglePlaceBtn').addEventListener('click', () => {
      const cur = latestState?.settings?.placement === 'left' ? 'right' : 'left';
      patchSettings({ placement: cur });
    });

    document.getElementById('copyCompactBtn').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = '压缩中...';
      try {
        const resp = await fetch(apiUrl('/api/compact'), { method: 'POST', headers: apiHeaders() });
        const data = await resp.json();
        if (data?.ok) {
          btn.textContent = data.message || '✓ 已执行压缩';
        } else {
          navigator.clipboard?.writeText('/compact').catch(() => {});
          btn.textContent = data?.message || '已复制 /compact';
        }
      } catch {
        navigator.clipboard?.writeText('/compact').catch(() => {});
        btn.textContent = '已复制 /compact';
      } finally {
        btn.disabled = false;
        setTimeout(() => { btn.textContent = '执行 /compact'; }, 1600);
      }
    });

    document.getElementById('fixShortcutBtn').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.textContent = '正在修复...';
      await fetch(apiUrl('/api/reconfigure-shortcuts'), { method: 'POST', headers: apiHeaders() });
      btn.textContent = '已修复，请重开客户端';
    });

    refreshState();
    setInterval(refreshState, 2500);
  </script>
</body>
</html>`;
}

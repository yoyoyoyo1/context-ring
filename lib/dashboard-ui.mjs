/**
 * 生成右侧 Sidecar 实时监控与可视化样式工坊页面 HTML
 * 支持双页签：「实时与外观」（3 种形态 + 按模型上限 + 实时速度体检 + 压缩后防失忆开关）与「历史与费用」（多周期统计 + 12 周活跃热力图 + 预估 API 费用）
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
      --surface-soft: rgba(148, 163, 184, 0.09);
      --border: rgba(148, 163, 184, 0.24);
      --text: #0f172a;
      --muted: #64748b;
      --accent: #0ea5e9;
      --accent-soft: rgba(14, 165, 233, 0.12);
      --ok: #10b981;
      --warn: #f59e0b;
      --danger: #ef4444;
      --hm-0: rgba(148, 163, 184, 0.16);
      --hm-1: #bbf7d0;
      --hm-2: #4ade80;
      --hm-3: #16a34a;
      --hm-4: #15803d;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0f131a;
        --card: #171d27;
        --surface-soft: rgba(255, 255, 255, 0.045);
        --border: rgba(148, 163, 184, 0.16);
        --text: #f1f5f9;
        --muted: #94a3b8;
        --accent: #38bdf8;
        --accent-soft: rgba(56, 189, 248, 0.16);
        --hm-0: rgba(148, 163, 184, 0.12);
        --hm-1: #14532d;
        --hm-2: #166534;
        --hm-3: #22c55e;
        --hm-4: #4ade80;
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
      margin-bottom: 10px;
      gap: 8px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 7px;
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
    .tab-bar {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 4px;
      padding: 3px;
      border-radius: 11px;
      background: var(--surface-soft);
      border: 1px solid var(--border);
      margin-bottom: 12px;
    }
    .tab-btn {
      border: none;
      background: transparent;
      color: var(--muted);
      font-size: 12px;
      font-weight: 600;
      padding: 6px 8px;
      border-radius: 8px;
      cursor: pointer;
      transition: background-color 0.15s ease, color 0.15s ease;
    }
    .tab-btn.active {
      background: var(--card);
      color: var(--text);
      box-shadow: 0 1px 3px rgba(15, 23, 42, 0.12);
    }
    .tab-panel { display: none; }
    .tab-panel.active { display: block; }
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
      background: var(--ok);
    }
    .status-dot.warn { background: var(--warn); }
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
      gap: 8px;
    }
    .hero-stage {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 4px 2px 10px;
    }
    .preview-box {
      width: 78px;
      height: 78px;
      border-radius: 16px;
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
      font-size: 25px;
      font-weight: 800;
      line-height: 1.1;
    }
    .sub-line {
      color: var(--muted);
      font-size: 11.5px;
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
      margin-top: 9px;
    }
    .seg-cache { background: #10b981; transition: width 0.3s ease; }
    .seg-input { background: #0ea5e9; transition: width 0.3s ease; }
    .seg-output { background: #8b5cf6; transition: width 0.3s ease; }
    .speed-strip {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 10px;
      padding: 7px 10px;
      border-radius: 10px;
      background: var(--surface-soft);
      border: 1px solid var(--border);
      font-size: 11.5px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    .speed-strip.is-hidden { display: none; }
    .speed-left {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-weight: 700;
    }
    .speed-meta {
      color: var(--muted);
      font-size: 11px;
    }
    .grade-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 18px;
      height: 18px;
      padding: 0 5px;
      border-radius: 6px;
      font-size: 10.5px;
      font-weight: 800;
      color: #fff;
      background: #10b981;
    }
    .grade-S { background: #059669; }
    .grade-A { background: #0ea5e9; }
    .grade-B { background: #6366f1; }
    .grade-C { background: #f59e0b; }
    .grade-D { background: #ef4444; }
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
    .kpi-sub {
      font-size: 10.5px;
      color: var(--muted);
      margin-top: 2px;
    }
    .style-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
      margin-bottom: 12px;
    }
    .opt-btn {
      border: 1px solid var(--border);
      background: transparent;
      color: var(--text);
      padding: 10px 6px;
      border-radius: 11px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      transition: border-color 0.15s ease, background-color 0.15s ease;
    }
    .opt-btn:hover { border-color: var(--accent); }
    .opt-btn.active {
      border-color: var(--accent);
      background: var(--accent-soft);
      color: var(--accent);
    }
    .row-ctrl {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      padding: 8px 0;
      border-top: 1px solid var(--border);
      gap: 8px;
    }
    .pill-group {
      display: inline-flex;
      flex-wrap: wrap;
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
    .pill-btn:hover { border-color: var(--accent); }
    .pill-btn.active {
      border-color: var(--accent);
      background: var(--accent-soft);
      color: var(--accent);
    }
    .pill-btn.ok-active {
      border-color: rgba(16, 185, 129, 0.5);
      background: rgba(16, 185, 129, 0.14);
      color: #059669;
    }
    @media (prefers-color-scheme: dark) {
      .pill-btn.ok-active { color: #6ee7b7; }
    }
    .model-limit-tags {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 6px;
    }
    .model-limit-tag {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 3px 8px;
      border-radius: 999px;
      font-size: 11px;
      background: var(--surface-soft);
      border: 1px solid var(--border);
    }
    .model-limit-tag button {
      border: none;
      background: transparent;
      color: var(--muted);
      cursor: pointer;
      padding: 0 2px;
      font-weight: 700;
    }
    .rehydrate-note {
      font-size: 11.5px;
      color: var(--muted);
      margin-top: 6px;
      line-height: 1.45;
    }
    .rehydrate-warn {
      margin-top: 6px;
      padding: 6px 9px;
      border-radius: 8px;
      background: rgba(245, 158, 11, 0.12);
      color: #b45309;
      font-size: 11px;
    }
    @media (prefers-color-scheme: dark) {
      .rehydrate-warn { color: #fcd34d; }
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
    .heatmap-wrap {
      display: grid;
      grid-template-columns: repeat(12, minmax(0, 1fr));
      gap: 4px;
      margin-top: 6px;
    }
    .hm-week {
      display: grid;
      grid-template-rows: repeat(7, 1fr);
      gap: 4px;
    }
    .hm-cell {
      width: 100%;
      aspect-ratio: 1 / 1;
      border-radius: 3px;
      background: var(--hm-0);
    }
    .hm-l1 { background: var(--hm-1); }
    .hm-l2 { background: var(--hm-2); }
    .hm-l3 { background: var(--hm-3); }
    .hm-l4 { background: var(--hm-4); }
    .hm-legend {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-top: 8px;
      font-size: 11px;
      color: var(--muted);
    }
    .hm-scale {
      display: inline-flex;
      align-items: center;
      gap: 3px;
    }
    .hm-swatch {
      width: 10px;
      height: 10px;
      border-radius: 2px;
      display: inline-block;
    }
    .model-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .model-row {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .model-row-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 12px;
      gap: 8px;
    }
    .model-row-name {
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .model-row-val {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11.5px;
      color: var(--muted);
      flex-shrink: 0;
    }
    .model-bar-track {
      height: 5px;
      border-radius: 999px;
      background: rgba(148, 163, 184, 0.18);
      overflow: hidden;
    }
    .model-bar-fill {
      height: 100%;
      border-radius: 999px;
      background: linear-gradient(90deg, #0ea5e9, #10b981);
    }
    .disclaimer {
      font-size: 11px;
      color: var(--muted);
      margin-top: 8px;
    }
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

  <div class="tab-bar" id="mainTabs">
    <button type="button" class="tab-btn active" data-tab="live">实时与外观</button>
    <button type="button" class="tab-btn" data-tab="history">历史用量与费用</button>
  </div>

  <div class="tab-panel active" id="tabLive">
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

      <div class="speed-strip is-hidden" id="speedStrip">
        <span class="speed-left">
          <span id="speedTps">⚡ --</span>
          <span class="grade-badge" id="speedGrade" style="display:none;">A</span>
        </span>
        <span class="speed-meta" id="speedMeta">--</span>
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
        <button type="button" class="opt-btn" data-style="bottle"><span>🧪</span><span>玻璃瓶</span></button>
        <button type="button" class="opt-btn" data-style="caterpillar"><span>🐛</span><span>毛毛虫</span></button>
        <button type="button" class="opt-btn" data-style="ring"><span>⭕</span><span>极简细环</span></button>
      </div>

      <div class="row-ctrl">
        <span>当前模型上限</span>
        <div class="pill-group" id="limitGroup">
          <button type="button" class="pill-btn" data-limit="0">自动</button>
          <button type="button" class="pill-btn" data-limit="256000">256k</button>
          <button type="button" class="pill-btn" data-limit="512000">512k</button>
          <button type="button" class="pill-btn" data-limit="1000000">1M</button>
        </div>
      </div>
      <div class="model-limit-tags" id="customModelLimits"></div>

      <div class="row-ctrl">
        <span>底栏外置与显示</span>
        <div class="pill-group">
          <button type="button" class="pill-btn" id="toggleFooterQuotaBtn">底栏额度 W/H</button>
          <button type="button" class="pill-btn" id="toggleFooterSpeedBtn">底栏测速</button>
          <button type="button" class="pill-btn" id="togglePctBtn">显示百分比</button>
          <button type="button" class="pill-btn" id="toggleAnimBtn">动态波浪</button>
          <button type="button" class="pill-btn" id="togglePlaceBtn">靠右</button>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">
        <span>压缩后防失忆（Post-Compact Hook）</span>
        <button type="button" class="pill-btn" id="rehydrateToggleBtn">未开启</button>
      </div>
      <div class="rehydrate-note" id="rehydrateNote">
        纯 Node.js 零依赖 <code>PreInvocation</code> Hook。执行 <code>/compact</code> 压缩上下文后，自动恢复用户需求时间线、近期摘要、活跃文档与工作区文件，避免长对话失忆。
      </div>
      <div class="rehydrate-warn" id="rehydrateWarn" style="display:none;"></div>
    </div>

    <div class="card">
      <div class="card-title">
        <span>近 30 步上下文趋势（绿=缓存 / 蓝=新输入）</span>
      </div>
      <div class="chart-bars" id="historyChart"></div>
    </div>
  </div>

  <div class="tab-panel" id="tabHistory">
    <div class="card">
      <div class="card-title">
        <span>用量统计周期</span>
        <div class="pill-group" id="historyPeriodGroup">
          <button type="button" class="pill-btn" data-period="today">今日</button>
          <button type="button" class="pill-btn" data-period="7d">7天</button>
          <button type="button" class="pill-btn active" data-period="30d">30天</button>
          <button type="button" class="pill-btn" data-period="all">全部</button>
        </div>
      </div>
      <div class="kpi-grid" style="margin-top:4px;">
        <div class="kpi">
          <div class="kpi-label">总 Token 消耗</div>
          <div class="kpi-val" id="histTotalTokens">--</div>
          <div class="kpi-sub" id="histTokenBreakdown">输入 -- · 输出 --</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">预估 API 费用</div>
          <div class="kpi-val" id="histCostUsd">--</div>
          <div class="kpi-sub" id="histCacheSaved">缓存已省 --</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">全局缓存命中率</div>
          <div class="kpi-val" id="histCacheRate">--</div>
          <div class="kpi-sub" id="histCacheTokens">缓存读取 --</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">会话 / 调用次数</div>
          <div class="kpi-val" id="histSessions">--</div>
          <div class="kpi-sub" id="histChannels">桌面 -- · CLI --</div>
        </div>
      </div>
      <div class="disclaimer">基于本地会话日志与公开 Developer API 参考费率估算，不代表实际订阅扣费。</div>
    </div>

    <div class="card">
      <div class="card-title">
        <span>近 12 周活跃热力图</span>
        <span id="heatmapMeta" style="font-size:11px;color:var(--muted);font-weight:500;">--</span>
      </div>
      <div class="heatmap-wrap" id="heatmapGrid"></div>
      <div class="hm-legend">
        <span id="heatmapPeak">峰值 --</span>
        <span class="hm-scale">
          <span>少</span>
          <span class="hm-swatch" style="background:var(--hm-0)"></span>
          <span class="hm-swatch hm-l1"></span>
          <span class="hm-swatch hm-l2"></span>
          <span class="hm-swatch hm-l3"></span>
          <span class="hm-swatch hm-l4"></span>
          <span>多</span>
        </span>
      </div>
    </div>

    <div class="card">
      <div class="card-title">
        <span>模型消耗与参考费用明细</span>
        <button type="button" class="pill-btn" id="refreshHistoryBtn">刷新</button>
      </div>
      <div class="model-list" id="historyModelList">
        <div style="color:var(--muted);font-size:12px;">正在加载历史账本...</div>
      </div>
    </div>
  </div>

  <script>
    const urlParams = new URLSearchParams(location.search);
    const uiToken = urlParams.get('token') || '';
    let latestState = null;
    let activeTab = 'live';
    let historyPeriod = '30d';

    function apiUrl(p) {
      return uiToken ? p + (p.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(uiToken) : p;
    }

    function apiHeaders(extra) {
      const h = Object.assign({ 'Content-Type': 'application/json' }, extra || {});
      if (uiToken) h['x-sidecar-token'] = uiToken;
      return h;
    }

    function esc(text) {
      return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function fmtCompact(n) {
      const v = Number(n || 0);
      if (v >= 1e9) return (v / 1e9).toFixed(2).replace(/\\.00$/, '') + 'B';
      if (v >= 1e6) return (v / 1e6).toFixed(v % 1e6 === 0 ? 0 : 1).replace(/\\.0$/, '') + 'M';
      if (v >= 1e3) return (v / 1e3).toFixed(v >= 1e5 ? 0 : 1).replace(/\\.0$/, '') + 'k';
      return String(v);
    }

    function fmtUsd(v) {
      const n = Number(v || 0);
      if (n <= 0) return '$0.00';
      if (n < 0.01) return '<$0.01';
      return '$' + n.toFixed(n >= 100 ? 1 : 2);
    }

    function normalizeModelKey(raw) {
      return String(raw || '')
        .trim()
        .replace(/\\s*\\((?:minimal|min|low|medium|med|high|xhigh|extra\\s*high|max|ultra|thinking|adaptive|preview)\\)\\s*$/i, '')
        .replace(/[-_\\s]+(?:minimal|low|medium|high|xhigh|extra[-_\\s]?high|max|ultra)$/i, '')
        .trim()
        .toLowerCase()
        .replace(/[.]+/g, '-')
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    }

    function resolveLimit(settings, usage) {
      const modelKey = normalizeModelKey(usage?.modelName || '');
      const customMap = settings?.modelContextLimits || {};
      if (modelKey && Number(customMap[modelKey]) > 0) {
        return { limit: Number(customMap[modelKey]), source: '自定', auto: false, modelKey };
      }
      if (Number(settings?.contextLimit || 0) > 0) {
        return { limit: Number(settings.contextLimit), source: '全局', auto: false, modelKey };
      }
      if (Number(usage?.detectedContextLimit || 0) > 0) {
        return { limit: Number(usage.detectedContextLimit), source: '真实上限', auto: true, modelKey };
      }
      if (Number(usage?.catalogContextLimit || 0) > 0) {
        return { limit: Number(usage.catalogContextLimit), source: '模型目录', auto: true, modelKey };
      }
      return { limit: 512000, source: '默认', auto: true, modelKey };
    }

    function pickColor(pct) {
      if (pct >= 85) return { main: '#ef4444', soft: '#fca5a5' };
      if (pct >= 60) return { main: '#f59e0b', soft: '#fcd34d' };
      return { main: '#10b981', soft: '#6ee7b7' };
    }

    function renderBigGraphic(styleMode, pct, colors, animate) {
      const clamped = Math.max(0, Math.min(100, pct));
      if (styleMode === 'ring') {
        const r = 24, c = 2 * Math.PI * r;
        return '<svg width="60" height="60" viewBox="0 0 64 64" fill="none">' +
          '<circle cx="32" cy="32" r="24" stroke="rgba(148,163,184,0.25)" stroke-width="5"/>' +
          '<circle cx="32" cy="32" r="24" stroke="' + colors.main + '" stroke-width="5.5" stroke-linecap="round" stroke-dasharray="' + c.toFixed(1) + '" stroke-dashoffset="' + (c * (1 - clamped / 100)).toFixed(1) + '" transform="rotate(-90 32 32)"/>' +
          '<circle cx="32" cy="32" r="6" fill="' + colors.main + '"/></svg>';
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
        return '<svg width="62" height="62" viewBox="0 0 68 68" fill="none">' + dots + body +
          '<g transform="translate(' + hx.toFixed(1) + ' ' + hy.toFixed(1) + ') rotate(' + deg.toFixed(1) + ')">' +
          '<path d="M 4 -4.6 Q 9 -9.2 11.8 -6.4" stroke="' + colors.main + '" stroke-width="2.6" stroke-linecap="round"/>' +
          '<path d="M 4.8 3.4 Q 9.5 6.8 11.8 4.0" stroke="' + colors.main + '" stroke-width="2.6" stroke-linecap="round"/>' +
          '<circle cx="0" cy="0" r="8.0" fill="' + colors.main + '" stroke="var(--card)" stroke-width="1.6"/>' +
          '<circle cx="2.6" cy="-1.4" r="2.4" fill="#fff"/></g></svg>';
      }
      const topY = 52 - (32 * clamped) / 100;
      return '<svg width="54" height="60" viewBox="0 0 56 64" fill="none">' +
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
        const rh = state.rehydrate || {};

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
          stDesc.innerHTML = '请完全退出客户端后从桌面/开始菜单快捷方式重新打开，或运行：<code class="hint-code">' + esc(state.manualLaunchHint || 'antigravity --remote-debugging-port=0') + '</code>';
          fixBtn.style.display = '';
        }

        const resolved = resolveLimit(s, u);
        const limit = resolved.limit;
        const total = Number(u.totalTokens || 0);
        const cache = Number(u.cacheReadTokens || 0);
        const input = Number(u.inputTokens || 0);
        const cumOut = Number(u.cumulativeOutputTokens || 0);
        const out = Number(u.outputTokens || 0);
        const hitRate = Number(u.cacheHitRate || 0);
        const pct = limit > 0 ? (total / limit) * 100 : 0;
        const colors = pickColor(pct);

        document.getElementById('bigPct').textContent = pct.toFixed(1) + '%';
        document.getElementById('bigPct').style.color = colors.main;
        document.getElementById('tokenSummary').textContent =
          fmtCompact(total) + ' / ' + fmtCompact(limit) + ' · ' + resolved.source;
        document.getElementById('modelTag').textContent = u.modelName || '等待会话请求';

        const denom = Math.max(limit, total, 1);
        document.getElementById('barCache').style.width = Math.min(100, (cache / denom) * 100).toFixed(1) + '%';
        document.getElementById('barInput').style.width = Math.min(100, (input / denom) * 100).toFixed(1) + '%';
        document.getElementById('barOutput').style.width = Math.min(100, (out / denom) * 100).toFixed(1) + '%';

        // 实时速度体检条
        const sp = u.speed || null;
        const speedStrip = document.getElementById('speedStrip');
        if (sp && (sp.displayTps || sp.ttftSec !== null || sp.outputTokens > 0)) {
          speedStrip.classList.remove('is-hidden');
          const tpsText = sp.displayTps
            ? '⚡ ' + sp.displayTps.toFixed(1) + ' tok/s'
            : (sp.phase === 'warming' ? '⚡ 预热中' : '⚡ 输出 ' + fmtCompact(sp.outputTokens));
          document.getElementById('speedTps').textContent = tpsText;
          const gradeEl = document.getElementById('speedGrade');
          if (sp.grade) {
            gradeEl.style.display = 'inline-flex';
            gradeEl.className = 'grade-badge grade-' + sp.grade;
            gradeEl.textContent = sp.grade;
            gradeEl.title = '体验评分 ' + (sp.score ?? '--') + ' (' + (sp.gradeLabel || '') + ')';
          } else {
            gradeEl.style.display = 'none';
          }
          const parts = [];
          if (sp.ttftSec !== null && sp.ttftSec !== undefined) parts.push('TTFT ' + sp.ttftSec.toFixed(1) + 's');
          if (sp.durationSec !== null && sp.durationSec !== undefined) parts.push('耗时 ' + sp.durationSec.toFixed(1) + 's');
          if (sp.thinkingTokens > 0 || sp.responseTokens > 0) {
            parts.push('思 ' + fmtCompact(sp.thinkingTokens) + ' / 文 ' + fmtCompact(sp.responseTokens));
          }
          document.getElementById('speedMeta').textContent = parts.join(' · ') || '--';
        } else {
          speedStrip.classList.add('is-hidden');
        }

        document.getElementById('kpiCache').textContent = hitRate.toFixed(1) + '%';
        document.getElementById('kpiInput').textContent = fmtCompact(input);
        document.getElementById('kpiOutput').textContent = fmtCompact(cumOut);
        document.getElementById('kpiSteps').textContent = (u.turnCount || 0) + ' / ' + (u.plannerStepCount || 0);

        document.getElementById('bigPreview').innerHTML = renderBigGraphic(
          s.styleMode || 'bottle',
          pct,
          colors,
          s.animateEffects !== false
        );

        for (const btn of document.querySelectorAll('#styleGrid .opt-btn')) {
          btn.classList.toggle('active', btn.dataset.style === (s.styleMode || 'bottle'));
        }
        for (const btn of document.querySelectorAll('#limitGroup .pill-btn')) {
          const val = Number(btn.dataset.limit);
          const isActive = resolved.auto ? val === 0 : val === limit;
          btn.classList.toggle('active', isActive);
        }

        const customEntries = Object.entries(s.modelContextLimits || {});
        const customWrap = document.getElementById('customModelLimits');
        customWrap.innerHTML = customEntries.length
          ? customEntries.map(([k, v]) =>
              '<span class="model-limit-tag"><span>' + esc(k) + ': ' + fmtCompact(v) + '</span>' +
              '<button type="button" data-clear-model="' + esc(k) + '" title="恢复自动上限">×</button></span>'
            ).join('')
          : '';

        const fqBtn = document.getElementById('toggleFooterQuotaBtn');
        fqBtn.classList.toggle('active', s.showFooterQuota !== false);
        fqBtn.textContent = s.showFooterQuota !== false ? '底栏额度 W/H: 开' : '底栏额度 W/H: 关';

        const fsBtn = document.getElementById('toggleFooterSpeedBtn');
        fsBtn.classList.toggle('active', s.showFooterSpeed !== false);
        fsBtn.textContent = s.showFooterSpeed !== false ? '底栏测速: 开' : '底栏测速: 关';

        const pctBtn = document.getElementById('togglePctBtn');
        pctBtn.classList.toggle('active', s.showPercentText !== false);
        pctBtn.textContent = s.showPercentText !== false ? '显示百分比: 开' : '显示百分比: 关';

        const animBtn = document.getElementById('toggleAnimBtn');
        animBtn.classList.toggle('active', s.animateEffects !== false);
        animBtn.textContent = s.animateEffects !== false ? '动态波浪: 开' : '动态波浪: 关';

        const placeBtn = document.getElementById('togglePlaceBtn');
        placeBtn.classList.toggle('active', true);
        placeBtn.textContent = s.placement === 'left' ? '位置: 靠左' : '位置: 靠右';

        // 压缩后防失忆状态
        const rhBtn = document.getElementById('rehydrateToggleBtn');
        rhBtn.classList.toggle('ok-active', Boolean(rh.enabled));
        rhBtn.textContent = rh.enabled ? '✓ 已开启' : '未开启 · 启用';
        const rhWarn = document.getElementById('rehydrateWarn');
        if (rh.error) {
          rhWarn.style.display = 'block';
          rhWarn.textContent = '配置提示：' + rh.error;
        } else if (rh.externalConflict) {
          rhWarn.style.display = 'block';
          rhWarn.textContent = '提示：检测到 hooks.json 已启用同类 Hook (' + rh.externalHookName + ')，建议只保留其中一个以免重复注入。';
        } else {
          rhWarn.style.display = 'none';
        }

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

    async function refreshHistory() {
      try {
        const resp = await fetch(apiUrl('/api/history?period=' + encodeURIComponent(historyPeriod)), {
          headers: apiHeaders(),
        });
        if (!resp.ok) return;
        const data = await resp.json();
        const report = data?.report;
        if (!report) return;

        const sum = report.summary || {};
        document.getElementById('histTotalTokens').textContent = fmtCompact(sum.totalTokens || 0);
        document.getElementById('histTokenBreakdown').textContent =
          '新输入 ' + fmtCompact(sum.inputTokens || 0) + ' · 输出 ' + fmtCompact(sum.outputTokens || 0);
        document.getElementById('histCostUsd').textContent = fmtUsd(sum.estimatedCostUsd || 0);
        document.getElementById('histCacheSaved').textContent = '缓存已省 ' + fmtUsd(sum.cacheSavedUsd || 0);
        document.getElementById('histCacheRate').textContent = Number(sum.cacheHitRate || 0).toFixed(1) + '%';
        document.getElementById('histCacheTokens').textContent = '缓存读取 ' + fmtCompact(sum.cacheReadTokens || 0);
        document.getElementById('histSessions').textContent = (sum.sessionCount || 0) + ' / ' + (sum.callCount || 0);
        document.getElementById('histChannels').textContent =
          '桌面 ' + (sum.desktopCalls || 0) + ' · CLI ' + (sum.cliCalls || 0);

        // 渲染近 12 周（84 天）活跃热力图
        const hm = report.heatmap || {};
        const days = Array.isArray(hm.days) ? hm.days : [];
        document.getElementById('heatmapMeta').textContent =
          '活跃 ' + (hm.activeDays || 0) + ' 天 · ' + fmtCompact(hm.total84dTokens || 0);
        document.getElementById('heatmapPeak').textContent = '单日峰值 ' + fmtCompact(hm.maxDayTokens || 0);
        let gridHtml = '';
        for (let w = 0; w < 12; w++) {
          let colHtml = '<div class="hm-week">';
          for (let d = 0; d < 7; d++) {
            const item = days[w * 7 + d];
            if (!item) {
              colHtml += '<div class="hm-cell"></div>';
            } else {
              const cls = item.level > 0 ? 'hm-cell hm-l' + item.level : 'hm-cell';
              const tip = item.date + ' · ' + fmtCompact(item.totalTokens) + ' tokens · ' + item.calls + ' 次 · ' + fmtUsd(item.costUsd);
              colHtml += '<div class="' + cls + '" title="' + esc(tip) + '"></div>';
            }
          }
          colHtml += '</div>';
          gridHtml += colHtml;
        }
        document.getElementById('heatmapGrid').innerHTML = gridHtml;

        // 模型消耗排行
        const models = Array.isArray(report.models) ? report.models : [];
        document.getElementById('historyModelList').innerHTML = models.length
          ? models.map((m) =>
              '<div class="model-row">' +
                '<div class="model-row-top">' +
                  '<span class="model-row-name">' + esc(m.displayName) + '</span>' +
                  '<span class="model-row-val">' + fmtCompact(m.totalTokens) + ' · ' + m.cacheHitRate + '% 命中 · ' + (m.priced ? fmtUsd(m.estimatedCostUsd) : '未定价') + '</span>' +
                '</div>' +
                '<div class="model-bar-track"><div class="model-bar-fill" style="width:' + Math.max(2, Math.min(100, m.sharePct || 0)) + '%"></div></div>' +
              '</div>'
            ).join('')
          : '<div style="color:var(--muted);font-size:12px;">该周期暂无记录的会话消耗</div>';
      } catch {}
    }

    document.getElementById('mainTabs').addEventListener('click', (e) => {
      const btn = e.target.closest('.tab-btn');
      if (!btn) return;
      activeTab = btn.dataset.tab || 'live';
      for (const b of document.querySelectorAll('#mainTabs .tab-btn')) {
        b.classList.toggle('active', b.dataset.tab === activeTab);
      }
      document.getElementById('tabLive').classList.toggle('active', activeTab === 'live');
      document.getElementById('tabHistory').classList.toggle('active', activeTab === 'history');
      if (activeTab === 'history') {
        refreshHistory();
      }
    });

    document.getElementById('historyPeriodGroup').addEventListener('click', (e) => {
      const btn = e.target.closest('.pill-btn');
      if (!btn) return;
      historyPeriod = btn.dataset.period || '30d';
      for (const b of document.querySelectorAll('#historyPeriodGroup .pill-btn')) {
        b.classList.toggle('active', b.dataset.period === historyPeriod);
      }
      refreshHistory();
    });

    document.getElementById('refreshHistoryBtn').addEventListener('click', () => {
      refreshHistory();
    });

    document.getElementById('styleGrid').addEventListener('click', (e) => {
      const btn = e.target.closest('.opt-btn');
      if (btn) patchSettings({ styleMode: btn.dataset.style });
    });

    document.getElementById('limitGroup').addEventListener('click', (e) => {
      const btn = e.target.closest('.pill-btn');
      if (!btn) return;
      const nextLimit = Number(btn.dataset.limit);
      const modelName = latestState?.usage?.modelName || '';
      if (modelName) {
        patchSettings({
          contextLimit: 0,
          setModelContextLimit: { modelName, limit: nextLimit },
        });
      } else {
        patchSettings({ contextLimit: nextLimit });
      }
    });

    document.getElementById('customModelLimits').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-clear-model]');
      if (!btn) return;
      patchSettings({
        setModelContextLimit: { modelKey: btn.getAttribute('data-clear-model'), limit: 0 },
      });
    });

    document.getElementById('rehydrateToggleBtn').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const curEnabled = Boolean(latestState?.rehydrate?.enabled);
      btn.disabled = true;
      btn.textContent = curEnabled ? '关闭中...' : '启用中...';
      try {
        await fetch(apiUrl('/api/rehydrate'), {
          method: 'POST',
          headers: apiHeaders(),
          body: JSON.stringify({ enabled: !curEnabled }),
        });
        await refreshState();
      } finally {
        btn.disabled = false;
      }
    });

    document.getElementById('toggleFooterQuotaBtn').addEventListener('click', () => {
      const cur = latestState?.settings?.showFooterQuota !== false;
      patchSettings({ showFooterQuota: !cur });
    });

    document.getElementById('toggleFooterSpeedBtn').addEventListener('click', () => {
      const cur = latestState?.settings?.showFooterSpeed !== false;
      patchSettings({ showFooterSpeed: !cur });
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
    setInterval(() => {
      refreshState();
    }, 2500);
  </script>
</body>
</html>`;
}

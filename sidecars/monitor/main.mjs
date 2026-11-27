import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPluginPaths } from '../../lib/paths.mjs';
import { createSettingsStore } from '../../lib/settings.mjs';
import { createEmptyUsage, getConversationUsage } from '../../lib/transcript-parser.mjs';
import { configureClientLaunchers, getManualLaunchHint } from '../../lib/launcher.mjs';
import { startCdpInjectionHost } from '../../lib/cdp-host.mjs';
import { renderSidecarDashboardHtml } from '../../lib/dashboard-ui.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');

/**
 * 读取宿主 Sidecar SDK preload.js（保证右侧辅助面板原生桥接能力可用）
 */
function loadSidecarPreloadJs() {
  const candidates = [
    process.env.ANTIGRAVITY_APP_DATA_DIR &&
      path.join(process.env.ANTIGRAVITY_APP_DATA_DIR, 'lib', 'node_modules', 'sidecar_sdk', 'preload.js'),
    path.join(os.homedir(), '.gemini', 'antigravity', 'lib', 'node_modules', 'sidecar_sdk', 'preload.js'),
  ].filter(Boolean);

  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        return fs.readFileSync(file, 'utf8');
      }
    } catch {
      // 忽略单个路径读取失败
    }
  }
  return '';
}

/**
 * 读取 HTTP JSON 请求体（限制最大 8 KB）
 */
function readRequestJson(req, maxBytes = 8192) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        req.destroy();
        reject(new Error('请求体超出上限'));
      }
    });
    req.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('JSON 格式无效'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * 启动本地运行态控制端口（供 install/uninstall/status 脚本查询健康度与平滑卸载）
 */
async function startRuntimeControlServer(runtimeDir, version, cdpHost) {
  fs.mkdirSync(runtimeDir, { recursive: true });

  // 清理已退出进程的陈旧记录文件
  for (const name of fs.readdirSync(runtimeDir)) {
    const m = name.match(/^(\d+)-[a-f0-9]+\.json$/);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid && pid !== process.pid) {
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch (err) {
        if (err?.code === 'ESRCH') alive = false;
      }
      if (!alive) {
        try {
          fs.unlinkSync(path.join(runtimeDir, name));
        } catch {}
      }
    }
  }

  const secretToken = crypto.randomBytes(20).toString('hex');
  const recordFile = path.join(runtimeDir, `${process.pid}-${crypto.randomBytes(6).toString('hex')}.json`);

  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${secretToken}`) {
      res.writeHead(403).end();
      return;
    }

    if (req.method === 'GET' && req.url === '/health') {
      const health = await cdpHost.getHealth();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ id: 'context-ring', version, ...health }));
      return;
    }

    if (req.method === 'POST' && req.url === '/detach') {
      await cdpHost.stop({ removeWidgets: true });
      try {
        fs.unlinkSync(recordFile);
      } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      setTimeout(() => process.exit(0), 120).unref();
      return;
    }

    res.writeHead(404).end();
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  fs.writeFileSync(
    recordFile,
    JSON.stringify({ id: 'context-ring', version, pid: process.pid, port, token: secretToken }),
    { mode: 0o600 }
  );

  return async function closeControl() {
    try {
      fs.unlinkSync(recordFile);
    } catch {}
    await new Promise((resolve) => server.close(() => resolve()));
  };
}

/**
 * Sidecar 主启动流程
 */
async function main() {
  const paths = getPluginPaths(os.homedir());
  const pkgJson = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8'));
  const version = pkgJson.version || '1.0.0';
  const knownDistrosFile = path.join(PLUGIN_ROOT, '.wsl-distros.json');

  const settingsStore = createSettingsStore(paths.dataDir);
  const cdpHost = startCdpInjectionHost({
    settingsStore,
    version,
    knownDistrosFile,
  });

  await startRuntimeControlServer(path.join(paths.dataDir, 'runtime'), version, cdpHost);

  const webPort = Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || 0);
  const uiToken = String(process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '');

  if (Number.isInteger(webPort) && webPort > 0 && webPort < 65536) {
    const preloadScript = loadSidecarPreloadJs();

    const uiServer = http.createServer(async (req, res) => {
      const urlObj = new URL(req.url || '/', `http://127.0.0.1:${webPort}`);

      if (urlObj.pathname === '/preload.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
        res.end(preloadScript);
        return;
      }

      // 校验宿主传入的访问令牌
      const reqToken = req.headers['x-sidecar-token'] || urlObj.searchParams.get('token') || '';
      if (uiToken && reqToken !== uiToken) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      if (req.method === 'GET' && (urlObj.pathname === '/' || urlObj.pathname === '/ui.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderSidecarDashboardHtml({ version }));
        return;
      }

      if (req.method === 'GET' && urlObj.pathname === '/api/state') {
        const health = await cdpHost.getHealth();
        const queryCid = String(urlObj.searchParams.get('conversationId') || '').trim();
        const windows = Array.isArray(health.windows) ? health.windows : [];
        let usage;
        if (queryCid) {
          usage = getConversationUsage(queryCid, { knownDistrosFile, allowLatestFallback: false });
        } else if (windows.length > 0) {
          const focusedWin = windows.find((w) => w.focused) || null;
          let targetWin = focusedWin;
          if (!targetWin) {
            const recentlyFocused = windows
              .filter((w) => Number(w.lastFocusedAt || 0) > 0)
              .sort((a, b) => Number(b.lastFocusedAt || 0) - Number(a.lastFocusedAt || 0))[0];
            targetWin =
              recentlyFocused ||
              (windows.length === 1 ? windows[0] : windows.find((w) => w.activeConversationId) || windows[0]);
          }
          const targetCid = String(targetWin?.activeConversationId || '').trim();
          usage = targetCid
            ? getConversationUsage(targetCid, { knownDistrosFile, allowLatestFallback: false })
            : createEmptyUsage('', '');
        } else {
          usage = getConversationUsage('', { knownDistrosFile, allowLatestFallback: true });
        }

        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(
          JSON.stringify({
            ok: true,
            version,
            settings: settingsStore.get(),
            usage,
            health,
            manualLaunchHint: getManualLaunchHint(),
          })
        );
        return;
      }

      if (req.method === 'POST' && urlObj.pathname === '/api/settings') {
        try {
          const patch = await readRequestJson(req);
          const updated = settingsStore.set(patch);
          await cdpHost.broadcastSettings(updated);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, settings: updated }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: err?.message || String(err) }));
        }
        return;
      }

      if (req.method === 'POST' && urlObj.pathname === '/api/compact') {
        try {
          const result = await cdpHost.triggerCompact();
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: err?.message || String(err) }));
        }
        return;
      }

      if (req.method === 'POST' && urlObj.pathname === '/api/reconfigure-shortcuts') {
        const result = configureClientLaunchers({ home: paths.home, dataDir: paths.dataDir });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, result }));
        return;
      }

      res.writeHead(404).end('Not Found');
    });

    uiServer.listen(webPort, '127.0.0.1', () => {
      console.log(`[context-ring] Sidecar 监控工坊已监听 http://127.0.0.1:${webPort}`);
    });
  }
}

main().catch((err) => {
  console.error('[context-ring] Sidecar 启动失败:', err);
  process.exitCode = 1;
});

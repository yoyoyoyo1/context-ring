import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDevToolsPortFilePath, isWslEnvironment } from './paths.mjs';
import { createEmptyUsage, getConversationUsage } from './transcript-parser.mjs';
import { enrichUsageWithTelemetry, fetchAvailableModelCatalog, lookupCatalogModel } from './ls-telemetry.mjs';
import { getUsageHistoryReport } from './usage-history.mjs';
import { getRehydrateStatus, setRehydrateEnabled } from './rehydrate-manager.mjs';
import { createWslLocalhostBridge } from './wsl-bridge.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_PLUGIN_ROOT = path.resolve(__dirname, '..');
const RENDERER_SCRIPT_PATH = path.resolve(__dirname, '..', 'renderer', 'composer-widget.js');
const BINDING_NAME = '__contextRingHost';

const HUB_TITLE_PATTERN = /Antigravity|\((?:SSH|WSL):/i;
const HUB_PATH_PATTERN = /^\/(?:c\/[a-zA-Z0-9_-]+|customizations|automations|powertools)?(?:\/|$)/;

/**
 * 判断 CDP Target 是否为 Antigravity 主界面渲染窗口
 */
export function isAntigravityHubTarget(target) {
  if (!target || target.type !== 'page' || !target.webSocketDebuggerUrl) {
    return false;
  }
  try {
    const parsedUrl = new URL(target.url || '');
    const isLocalProtocol = parsedUrl.protocol === 'https:' || parsedUrl.protocol === 'http:';
    const isLocalHost = ['127.0.0.1', 'localhost', '[::1]'].includes(parsedUrl.hostname);
    if (!isLocalProtocol || !isLocalHost) return false;

    return HUB_TITLE_PATTERN.test(String(target.title || '')) || HUB_PATH_PATTERN.test(parsedUrl.pathname);
  } catch {
    return false;
  }
}

/**
 * 建立单条到渲染窗口的 CDP WebSocket 连接
 */
export function connectCdpSocket(wsUrl, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const pendingMap = new Map();
    const eventListeners = new Set();
    let seq = 0;

    const openTimer = setTimeout(() => {
      try {
        socket.close();
      } catch {}
      reject(new Error('CDP WebSocket 连接超时'));
    }, timeoutMs);

    // 连接关闭时清理所有未决请求
    function handleSocketClose() {
      for (const item of pendingMap.values()) {
        clearTimeout(item.timer);
        item.reject(new Error('CDP 连接已关闭'));
      }
      pendingMap.clear();
    }

    socket.addEventListener('error', () => {
      clearTimeout(openTimer);
      reject(new Error('CDP WebSocket 不可用'));
    });

    socket.addEventListener('close', handleSocketClose);

    socket.addEventListener('message', (event) => {
      let payload;
      try {
        payload = JSON.parse(String(event.data));
      } catch {
        return;
      }

      if (payload.id && pendingMap.has(payload.id)) {
        const entry = pendingMap.get(payload.id);
        clearTimeout(entry.timer);
        pendingMap.delete(payload.id);
        if (payload.error) {
          entry.reject(new Error(payload.error.message || 'CDP 调用失败'));
        } else {
          entry.resolve(payload.result);
        }
        return;
      }

      for (const fn of eventListeners) {
        fn(payload);
      }
    });

    socket.addEventListener('open', () => {
      clearTimeout(openTimer);
      resolve({
        socket,
        onEvent(listener) {
          eventListeners.add(listener);
        },
        send(method, params = {}) {
          if (socket.readyState !== WebSocket.OPEN) {
            return Promise.reject(new Error('CDP 连接未就绪'));
          }
          return new Promise((res, rej) => {
            const id = ++seq;
            const timer = setTimeout(() => {
              pendingMap.delete(id);
              rej(new Error(`CDP 方法超时: ${method}`));
            }, 8000);
            pendingMap.set(id, { resolve: res, reject: rej, timer });
            socket.send(JSON.stringify({ id, method, params }));
          });
        },
      });
    });
  });
}

/**
 * 组装注入到渲染进程的完整脚本（携带初始设置快照与组件源码）
 */
export function buildInjectedSource(settingsSnapshot, version = '1.0.0') {
  const widgetCode = fs.readFileSync(RENDERER_SCRIPT_PATH, 'utf8');
  return [
    `window.__CONTEXT_RING_BOOT_SETTINGS__ = ${JSON.stringify(settingsSnapshot)};`,
    `window.__CONTEXT_RING_EXPECTED_VERSION__ = ${JSON.stringify(version)};`,
    widgetCode,
  ].join('\n');
}

/**
 * 启动常驻的无侵入 CDP 注入与双向通信宿主
 */
export function startCdpInjectionHost(options = {}) {
  const settingsStore = options.settingsStore;
  const version = options.version || '1.0.0';
  const knownDistrosFile = options.knownDistrosFile || '';
  const dataDir = options.dataDir || '';
  const pluginRoot = options.pluginRoot || DEFAULT_PLUGIN_ROOT;
  const portFile = getDevToolsPortFilePath(options);
  const inWsl = options.wsl ?? isWslEnvironment(options);
  const onStatus = options.onStatus || ((msg) => console.log(`[context-ring] ${msg}`));
  const onSettingsChanged = options.onSettingsChanged || null;

  const connectedClients = new Map();
  let wslBridge = null;
  let stopped = false;
  let polling = false;
  let lastStatusText = '';
  let lastErrorText = '';
  let debugPortAvailable = false;

  // 输出去重后的状态日志
  function reportStatus(text) {
    if (text !== lastStatusText) {
      lastStatusText = text;
      onStatus(text);
    }
  }

  // 向所有已连接的客户端实时推送最新配置
  async function broadcastSettings(nextSettings) {
    const expr = `window.__contextRingReceiveSettings && window.__contextRingReceiveSettings(${JSON.stringify(nextSettings)})`;
    for (const client of connectedClients.values()) {
      try {
        await client.send('Runtime.evaluate', { expression: expr });
      } catch {
        // 忽略正在刷新的窗口
      }
    }
  }

  // 向所有已连接的客户端同步压缩后防失忆 Hook 最新状态
  async function broadcastRehydrate(rehydrateStatus) {
    const expr = `window.__contextRingReceiveRehydrate && window.__contextRingReceiveRehydrate(${JSON.stringify(rehydrateStatus)})`;
    for (const client of connectedClients.values()) {
      try {
        await client.send('Runtime.evaluate', { expression: expr });
      } catch {
        // 忽略正在刷新的窗口
      }
    }
  }

  // 挂载单个 Antigravity 渲染目标并注册 Runtime.addBinding 零端口通信通道
  async function attachToTarget(target) {
    const client = await connectCdpSocket(target.webSocketDebuggerUrl);
    client.targetId = target.id;
    client.endpoint = target.webSocketDebuggerUrl;
    client.url = target.url;
    client.title = target.title || '';
    client.scriptId = '';
    client.lastFocusedAt = 0;

    connectedClients.set(target.id, client);
    client.socket.addEventListener('close', () => {
      if (connectedClients.get(target.id) === client) {
        connectedClients.delete(target.id);
      }
    });

    // 处理来自输入框组件的异步 RPC 请求
    client.onEvent(async (event) => {
      if (event.method !== 'Runtime.bindingCalled' || event.params?.name !== BINDING_NAME) {
        return;
      }

      let req;
      try {
        const rawPayload = String(event.params.payload || '');
        if (rawPayload.length > 32768) return;
        req = JSON.parse(rawPayload);
      } catch {
        return;
      }

      if (!req || !Number.isInteger(req.id)) return;
      const contextId = event.params.executionContextId;

      let responsePayload;
      try {
        if (req.method === 'usage.get') {
          const cid = typeof req.params?.conversationId === 'string' ? req.params.conversationId.trim() : '';
          const reqModel = typeof req.params?.modelName === 'string' ? req.params.modelName.trim() : '';
          // 输入框侧严格按会话 ID 隔离：新开空白窗口/未建会话时必须归零，禁止回退到上一个旧会话
          let usage = cid
            ? getConversationUsage(cid, { knownDistrosFile, allowLatestFallback: false })
            : createEmptyUsage('', '');
          if (cid) {
            usage = await enrichUsageWithTelemetry(usage);
          } else if (reqModel) {
            const catalog = await fetchAvailableModelCatalog();
            const entry = lookupCatalogModel(catalog, reqModel);
            usage = { ...usage, modelName: reqModel, catalogContextLimit: entry?.maxTokens || 0 };
          }
          responsePayload = {
            ok: true,
            usage,
            settings: settingsStore.get(),
            rehydrate: getRehydrateStatus({ pluginRoot }),
          };
        } else if (req.method === 'settings.get') {
          responsePayload = {
            ok: true,
            settings: settingsStore.get(),
            rehydrate: getRehydrateStatus({ pluginRoot }),
          };
        } else if (req.method === 'settings.set') {
          const updated = settingsStore.set(req.params?.patch || {});
          await broadcastSettings(updated);
          if (typeof onSettingsChanged === 'function') {
            onSettingsChanged(updated);
          }
          responsePayload = {
            ok: true,
            settings: updated,
          };
        } else if (req.method === 'history.get') {
          const period = String(req.params?.period || '30d');
          const report = getUsageHistoryReport({
            period,
            knownDistrosFile,
            cacheDir: dataDir || undefined,
          });
          responsePayload = {
            ok: true,
            report,
          };
        } else if (req.method === 'rehydrate.status') {
          responsePayload = {
            ok: true,
            rehydrate: getRehydrateStatus({ pluginRoot }),
          };
        } else if (req.method === 'rehydrate.set') {
          const res = setRehydrateEnabled(Boolean(req.params?.enabled), { pluginRoot });
          if (res.ok) {
            await broadcastRehydrate(res.status);
          }
          responsePayload = {
            ok: res.ok,
            error: res.error || '',
            rehydrate: res.status,
          };
        } else {
          responsePayload = { ok: false, error: `未知请求方法: ${req.method}` };
        }
      } catch (err) {
        responsePayload = { ok: false, error: err?.message || String(err) };
      }

      const replyExpr = `window.__contextRingResolveRpc && window.__contextRingResolveRpc(${JSON.stringify({
        id: req.id,
        ...responsePayload,
      })})`;

      try {
        await client.send('Runtime.evaluate', {
          expression: replyExpr,
          ...(Number.isInteger(contextId) ? { contextId } : {}),
        });
      } catch {
        // 页面跳转时旧 context 销毁可安全忽略
      }
    });

    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Runtime.addBinding', { name: BINDING_NAME });

    const source = buildInjectedSource(settingsStore.get(), version);
    const added = await client.send('Page.addScriptToEvaluateOnNewDocument', { source });
    client.scriptId = added?.identifier || '';

    const evalRes = await client.send('Runtime.evaluate', { expression: source });
    if (evalRes?.exceptionDetails) {
      throw new Error(evalRes.exceptionDetails.text || '渲染脚本执行异常');
    }

    reportStatus('已通过 CDP 无侵入接入 Antigravity 输入框');
  }

  // 轮询检测客户端调试端口与活动窗口列表
  async function pollTargets() {
    if (stopped || polling) return;
    polling = true;

    try {
      if (!fs.existsSync(portFile)) {
        debugPortAvailable = false;
        lastErrorText = '未检测到 DevToolsActivePort（请通过带调试参数的快捷方式重启客户端）';
        reportStatus('等待 Antigravity 本地调试接口...');
        return;
      }

      const firstLine = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/)[0];
      const port = Number(firstLine);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        debugPortAvailable = false;
        lastErrorText = 'DevToolsActivePort 端口号无效';
        return;
      }

      let targets = null;
      try {
        const resp = await fetch(`http://127.0.0.1:${port}/json/list`, {
          signal: AbortSignal.timeout(inWsl ? 1500 : 4000),
        });
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status}`);
        }
        targets = await resp.json();
      } catch (directErr) {
        if (!inWsl) throw directErr;
        // WSL2 NAT 模式下自动启用宿主机回环转发桥
        if (!wslBridge) {
          wslBridge = createWslLocalhostBridge();
        }
        const endpoint = await wslBridge.ensureEndpoint(port);
        const resp = await fetch(`http://${endpoint.host}:${endpoint.port}/json/list`, {
          signal: AbortSignal.timeout(4500),
        });
        if (!resp.ok) {
          throw new Error(`WSL 桥接 HTTP ${resp.status}`);
        }
        const rawList = await resp.json();
        targets = wslBridge.rewriteTargets(rawList, port);
      }

      if (!Array.isArray(targets)) {
        throw new Error('调试目标列表格式无效');
      }

      debugPortAvailable = true;
      lastErrorText = '';

      const hubTargets = targets.filter(isAntigravityHubTarget);
      for (const target of hubTargets) {
        let existing = connectedClients.get(target.id);
        try {
          if (existing && existing.endpoint !== target.webSocketDebuggerUrl) {
            existing.socket.close();
            connectedClients.delete(target.id);
            existing = null;
          }

          if (!existing) {
            await attachToTarget(target);
          } else {
            existing.title = target.title || existing.title;
            existing.url = target.url || existing.url;

            // 检查页面刷新或热重载后组件是否仍存活，若丢失则自动重挂载
            const probe = await existing.send('Runtime.evaluate', {
              expression: `Boolean(window.__CONTEXT_RING_INSTALLED__ && window.__CONTEXT_RING_VERSION__ === ${JSON.stringify(version)})`,
              returnByValue: true,
            });
            if (probe?.result?.value !== true) {
              const source = buildInjectedSource(settingsStore.get(), version);
              await existing.send('Runtime.evaluate', { expression: source });
            }
          }
        } catch (attachErr) {
          connectedClients.get(target.id)?.socket.close();
          connectedClients.delete(target.id);
          lastErrorText = attachErr?.message || String(attachErr);
        }
      }

      // 清理已关闭窗口的残留连接
      const activeIds = new Set(hubTargets.map((t) => t.id));
      for (const [id, client] of connectedClients.entries()) {
        if (!activeIds.has(id)) {
          client.socket.close();
          connectedClients.delete(id);
        }
      }

      if (hubTargets.length === 0) {
        reportStatus('等待 Antigravity 主会话窗口打开...');
      }
    } catch (err) {
      debugPortAvailable = false;
      lastErrorText = err?.message || String(err);
      reportStatus('等待 Antigravity 本地调试接口...');
    } finally {
      polling = false;
    }
  }

  const pollTimer = setInterval(pollTargets, 3500);
  const initialReady = pollTargets();

  // 查询当前连接与挂载健康状态
  async function getHealth() {
    await initialReady;
    const windows = [];

    for (const client of connectedClients.values()) {
      try {
        const res = await client.send('Runtime.evaluate', {
          expression: `({
            installed: Boolean(window.__CONTEXT_RING_INSTALLED__),
            version: window.__CONTEXT_RING_VERSION__ || '',
            mountedCount: Number(window.__CONTEXT_RING_MOUNTED_COUNT__ || 0),
            activeConversationId: window.__CONTEXT_RING_ACTIVE_CID__ || '',
            focused: typeof document !== 'undefined' && typeof document.hasFocus === 'function' ? Boolean(document.hasFocus()) : false
          })`,
          returnByValue: true,
        });
        const val = res?.result?.value || {};
        const focused = Boolean(val.focused);
        if (focused) {
          client.lastFocusedAt = Date.now();
        }
        windows.push({
          title: client.title,
          installed: Boolean(val.installed),
          version: String(val.version || ''),
          mountedCount: Number(val.mountedCount || 0),
          activeConversationId: String(val.activeConversationId || ''),
          focused,
          lastFocusedAt: Number(client.lastFocusedAt || 0),
        });
      } catch {
        // 忽略单窗口瞬时不可达
      }
    }

    return {
      version,
      debugPortAvailable,
      portFile,
      connectedWindows: connectedClients.size,
      healthy: windows.some((w) => w.installed),
      lastError: lastErrorText,
      windows,
    };
  }

  // 停止注入宿主并可选从当前运行窗口即时卸载 DOM 组件
  async function stop(stopOpts = {}) {
    stopped = true;
    clearInterval(pollTimer);

    for (const client of connectedClients.values()) {
      try {
        if (client.scriptId) {
          await client.send('Page.removeScriptToEvaluateOnNewDocument', {
            identifier: client.scriptId,
          });
        }
        if (stopOpts.removeWidgets !== false) {
          await client.send('Runtime.evaluate', {
            expression: 'window.__CONTEXT_RING_CLEANUP__ && window.__CONTEXT_RING_CLEANUP__()',
          });
        }
      } catch {
        // 忽略关闭阶段错误
      }
      client.socket.close();
    }
    connectedClients.clear();

    if (wslBridge) {
      await wslBridge.close();
      wslBridge = null;
    }
  }

  // 在当前活动的 Antigravity 窗口中直接执行 /compact 压缩指令
  async function triggerCompact() {
    await initialReady;
    const clients = Array.from(connectedClients.values());
    if (clients.length === 0) {
      return { ok: false, error: '当前未连接到运行中的 Antigravity 窗口' };
    }

    let lastResult = null;
    for (const client of clients) {
      try {
        const res = await client.send('Runtime.evaluate', {
          expression:
            '(async () => typeof window.__CONTEXT_RING_TRIGGER_COMPACT__ === "function" ? window.__CONTEXT_RING_TRIGGER_COMPACT__() : { ok: false, error: "组件未就绪" })()',
          awaitPromise: true,
          returnByValue: true,
        });
        const val = res?.result?.value || { ok: false, error: '无响应' };
        lastResult = val;
        if (val.ok) {
          return val;
        }
      } catch (err) {
        lastResult = { ok: false, error: err?.message || String(err) };
      }
    }

    return lastResult || { ok: false, error: '无法触发 /compact' };
  }

  return {
    checkNow: pollTargets,
    broadcastSettings,
    broadcastRehydrate,
    triggerCompact,
    getHealth,
    stop,
  };
}

#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  PLUGIN_ID,
  getPluginPaths,
  getDevToolsPortFilePath,
  collectWindowsWslHomes,
} from '../lib/paths.mjs';
import { createSettingsStore } from '../lib/settings.mjs';
import { getConversationUsage } from '../lib/transcript-parser.mjs';
import {
  configureClientLaunchers,
  restoreClientLaunchers,
  getManualLaunchHint,
} from '../lib/launcher.mjs';
import {
  isAntigravityHubTarget,
  connectCdpSocket,
  buildInjectedSource,
} from '../lib/cdp-host.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SOURCE_ROOT = path.resolve(__dirname, '..');

const COPY_ITEMS = [
  'plugin.json',
  'package.json',
  'LICENSE',
  'README.md',
  'install.cmd',
  'uninstall.cmd',
  'install.ps1',
  'uninstall.ps1',
  'install.sh',
  'uninstall.sh',
  'assets',
  'lib',
  'renderer',
  'sidecars',
  'rules',
  'skills',
  'scripts',
];

/**
 * 递归复制文件或文件夹到目标目录
 */
function copyRecursiveSync(srcPath, destPath) {
  const stat = fs.statSync(srcPath);
  if (stat.isDirectory()) {
    fs.mkdirSync(destPath, { recursive: true });
    for (const entry of fs.readdirSync(srcPath, { withFileTypes: true })) {
      copyRecursiveSync(path.join(srcPath, entry.name), path.join(destPath, entry.name));
    }
  } else {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(srcPath, destPath);
  }
}

/**
 * 原子修改 ~/.gemini/config/config.json，避免损坏现有插件与用户配置
 */
function updateAntigravityConfig(configFilePath, mutator) {
  let config = {};
  if (fs.existsSync(configFilePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configFilePath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        config = parsed;
      }
    } catch {
      throw new Error(`无法解析配置文件: ${configFilePath}`);
    }
  }

  mutator(config);
  fs.mkdirSync(path.dirname(configFilePath), { recursive: true });
  const tempFile = `${configFilePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  try {
    fs.renameSync(tempFile, configFilePath);
  } catch {
    fs.copyFileSync(tempFile, configFilePath);
    try {
      fs.unlinkSync(tempFile);
    } catch {}
  }
}

/**
 * 在 Windows 主机上枚举可用于开发的 WSL2 发行版并同步插件副本
 */
function syncWslDistributions(action, pluginSourceDir) {
  if (process.platform !== 'win32') return [];
  const wslExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wsl.exe');
  if (!fs.existsSync(wslExe)) return [];

  let distros = [];
  try {
    const res = spawnSync(wslExe, ['-l', '-q'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 5000,
    });
    if (res.status === 0 && res.stdout) {
      // wsl.exe -l -q 默认输出 UTF-16LE
      const text = res.stdout.includes(0)
        ? res.stdout.toString('utf16le')
        : res.stdout.toString('utf8');
      distros = text
        .split(/\r?\n/)
        .map((s) => s.replace(/\0/g, '').trim())
        .filter((s) => s && !/^docker-desktop(?:-data)?$/i.test(s));
    }
  } catch {
    return [];
  }

  const synced = [];
  for (const distro of distros) {
    const homes = collectWindowsWslHomes(distro);
    for (const uncHome of homes) {
      const targetDir = path.join(uncHome, '.gemini', 'config', 'plugins', PLUGIN_ID);
      try {
        if (action === 'install') {
          fs.mkdirSync(targetDir, { recursive: true });
          for (const item of COPY_ITEMS) {
            const src = path.join(pluginSourceDir, item);
            if (fs.existsSync(src)) {
              copyRecursiveSync(src, path.join(targetDir, item));
            }
          }
          synced.push({ name: distro, uncHome, targetDir });
        } else if (action === 'uninstall') {
          if (fs.existsSync(targetDir)) {
            fs.rmSync(targetDir, { recursive: true, force: true });
            synced.push({ name: distro, uncHome, targetDir });
          }
        }
      } catch {
        // 跳过未启动或只读的 WSL 发行版
      }
    }
  }

  return synced;
}

/**
 * 若当前客户端已开启远程调试端口，立即向运行中窗口热注入或热卸载组件（无需重启即可预览）
 */
async function syncRunningWindowsOverCdp(mode, settingsSnapshot, version) {
  const portFile = getDevToolsPortFilePath();
  if (!fs.existsSync(portFile)) {
    return { reachable: false, updatedWindows: 0 };
  }

  try {
    const port = Number(fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/)[0]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { reachable: false, updatedWindows: 0 };
    }

    const resp = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!resp.ok) {
      return { reachable: false, updatedWindows: 0 };
    }

    const targets = await resp.json();
    const hubs = Array.isArray(targets) ? targets.filter(isAntigravityHubTarget) : [];
    let updatedWindows = 0;

    for (const target of hubs) {
      let client = null;
      try {
        client = await connectCdpSocket(target.webSocketDebuggerUrl, 2500);
        if (mode === 'install') {
          const seedUsage = getConversationUsage('');
          const source =
            `window.__CONTEXT_RING_FORCE_RELOAD__ = true;\n` +
            `window.__CONTEXT_RING_SEED_USAGE__ = ${JSON.stringify(seedUsage)};\n` +
            buildInjectedSource(settingsSnapshot, version);
          await client.send('Runtime.evaluate', { expression: source });
        } else {
          await client.send('Runtime.evaluate', {
            expression: 'window.__CONTEXT_RING_CLEANUP__ && window.__CONTEXT_RING_CLEANUP__()',
          });
        }
        updatedWindows++;
      } catch {
        // 忽略单个窗口瞬时错误
      } finally {
        client?.socket.close();
      }
    }

    return { reachable: true, updatedWindows };
  } catch {
    return { reachable: false, updatedWindows: 0 };
  }
}

/**
 * 通知运行中的 Sidecar 进程断开并退出
 */
async function stopRunningSidecarRuntimes(runtimeDir) {
  if (!fs.existsSync(runtimeDir)) return 0;
  let stopped = 0;

  for (const name of fs.readdirSync(runtimeDir)) {
    if (!name.endsWith('.json')) continue;
    const recordPath = path.join(runtimeDir, name);
    try {
      const rec = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
      if (rec?.port && rec?.token) {
        await fetch(`http://127.0.0.1:${rec.port}/detach`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${rec.token}` },
          signal: AbortSignal.timeout(2500),
        });
        stopped++;
      }
    } catch {
      // 忽略已退出的旧进程
    }
    try {
      fs.unlinkSync(recordPath);
    } catch {}
  }

  return stopped;
}

/**
 * 执行插件安装流程
 */
async function runInstall() {
  const paths = getPluginPaths(os.homedir());
  const pkg = JSON.parse(fs.readFileSync(path.join(SOURCE_ROOT, 'package.json'), 'utf8'));
  const version = pkg.version || '1.0.0';

  console.log(`=== [1/4] 同步 Context Ring v${version} 到全局插件目录 ===`);
  const sameDir = path.resolve(SOURCE_ROOT).toLowerCase() === path.resolve(paths.installDir).toLowerCase();
  if (!sameDir) {
    fs.mkdirSync(paths.installDir, { recursive: true });
    for (const item of COPY_ITEMS) {
      const src = path.join(SOURCE_ROOT, item);
      if (fs.existsSync(src)) {
        copyRecursiveSync(src, path.join(paths.installDir, item));
      }
    }
  }
  console.log(`  -> 已安装至: ${paths.installDir}`);

  const wslSynced = syncWslDistributions('install', SOURCE_ROOT);
  const wslMetaFile = path.join(paths.installDir, '.wsl-distros.json');
  fs.writeFileSync(wslMetaFile, `${JSON.stringify(wslSynced, null, 2)}\n`, 'utf8');
  if (wslSynced.length > 0) {
    console.log(
      `  -> 已同步至 WSL2: ${wslSynced.map((item) => `${item.name} (${item.uncHome})`).join(', ')}`
    );
  }

  console.log('\n=== [2/4] 启用插件配置并初始化默认样式 ===');
  updateAntigravityConfig(paths.configFile, (cfg) => {
    cfg.plugins = cfg.plugins || {};
    cfg.plugins[PLUGIN_ID] = { ...(cfg.plugins[PLUGIN_ID] || {}), enabled: true };
  });
  const settingsStore = createSettingsStore(paths.dataDir);
  const currentSettings = settingsStore.set({});
  console.log(
    `  -> 已启用插件 (当前形态: ${currentSettings.styleMode}, 上限: ${currentSettings.contextLimit / 1000}k, 零 app.asar 修改)`
  );

  console.log('\n=== [3/4] 配置客户端快捷方式本地调试参数 ===');
  const launcherRes = configureClientLaunchers({ home: paths.home, dataDir: paths.dataDir });
  if (launcherRes.modifiedShortcuts.length > 0 || launcherRes.modifiedDesktopEntries.length > 0) {
    console.log(
      `  -> 已更新 ${launcherRes.modifiedShortcuts.length + launcherRes.modifiedDesktopEntries.length} 个快捷方式/桌面入口 (--remote-debugging-port=0)`
    );
  } else if (launcherRes.alreadyReadyShortcuts.length > 0) {
    console.log(
      `  -> 检测到 ${launcherRes.alreadyReadyShortcuts.length} 个快捷方式已包含调试参数，无需重复修改`
    );
  } else {
    console.log(`  -> 若未自动识别快捷方式，可使用以下命令启动客户端: ${getManualLaunchHint()}`);
  }

  console.log('\n=== [4/4] 检查运行中窗口并尝试免重启热挂载 ===');
  const hotRes = await syncRunningWindowsOverCdp('install', currentSettings, version);
  if (hotRes.reachable && hotRes.updatedWindows > 0) {
    console.log(
      `  -> 已实时挂载到 ${hotRes.updatedWindows} 个运行中的窗口（重启客户端后 Sidecar 监控工坊也将完整就绪）`
    );
  } else {
    console.log('  -> 请从桌面或开始菜单快捷方式重新打开一次 Antigravity 以激活输入框组件与右侧监控工坊');
  }
}

/**
 * 执行插件卸载流程
 */
async function runUninstall(keepSettings = false) {
  const paths = getPluginPaths(os.homedir());
  console.log('=== [1/4] 从运行中窗口卸载组件并停止后台宿主 ===');
  await stopRunningSidecarRuntimes(path.join(paths.dataDir, 'runtime'));
  const hotRes = await syncRunningWindowsOverCdp('uninstall', null, '');
  if (hotRes.updatedWindows > 0) {
    console.log(`  -> 已从 ${hotRes.updatedWindows} 个运行中窗口无痕移除组件`);
  }

  console.log('\n=== [2/4] 清理客户端配置与还原快捷方式 ===');
  if (fs.existsSync(paths.configFile)) {
    updateAntigravityConfig(paths.configFile, (cfg) => {
      if (cfg.plugins) delete cfg.plugins[PLUGIN_ID];
      if (cfg.sidecars) {
        for (const key of Object.keys(cfg.sidecars)) {
          if (key === PLUGIN_ID || key.startsWith(`${PLUGIN_ID}/`)) {
            delete cfg.sidecars[key];
          }
        }
      }
    });
  }

  const restoreRes = restoreClientLaunchers({ home: paths.home, dataDir: paths.dataDir });
  if (restoreRes.skippedForPeerPlugin) {
    console.log('  -> 检测到其他 CDP 插件（如 agy-powertools）仍在启用，已安全保留快捷方式调试参数');
  } else if (restoreRes.restoredCount > 0) {
    console.log(`  -> 已还原 ${restoreRes.restoredCount} 个快捷方式的原始启动参数`);
  }

  console.log('\n=== [3/4] 移除全局插件目录与 WSL 副本 ===');
  syncWslDistributions('uninstall', SOURCE_ROOT);
  const sameDir = path.resolve(SOURCE_ROOT).toLowerCase() === path.resolve(paths.installDir).toLowerCase();
  if (!sameDir && fs.existsSync(paths.installDir)) {
    try {
      fs.rmSync(paths.installDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      console.log(`  -> 已移除目录: ${paths.installDir}`);
    } catch {
      // 若被当前运行中的 LanguageServer 占用目录句柄，先移除 plugin.json 使其重启后彻底失效
      try {
        fs.rmSync(path.join(paths.installDir, 'plugin.json'), { force: true });
      } catch {}
      console.log(`  -> 已标记卸载 ${paths.installDir}（重启客户端后释放残留空目录）`);
    }
  }

  console.log('\n=== [4/4] 清理运行态数据 ===');
  if (!keepSettings && fs.existsSync(paths.dataDir)) {
    try {
      fs.rmSync(paths.dataDir, { recursive: true, force: true });
      console.log('  -> 已清理插件配置与缓存数据');
    } catch {}
  } else if (keepSettings) {
    console.log('  -> 已按 --keep-settings 保留个人样式设置');
  }
}

/**
 * 查看当前安装与运行状态
 */
async function runStatus() {
  const paths = getPluginPaths(os.homedir());
  const installed = fs.existsSync(path.join(paths.installDir, 'plugin.json'));
  const portFile = getDevToolsPortFilePath();
  const hasPortFile = fs.existsSync(portFile);
  const settings = createSettingsStore(paths.dataDir).get();
  const wslMetaFile = path.join(paths.installDir, '.wsl-distros.json');
  const usage = getConversationUsage('', { knownDistrosFile: wslMetaFile });

  let runtimeHealth = null;
  const runtimeDir = path.join(paths.dataDir, 'runtime');
  if (fs.existsSync(runtimeDir)) {
    for (const name of fs.readdirSync(runtimeDir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(runtimeDir, name), 'utf8'));
        const resp = await fetch(`http://127.0.0.1:${rec.port}/health`, {
          headers: { Authorization: `Bearer ${rec.token}` },
          signal: AbortSignal.timeout(2000),
        });
        if (resp.ok) {
          runtimeHealth = await resp.json();
          break;
        }
      } catch {}
    }
  }

  console.log('=== Context Ring 状态诊断 ===');
  console.log(`1. 全局插件目录 : ${installed ? '已安装' : '未安装'} (${paths.installDir})`);
  console.log(`2. 注入架构     : 无侵入 CDP + Sidecar (零 app.asar 修改)`);
  console.log(`3. 调试端口文件 : ${hasPortFile ? '就绪' : '未就绪'} (${portFile})`);
  console.log(
    `4. Sidecar 宿主 : ${
      runtimeHealth
        ? `运行中 (已连接窗口=${runtimeHealth.connectedWindows}, 挂载=${runtimeHealth.healthy ? '正常' : '等待窗口'})`
        : '未运行（重启客户端后由 Antigravity 自动拉起）'
    }`
  );
  console.log(
    `5. 当前样式配置 : 形态=${settings.styleMode}, 配色=${settings.palette}, 上限=${settings.contextLimit / 1000}k, 位置=${settings.placement}`
  );
  console.log(
    `6. 最近活跃会话 : ${
      usage.conversationId
        ? `${usage.conversationId.slice(0, 8)}… (总计 ${usage.totalTokens.toLocaleString()} tokens, 缓存命中 ${usage.cacheHitRate}%)`
        : '未检测到会话日志'
    }`
  );
}

const command = String(process.argv[2] || 'status').toLowerCase();
const keepSettings = process.argv.includes('--keep-settings');

if (command === 'install') {
  runInstall().catch((err) => {
    console.error('安装失败:', err?.message || err);
    process.exitCode = 1;
  });
} else if (command === 'uninstall') {
  runUninstall(keepSettings).catch((err) => {
    console.error('卸载失败:', err?.message || err);
    process.exitCode = 1;
  });
} else {
  runStatus().catch((err) => {
    console.error('状态检查失败:', err?.message || err);
    process.exitCode = 1;
  });
}

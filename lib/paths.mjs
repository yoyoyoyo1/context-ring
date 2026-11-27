import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const PLUGIN_ID = 'context-ring';

/**
 * 判断当前进程是否运行在 WSL2 Linux 环境中
 */
export function isWslEnvironment(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  if (platform !== 'linux') return false;
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;

  // 仅在实际 Linux 主机默认环境下读取 /proc/version，避免污染单元测试
  if (process.platform === 'linux' && env === process.env) {
    try {
      const procVer = fs.readFileSync('/proc/version', 'utf8');
      return /microsoft|wsl/i.test(procVer);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * 在 WSL 中读取 Windows 侧的环境变量值（如 APPDATA、LOCALAPPDATA）
 */
export function resolveWindowsEnvFromWsl(varName, options = {}) {
  const clean = String(varName || '').trim();
  if (!/^[A-Za-z0-9_()]+$/.test(clean)) return '';

  const runSpawn = options.runSpawn || spawnSync;
  try {
    const res = runSpawn('cmd.exe', ['/d', '/c', `echo %${clean}%`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 4000,
    });
    if (res.error || res.status !== 0) return '';
    const lines = String(res.stdout || '').trim().split(/\r?\n/);
    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (trimmed && trimmed.toUpperCase() !== `%${clean.toUpperCase()}%`) {
        return trimmed;
      }
    }
  } catch {
    // 忽略跨系统调用异常
  }
  return '';
}

/**
 * 将 Windows 路径转换为 WSL 挂载路径（例如 C:\Users\jj -> /mnt/c/Users/jj）
 */
export function windowsPathToWslPath(winPath, options = {}) {
  const raw = String(winPath || '').trim();
  if (!raw) return '';

  const runSpawn = options.runSpawn || spawnSync;
  try {
    const res = runSpawn('wslpath', ['-u', raw], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    });
    if (!res.error && res.status === 0) {
      const out = String(res.stdout || '').trim();
      if (out) return out;
    }
  } catch {
    // 回退到盘符规则转换
  }

  const match = raw.match(/^([A-Za-z]):[\\/](.*)$/);
  if (match) {
    return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, '/')}`;
  }
  return '';
}

/**
 * 获取插件的全局安装目录、配置目录与运行数据目录
 */
export function getPluginPaths(homeDir = os.homedir()) {
  const resolvedHome = path.resolve(homeDir);
  const geminiRoot = path.join(resolvedHome, '.gemini');
  return {
    home: resolvedHome,
    geminiRoot,
    configFile: path.join(geminiRoot, 'config', 'config.json'),
    installDir: path.join(geminiRoot, 'config', 'plugins', PLUGIN_ID),
    dataDir: path.join(geminiRoot, 'antigravity', 'plugin_data', PLUGIN_ID),
    sidecarDataDir: path.join(geminiRoot, 'antigravity', 'sidecar_data', PLUGIN_ID),
    brainDir: path.join(geminiRoot, 'antigravity', 'brain'),
  };
}

/**
 * 定位 Antigravity 桌面客户端的 UserData 目录（兼容 Windows、macOS、Linux 与 WSL2）
 */
export function getAntigravityUserDataDir(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const home = options.home || os.homedir();

  if (env.ANTIGRAVITY_USER_DATA_DIR) {
    return env.ANTIGRAVITY_USER_DATA_DIR;
  }

  if (platform === 'win32') {
    const appData = env.APPDATA || path.win32.join(home, 'AppData', 'Roaming');
    return path.win32.join(appData, 'Antigravity');
  }

  if (platform === 'darwin') {
    return path.posix.join(home, 'Library', 'Application Support', 'Antigravity');
  }

  if (isWslEnvironment({ platform, env })) {
    const winAppData = resolveWindowsEnvFromWsl('APPDATA', options);
    const wslAppData = winAppData ? windowsPathToWslPath(winAppData, options) : '';
    if (wslAppData) {
      return path.posix.join(wslAppData, 'Antigravity');
    }
    // 兜底扫描 /mnt/c/Users/*/AppData/Roaming/Antigravity
    try {
      if (fs.existsSync('/mnt/c/Users')) {
        for (const entry of fs.readdirSync('/mnt/c/Users', { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          if (['Public', 'Default', 'Default User', 'All Users'].includes(entry.name)) continue;
          const candidate = path.posix.join('/mnt/c/Users', entry.name, 'AppData', 'Roaming', 'Antigravity');
          if (fs.existsSync(candidate)) return candidate;
        }
      }
    } catch {
      // 忽略权限错误
    }
  }

  const xdgConfig = env.XDG_CONFIG_HOME || path.posix.join(home, '.config');
  return path.posix.join(xdgConfig, 'Antigravity');
}

/**
 * 获取客户端远程调试端口文件 DevToolsActivePort 的完整路径
 */
export function getDevToolsPortFilePath(options = {}) {
  const env = options.env || process.env;
  if (options.portFile) return options.portFile;
  if (env.ANTIGRAVITY_CDP_PORT_FILE) return env.ANTIGRAVITY_CDP_PORT_FILE;

  const userDataDir = getAntigravityUserDataDir(options);
  const platform = options.platform || process.platform;
  return platform === 'win32'
    ? path.win32.join(userDataDir, 'DevToolsActivePort')
    : path.posix.join(userDataDir, 'DevToolsActivePort');
}

/**
 * 扫描 Windows 主机上已安装的 WSL 发行版用户主目录（UNC 路径）
 */
export function collectWindowsWslHomes(distroName, knownDistrosFile = '') {
  if (!distroName || process.platform !== 'win32') return [];
  const homes = [];
  const seen = new Set();

  // 记录去重后的 UNC 用户目录
  function addHome(candidate) {
    if (!candidate) return;
    const normKey = candidate.toLowerCase();
    if (!seen.has(normKey)) {
      seen.add(normKey);
      homes.push(candidate);
    }
  }

  // 1. 优先读取安装时缓存的发行版信息
  if (knownDistrosFile && fs.existsSync(knownDistrosFile)) {
    try {
      const list = JSON.parse(fs.readFileSync(knownDistrosFile, 'utf8'));
      if (Array.isArray(list)) {
        for (const item of list) {
          if (item && item.name === distroName && item.uncHome && fs.existsSync(item.uncHome)) {
            addHome(item.uncHome);
          }
        }
      }
    } catch {
      // 忽略损坏的缓存文件
    }
  }

  // 2. 扫描 \\wsl.localhost\<distro>\home\* 与 \\wsl$\<distro>\home\*
  const uncRoots = [`\\\\wsl.localhost\\${distroName}`, `\\\\wsl$\\${distroName}`];
  for (const root of uncRoots) {
    let foundAny = false;
    try {
      const homeRoot = path.join(root, 'home');
      if (fs.existsSync(homeRoot)) {
        for (const entry of fs.readdirSync(homeRoot, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            addHome(path.join(homeRoot, entry.name));
            foundAny = true;
          }
        }
      }
    } catch {
      // 当前 UNC 前缀不可达时继续尝试下一个
    }

    try {
      const rootGemini = path.join(root, 'root', '.gemini');
      if (fs.existsSync(rootGemini)) {
        addHome(path.join(root, 'root'));
        foundAny = true;
      }
    } catch {
      // 忽略 root 目录无权限情况
    }

    if (foundAny) break;
  }

  return homes;
}

/**
 * 获取所有可能存放会话日志的 Brain 目录列表（支持 Windows 本地 + WSL 跨端双向检索）
 */
export function getCandidateBrainDirs(options = {}) {
  const home = options.home || os.homedir();
  const platform = options.platform || process.platform;
  const knownDistrosFile = options.knownDistrosFile || '';

  const localDirs = [
    path.join(home, '.gemini', 'antigravity', 'brain'),
    path.join(home, '.gemini', 'antigravity-ide', 'brain'),
    path.join(home, '.gemini', 'antigravity-cli', 'brain'),
  ];

  const extraDirs = [];
  const preferExtraFirst = [];

  // Windows 下补充 WSL2 发行版中的 .gemini/*/brain 目录
  if (platform === 'win32') {
    const distros = [];
    let activeDistro = '';
    try {
      const wslStateFile = path.join(home, 'AppData', 'Roaming', 'Antigravity', 'wsl_state.json');
      if (fs.existsSync(wslStateFile)) {
        const parsed = JSON.parse(fs.readFileSync(wslStateFile, 'utf8'));
        activeDistro = String(parsed?.distro || '').trim();
        if (activeDistro) distros.push(activeDistro);
      }
    } catch {
      // 忽略读取失败
    }

    if (knownDistrosFile && fs.existsSync(knownDistrosFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(knownDistrosFile, 'utf8'));
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            const name = String(item?.name || '').trim();
            if (name && !distros.includes(name)) distros.push(name);
          }
        }
      } catch {
        // 忽略缓存解析失败
      }
    }

    for (const distro of distros) {
      const wslHomes = collectWindowsWslHomes(distro, knownDistrosFile);
      const targetBucket = distro === activeDistro ? preferExtraFirst : extraDirs;
      for (const wslHome of wslHomes) {
        targetBucket.push(
          path.join(wslHome, '.gemini', 'antigravity', 'brain'),
          path.join(wslHome, '.gemini', 'antigravity-ide', 'brain'),
          path.join(wslHome, '.gemini', 'antigravity-cli', 'brain')
        );
      }
    }
  } else if (platform === 'linux') {
    // WSL Linux 下补充 Windows 侧宿主机的 .gemini/*/brain 目录
    try {
      if (fs.existsSync('/mnt/c/Users')) {
        for (const entry of fs.readdirSync('/mnt/c/Users', { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          if (['Public', 'Default', 'Default User', 'All Users'].includes(entry.name)) continue;
          const winHome = path.posix.join('/mnt/c/Users', entry.name);
          extraDirs.push(
            path.posix.join(winHome, '.gemini', 'antigravity', 'brain'),
            path.posix.join(winHome, '.gemini', 'antigravity-ide', 'brain'),
            path.posix.join(winHome, '.gemini', 'antigravity-cli', 'brain')
          );
        }
      }
    } catch {
      // 忽略跨挂载点扫描失败
    }
  }

  const combined = [...preferExtraFirst, ...localDirs, ...extraDirs];
  const unique = [];
  const seen = new Set();

  for (const dir of combined) {
    const norm = platform === 'win32' ? dir.toLowerCase() : dir;
    if (seen.has(norm)) continue;
    seen.add(norm);
    try {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
        unique.push(dir);
      }
    } catch {
      // 跳过不可访问目录
    }
  }

  return unique;
}

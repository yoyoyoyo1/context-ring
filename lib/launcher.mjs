import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isWslEnvironment } from './paths.mjs';

export const DEBUG_PORT_FLAG = '--remote-debugging-port=0';
const HAS_DEBUG_PORT_RE = /(?:^|\s)--remote-debugging-port(?:\s|=|$)/i;
const STRIP_DEBUG_PORT_RE = /(?:^|\s)--remote-debugging-port(?:=\S+|\s+\d+)?(?=\s|$)/gi;

/**
 * 向启动参数字符串中幂等注入 --remote-debugging-port=0
 */
export function injectDebugPortArg(rawArgs = '') {
  const trimmed = String(rawArgs || '').trim();
  if (HAS_DEBUG_PORT_RE.test(trimmed)) {
    return trimmed;
  }
  return trimmed ? `${trimmed} ${DEBUG_PORT_FLAG}` : DEBUG_PORT_FLAG;
}

/**
 * 从启动参数字符串中精确移除 --remote-debugging-port 参数
 */
export function removeDebugPortArg(rawArgs = '') {
  return String(rawArgs || '')
    .replace(STRIP_DEBUG_PORT_RE, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * 为 Linux .desktop 文件中的 Exec= 行追加调试端口参数
 */
export function patchLinuxDesktopEntry(content = '') {
  let changed = false;
  const lines = String(content).split(/\r?\n/);
  const updated = lines.map((line) => {
    if (!/^Exec\s*=/.test(line) || HAS_DEBUG_PORT_RE.test(line)) {
      return line;
    }
    const eqIdx = line.indexOf('=');
    const prefix = line.slice(0, eqIdx + 1);
    const commandPart = line.slice(eqIdx + 1).trim();
    if (!/antigravity/i.test(commandPart)) {
      return line;
    }
    const match = commandPart.match(/^("[^"]+"|\S+)([\s\S]*)$/);
    if (!match) return line;
    changed = true;
    const rest = match[2].trim();
    return `${prefix}${match[1]} ${DEBUG_PORT_FLAG}${rest ? ` ${rest}` : ''}`;
  });

  return { content: updated.join('\n'), changed };
}

/**
 * 还原 Linux .desktop 文件中的调试端口参数
 */
export function unpatchLinuxDesktopEntry(content = '') {
  let changed = false;
  const lines = String(content).split(/\r?\n/);
  const updated = lines.map((line) => {
    if (!/^Exec\s*=/.test(line) || !HAS_DEBUG_PORT_RE.test(line)) {
      return line;
    }
    const next = line
      .replace(STRIP_DEBUG_PORT_RE, ' ')
      .replace(/^(Exec\s*=\s*)/, '$1')
      .replace(/\s{2,}/g, ' ')
      .trimEnd();
    if (next !== line) changed = true;
    return next;
  });

  return { content: updated.join('\n'), changed };
}

/**
 * 检查是否仍有其他依赖 CDP 调试端口的同级插件处于启用状态（如 agy-powertools）
 */
export function hasOtherCdpPluginsInstalled(homeDir = os.homedir()) {
  try {
    const pluginsRoot = path.join(homeDir, '.gemini', 'config', 'plugins');
    const configPath = path.join(homeDir, '.gemini', 'config', 'config.json');
    const peerPluginDir = path.join(pluginsRoot, 'agy-powertools', 'plugin.json');
    if (!fs.existsSync(peerPluginDir)) return false;

    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (cfg?.plugins?.['agy-powertools']?.enabled === false) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 调用 Windows PowerShell 扫描并按需为 Antigravity 快捷方式添加调试参数
 */
function configureWindowsShortcuts(options = {}) {
  const runSpawn = options.runSpawn || spawnSync;
  const psScript = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$dirs = @(
  [Environment]::GetFolderPath('Desktop'),
  (Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs'),
  (Join-Path $env:APPDATA 'Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar')
)
if ($env:OneDrive) { $dirs += (Join-Path $env:OneDrive 'Desktop') }
$candidates = @()
foreach ($d in ($dirs | Select-Object -Unique)) {
  if ($d -and (Test-Path -LiteralPath $d)) {
    Get-ChildItem -LiteralPath $d -Filter '*.lnk' -File | ForEach-Object { $candidates += $_.FullName }
    $sub = Join-Path $d 'Antigravity'
    if (Test-Path -LiteralPath $sub) {
      Get-ChildItem -LiteralPath $sub -Filter '*.lnk' -File | ForEach-Object { $candidates += $_.FullName }
    }
  }
}
$wsh = New-Object -ComObject WScript.Shell
$modified = @()
$alreadyReady = @()
foreach ($lnk in ($candidates | Select-Object -Unique)) {
  $sc = $wsh.CreateShortcut($lnk)
  $target = [string]$sc.TargetPath
  $name = [System.IO.Path]::GetFileName($lnk)
  if (($name -notmatch '(?i)antigravity') -and ($target -notmatch '(?i)antigravity\\.exe$')) {
    continue
  }
  $args = [string]$sc.Arguments
  if ($args -match '(?i)(?:^|\\s)--remote-debugging-port(?:\\s|=|$)') {
    $alreadyReady += $lnk
  } else {
    $sc.Arguments = if ($args.Trim()) { "$($args.Trim()) --remote-debugging-port=0" } else { "--remote-debugging-port=0" }
    $sc.Save()
    $modified += $lnk
  }
}
@{ modified = $modified; alreadyReady = $alreadyReady } | ConvertTo-Json -Compress
`;

  const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
  const res = runSpawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 15000,
    }
  );

  if (res.error || res.status !== 0) {
    return { modified: [], alreadyReady: [] };
  }

  try {
    const parsed = JSON.parse(String(res.stdout || '').trim() || '{}');
    const toArray = (val) => (Array.isArray(val) ? val : val ? [String(val)] : []);
    return {
      modified: toArray(parsed.modified),
      alreadyReady: toArray(parsed.alreadyReady),
    };
  } catch {
    return { modified: [], alreadyReady: [] };
  }
}

/**
 * 为插件配置客户端启动器（Windows / WSL 快捷方式或 Linux .desktop 文件）
 */
export function configureClientLaunchers(options = {}) {
  const home = options.home || os.homedir();
  const dataDir = options.dataDir || path.join(home, '.gemini', 'antigravity', 'plugin_data', 'context-ring');
  const platform = options.platform || process.platform;
  const statePath = path.join(dataDir, 'launcher-state.json');

  let prevState = { modifiedShortcuts: [], modifiedDesktopEntries: [] };
  try {
    if (fs.existsSync(statePath)) {
      prevState = JSON.parse(fs.readFileSync(statePath, 'utf8')) || prevState;
    }
  } catch {
    // 忽略旧状态读取失败
  }

  const result = {
    modifiedShortcuts: [...(prevState.modifiedShortcuts || [])],
    alreadyReadyShortcuts: [],
    modifiedDesktopEntries: [...(prevState.modifiedDesktopEntries || [])],
  };

  if (platform === 'win32' || isWslEnvironment({ platform })) {
    const winRes = configureWindowsShortcuts(options);
    for (const p of winRes.modified) {
      if (!result.modifiedShortcuts.includes(p)) {
        result.modifiedShortcuts.push(p);
      }
    }
    result.alreadyReadyShortcuts = winRes.alreadyReady;
  } else if (platform === 'linux') {
    const desktopDir = path.join(home, '.local', 'share', 'applications');
    if (fs.existsSync(desktopDir)) {
      try {
        for (const entry of fs.readdirSync(desktopDir, { withFileTypes: true })) {
          if (!entry.isFile() || !/antigravity.*\.desktop$/i.test(entry.name)) continue;
          const fullPath = path.join(desktopDir, entry.name);
          const raw = fs.readFileSync(fullPath, 'utf8');
          const patched = patchLinuxDesktopEntry(raw);
          if (patched.changed) {
            fs.writeFileSync(fullPath, patched.content, 'utf8');
            if (!result.modifiedDesktopEntries.includes(fullPath)) {
              result.modifiedDesktopEntries.push(fullPath);
            }
          }
        }
      } catch {
        // 忽略桌面入口写入异常
      }
    }
  }

  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(statePath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  } catch {
    // 忽略状态记录失败
  }

  return result;
}

/**
 * 卸载插件时按需还原由本插件修改过的快捷方式（若检测到其他 CDP 插件仍启用则安全保留）
 */
export function restoreClientLaunchers(options = {}) {
  const home = options.home || os.homedir();
  const dataDir = options.dataDir || path.join(home, '.gemini', 'antigravity', 'plugin_data', 'context-ring');
  const platform = options.platform || process.platform;
  const statePath = path.join(dataDir, 'launcher-state.json');

  // 若用户仍启用了 agy-powertools 等共享调试端口的插件，不能剥离快捷方式参数
  if (hasOtherCdpPluginsInstalled(home)) {
    return { skippedForPeerPlugin: true, restoredCount: 0 };
  }

  if (!fs.existsSync(statePath)) {
    return { skippedForPeerPlugin: false, restoredCount: 0 };
  }

  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(statePath, 'utf8')) || {};
  } catch {
    return { skippedForPeerPlugin: false, restoredCount: 0 };
  }

  let restoredCount = 0;
  const shortcuts = Array.isArray(saved.modifiedShortcuts) ? saved.modifiedShortcuts : [];

  if (shortcuts.length > 0 && (platform === 'win32' || isWslEnvironment({ platform }))) {
    const runSpawn = options.runSpawn || spawnSync;
    const jsonList = JSON.stringify(shortcuts);
    const psScript = `
$ErrorActionPreference = 'SilentlyContinue'
$list = '${jsonList.replace(/'/g, "''")}' | ConvertFrom-Json
$wsh = New-Object -ComObject WScript.Shell
$count = 0
foreach ($lnk in $list) {
  if ($lnk -and (Test-Path -LiteralPath $lnk)) {
    $sc = $wsh.CreateShortcut($lnk)
    $next = ([string]$sc.Arguments) -replace '(?i)(?:^|\\s)--remote-debugging-port(?:=\\S+|\\s+\\d+)?(?=\\s|$)', ' '
    $sc.Arguments = ($next -replace '\\s{2,}', ' ').Trim()
    $sc.Save()
    $count++
  }
}
Write-Output $count
`;
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    const res = runSpawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        timeout: 15000,
      }
    );
    restoredCount += Number(String(res.stdout || '').trim()) || 0;
  }

  const desktopEntries = Array.isArray(saved.modifiedDesktopEntries) ? saved.modifiedDesktopEntries : [];
  for (const file of desktopEntries) {
    try {
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, 'utf8');
        const unpatched = unpatchLinuxDesktopEntry(raw);
        if (unpatched.changed) {
          fs.writeFileSync(file, unpatched.content, 'utf8');
          restoredCount++;
        }
      }
    } catch {
      // 忽略单个文件还原失败
    }
  }

  return { skippedForPeerPlugin: false, restoredCount };
}

/**
 * 生成供用户参考的手动带参启动命令提示
 */
export function getManualLaunchHint(platform = process.platform) {
  if (platform === 'win32') {
    const exe = path.win32.join(
      process.env.LOCALAPPDATA || 'C:\\Users\\<User>\\AppData\\Local',
      'Programs',
      'antigravity',
      'Antigravity.exe'
    );
    return `"${exe}" ${DEBUG_PORT_FLAG}`;
  }
  if (platform === 'darwin') {
    return `open -a "Antigravity" --args ${DEBUG_PORT_FLAG}`;
  }
  return `antigravity ${DEBUG_PORT_FLAG}`;
}

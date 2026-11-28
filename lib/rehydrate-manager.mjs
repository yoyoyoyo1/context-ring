import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPluginPaths } from './paths.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_PLUGIN_ROOT = path.resolve(__dirname, '..');

export const REHYDRATE_HOOK_NAME = 'context-ring-rehydrate';
const EXTERNAL_CONFLICT_NAMES = ['post-compact-rehydrate'];

/**
 * 检查路径是否为符号链接（安全护栏：拒绝向符号链接写入 hooks.json）
 */
function isSymlinkPath(targetPath) {
  try {
    return fs.lstatSync(targetPath).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * 以 fail-closed 方式安全读取 ~/.gemini/config/hooks.json
 */
function readHooksJsonSafe(hooksJsonPath) {
  const configDir = path.dirname(hooksJsonPath);
  if (isSymlinkPath(configDir) || isSymlinkPath(hooksJsonPath)) {
    return {
      ok: false,
      exists: fs.existsSync(hooksJsonPath),
      data: null,
      error: '检测到配置目录或 hooks.json 为符号链接，已中止操作以保护配置安全',
    };
  }

  if (!fs.existsSync(hooksJsonPath)) {
    return { ok: true, exists: false, data: {}, error: '' };
  }

  try {
    const st = fs.lstatSync(hooksJsonPath);
    if (!st.isFile()) {
      return { ok: false, exists: true, data: null, error: 'hooks.json 不是常规文件' };
    }
    const raw = fs.readFileSync(hooksJsonPath, 'utf8').replace(/^\uFEFF/, '');
    if (!raw.trim()) {
      return { ok: true, exists: true, data: {}, error: '' };
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, exists: true, data: null, error: 'hooks.json 根节点必须为 JSON 对象' };
    }
    return { ok: true, exists: true, data: parsed, error: '' };
  } catch {
    return { ok: false, exists: true, data: null, error: 'hooks.json 解析失败，已中止写入避免损坏其他 Hook' };
  }
}

/**
 * 原子写入 JSON 文件
 */
function writeJsonAtomic(filePath, dataObj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpFile, `${JSON.stringify(dataObj, null, 2)}\n`, 'utf8');
  try {
    fs.renameSync(tmpFile, filePath);
  } catch {
    fs.copyFileSync(tmpFile, filePath);
    try {
      fs.unlinkSync(tmpFile);
    } catch {}
  }
}

import { resolveHookNodeRuntime } from './planning-manager.mjs';

/**
 * 构建跨平台安全的 Node.js Hook 启动命令（零 Python 依赖；规避 Electron 外壳与 Windows cmd /c 引号剥离）
 */
export function buildNodeHookCommand(scriptPath, options = {}) {
  const platform = options.platform || process.platform;
  const { bin, isElectron } = resolveHookNodeRuntime(options);
  const resolvedScript = path.resolve(scriptPath);

  if (platform === 'win32') {
    const safeNode = `"${String(bin).replace(/"/g, '""')}"`;
    const safeScript = `"${resolvedScript.replace(/"/g, '""')}"`;
    return isElectron
      ? `set ELECTRON_RUN_AS_NODE=1&& ${safeNode} ${safeScript}`
      : `call ${safeNode} ${safeScript}`;
  }

  const quotePosix = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  return isElectron
    ? `ELECTRON_RUN_AS_NODE=1 ${quotePosix(bin)} ${quotePosix(resolvedScript)}`
    : `${quotePosix(bin)} ${quotePosix(resolvedScript)}`;
}

/**
 * 解析当前生效的 rehydrate-hook.mjs 脚本路径（优先使用已安装的插件目录副本，回退源码目录）
 */
export function resolveRehydrateScriptPath(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const paths = getPluginPaths(homeDir);
  const candidates = [
    options.pluginRoot ? path.join(options.pluginRoot, 'scripts', 'rehydrate-hook.mjs') : '',
    path.join(paths.installDir, 'scripts', 'rehydrate-hook.mjs'),
    path.join(DEFAULT_PLUGIN_ROOT, 'scripts', 'rehydrate-hook.mjs'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0];
}

/**
 * 查询压缩后防失忆 Hook 的注册状态、健康度与潜在外部冲突
 */
export function getRehydrateStatus(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const paths = getPluginPaths(homeDir);
  const hooksJsonPath = path.join(paths.geminiRoot, 'config', 'hooks.json');
  const scriptPath = resolveRehydrateScriptPath(options);
  const scriptExists = Boolean(scriptPath && fs.existsSync(scriptPath));

  const readRes = readHooksJsonSafe(hooksJsonPath);
  if (!readRes.ok) {
    return {
      enabled: false,
      registered: false,
      scriptExists,
      scriptPath,
      hooksJsonPath,
      externalConflict: false,
      externalHookName: '',
      runtime: 'Node.js (零外部依赖)',
      error: readRes.error,
    };
  }

  const hooksObj = readRes.data || {};
  const ownEntry = hooksObj[REHYDRATE_HOOK_NAME];
  const handlers = Array.isArray(ownEntry?.PreInvocation) ? ownEntry.PreInvocation : [];
  const registered = Boolean(ownEntry && typeof ownEntry === 'object' && handlers.length > 0);
  const enabled = Boolean(registered && ownEntry.enabled !== false && scriptExists);

  // 检查是否已启用其他同类压缩恢复 Hook（如 antigravity-context-viewer 注册的 post-compact-rehydrate）
  let externalHookName = '';
  for (const name of EXTERNAL_CONFLICT_NAMES) {
    const ext = hooksObj[name];
    if (ext && typeof ext === 'object' && ext.enabled !== false && Array.isArray(ext.PreInvocation) && ext.PreInvocation.length > 0) {
      externalHookName = name;
      break;
    }
  }

  return {
    enabled,
    registered,
    scriptExists,
    scriptPath,
    hooksJsonPath,
    externalConflict: Boolean(externalHookName),
    externalHookName,
    runtime: 'Node.js (零外部依赖)',
    error: registered && !scriptExists ? 'Hook 已注册但未找到脚本文件 rehydrate-hook.mjs' : '',
  };
}

/**
 * 一键启用或停用「压缩后防失忆」PreInvocation Hook
 */
export function setRehydrateEnabled(enabled, options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const paths = getPluginPaths(homeDir);
  const hooksJsonPath = path.join(paths.geminiRoot, 'config', 'hooks.json');
  const scriptPath = resolveRehydrateScriptPath(options);

  const readRes = readHooksJsonSafe(hooksJsonPath);
  if (!readRes.ok) {
    return { ok: false, error: readRes.error, status: getRehydrateStatus(options) };
  }

  const hooksObj = { ...(readRes.data || {}) };

  if (enabled) {
    if (!scriptPath || !fs.existsSync(scriptPath)) {
      return {
        ok: false,
        error: `未找到防失忆 Hook 脚本: ${scriptPath || 'rehydrate-hook.mjs'}`,
        status: getRehydrateStatus(options),
      };
    }
    const command = buildNodeHookCommand(scriptPath, options);
    hooksObj[REHYDRATE_HOOK_NAME] = {
      enabled: true,
      PreInvocation: [
        {
          type: 'command',
          command,
          timeout: 10,
        },
      ],
    };
    writeJsonAtomic(hooksJsonPath, hooksObj);
  } else {
    if (Object.prototype.hasOwnProperty.call(hooksObj, REHYDRATE_HOOK_NAME)) {
      delete hooksObj[REHYDRATE_HOOK_NAME];
      writeJsonAtomic(hooksJsonPath, hooksObj);
    }
  }

  return {
    ok: true,
    status: getRehydrateStatus(options),
  };
}

/**
 * 卸载插件时无痕清理 context-ring 注册的防失忆 Hook 条目
 */
export function removeRehydrateHook(options = {}) {
  return setRehydrateEnabled(false, options);
}

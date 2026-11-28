import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPluginPaths } from './paths.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_PLUGIN_ROOT = path.resolve(__dirname, '..');

export const PLANNING_HOOK_NAME = 'context-ring-planning';
export const PLANNING_STATE_FILENAME = 'planning-state.json';
export const PENDING_SESSION_TTL_MS = 30 * 60 * 1000; // 30 分钟
export const EXIT_NOTICE_TTL_MS = 24 * 60 * 60 * 1000; // 24 小时
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 天
export const MAX_TRACKED_SESSIONS = 100;
export const MAX_NATIVE_PLAN_TEXT_LEN = 12000;
export const SAFE_CID_RE = /^[a-zA-Z0-9_-]{8,128}$/;

/**
 * 检查路径是否为符号链接（fail-closed 安全护栏：拒绝向符号链接写入配置或状态）
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
  const dir = path.dirname(filePath);
  if (isSymlinkPath(dir) || isSymlinkPath(filePath)) {
    throw new Error(`拒绝向符号链接路径写入文件: ${filePath}`);
  }
  fs.mkdirSync(dir, { recursive: true });
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

/**
 * 解析可靠的 Node.js 运行时路径：
 * Sidecar 在 Antigravity 中以 Electron 进程（Antigravity.exe）运行，直接写 process.execPath 会启动 GUI 外壳，
 * 因此优先查找真实 node 可执行文件，兜底时为 Electron 二进制显式附加 ELECTRON_RUN_AS_NODE=1。
 */
export function resolveHookNodeRuntime(options = {}) {
  const platform = options.platform || process.platform;
  if (options.nodePath) {
    const raw = String(options.nodePath).trim();
    const base = path.basename(raw).toLowerCase();
    const isRealNode = base === 'node' || base === 'node.exe';
    return { bin: raw, isElectron: !isRealNode };
  }

  const execPath = String(process.execPath || '').trim();
  const execBase = path.basename(execPath).toLowerCase();
  const execIsRealNode = !process.versions?.electron && (execBase === 'node' || execBase === 'node.exe');
  if (execIsRealNode && execPath) {
    return { bin: execPath, isElectron: false };
  }

  const binName = platform === 'win32' ? 'node.exe' : 'node';
  const pathDirs = String(process.env.PATH || '')
    .split(path.delimiter)
    .map((d) => d.trim().replace(/^"+|"+$/g, ''))
    .filter(Boolean);
  const commonDirs =
    platform === 'win32'
      ? [
          path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs'),
          path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs'),
        ]
      : ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin'];

  for (const dir of [...pathDirs, ...commonDirs]) {
    const candidate = path.join(dir, binName);
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return { bin: candidate, isElectron: false };
      }
    } catch {}
  }

  if (execPath) {
    return { bin: execPath, isElectron: true };
  }
  return { bin: 'node', isElectron: false };
}

/**
 * 构建跨平台安全的 Node.js Hook 启动命令（零外部依赖；Windows 使用 call / set 前缀规避 cmd /c 首尾引号剥离）
 */
export function buildPlanningHookCommand(scriptPath, options = {}) {
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
 * 解析当前生效的 planning-hook.mjs 脚本路径（优先插件目录副本，回退源码目录）
 */
export function resolvePlanningScriptPath(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const paths = getPluginPaths(homeDir);
  const candidates = [
    options.pluginRoot ? path.join(options.pluginRoot, 'scripts', 'planning-hook.mjs') : '',
    path.join(paths.installDir, 'scripts', 'planning-hook.mjs'),
    path.join(DEFAULT_PLUGIN_ROOT, 'scripts', 'planning-hook.mjs'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0];
}

/**
 * 解析 planning-state.json 状态文件路径
 */
export function resolvePlanningStatePath(options = {}) {
  if (options.statePath) return path.resolve(options.statePath);
  const homeDir = options.homeDir || os.homedir();
  const dataDir = options.dataDir || getPluginPaths(homeDir).dataDir;
  return path.join(dataDir, PLANNING_STATE_FILENAME);
}

/**
 * 创建空的 Planning 运行态对象
 */
export function createEmptyPlanningState() {
  return {
    version: 1,
    sessions: {},
    pendingNewSession: null,
    exitNotices: {},
    nativePlanPrompt: null,
  };
}

/**
 * 校验并规范化 Planning 状态对象，自动清理过期会话、待领槽位与退出通知
 */
export function normalizePlanningState(raw, now = Date.now()) {
  const base = createEmptyPlanningState();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return base;
  }

  const rawSessions = raw.sessions && typeof raw.sessions === 'object' && !Array.isArray(raw.sessions)
    ? raw.sessions
    : {};
  const validEntries = [];
  for (const [cid, entry] of Object.entries(rawSessions)) {
    if (!SAFE_CID_RE.test(cid) || !entry || typeof entry !== 'object' || entry.enabled !== true) {
      continue;
    }
    const updatedAt = Number(entry.updatedAt || 0);
    if (updatedAt > 0 && now - updatedAt > SESSION_TTL_MS) {
      continue;
    }
    validEntries.push([
      cid,
      {
        enabled: true,
        injectedPrompt: Boolean(entry.injectedPrompt),
        lastCheckpointUid: typeof entry.lastCheckpointUid === 'string' ? entry.lastCheckpointUid.slice(0, 64) : '',
        enteredUserLineIdx: Number.isInteger(entry.enteredUserLineIdx) ? entry.enteredUserLineIdx : -1,
        updatedAt: updatedAt > 0 ? updatedAt : now,
        claimedFromPending: Boolean(entry.claimedFromPending),
      },
    ]);
  }
  validEntries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  for (const [cid, val] of validEntries.slice(0, MAX_TRACKED_SESSIONS)) {
    base.sessions[cid] = val;
  }

  const pending = raw.pendingNewSession;
  if (pending && typeof pending === 'object' && pending.enabled === true) {
    const armedAt = Number(pending.armedAt || 0);
    const ttlMs = Number(pending.ttlMs || PENDING_SESSION_TTL_MS);
    const safeTtl = Number.isFinite(ttlMs) && ttlMs > 0 ? Math.min(ttlMs, 4 * 60 * 60 * 1000) : PENDING_SESSION_TTL_MS;
    if (armedAt > 0 && now - armedAt <= safeTtl) {
      base.pendingNewSession = {
        enabled: true,
        armedAt,
        ttlMs: safeTtl,
      };
    }
  }

  const rawExit = raw.exitNotices && typeof raw.exitNotices === 'object' && !Array.isArray(raw.exitNotices)
    ? raw.exitNotices
    : {};
  const exitEntries = [];
  for (const [cid, entry] of Object.entries(rawExit)) {
    if (!SAFE_CID_RE.test(cid) || base.sessions[cid]) continue;
    const createdAt = Number(entry?.createdAt || 0);
    if (createdAt > 0 && now - createdAt > EXIT_NOTICE_TTL_MS) continue;
    exitEntries.push([cid, { createdAt: createdAt > 0 ? createdAt : now }]);
  }
  exitEntries.sort((a, b) => b[1].createdAt - a[1].createdAt);
  for (const [cid, val] of exitEntries.slice(0, 50)) {
    base.exitNotices[cid] = val;
  }

  const nativePrompt = raw.nativePlanPrompt;
  if (nativePrompt && typeof nativePrompt === 'object' && typeof nativePrompt.text === 'string') {
    const trimmed = nativePrompt.text.trim();
    if (trimmed) {
      base.nativePlanPrompt = {
        text: trimmed.slice(0, MAX_NATIVE_PLAN_TEXT_LEN),
        updatedAt: Number(nativePrompt.updatedAt || now),
      };
    }
  }

  return base;
}

/**
 * 读取并规范化本地 Planning 状态文件
 */
export function readPlanningState(options = {}) {
  const statePath = resolvePlanningStatePath(options);
  const now = Number(options.now || Date.now());
  try {
    if (isSymlinkPath(statePath) || !fs.existsSync(statePath)) {
      return createEmptyPlanningState();
    }
    const raw = fs.readFileSync(statePath, 'utf8').replace(/^\uFEFF/, '');
    if (!raw.trim()) return createEmptyPlanningState();
    return normalizePlanningState(JSON.parse(raw), now);
  } catch {
    return createEmptyPlanningState();
  }
}

/**
 * 原子持久化 Planning 状态文件
 */
export function writePlanningState(state, options = {}) {
  const statePath = resolvePlanningStatePath(options);
  const now = Number(options.now || Date.now());
  const normalized = normalizePlanningState(state, now);
  writeJsonAtomic(statePath, normalized);
  return normalized;
}

/**
 * 计算期望的 hooks.json 注册模式：
 * - full: 存在激活 Planning 会话或空白新会话待领槽位（注册 PreInvocation + PreToolUse）
 * - exit-only: 全部会话已关闭但仍有待投递的退出通知（仅注册 PreInvocation，实现阶段零工具拦截开销）
 * - off: 全部空闲（从 hooks.json 彻底移除 context-ring-planning）
 */
export function resolveDesiredHookMode(state) {
  const activeCount = Object.keys(state?.sessions || {}).length;
  const hasPending = Boolean(state?.pendingNewSession?.enabled);
  if (activeCount > 0 || hasPending) return 'full';
  const exitCount = Object.keys(state?.exitNotices || {}).length;
  if (exitCount > 0) return 'exit-only';
  return 'off';
}

/**
 * 按当前 Planning 状态自动同步 ~/.gemini/config/hooks.json 的三态注册
 */
export function syncPlanningHookRegistration(state, options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const paths = getPluginPaths(homeDir);
  const hooksJsonPath = path.join(paths.geminiRoot, 'config', 'hooks.json');
  const scriptPath = resolvePlanningScriptPath(options);
  const desiredMode = resolveDesiredHookMode(state);

  const readRes = readHooksJsonSafe(hooksJsonPath);
  if (!readRes.ok) {
    return { ok: false, error: readRes.error, hookMode: 'off', hooksJsonPath };
  }

  const hooksObj = { ...(readRes.data || {}) };

  if (desiredMode === 'off') {
    if (Object.prototype.hasOwnProperty.call(hooksObj, PLANNING_HOOK_NAME)) {
      delete hooksObj[PLANNING_HOOK_NAME];
      writeJsonAtomic(hooksJsonPath, hooksObj);
    }
    return { ok: true, error: '', hookMode: 'off', hooksJsonPath };
  }

  if (!scriptPath || !fs.existsSync(scriptPath)) {
    return {
      ok: false,
      error: `未找到 Planning 护栏脚本: ${scriptPath || 'planning-hook.mjs'}`,
      hookMode: 'off',
      hooksJsonPath,
    };
  }

  const command = buildPlanningHookCommand(scriptPath, options);
  const nextEntry = {
    enabled: true,
    PreInvocation: [
      {
        type: 'command',
        command,
        timeout: 8,
      },
    ],
  };

  if (desiredMode === 'full') {
    nextEntry.PreToolUse = [
      {
        matcher: '*',
        hooks: [
          {
            type: 'command',
            command,
            timeout: 8,
          },
        ],
      },
    ];
  }

  const prevSerialized = JSON.stringify(hooksObj[PLANNING_HOOK_NAME] || null);
  const nextSerialized = JSON.stringify(nextEntry);
  if (prevSerialized !== nextSerialized) {
    hooksObj[PLANNING_HOOK_NAME] = nextEntry;
    writeJsonAtomic(hooksJsonPath, hooksObj);
  }

  return { ok: true, error: '', hookMode: desiredMode, hooksJsonPath };
}

/**
 * 查询当前 Planning 模式的完整状态快照（供前端、Sidecar 与 CLI 同步）
 */
export function getPlanningStatus(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const paths = getPluginPaths(homeDir);
  const hooksJsonPath = path.join(paths.geminiRoot, 'config', 'hooks.json');
  const statePath = resolvePlanningStatePath(options);
  const scriptPath = resolvePlanningScriptPath(options);
  const scriptExists = Boolean(scriptPath && fs.existsSync(scriptPath));
  const state = readPlanningState(options);
  const activeSessionIds = Object.keys(state.sessions);
  const exitNoticeCount = Object.keys(state.exitNotices).length;

  const readRes = readHooksJsonSafe(hooksJsonPath);
  if (!readRes.ok) {
    return {
      hookRegistered: false,
      hookMode: 'off',
      activeSessionIds,
      activeCount: activeSessionIds.length,
      pendingNewSession: Boolean(state.pendingNewSession?.enabled),
      pendingArmedAt: state.pendingNewSession?.armedAt || 0,
      exitNoticeCount,
      hasNativePlanPrompt: Boolean(state.nativePlanPrompt?.text),
      scriptExists,
      scriptPath,
      hooksJsonPath,
      statePath,
      runtime: 'Node.js (零外部依赖)',
      error: readRes.error,
    };
  }

  const ownEntry = (readRes.data || {})[PLANNING_HOOK_NAME];
  const hasPreInv = Array.isArray(ownEntry?.PreInvocation) && ownEntry.PreInvocation.length > 0;
  const hasPreTool = Array.isArray(ownEntry?.PreToolUse) && ownEntry.PreToolUse.length > 0;
  const hookRegistered = Boolean(ownEntry && typeof ownEntry === 'object' && ownEntry.enabled !== false && (hasPreInv || hasPreTool));
  let hookMode = 'off';
  if (hookRegistered && scriptExists) {
    hookMode = hasPreTool ? 'full' : 'exit-only';
  }

  const desiredMode = resolveDesiredHookMode(state);
  let error = '';
  if (hookRegistered && !scriptExists) {
    error = 'Planning Hook 已注册但未找到脚本 planning-hook.mjs';
  } else if (desiredMode === 'full' && hookMode !== 'full') {
    error = 'Planning 状态已开启但 hooks.json 护栏未就绪，请重新切换开关同步';
  }

  return {
    hookRegistered,
    hookMode,
    activeSessionIds,
    activeCount: activeSessionIds.length,
    pendingNewSession: Boolean(state.pendingNewSession?.enabled),
    pendingArmedAt: state.pendingNewSession?.armedAt || 0,
    exitNoticeCount,
    hasNativePlanPrompt: Boolean(state.nativePlanPrompt?.text),
    scriptExists,
    scriptPath,
    hooksJsonPath,
    statePath,
    runtime: 'Node.js (零外部依赖)',
    error,
  };
}

/**
 * 判断指定会话（或空白新会话）当前是否处于 Planning 模式
 */
export function isPlanningActiveFor(statusOrState, conversationId = '') {
  const cid = String(conversationId || '').trim();
  if (!statusOrState || typeof statusOrState !== 'object') return false;
  if (!cid) {
    return Boolean(
      typeof statusOrState.pendingNewSession === 'boolean'
        ? statusOrState.pendingNewSession
        : statusOrState.pendingNewSession?.enabled
    );
  }
  if (Array.isArray(statusOrState.activeSessionIds)) {
    return statusOrState.activeSessionIds.includes(cid);
  }
  return Boolean(statusOrState.sessions?.[cid]?.enabled);
}

/**
 * 为指定会话（或空白新会话）开启/关闭 Planning 模式，并自动同步 hooks.json 护栏
 */
export function setPlanningForConversation(
  { conversationId = '', enabled = false, nativePlanText = '' } = {},
  options = {}
) {
  const now = Number(options.now || Date.now());
  const cid = String(conversationId || '').trim();
  if (cid && !SAFE_CID_RE.test(cid)) {
    return {
      ok: false,
      error: '无效的会话 ID 格式',
      status: getPlanningStatus(options),
    };
  }

  const state = readPlanningState({ ...options, now });
  const cleanNative = typeof nativePlanText === 'string' ? nativePlanText.trim() : '';
  if (cleanNative) {
    state.nativePlanPrompt = {
      text: cleanNative.slice(0, MAX_NATIVE_PLAN_TEXT_LEN),
      updatedAt: now,
    };
  }

  if (enabled) {
    if (cid) {
      const prev = state.sessions[cid];
      state.sessions[cid] = {
        enabled: true,
        injectedPrompt: Boolean(prev?.injectedPrompt),
        lastCheckpointUid: prev?.lastCheckpointUid || '',
        updatedAt: now,
        claimedFromPending: Boolean(prev?.claimedFromPending),
      };
      delete state.exitNotices[cid];
    } else {
      state.pendingNewSession = {
        enabled: true,
        armedAt: now,
        ttlMs: PENDING_SESSION_TTL_MS,
      };
    }
  } else if (cid) {
    const prev = state.sessions[cid];
    delete state.sessions[cid];
    if (prev && prev.injectedPrompt) {
      state.exitNotices[cid] = { createdAt: now };
    }
  } else {
    state.pendingNewSession = null;
  }

  const syncRes = syncPlanningHookRegistration(state, options);
  if (enabled && !syncRes.ok) {
    // fail-closed：无法注册 hooks.json 护栏时绝不落盘激活态，避免前端假显示「已开启」
    return {
      ok: false,
      error: syncRes.error,
      status: getPlanningStatus(options),
    };
  }

  try {
    writePlanningState(state, { ...options, now });
  } catch (err) {
    return {
      ok: false,
      error: err?.message || String(err),
      status: getPlanningStatus(options),
    };
  }

  return {
    ok: syncRes.ok,
    error: syncRes.error || '',
    status: getPlanningStatus(options),
  };
}

/**
 * 静默缓存从宿主 slashCommandItems 采样到的原生 /plan 指导文本
 */
export function syncNativePlanPrompt(nativePlanText, options = {}) {
  const clean = typeof nativePlanText === 'string' ? nativePlanText.trim() : '';
  if (!clean) return { ok: false, updated: false };
  const clipped = clean.slice(0, MAX_NATIVE_PLAN_TEXT_LEN);
  const now = Number(options.now || Date.now());
  const state = readPlanningState({ ...options, now });
  if (state.nativePlanPrompt?.text === clipped) {
    return { ok: true, updated: false };
  }
  state.nativePlanPrompt = { text: clipped, updatedAt: now };
  try {
    writePlanningState(state, { ...options, now });
    return { ok: true, updated: true };
  } catch {
    return { ok: false, updated: false };
  }
}

/**
 * 清空所有会话的 Planning 模式（用于 CLI 批量重置或插件卸载）
 */
export function clearAllPlanningSessions(options = {}) {
  const now = Number(options.now || Date.now());
  const emitExitNotices = Boolean(options.emitExitNotices);
  const prev = readPlanningState({ ...options, now });
  const next = createEmptyPlanningState();
  next.nativePlanPrompt = prev.nativePlanPrompt;

  if (emitExitNotices) {
    for (const [cid, entry] of Object.entries(prev.sessions)) {
      if (entry && entry.injectedPrompt) {
        next.exitNotices[cid] = { createdAt: now };
      }
    }
  }

  const syncRes = syncPlanningHookRegistration(next, options);
  try {
    writePlanningState(next, { ...options, now });
  } catch {
    // 卸载阶段忽略数据目录写入失败
  }

  return {
    ok: syncRes.ok,
    error: syncRes.error || '',
    status: getPlanningStatus(options),
  };
}

/**
 * 卸载插件时无痕清理 context-ring-planning Hook 条目与运行态
 */
export function removePlanningHook(options = {}) {
  return clearAllPlanningSessions({ ...options, emitExitNotices: false });
}

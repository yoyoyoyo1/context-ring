#!/usr/bin/env node
/**
 * Context Ring — Planning 模式（PreInvocation 规划引导 + PreToolUse 只读护栏）Hook
 *
 * 特点：
 * 1. 纯 Node.js 零外部依赖实现，按会话 ID 严格隔离；
 * 2. PreInvocation 优先复用采样自 Antigravity 原生 /plan 的规范文本，仅在进入 Planning
 *    或发生 CHECKPOINT 压缩后注入一次，保护 Prompt Cache；退出后首轮自动投递解除通知并注销 Hook；
 * 3. PreToolUse 在 Planning 开启期间硬拦截工作区文件修改与写操作命令，仅放行只读调研工具、
 *    安全的单条只读检查命令，以及严格位于 artifactDirectoryPath 内的规划文档写入（如 implementation_plan.md）；
 * 4. 空白新会话提前点开 Planning 时，自动把待领槽位精准晋升绑定到新建会话，绝不被已有老会话误领。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  SAFE_CID_RE,
  readPlanningState,
  writePlanningState,
  syncPlanningHookRegistration,
} from '../lib/planning-manager.mjs';

const DEFAULT_NATIVE_ALIGNED_PLAN_PROMPT = `<PLAN>The user has enabled Planning Mode for this conversation. Think and plan carefully before executing the task.
Carefully research the task, make sure that you and the user are aligned on the goals and requirements,
create a detailed implementation plan artifact, and get user approval on the plan before making any code changes (besides artifacts)
or running any modifying commands.

# Guidelines
- Establish a shared understanding of the task with the user. If there are any ambiguities, underspecified requirements,
  or implicit assumptions, clarify them with the user before proceeding.
- Thoroughly research the codebase using read-only tools to establish a solid understanding of the relevant components, systems, dependencies, and architecture.
  Provide brief progress updates as you research.
- Create an implementation plan artifact (e.g. \`implementation_plan.md\`) inside the conversation's artifact directory with \`RequestFeedback: true\` and \`UserFacing: true\` in ArtifactMetadata so the user can review and approve it.
- Do NOT modify workspace source files or run mutating commands while Planning Mode is active.
- Only after the user approves the plan and exits Planning Mode should you proceed to implementation and verification.</PLAN>`;

const ALWAYS_ALLOW_TOOLS = new Set([
  'read_file',
  'view_file',
  'view_file_outline',
  'view_code_item',
  'list_dir',
  'find_by_name',
  'grep_search',
  'read_resource',
  'list_resources',
  'search_web',
  'read_url_content',
  'search_marketplace',
  'list_plugin_accounts',
  'command_status',
  'read_terminal',
  'ask_question',
  'update_focus',
  'update_steps',
  'notify_user',
  'task_boundary',
  'view_content_chunk',
]);

const FILE_WRITE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
  'code_action',
  'notebook_edit',
  'edit_notebook',
]);

const ALWAYS_DENY_TOOLS = new Set([
  'delete_file',
  'remove_file',
  'move_file',
  'rename_file',
  'send_command_input',
  'run_workflow',
  'swarm',
  'schedule',
  'image_generator',
  'generate_image',
]);

const ARTIFACT_ALLOWED_EXTS = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.json',
  '.mmd',
  '.mermaid',
  '.svg',
]);

const PATH_KEYS = ['Path', 'path', 'AbsolutePath', 'TargetFile', 'file_path', 'target_file', 'FilePath'];

const SHELL_METACHAR_RE = /[|&;<>`$\r\n]/;
const MUTATING_FLAG_RE = /(?:^|\s)(?:--in-place|--fix|--write|-o|--output|--delete|--force)(?=\s|$|=)/;
const POWERSHELL_WRITE_RE = /\b(?:invoke-|iex\b|set-|remove-|new-|copy-|move-|rename-|clear-|out-file|add-content|set-content|start-process|stop-process|kill\b)/i;

const SAFE_READONLY_COMMAND_PATTERNS = [
  /^git\s+(?:status|log|diff|show|rev-parse|ls-files|describe|shortlog|blame|cat-file|check-ignore)(?:\s|$)/i,
  /^git\s+branch(?:\s+(?:-[arv]|--list|--show-current|--all|--remotes|--verbose))*$/i,
  /^git\s+tag(?:\s+(?:-l|--list)(?:\s+\S+)?)?$/i,
  /^git\s+remote(?:\s+-v|\s+--verbose|\s+show(?:\s+\S+)?)?$/i,
  /^git\s+(?:--version|-v)$/i,
  /^(?:ls|dir|pwd|which|where|whoami|tree|rg|grep|findstr|head|tail|wc|cat|type|get-childitem|get-content)(?:\s|$)/i,
  /^(?:node|npm|pnpm|yarn|python|python3|go|rustc|cargo|java|javac|dotnet)\s+(?:-v|--version|version)$/i,
];

const READONLY_MCP_VERB_RE = /(?:^|_)(?:read|get|list|search|find|query|inspect|describe|fetch|outline|batch_search|read_slices|quick_outline)(?:_|$)/i;
const MUTATING_TOOL_VERB_RE = /(?:^|_)(?:write|edit|delete|remove|move|rename|create|patch|apply|exec|command|terminal|shell|deploy|push|commit|merge|install|uninstall|modify|update|put|post|run_checks|apply_edits)(?:_|$)/i;

/**
 * 规范化路径以便在 Windows / POSIX 下安全比较前缀边界
 */
function normalizeComparePath(p) {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * 检查目标路径是否严格落在会话 artifactDirectoryPath 内，且为安全的文本/规划文档扩展名（防路径穿越与符号链接越界）
 */
export function isPathInsideArtifactDir(rawPath, artifactDir, cwd = '') {
  const targetRaw = String(rawPath || '').trim();
  const baseRaw = String(artifactDir || '').trim();
  if (!targetRaw || !baseRaw) return false;

  const absTarget = path.isAbsolute(targetRaw)
    ? path.resolve(targetRaw)
    : cwd
      ? path.resolve(cwd, targetRaw)
      : '';
  if (!absTarget) return false;

  const absBase = path.resolve(baseRaw);

  // 禁止写入可执行或脚本文件到 Artifact 目录
  const ext = path.extname(absTarget).toLowerCase();
  if (!ARTIFACT_ALLOWED_EXTS.has(ext)) {
    return false;
  }

  // 解析真实基路径（若目录已存在）
  let realBase = absBase;
  try {
    if (fs.existsSync(absBase)) {
      realBase = fs.realpathSync(absBase);
    }
  } catch {
    return false;
  }

  // 校验逻辑路径边界
  const rel = path.relative(normalizeComparePath(absBase), normalizeComparePath(absTarget));
  if (!rel || rel === '.' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return false;
  }

  // 逐级检查已存在的路径节点是否为符号链接，防止借软链跳出 Artifact 目录
  try {
    let cursor = absTarget;
    const baseNorm = normalizeComparePath(absBase);
    while (normalizeComparePath(cursor) !== baseNorm) {
      if (fs.existsSync(cursor)) {
        const st = fs.lstatSync(cursor);
        if (st.isSymbolicLink()) return false;
        const realCursor = fs.realpathSync(cursor);
        const realRel = path.relative(normalizeComparePath(realBase), normalizeComparePath(realCursor));
        if (!realRel || realRel.startsWith('..') || path.isAbsolute(realRel)) {
          return false;
        }
        break;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  } catch {
    return false;
  }

  return true;
}

/**
 * 判断一条终端命令是否为严格安全的单条只读检视命令（拒绝任何管道、链式连接、重定向、命令替换与写标志）
 */
export function isSafeReadOnlyCommand(commandLine) {
  const cmd = String(commandLine || '').trim();
  if (!cmd || cmd.length > 400) return false;
  if (SHELL_METACHAR_RE.test(cmd)) return false;
  if (POWERSHELL_WRITE_RE.test(cmd)) return false;
  if (MUTATING_FLAG_RE.test(cmd)) return false;
  return SAFE_READONLY_COMMAND_PATTERNS.some((re) => re.test(cmd));
}

/**
 * 从工具参数中提取目标文件路径
 */
function extractTargetFilePath(args) {
  if (!args || typeof args !== 'object') return '';
  for (const key of PATH_KEYS) {
    const val = args[key];
    if (typeof val === 'string' && val.trim()) {
      return val.trim();
    }
  }
  return '';
}

/**
 * 构造统一的 Planning 只读拦截响应
 */
function buildDeny(reasonDetail) {
  return {
    decision: 'deny',
    reason: `Context Ring Planning 模式已开启（只读规划阶段）：${reasonDetail}。请先完成调研并生成/完善规划文档等待用户确认，或提醒用户点击输入框底栏 Planning 胶囊切回普通模式后再执行修改。`,
  };
}

/**
 * 在 Planning 模式下对单个 PreToolUse 工具调用进行放行/硬拦截判定
 */
export function classifyToolCall(toolCall, payload = {}) {
  const rawName = String(toolCall?.name || '').trim().toLowerCase().replace(/^cortex_step_type_/, '');
  const args = toolCall?.args && typeof toolCall.args === 'object' ? toolCall.args : {};
  const artifactDir = String(payload?.artifactDirectoryPath || '').trim();
  const cwd = String(payload?.cwd || payload?.workspacePaths?.[0] || '').trim();

  if (!rawName) {
    return { decision: 'allow' };
  }

  // 1. 明确放行的只读与规划协作工具
  if (ALWAYS_ALLOW_TOOLS.has(rawName)) {
    return { decision: 'allow' };
  }

  if (rawName === 'manage_task') {
    const action = String(args.Action || args.action || '').trim().toLowerCase();
    return action === 'list' || action === 'status'
      ? { decision: 'allow' }
      : buildDeny(`禁止执行 manage_task(${action || 'unknown'}) 修改后台任务`);
  }

  if (rawName === 'manage_subagents') {
    const action = String(args.Action || args.action || '').trim().toLowerCase();
    return action === 'list'
      ? { decision: 'allow' }
      : buildDeny(`禁止执行 manage_subagents(${action || 'unknown'})`);
  }

  // 2. 明确禁止的破坏性文件操作与多代理写编排工具
  if (ALWAYS_DENY_TOOLS.has(rawName)) {
    return buildDeny(`禁止调用写操作/编排工具 ${rawName}`);
  }

  // 3. 子代理调用：仅放行只读 research 子代理
  if (rawName === 'invoke_subagent') {
    const typeName = String(args.TypeName || args.typeName || '').trim().toLowerCase();
    if (typeName === 'research') {
      return { decision: 'allow' };
    }
    return buildDeny(`禁止拉起可能执行写操作的子代理 (${typeName || 'unknown'})，调研请使用 research 子代理`);
  }

  // 4. 文件写入与编辑工具：仅放行写入当前会话 artifactDirectoryPath 内的规划文档
  if (FILE_WRITE_TOOLS.has(rawName)) {
    const targetPath = extractTargetFilePath(args);
    if (targetPath && isPathInsideArtifactDir(targetPath, artifactDir, cwd)) {
      return { decision: 'allow' };
    }
    return buildDeny(`禁止修改工作区或非 Artifact 目录文件 (${targetPath || rawName})`);
  }

  // 5. 终端命令工具：仅放行严格白名单内的单条只读命令
  if (rawName === 'run_command') {
    const cmd = String(args.CommandLine || args.command || args.cmd || '').trim();
    if (isSafeReadOnlyCommand(cmd)) {
      return { decision: 'allow' };
    }
    return buildDeny(`禁止执行可能产生副作用的终端命令 (${cmd.slice(0, 80) || 'run_command'})`);
  }

  // 6. MCP 工具（含直调 mcp_* 与延迟包装 call_mcp_tool）
  if (rawName.startsWith('mcp_') || rawName === 'call_mcp_tool' || rawName === 'mcp_tool') {
    let mcpTool = rawName;
    let mcpArgs = args;
    if (rawName === 'call_mcp_tool' || rawName === 'mcp_tool') {
      mcpTool = String(args.ToolName || args.toolName || args.name || '').trim().toLowerCase();
      const inner = args.Arguments || args.arguments || {};
      mcpArgs = typeof inner === 'string' ? (() => { try { return JSON.parse(inner); } catch { return {}; } })() : inner;
    }

    if (mcpTool.endsWith('apply_edits')) {
      if (mcpArgs?.verify) {
        return buildDeny('禁止在 apply_edits 中携带 verify 终端命令');
      }
      let edits = mcpArgs?.edits;
      if (typeof edits === 'string') {
        try {
          edits = JSON.parse(edits);
        } catch {
          edits = null;
        }
      }
      const editCwd = String(mcpArgs?.cwd || cwd || '').trim();
      if (Array.isArray(edits) && edits.length > 0) {
        const allInsideArtifact = edits.every((item) =>
          item && typeof item.path === 'string' && isPathInsideArtifactDir(item.path, artifactDir, editCwd)
        );
        if (allInsideArtifact) {
          return { decision: 'allow' };
        }
      }
      return buildDeny(`禁止通过 ${mcpTool} 批量修改工作区代码`);
    }

    if (mcpTool.endsWith('run_checks')) {
      const cmds = Array.isArray(mcpArgs?.commands) ? mcpArgs.commands : [];
      if (cmds.length > 0 && cmds.every((item) => isSafeReadOnlyCommand(item?.command || ''))) {
        return { decision: 'allow' };
      }
      return buildDeny(`禁止通过 ${mcpTool} 执行修改型或复合检查命令`);
    }

    if (MUTATING_TOOL_VERB_RE.test(mcpTool)) {
      return buildDeny(`禁止调用写入类 MCP 工具 (${mcpTool})`);
    }
    if (READONLY_MCP_VERB_RE.test(mcpTool)) {
      return { decision: 'allow' };
    }
    // 未知 MCP 工具采取安全保守策略：拒绝而非盲目放行
    return buildDeny(`Planning 模式下未识别为只读的 MCP 工具 (${mcpTool || rawName}) 已拦截`);
  }

  // 7. 兜底：匹配写操作语义的工具一律拦截，其余无害内置元数据步骤放行
  if (MUTATING_TOOL_VERB_RE.test(rawName)) {
    return buildDeny(`禁止调用写入类工具 (${rawName})`);
  }
  return { decision: 'allow' };
}

/**
 * 判断用户输入文本是否为 Antigravity 原生点击 Proceed 批准实施计划的系统消息
 */
export function isArtifactProceedApprovalText(rawText) {
  const text = String(rawText || '');
  return (
    text.includes('Comments on artifact URI:') &&
    /The user has approved this document\./i.test(text)
  );
}

/**
 * 精准扫描 transcript.jsonl：解析真实步骤类型，判断是否有历史 PLANNER_RESPONSE、
 * 提取最新 CHECKPOINT 指纹及最新 USER_INPUT 是否为原生 Proceed 批准消息
 */
function inspectTranscriptMeta(transcriptPath) {
  const result = {
    hasPriorPlannerResponse: false,
    latestCheckpointUid: '',
    latestUserLineIdx: -1,
    latestUserIsProceed: false,
  };
  const filePath = String(transcriptPath || '').trim();
  if (!filePath) return result;
  try {
    if (!fs.existsSync(filePath)) return result;
    const st = fs.lstatSync(filePath);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 20 * 1024 * 1024) return result;
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      if (!line) continue;
      if (
        !line.includes('"PLANNER_RESPONSE"') &&
        !line.includes('"CHECKPOINT"') &&
        !line.includes('"USER_INPUT"')
      ) {
        continue;
      }
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== 'object') continue;
      if (parsed.type === 'PLANNER_RESPONSE') {
        result.hasPriorPlannerResponse = true;
      } else if (parsed.type === 'CHECKPOINT') {
        result.latestCheckpointUid = crypto
          .createHash('sha1')
          .update(`${idx}:${String(parsed.created_at || '')}:${String(parsed.step_index ?? '')}`)
          .digest('hex')
          .slice(0, 16);
      } else if (parsed.type === 'USER_INPUT') {
        result.latestUserLineIdx = idx;
        result.latestUserIsProceed = isArtifactProceedApprovalText(parsed.content || '');
      }
    }
  } catch {
    // 读取失败时保守返回默认值，不阻塞会话
  }
  return result;
}

/**
 * 组装注入给模型的 Planning 模式系统提示（优先复用 Antigravity 原生 /plan 文本）
 */
export function buildPlanningSystemMessage(nativePlanText = '', artifactDir = '') {
  const corePlanSpec = String(nativePlanText || '').trim() || DEFAULT_NATIVE_ALIGNED_PLAN_PROMPT;
  const artifactHint = artifactDir
    ? `当前会话 Artifact 目录：\`${artifactDir}\`（仅允许在此目录内创建/更新规划文档，如 \`implementation_plan.md\`）。`
    : '仅允许在当前会话的 Artifact 目录内创建/更新规划文档（如 `implementation_plan.md`）。';

  return [
    '[Context Ring · Planning Mode ACTIVE]',
    corePlanSpec,
    '',
    '# Context Ring Read-Only Guardrail',
    `- 当前会话已开启 Context Ring Planning 模式，\`PreToolUse\` 只读护栏正在生效：任何工作区代码写入、编辑或修改型终端命令都会被硬拦截。`,
    `- ${artifactHint}`,
    '- 请专注于只读代码调研、澄清关键决策，并输出清晰可审阅的实施计划 Artifact（设置 `RequestFeedback: true, UserFacing: true`）；用户点击计划上的 **Proceed** 按钮（或手动关闭底栏 **Planning** 胶囊）后会自动退出只读护栏，届时即可直接开始执行代码修改。',
  ].join('\n');
}

/**
 * 退出 Planning 模式后的单次解除通知
 */
export function buildPlanningExitMessage(byProceed = false) {
  if (byProceed) {
    return '[Context Ring · Planning Mode EXITED]\n用户已点击 Proceed 批准实施计划，当前会话已自动退出 Planning 模式并解除只读护栏。现在可以正常编辑工作区文件、执行命令并按已确认的计划完成实施。';
  }
  return '[Context Ring · Planning Mode EXITED]\n用户已关闭当前会话的 Planning 模式，只读护栏已解除。现在可以正常编辑工作区文件、执行命令并按已确认的计划继续实施。';
}

/**
 * 处理单次 Hook stdin 载荷并返回标准 stdout JSON 对象
 */
export function runPlanningHookPayload(payload, options = {}) {
  const safePayload = payload && typeof payload === 'object' ? payload : {};
  const eventName = String(safePayload.hookEventName || '').trim();
  const cid = String(safePayload.conversationId || '').trim();
  const now = Number(options.now || Date.now());

  const state = readPlanningState({ ...options, now });

  // 事件 1：PreToolUse 工具执行前护栏
  if (eventName === 'PreToolUse') {
    if (!cid || !state.sessions[cid]?.enabled) {
      return { decision: 'allow' };
    }
    return classifyToolCall(safePayload.toolCall, safePayload);
  }

  // 事件 2：PreInvocation 模型调用前引导 / 晋升 / Proceed 自动退出 / 退出通知
  if (eventName === 'PreInvocation' || !eventName) {
    let stateMutated = false;

    // 2.1 若用户在新开空白会话里提前开启了 Planning，精准晋升绑定到新建会话
    if (cid && SAFE_CID_RE.test(cid) && !state.sessions[cid] && state.pendingNewSession?.enabled) {
      const initialNumSteps = Number(safePayload.initialNumSteps ?? 0);
      const invocationNum = Number(safePayload.invocationNum ?? 1);
      const meta = inspectTranscriptMeta(safePayload.transcriptPath);
      const isFreshSession =
        Number.isFinite(initialNumSteps) &&
        initialNumSteps <= 4 &&
        Number.isFinite(invocationNum) &&
        invocationNum <= 1 &&
        !meta.hasPriorPlannerResponse;

      if (isFreshSession) {
        state.sessions[cid] = {
          enabled: true,
          injectedPrompt: false,
          lastCheckpointUid: meta.latestCheckpointUid || '',
          enteredUserLineIdx: meta.latestUserLineIdx,
          updatedAt: now,
          claimedFromPending: true,
        };
        state.pendingNewSession = null;
        delete state.exitNotices[cid];
        stateMutated = true;
      }
    }

    // 2.2 当前会话处于 Planning 模式
    const activeSession = cid ? state.sessions[cid] : null;
    if (activeSession && activeSession.enabled) {
      const meta = inspectTranscriptMeta(safePayload.transcriptPath);

      // 2.2a 检测用户点击原生 Proceed 批准计划：立即自动退出 Planning 并解除只读护栏
      const proceedFromPayload = isArtifactProceedApprovalText(safePayload.lastUserInput || '');
      const proceedFromTranscript = Boolean(
        activeSession.injectedPrompt &&
          meta.latestUserIsProceed &&
          meta.latestUserLineIdx > (Number.isInteger(activeSession.enteredUserLineIdx) ? activeSession.enteredUserLineIdx : -1)
      );
      if (proceedFromPayload || proceedFromTranscript) {
        delete state.sessions[cid];
        delete state.exitNotices[cid];
        try {
          writePlanningState(state, { ...options, now });
          syncPlanningHookRegistration(state, options);
        } catch {}
        return {
          injectSteps: [
            {
              systemMessage: {
                systemMessage: buildPlanningExitMessage(true),
              },
            },
          ],
        };
      }

      const checkpointChanged = Boolean(
        meta.latestCheckpointUid && meta.latestCheckpointUid !== activeSession.lastCheckpointUid
      );
      const shouldInject = !activeSession.injectedPrompt || checkpointChanged;

      if (shouldInject) {
        activeSession.injectedPrompt = true;
        if (meta.latestCheckpointUid) {
          activeSession.lastCheckpointUid = meta.latestCheckpointUid;
        }
        if (meta.latestUserLineIdx >= 0 && !meta.latestUserIsProceed) {
          activeSession.enteredUserLineIdx = meta.latestUserLineIdx;
        }
        activeSession.updatedAt = now;
        try {
          writePlanningState(state, { ...options, now });
        } catch {}

        const systemMessage = buildPlanningSystemMessage(
          state.nativePlanPrompt?.text || '',
          String(safePayload.artifactDirectoryPath || '').trim()
        );
        return {
          injectSteps: [
            {
              systemMessage: {
                systemMessage,
              },
            },
          ],
        };
      }

      if (stateMutated) {
        try {
          writePlanningState(state, { ...options, now });
        } catch {}
      }
      return {};
    }

    // 2.3 当前会话刚关闭 Planning，投递一次性退出通知并在空闲时自动卸载 Hook
    if (cid && state.exitNotices[cid]) {
      delete state.exitNotices[cid];
      try {
        writePlanningState(state, { ...options, now });
        syncPlanningHookRegistration(state, options);
      } catch {}
      return {
        injectSteps: [
          {
            systemMessage: {
              systemMessage: buildPlanningExitMessage(),
            },
          },
        ],
      };
    }

    // 2.4 所有会话与通知都已过期空闲时，顺手自动注销 hooks.json 释放开销
    const noActive = Object.keys(state.sessions).length === 0;
    const noPending = !state.pendingNewSession?.enabled;
    const noExit = Object.keys(state.exitNotices).length === 0;
    if (noActive && noPending && noExit) {
      try {
        syncPlanningHookRegistration(state, options);
      } catch {}
    }

    return {};
  }

  return {};
}

/**
 * Hook CLI 入口：读取 stdin JSON 并输出 stdout JSON（fail-safe，绝不阻塞宿主会话）
 */
async function main() {
  try {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    const payload = raw ? JSON.parse(raw) : {};
    const result = runPlanningHookPayload(payload);
    process.stdout.write(`${JSON.stringify(result || {})}\n`);
  } catch {
    process.stdout.write('{}\n');
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main();
}

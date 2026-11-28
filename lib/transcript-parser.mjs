import fs from 'node:fs';
import path from 'node:path';
import { getCandidateBrainDirs } from './paths.mjs';

// 基于文件路径的内存缓存（按 mtimeMs + size 命中跳过重复解析）
const transcriptParseCache = new Map();
const MAX_CACHE_ENTRIES = 24;

/**
 * 从日志路径中提取 36 位会话 UUID
 */
export function extractConversationIdFromPath(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  const match = normalized.match(/\/brain\/([0-9a-fA-F-]{8,128})\//);
  return match ? match[1] : '';
}

/**
 * 根据会话 ID 查找对应的 transcript.jsonl 文件；未传会话 ID 时查找最近活跃会话
 */
export function resolveTranscriptFile(conversationId = '', options = {}) {
  if (options.explicitTranscriptPath && fs.existsSync(options.explicitTranscriptPath)) {
    return {
      conversationId:
        conversationId || extractConversationIdFromPath(options.explicitTranscriptPath) || 'unknown',
      transcriptPath: options.explicitTranscriptPath,
    };
  }

  const brainDirs = options.brainDirs || getCandidateBrainDirs(options);
  const cleanCid = String(conversationId || '').trim();

  // 指定了会话 ID 时严格匹配对应目录，避免新建空白会话时串台显示其他会话的数据
  if (cleanCid) {
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(cleanCid)) {
      return null;
    }
    for (const brainDir of brainDirs) {
      const candidate = path.join(brainDir, cleanCid, '.system_generated', 'logs', 'transcript.jsonl');
      if (fs.existsSync(candidate)) {
        return { conversationId: cleanCid, transcriptPath: candidate };
      }
    }
    return null;
  }

  // 严格模式下空会话 ID 不允许回退扫描最近会话，确保新开空白窗口稳定归零
  if (options.allowLatestFallback === false) {
    return null;
  }

  // 未指定会话 ID 时（例如 CLI 或无 CDP 连接时的默认参考），定位最近更新的会话日志
  let newest = null;
  let newestMtime = 0;

  for (const brainDir of brainDirs) {
    let entries = [];
    try {
      entries = fs.readdirSync(brainDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(brainDir, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
      try {
        const stat = fs.statSync(candidate);
        if (stat.mtimeMs > newestMtime) {
          newestMtime = stat.mtimeMs;
          newest = { conversationId: entry.name, transcriptPath: candidate };
        }
      } catch {
        // 忽略尚未生成 transcript.jsonl 的会话目录
      }
    }
  }

  return newest;
}

/**
 * 构造空的上下文占用统计对象
 */
export function createEmptyUsage(conversationId = '', transcriptPath = '') {
  return {
    conversationId: conversationId || '',
    transcriptPath: transcriptPath || '',
    modelName: '',
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    promptTokens: 0,
    totalTokens: 0,
    cumulativeOutputTokens: 0,
    cacheHitRate: 0,
    turnCount: 0,
    plannerStepCount: 0,
    stepCount: 0,
    toolCallCount: 0,
    checkpointCount: 0,
    latestThinkingTokens: 0,
    latestResponseTokens: 0,
    latestThinkingChars: 0,
    latestContentChars: 0,
    isRunning: false,
    history: [],
    steps: [],
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 解析单个 transcript.jsonl 文件，提取最新一轮上下文窗口占用、缓存命中率与近 30 步趋势
 */
export function parseTranscriptFile(transcriptPath, conversationIdOverride = '') {
  const fallbackCid = conversationIdOverride || extractConversationIdFromPath(transcriptPath);
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return createEmptyUsage(fallbackCid, transcriptPath);
  }

  try {
    const stat = fs.statSync(transcriptPath);
    const fingerprint = `${stat.mtimeMs}:${stat.size}`;
    const cached = transcriptParseCache.get(transcriptPath);
    if (cached && cached.fingerprint === fingerprint) {
      return {
        ...cached.result,
        conversationId: fallbackCid || cached.result.conversationId,
      };
    }

    const rawText = fs.readFileSync(transcriptPath, 'utf8');
    const lines = rawText.split(/\r?\n/);

    let latestStepUsage = null;
    let modelName = '';
    let turnCount = 0;
    let plannerStepCount = 0;
    let validLineCount = 0;
    let cumulativeOutputTokens = 0;
    let toolCallCount = 0;
    let checkpointCount = 0;
    let lastNonSystemType = '';
    let lastStepStatus = '';
    let currentTurnPrompt = '';
    let prevStepTotalTokens = 0;
    const history = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      let step;
      try {
        step = JSON.parse(line);
      } catch {
        continue;
      }
      validLineCount++;

      if (step.type && step.type !== 'SYSTEM_MESSAGE') {
        lastNonSystemType = step.type;
        lastStepStatus = String(step.status || '');
      }

      // 统计用户提问轮次，并识别模型切换记录与本轮提问摘要
      if (step.type === 'USER_INPUT') {
        turnCount++;
        if (typeof step.content === 'string') {
          const match = step.content.match(/changed setting `Model Selection` from .*? to ([^\n.]+)/);
          if (match && match[1]) {
            modelName = match[1].trim();
          }
          const reqMatch = step.content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
          const rawPrompt = (reqMatch ? reqMatch[1] : step.content)
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          if (rawPrompt) {
            currentTurnPrompt = rawPrompt.length > 32 ? `${rawPrompt.slice(0, 31)}…` : rawPrompt;
          } else if (/The user has approved this document\./i.test(step.content)) {
            currentTurnPrompt = '批准实施计划';
          } else {
            currentTurnPrompt = `第 ${turnCount} 轮`;
          }
        }
      }

      if (step.type === 'CHECKPOINT') {
        checkpointCount++;
      }

      // 兼容扁平字段（Antigravity 2.34+）与嵌套 token_usage 字段
      if (step.type === 'PLANNER_RESPONSE' || step.token_usage) {
        if (Array.isArray(step.tool_calls)) {
          toolCallCount += step.tool_calls.length;
        }
        const usageSource =
          step.token_usage && typeof step.token_usage === 'object' ? step.token_usage : step;

        const input = Number(usageSource.input_tokens) || 0;
        const cacheRead = Number(usageSource.cache_read_tokens) || 0;
        const output = Number(usageSource.output_tokens) || 0;
        const thinkingTokens = Number(usageSource.thinking_output_tokens ?? usageSource.thinking_tokens) || 0;
        const responseTokens = Number(usageSource.response_output_tokens ?? usageSource.response_tokens) || 0;
        const thinkingChars = typeof step.thinking === 'string' ? step.thinking.length : 0;
        const contentChars = typeof step.content === 'string' ? step.content.length : 0;
        const stepTotal = input + cacheRead + output;
        const rawRespText = typeof step.content === 'string'
          ? step.content
              .replace(/```[\s\S]*?```/g, ' ')
              .replace(/[`*_~#>]+/g, '')
              .replace(/\s+/g, ' ')
              .trim()
          : '';
        const responseSnippet = rawRespText.length > 36 ? `${rawRespText.slice(0, 35)}…` : rawRespText;

        let stepModel = '';
        if (typeof usageSource.model === 'string' && usageSource.model.trim()) {
          stepModel = usageSource.model.trim();
          modelName = stepModel;
        } else if (typeof step.model === 'string' && step.model.trim()) {
          stepModel = step.model.trim();
          modelName = stepModel;
        }

        if (stepTotal > 0) {
          plannerStepCount++;
          cumulativeOutputTokens += output;
          const stepPromptTokens = input + cacheRead;
          const stepCacheHitRate =
            stepPromptTokens > 0 ? Math.round((cacheRead / stepPromptTokens) * 1000) / 10 : 0;
          const deltaTokens = plannerStepCount === 1 ? stepTotal : stepTotal - prevStepTotalTokens;
          prevStepTotalTokens = stepTotal;
          latestStepUsage = {
            stepIndex: Number.isInteger(step.step_index) ? step.step_index : plannerStepCount,
            inputTokens: input,
            cacheReadTokens: cacheRead,
            outputTokens: output,
            thinkingTokens,
            responseTokens,
            thinkingChars,
            contentChars,
            totalTokens: stepTotal,
            createdAt: step.created_at || null,
          };
          history.push({
            step: plannerStepCount,
            turn: Math.max(1, turnCount),
            stepIndex: latestStepUsage.stepIndex,
            inputTokens: input,
            cacheReadTokens: cacheRead,
            outputTokens: output,
            cumulativeOutputTokens,
            cacheHitRate: stepCacheHitRate,
            totalTokens: stepTotal,
            deltaTokens,
            toolCount: Array.isArray(step.tool_calls) ? step.tool_calls.length : 0,
            model: stepModel || modelName || '',
            promptSnippet: currentTurnPrompt,
            responseSnippet,
            createdAt: latestStepUsage.createdAt,
          });
        }
      }
    }

    const inputTokens = latestStepUsage ? latestStepUsage.inputTokens : 0;
    const cacheReadTokens = latestStepUsage ? latestStepUsage.cacheReadTokens : 0;
    const outputTokens = latestStepUsage ? latestStepUsage.outputTokens : 0;
    const promptTokens = inputTokens + cacheReadTokens;
    const totalTokens = promptTokens + outputTokens;
    const cacheHitRate =
      promptTokens > 0 ? Math.round((cacheReadTokens / promptTokens) * 1000) / 10 : 0;

    // 估算或读取最新一步思考/正文输出拆分（若宿主未提供精确值则按字符占比估算）
    let latestThinkingTokens = latestStepUsage ? latestStepUsage.thinkingTokens : 0;
    let latestResponseTokens = latestStepUsage ? latestStepUsage.responseTokens : 0;
    const latestThinkingChars = latestStepUsage ? latestStepUsage.thinkingChars : 0;
    const latestContentChars = latestStepUsage ? latestStepUsage.contentChars : 0;
    if (outputTokens > 0 && latestThinkingTokens === 0 && latestResponseTokens === 0) {
      const charSum = latestThinkingChars + latestContentChars;
      if (charSum > 0) {
        latestThinkingTokens = Math.round((outputTokens * latestThinkingChars) / charSum);
        latestResponseTokens = Math.max(0, outputTokens - latestThinkingTokens);
      } else {
        latestResponseTokens = outputTokens;
      }
    }

    // 粗略判断会话是否正处于活跃执行中（配合渲染层按钮状态辅助呼吸/波浪动画）
    const isRunning =
      lastNonSystemType === 'USER_INPUT' ||
      (lastStepStatus !== '' && lastStepStatus !== 'DONE' && lastStepStatus !== 'COMPLETED');

    const result = {
      conversationId: fallbackCid,
      transcriptPath,
      modelName,
      inputTokens,
      cacheReadTokens,
      outputTokens,
      promptTokens,
      totalTokens,
      cumulativeOutputTokens,
      cacheHitRate,
      turnCount,
      plannerStepCount,
      stepCount: validLineCount,
      toolCallCount,
      checkpointCount,
      latestThinkingTokens,
      latestResponseTokens,
      latestThinkingChars,
      latestContentChars,
      isRunning,
      history: history.slice(-30),
      steps: history.slice(-120),
      fileMtimeMs: stat.mtimeMs,
      updatedAt: latestStepUsage?.createdAt || new Date(stat.mtimeMs).toISOString(),
    };

    // 维护固定容量 LRU 缓存
    transcriptParseCache.delete(transcriptPath);
    transcriptParseCache.set(transcriptPath, { fingerprint, result });
    if (transcriptParseCache.size > MAX_CACHE_ENTRIES) {
      const oldestKey = transcriptParseCache.keys().next().value;
      transcriptParseCache.delete(oldestKey);
    }

    return result;
  } catch {
    return createEmptyUsage(fallbackCid, transcriptPath);
  }
}

/**
 * 获取指定会话（或最近活跃会话）的上下文统计结果
 */
export function getConversationUsage(conversationId = '', options = {}) {
  const resolved = resolveTranscriptFile(conversationId, options);
  if (!resolved || !resolved.transcriptPath) {
    return createEmptyUsage(conversationId, '');
  }
  return parseTranscriptFile(resolved.transcriptPath, resolved.conversationId);
}

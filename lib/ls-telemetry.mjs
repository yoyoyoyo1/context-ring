import { normalizeModelKey } from './settings.mjs';

const CATALOG_TTL_MS = 60_000;
const TELEMETRY_TTL_MS = 2_200;
const MIN_SETTLED_STREAM_SEC = 0.45;
const MIN_SETTLED_STREAM_TOKENS = 12;

let cachedCatalog = null;
let cachedCatalogAt = 0;
let catalogInFlight = null;

const telemetryCache = new Map();
const telemetryInFlight = new Map();
const MAX_TELEMETRY_CACHE = 32;

/**
 * 解析 Go/Protobuf 时长字符串或对象为秒数（如 "6.569948100s"、"450ms"、"1m2.5s"、{ seconds, nanos }）
 */
export function parseDurationSec(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw >= 0 ? raw : null;
  }
  if (typeof raw === 'object') {
    const sec = Number(raw.seconds || 0);
    const nanos = Number(raw.nanos || 0);
    if (!Number.isFinite(sec) || !Number.isFinite(nanos)) return null;
    const total = sec + nanos / 1e9;
    return total >= 0 ? total : null;
  }
  const str = String(raw).trim();
  if (!str) return null;
  if (/^\d+(?:\.\d+)?$/.test(str)) {
    const num = Number(str);
    return Number.isFinite(num) && num >= 0 ? num : null;
  }
  let totalSec = 0;
  let matched = false;
  const re = /(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|s|m|h)/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    matched = true;
    const val = Number(m[1]);
    const unit = m[2];
    if (!Number.isFinite(val)) return null;
    if (unit === 'h') totalSec += val * 3600;
    else if (unit === 'm') totalSec += val * 60;
    else if (unit === 's') totalSec += val;
    else if (unit === 'ms') totalSec += val / 1e3;
    else if (unit === 'us' || unit === 'µs' || unit === 'μs') totalSec += val / 1e6;
    else if (unit === 'ns') totalSec += val / 1e9;
  }
  return matched && Number.isFinite(totalSec) && totalSec >= 0 ? totalSec : null;
}

/**
 * 将体验分映射为直观评级（S/A/B/C/D）与简短中文标签
 */
export function classifyExperienceGrade(score) {
  if (!Number.isFinite(score)) return { grade: null, label: '' };
  if (score >= 90) return { grade: 'S', label: '极速' };
  if (score >= 78) return { grade: 'A', label: '流畅' };
  if (score >= 62) return { grade: 'B', label: '良好' };
  if (score >= 45) return { grade: 'C', label: '偏慢' };
  return { grade: 'D', label: '拥堵' };
}

/**
 * 基于首字延迟（TTFT）、流式速度（tok/s）与总耗时计算响应体验综合评分（0-100）
 * 样本过小时（outputTokens < 15 或 streamingSec < 0.5s）不强行给出评级。
 */
export function calculateSpeedExperience(input = {}) {
  const outputTokens = Number(input.outputTokens);
  const inputTokens = Number(input.totalInputTokens ?? input.inputTokens ?? 0);
  const ttftSec = Number(input.ttftSec);
  const totalDurationSec = Number(input.totalDurationSec);
  const streamingSec = Number(input.streamingSec);
  let streamSpeed = Number(input.streamSpeed);

  if (
    (!Number.isFinite(streamSpeed) || streamSpeed <= 0) &&
    Number.isFinite(outputTokens) &&
    outputTokens > 0 &&
    Number.isFinite(streamingSec) &&
    streamingSec >= 0.05
  ) {
    streamSpeed = outputTokens / streamingSec;
  }

  if (
    !Number.isFinite(outputTokens) ||
    outputTokens < 15 ||
    !Number.isFinite(streamingSec) ||
    streamingSec < 0.5
  ) {
    return { available: false, score: null, grade: null, label: '' };
  }

  if (
    !Number.isFinite(ttftSec) ||
    ttftSec < 0 ||
    !Number.isFinite(totalDurationSec) ||
    totalDurationSec <= 0 ||
    !Number.isFinite(streamSpeed) ||
    streamSpeed <= 0
  ) {
    return { available: false, score: null, grade: null, label: '' };
  }

  const workLoad = inputTokens > 0 ? Math.max(1, outputTokens + 0.15 * inputTokens) : Math.max(1, outputTokens);
  const complexity = Math.log10(1 + workLoad);
  const gamma = 1 + 0.5 * Math.max(0, complexity - 2.3);
  const sResp = 1 / (1 + Math.pow(ttftSec / (8 * gamma), 1.5));
  const sSpeed = 1 / (1 + Math.pow(35 / Math.max(streamSpeed, 0.1), 1.4));
  const tBase = 5.0 + workLoad / 25.0;
  const sDur = 1 / (1 + Math.pow(totalDurationSec / (tBase * gamma), 1.2));
  const w1 = Math.min(0.4, Math.max(0.15, 0.4 - 0.1 * Math.max(0, complexity - 2.3)));
  const w2 = 0.35;
  const w3 = 1 - w1 - w2;
  const rawScore = 100 * Math.pow(sResp, w1) * Math.pow(sSpeed, w2) * Math.pow(sDur, w3);
  const score = Math.max(0, Math.min(100, Math.round(rawScore * 10) / 10));
  const tier = classifyExperienceGrade(score);

  return {
    available: true,
    score,
    grade: tier.grade,
    label: tier.label,
  };
}

/**
 * 从单条 generatorMetadata.chatModel 提取实时速度、思考/正文拆分与真实上下文预算
 */
export function extractChatModelTelemetry(chatModel) {
  if (!chatModel || typeof chatModel !== 'object') return null;
  const lastRetry = Array.isArray(chatModel.retryInfos) && chatModel.retryInfos.length > 0
    ? chatModel.retryInfos[chatModel.retryInfos.length - 1]
    : null;
  const usage = lastRetry?.usage || chatModel.usage || {};
  const inputTokens = Number(usage.inputTokens) || 0;
  const cacheReadTokens = Number(usage.cacheReadTokens) || 0;
  const cacheWriteTokens =
    Number(usage.cacheCreationInputTokens ?? usage.cacheWriteTokens ?? usage.cacheWriteInputTokens) || 0;
  const outputTokens = Number(usage.outputTokens) || 0;
  const thinkingTokens = Number(usage.thinkingOutputTokens) || 0;
  const responseTokens =
    Number(usage.responseOutputTokens) || Math.max(0, outputTokens - thinkingTokens);

  const ttftSec = parseDurationSec(chatModel.timeToFirstToken);
  const streamingSec = parseDurationSec(chatModel.streamingDuration);
  const durationSec =
    ttftSec !== null && streamingSec !== null
      ? ttftSec + streamingSec
      : (ttftSec ?? streamingSec ?? null);

  const tps =
    outputTokens > 0 && durationSec !== null && durationSec > 0
      ? Number((outputTokens / durationSec).toFixed(1))
      : null;
  const streamingTps =
    outputTokens > 0 && streamingSec !== null && streamingSec > 0
      ? Number((outputTokens / streamingSec).toFixed(1))
      : null;

  const isSettled = Boolean(
    outputTokens > 0 &&
      streamingSec !== null &&
      (streamingSec >= MIN_SETTLED_STREAM_SEC ||
        (streamingSec > 0.05 && outputTokens >= MIN_SETTLED_STREAM_TOKENS))
  );
  const isWarming = Boolean(
    outputTokens > 0 && !isSettled && (streamingSec === null || streamingSec < MIN_SETTLED_STREAM_SEC)
  );
  const phase = isWarming ? 'warming' : isSettled || tps !== null ? 'settled' : 'idle';
  const totalInputTokens = inputTokens + cacheReadTokens + cacheWriteTokens;

  const exp = calculateSpeedExperience({
    outputTokens,
    totalInputTokens,
    ttftSec,
    streamingSec,
    totalDurationSec: durationSec,
    streamSpeed: streamingTps,
  });

  const ctxMeta = chatModel.chatStartMetadata?.contextWindowMetadata || {};
  const maxContextTokens =
    Number.isFinite(Number(ctxMeta.maxContextTokens)) && Number(ctxMeta.maxContextTokens) > 0
      ? Math.round(Number(ctxMeta.maxContextTokens))
      : 0;
  const estimatedTokensUsed =
    Number.isFinite(Number(ctxMeta.estimatedTokensUsed)) && Number(ctxMeta.estimatedTokensUsed) > 0
      ? Math.round(Number(ctxMeta.estimatedTokensUsed))
      : 0;

  const speed =
    tps !== null || streamingTps !== null || ttftSec !== null || outputTokens > 0
      ? {
          source: 'ls',
          phase,
          tps,
          streamingTps,
          displayTps: phase === 'warming' ? null : (streamingTps ?? tps ?? null),
          ttftSec: ttftSec !== null ? Number(ttftSec.toFixed(2)) : null,
          streamingSec: streamingSec !== null ? Number(streamingSec.toFixed(2)) : null,
          durationSec: durationSec !== null ? Number(durationSec.toFixed(2)) : null,
          ttftRatio:
            ttftSec !== null && durationSec !== null && durationSec > 0
              ? Number(Math.min(100, Math.max(0, (ttftSec / durationSec) * 100)).toFixed(1))
              : null,
          outputTokens,
          thinkingTokens,
          responseTokens,
          score: exp.score,
          grade: exp.grade,
          gradeLabel: exp.label,
        }
      : null;

  return {
    modelRaw: String(chatModel.model || chatModel.responseModel || usage.model || '').trim(),
    modelDisplayName: String(chatModel.modelDisplayName || '').trim(),
    maxContextTokens,
    estimatedTokensUsed,
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    thinkingTokens,
    responseTokens,
    speed,
  };
}

/**
 * 解析当前进程环境中的官方 Language Server 连接配置
 */
function resolveLsConfig(options = {}) {
  const env = options.env || process.env;
  const address = String(options.lsAddress || env.ANTIGRAVITY_LS_ADDRESS || '').trim();
  const csrfToken = String(options.csrfToken || env.ANTIGRAVITY_CSRF_TOKEN || '').trim();
  if (!address || !csrfToken) return null;
  const baseUrl = /^https?:\/\//i.test(address) ? address.replace(/\/+$/, '') : `http://${address}`;
  return { baseUrl, csrfToken };
}

/**
 * 通用只读 Connect JSON POST 调用（带超时保护，不抛阻断异常）
 */
async function callLsRpc(method, body = {}, options = {}) {
  const cfg = resolveLsConfig(options);
  if (!cfg) return null;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return null;

  try {
    const resp = await fetchImpl(
      `${cfg.baseUrl}/exa.language_server_pb.LanguageServerService/${method}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-codeium-csrf-token': cfg.csrfToken,
        },
        body: JSON.stringify(body || {}),
        signal: AbortSignal.timeout(options.timeoutMs || 2500),
      }
    );
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

/**
 * 解析 GetAvailableModels 响应为多键索引表（支持按 id / displayName / modelKey / placeholder 查真实上下文上限）
 */
export function buildModelCatalogIndex(rawResponse) {
  const resp = rawResponse?.response || rawResponse || {};
  const modelsMap = resp.models && typeof resp.models === 'object' ? resp.models : {};
  const byKey = new Map();
  const list = [];

  for (const [id, info] of Object.entries(modelsMap)) {
    if (!info || typeof info !== 'object') continue;
    const maxTokens = Number(info.maxTokens || info.maxContextTokens || 0);
    const maxOutputTokens = Number(info.maxOutputTokens || 0);
    const displayName = String(info.displayName || id).trim();
    const rawPlaceholder = String(info.model || '').trim();
    const modelKey = normalizeModelKey(displayName || id);
    const entry = {
      id,
      modelKey,
      displayName,
      rawPlaceholder,
      maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? Math.round(maxTokens) : 0,
      maxOutputTokens: Number.isFinite(maxOutputTokens) && maxOutputTokens > 0 ? Math.round(maxOutputTokens) : 0,
    };
    list.push(entry);

    const keys = [
      id.toLowerCase(),
      displayName.toLowerCase(),
      modelKey,
      normalizeModelKey(id),
      rawPlaceholder.toLowerCase(),
    ].filter(Boolean);

    for (const k of keys) {
      const prev = byKey.get(k);
      if (!prev || (entry.maxTokens > 0 && prev.maxTokens <= 0)) {
        byKey.set(k, entry);
      }
    }
  }

  return { byKey, list };
}

/**
 * 根据模型名或占位符从模型目录查询官方真实上下文上限
 */
export function lookupCatalogModel(catalog, modelName = '') {
  if (!catalog || !catalog.byKey || !modelName) return null;
  const raw = String(modelName).trim().toLowerCase();
  if (!raw) return null;
  const direct = catalog.byKey.get(raw);
  if (direct) return direct;
  const norm = normalizeModelKey(raw);
  if (norm && catalog.byKey.has(norm)) {
    return catalog.byKey.get(norm);
  }
  return null;
}

/**
 * 拉取并缓存宿主模型目录（60s TTL）
 */
export async function fetchAvailableModelCatalog(options = {}) {
  const now = Date.now();
  if (!options.force && cachedCatalog && now - cachedCatalogAt < CATALOG_TTL_MS && !options.fetchImpl) {
    return cachedCatalog;
  }
  if (!options.fetchImpl && catalogInFlight) {
    return catalogInFlight;
  }

  const task = callLsRpc('GetAvailableModels', {}, options)
    .then((raw) => {
      if (!raw) return cachedCatalog;
      const index = buildModelCatalogIndex(raw);
      if (!options.fetchImpl && index.list.length > 0) {
        cachedCatalog = index;
        cachedCatalogAt = Date.now();
      }
      return index;
    })
    .finally(() => {
      if (!options.fetchImpl) catalogInFlight = null;
    });

  if (!options.fetchImpl) catalogInFlight = task;
  return task;
}

/**
 * 获取指定会话最新一次模型请求的实时速度、思考/正文拆分与真实上下文预算（2.2s TTL 缓存）
 */
export async function fetchConversationTelemetry(conversationId, options = {}) {
  const cid = String(conversationId || '').trim();
  if (!cid || !/^[a-zA-Z0-9_-]{8,128}$/.test(cid)) return null;

  const now = Date.now();
  const useSharedCache = !options.fetchImpl && !options.env;
  if (useSharedCache && !options.force) {
    const cached = telemetryCache.get(cid);
    if (cached && now - cached.at < TELEMETRY_TTL_MS) {
      return cached.value;
    }
    if (telemetryInFlight.has(cid)) {
      return telemetryInFlight.get(cid);
    }
  }

  const task = (async () => {
    const traj = await callLsRpc(
      'GetCascadeTrajectory',
      { cascadeId: cid, trajectoryVerbosity: 0 },
      options
    );
    if (!traj) return null;

    const count = Number(
      traj.numTotalGeneratorMetadata ??
        (Array.isArray(traj.trajectory?.generatorMetadata) ? traj.trajectory.generatorMetadata.length : 0)
    );
    if (!Number.isFinite(count) || count <= 0) return null;

    const offset = Math.max(0, count - 3);
    const gmResp = await callLsRpc(
      'GetCascadeTrajectoryGeneratorMetadata',
      {
        cascadeId: cid,
        generatorMetadataOffset: offset,
        includeMessages: false,
      },
      options
    );
    const list = Array.isArray(gmResp?.generatorMetadata) ? gmResp.generatorMetadata : [];
    for (let i = list.length - 1; i >= 0; i--) {
      const parsed = extractChatModelTelemetry(list[i]?.chatModel);
      if (parsed && (parsed.speed || parsed.maxContextTokens > 0)) {
        return parsed;
      }
    }
    return null;
  })()
    .then((value) => {
      if (useSharedCache) {
        telemetryCache.delete(cid);
        telemetryCache.set(cid, { at: Date.now(), value });
        if (telemetryCache.size > MAX_TELEMETRY_CACHE) {
          const oldest = telemetryCache.keys().next().value;
          telemetryCache.delete(oldest);
        }
      }
      return value;
    })
    .finally(() => {
      if (useSharedCache) telemetryInFlight.delete(cid);
    });

  if (useSharedCache) telemetryInFlight.set(cid, task);
  return task;
}

/**
 * 将本地 transcript 统计对象与 Language Server 实时遥测无缝融合
 * 若 Language Server 不可用，自动降级保留 transcript 估算的思考/正文拆分，零报错。
 */
export async function enrichUsageWithTelemetry(usage, options = {}) {
  if (!usage || typeof usage !== 'object') return usage;
  const cid = String(usage.conversationId || '').trim();

  const [telemetry, catalog] = await Promise.all([
    cid ? fetchConversationTelemetry(cid, options) : Promise.resolve(null),
    fetchAvailableModelCatalog(options),
  ]);

  const effectiveModelName =
    usage.modelName ||
    telemetry?.modelDisplayName ||
    lookupCatalogModel(catalog, telemetry?.modelRaw)?.displayName ||
    '';

  const catalogEntry =
    lookupCatalogModel(catalog, effectiveModelName) ||
    lookupCatalogModel(catalog, telemetry?.modelRaw);

  const detectedContextLimit = telemetry?.maxContextTokens || 0;
  const catalogContextLimit = catalogEntry?.maxTokens || 0;

  let speed = telemetry?.speed || null;
  // 若 LS 暂不可用但本地 transcript 已有最新一步输出，提供降级版思考/正文拆分
  if (!speed && Number(usage.outputTokens || 0) > 0) {
    speed = {
      source: 'transcript',
      phase: 'settled',
      tps: null,
      streamingTps: null,
      displayTps: null,
      ttftSec: null,
      streamingSec: null,
      durationSec: null,
      ttftRatio: null,
      outputTokens: Number(usage.outputTokens || 0),
      thinkingTokens: Number(usage.latestThinkingTokens || 0),
      responseTokens: Number(usage.latestResponseTokens || usage.outputTokens || 0),
      score: null,
      grade: null,
      gradeLabel: '',
    };
  }

  return {
    ...usage,
    modelName: effectiveModelName || usage.modelName || '',
    detectedContextLimit,
    catalogContextLimit,
    speed,
  };
}

/**
 * 重置模块内存缓存（仅供单元测试使用）
 */
export function clearTelemetryCaches() {
  cachedCatalog = null;
  cachedCatalogAt = 0;
  catalogInFlight = null;
  telemetryCache.clear();
  telemetryInFlight.clear();
}

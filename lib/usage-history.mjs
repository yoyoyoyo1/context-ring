import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getCandidateBrainDirs, getPluginPaths } from './paths.mjs';
import { normalizeModelKey } from './settings.mjs';

const CACHE_VERSION = 1;
const CACHE_FILENAME = 'usage-history-cache.json';

/**
 * 主流模型官方 Developer API 参考费率表（USD / 百万 Token）
 * 仅用于估算等价 API 费用与缓存节省金额，不代表实际订阅扣费。
 */
export const MODEL_PRICING_TABLE = Object.freeze({
  'gemini-4-neon': {
    displayName: 'Gemini 4 Neon',
    inputPerMillion: 3.0,
    outputPerMillion: 15.0,
    cacheReadPerMillion: 0.15,
  },
  'gemini-4-hydrogen': {
    displayName: 'Gemini 4 Hydrogen',
    inputPerMillion: 1.5,
    outputPerMillion: 7.5,
    cacheReadPerMillion: 0.075,
  },
  'gemini-4-carbon': {
    displayName: 'Gemini 4 Carbon',
    inputPerMillion: 2.0,
    outputPerMillion: 10.0,
    cacheReadPerMillion: 0.1,
  },
  'gemini-4-argon': {
    displayName: 'Gemini 4 Argon',
    inputPerMillion: 2.0,
    outputPerMillion: 10.0,
    cacheReadPerMillion: 0.1,
  },
  'gemini-3-8-flash': {
    displayName: 'Gemini 3.8 Flash',
    inputPerMillion: 0.75,
    outputPerMillion: 3.75,
    cacheReadPerMillion: 0.075,
  },
  'gemini-3-5-flash-lite': {
    displayName: 'Gemini 3.5 Flash-Lite',
    inputPerMillion: 0.3,
    outputPerMillion: 2.5,
    cacheReadPerMillion: 0.03,
  },
  'gemini-3-1-pro': {
    displayName: 'Gemini 3.1 Pro',
    inputPerMillion: 2.0,
    outputPerMillion: 12.0,
    cacheReadPerMillion: 0.2,
  },
  'gemini-2-5-pro': {
    displayName: 'Gemini 2.5 Pro',
    inputPerMillion: 1.25,
    outputPerMillion: 10.0,
    cacheReadPerMillion: 0.125,
  },
  'gemini-2-5-flash': {
    displayName: 'Gemini 2.5 Flash',
    inputPerMillion: 0.3,
    outputPerMillion: 2.5,
    cacheReadPerMillion: 0.03,
  },
  'claude-opus-5-5': {
    displayName: 'Claude Opus 5.5',
    inputPerMillion: 4.0,
    outputPerMillion: 20.0,
    cacheReadPerMillion: 0.2,
  },
  'claude-sonnet-5-5': {
    displayName: 'Claude Sonnet 5.5',
    inputPerMillion: 2.0,
    outputPerMillion: 10.0,
    cacheReadPerMillion: 0.1,
  },
  'claude-opus-4': {
    displayName: 'Claude Opus 4',
    inputPerMillion: 15.0,
    outputPerMillion: 75.0,
    cacheReadPerMillion: 1.5,
  },
  'claude-sonnet-4': {
    displayName: 'Claude Sonnet 4',
    inputPerMillion: 3.0,
    outputPerMillion: 15.0,
    cacheReadPerMillion: 0.3,
  },
  'gpt-5': {
    displayName: 'GPT-5',
    inputPerMillion: 1.25,
    outputPerMillion: 10.0,
    cacheReadPerMillion: 0.125,
  },
  'gpt-oss-120b': {
    displayName: 'GPT-OSS 120B',
    inputPerMillion: 0.5,
    outputPerMillion: 2.0,
    cacheReadPerMillion: 0.05,
  },
});

/**
 * 将任意模型名模糊匹配到内置费率键
 */
export function resolvePricingModelKey(rawModelName = '') {
  const norm = normalizeModelKey(rawModelName);
  if (!norm) return '';
  if (MODEL_PRICING_TABLE[norm]) return norm;

  if (norm.includes('neon')) return 'gemini-4-neon';
  if (norm.includes('hydrogen')) return 'gemini-4-hydrogen';
  if (norm.includes('carbon')) return 'gemini-4-carbon';
  if (norm.includes('argon')) return 'gemini-4-argon';
  if (norm.includes('flash-lite')) return 'gemini-3-5-flash-lite';
  if (norm.includes('3-8-flash') || norm.includes('3-flash')) return 'gemini-3-8-flash';
  if (norm.includes('2-5-flash')) return 'gemini-2-5-flash';
  if (norm.includes('3-1-pro') || norm.includes('3-pro')) return 'gemini-3-1-pro';
  if (norm.includes('2-5-pro')) return 'gemini-2-5-pro';
  if (norm.includes('opus-5') || norm.includes('claude-opus-5')) return 'claude-opus-5-5';
  if (norm.includes('sonnet-5') || norm.includes('claude-sonnet-5')) return 'claude-sonnet-5-5';
  if (norm.includes('opus')) return 'claude-opus-4';
  if (norm.includes('sonnet') || norm.includes('claude')) return 'claude-sonnet-4';
  if (norm.includes('gpt-oss')) return 'gpt-oss-120b';
  if (norm.includes('gpt-5')) return 'gpt-5';
  if (norm.includes('flash')) return 'gemini-3-8-flash';

  return '';
}

/**
 * 美化展示名称（若为内置费率模型则取标准名称，否则做温和格式化）
 */
export function formatModelDisplayName(rawModelName = '', pricingKey = '') {
  if (pricingKey && MODEL_PRICING_TABLE[pricingKey]?.displayName) {
    return MODEL_PRICING_TABLE[pricingKey].displayName;
  }
  const clean = normalizeModelKey(rawModelName);
  if (!clean) return '未知模型';
  return clean
    .split('-')
    .map((part) => (/^\d+$/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ');
}

/**
 * 按公开 API 单价估算单次/聚合 Token 费用及缓存节省金额（USD）
 */
export function estimateTokenCost({ modelName = '', inputTokens = 0, cacheReadTokens = 0, outputTokens = 0 } = {}) {
  const pricingKey = resolvePricingModelKey(modelName);
  const rule = pricingKey ? MODEL_PRICING_TABLE[pricingKey] : null;
  if (!rule) {
    return {
      priced: false,
      pricingKey: '',
      costUsd: 0,
      withoutCacheUsd: 0,
      cacheSavedUsd: 0,
    };
  }
  const inp = Math.max(0, Number(inputTokens) || 0);
  const cache = Math.max(0, Number(cacheReadTokens) || 0);
  const out = Math.max(0, Number(outputTokens) || 0);

  const costUsd =
    (inp / 1e6) * rule.inputPerMillion +
    (cache / 1e6) * rule.cacheReadPerMillion +
    (out / 1e6) * rule.outputPerMillion;
  const withoutCacheUsd =
    ((inp + cache) / 1e6) * rule.inputPerMillion + (out / 1e6) * rule.outputPerMillion;
  const cacheSavedUsd = Math.max(0, withoutCacheUsd - costUsd);

  return {
    priced: true,
    pricingKey,
    costUsd,
    withoutCacheUsd,
    cacheSavedUsd,
  };
}

/**
 * 将 Date 或毫秒时间戳转换为本地时区 YYYY-MM-DD 日期键
 */
export function formatLocalDateKey(tsMs) {
  const d = new Date(tsMs);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 根据 brain 目录路径推断会话来源（desktop / cli）
 */
function inferSourceKind(filePath) {
  const norm = String(filePath || '').replace(/\\/g, '/').toLowerCase();
  if (norm.includes('/antigravity-cli/')) return 'cli';
  return 'desktop';
}

/**
 * 增量扫描单个 transcript.jsonl，按「日期 × 模型」预聚合，生成体积极小的文件摘要供磁盘缓存复用
 */
function summarizeTranscriptFile(filePath, stat) {
  const sourceKind = inferSourceKind(filePath);
  const fallbackDate = formatLocalDateKey(stat.mtimeMs);
  const buckets = Object.create(null);

  let currentModel = '';
  let totalCalls = 0;

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      // 快速字符串过滤：仅解析包含 USER_INPUT / PLANNER_RESPONSE / token_usage 的行
      if (
        !line.includes('"USER_INPUT"') &&
        !line.includes('"PLANNER_RESPONSE"') &&
        !line.includes('"token_usage"')
      ) {
        continue;
      }

      let step;
      try {
        step = JSON.parse(line);
      } catch {
        continue;
      }

      if (step.type === 'USER_INPUT' && typeof step.content === 'string') {
        const match = step.content.match(/changed setting `Model Selection` from .*? to ([^\n.]+)/);
        if (match && match[1]) {
          currentModel = match[1].trim();
        }
        continue;
      }

      if (step.type !== 'PLANNER_RESPONSE' && !step.token_usage) continue;
      const usageSource =
        step.token_usage && typeof step.token_usage === 'object' ? step.token_usage : step;

      const input = Math.max(0, Number(usageSource.input_tokens) || 0);
      const cacheRead = Math.max(0, Number(usageSource.cache_read_tokens) || 0);
      const output = Math.max(0, Number(usageSource.output_tokens) || 0);
      if (input + cacheRead + output <= 0) continue;

      if (typeof usageSource.model === 'string' && usageSource.model.trim()) {
        currentModel = usageSource.model.trim();
      } else if (typeof step.model === 'string' && step.model.trim()) {
        currentModel = step.model.trim();
      }

      const stepTimeMs = step.created_at ? Date.parse(step.created_at) : NaN;
      const dateKey = Number.isFinite(stepTimeMs) ? formatLocalDateKey(stepTimeMs) : fallbackDate;
      if (!dateKey) continue;

      const modelKey = normalizeModelKey(currentModel) || 'unknown';
      const bucketKey = `${dateKey}|${modelKey}`;
      let b = buckets[bucketKey];
      if (!b) {
        b = {
          date: dateKey,
          modelKey,
          rawModel: currentModel || 'unknown',
          input: 0,
          cacheRead: 0,
          output: 0,
          calls: 0,
        };
        buckets[bucketKey] = b;
      }
      b.input += input;
      b.cacheRead += cacheRead;
      b.output += output;
      b.calls += 1;
      totalCalls += 1;
    }
  } catch {
    // 忽略单个损坏或不可读日志
  }

  return {
    fingerprint: `${Math.round(stat.mtimeMs)}:${stat.size}`,
    sourceKind,
    totalCalls,
    buckets: Object.values(buckets),
  };
}

/**
 * 读取历史账本磁盘索引缓存
 */
function loadHistoryCache(cacheFile) {
  if (!cacheFile || !fs.existsSync(cacheFile)) {
    return { version: CACHE_VERSION, files: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (parsed && parsed.version === CACHE_VERSION && parsed.files && typeof parsed.files === 'object') {
      return parsed;
    }
  } catch {
    // 损坏缓存自动重建
  }
  return { version: CACHE_VERSION, files: {} };
}

/**
 * 原子持久化历史账本索引缓存
 */
function saveHistoryCache(cacheFile, cacheObj) {
  if (!cacheFile) return;
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    const tmp = `${cacheFile}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cacheObj), 'utf8');
    try {
      fs.renameSync(tmp, cacheFile);
    } catch {
      fs.copyFileSync(tmp, cacheFile);
      try {
        fs.unlinkSync(tmp);
      } catch {}
    }
  } catch {
    // 缓存落盘失败不影响主查询结果
  }
}

/**
 * 枚举全部候选 Brain 目录下的 transcript.jsonl 文件（按规范路径去重）
 */
function collectAllTranscriptFiles(brainDirs) {
  const files = [];
  const seen = new Set();

  for (const brainDir of brainDirs) {
    let entries = [];
    try {
      entries = fs.readdirSync(brainDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const cid = entry.name;
      const filePath = path.join(brainDir, cid, '.system_generated', 'logs', 'transcript.jsonl');
      const dedupeKey = `${cid}:${process.platform === 'win32' ? filePath.toLowerCase() : filePath}`;
      if (seen.has(dedupeKey)) continue;
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile() || stat.size <= 0) continue;
        seen.add(dedupeKey);
        files.push({ cid, filePath, stat });
      } catch {
        // 跳过不存在或无权限的会话目录
      }
    }
  }

  return files;
}

/**
 * 根据分位数将每日 Token 消耗映射为 0-4 五档热力图色阶
 */
function computeHeatmapLevel(tokens, thresholds) {
  if (!tokens || tokens <= 0) return 0;
  if (tokens >= thresholds[2]) return 4;
  if (tokens >= thresholds[1]) return 3;
  if (tokens >= thresholds[0]) return 2;
  return 1;
}

/**
 * 生成多周期历史 Token 用量统计、模型费用排行榜与近 12 周（84 天）活跃热力图
 */
export function getUsageHistoryReport(options = {}) {
  const period = ['today', '7d', '30d', 'all'].includes(options.period) ? options.period : '30d';
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const brainDirs = Array.isArray(options.brainDirs)
    ? options.brainDirs
    : getCandidateBrainDirs({
        home: options.home,
        platform: options.platform,
        knownDistrosFile: options.knownDistrosFile,
      });

  const dataDir =
    options.cacheDir !== undefined
      ? options.cacheDir
      : getPluginPaths(options.home || os.homedir()).dataDir;
  const cacheFile = dataDir ? path.join(dataDir, CACHE_FILENAME) : '';

  const cache = loadHistoryCache(cacheFile);
  const discovered = collectAllTranscriptFiles(brainDirs);
  const activeFileKeys = new Set();
  let cacheDirty = false;

  const parsedEntries = [];
  for (const item of discovered) {
    const key = item.filePath;
    activeFileKeys.add(key);
    const fp = `${Math.round(item.stat.mtimeMs)}:${item.stat.size}`;
    let entry = cache.files[key];
    if (!entry || entry.fingerprint !== fp) {
      entry = summarizeTranscriptFile(item.filePath, item.stat);
      cache.files[key] = entry;
      cacheDirty = true;
    }
    parsedEntries.push({ cid: item.cid, entry });
  }

  // 清理已删除会话的过期缓存条目
  for (const cachedKey of Object.keys(cache.files)) {
    if (!activeFileKeys.has(cachedKey)) {
      delete cache.files[cachedKey];
      cacheDirty = true;
    }
  }
  if (cacheDirty && cacheFile) {
    saveHistoryCache(cacheFile, cache);
  }

  // 计算目标周期的起始本地日期键
  const todayDate = new Date(nowMs);
  todayDate.setHours(0, 0, 0, 0);
  const todayKey = formatLocalDateKey(todayDate.getTime());
  let minDateKey = '';
  if (period === 'today') {
    minDateKey = todayKey;
  } else if (period === '7d') {
    minDateKey = formatLocalDateKey(todayDate.getTime() - 6 * 86400_000);
  } else if (period === '30d') {
    minDateKey = formatLocalDateKey(todayDate.getTime() - 29 * 86400_000);
  }

  // 热力图固定展示近 84 天（12 周，对齐到本周结束）
  const heatmapStartMs = todayDate.getTime() - 83 * 86400_000;
  const heatmapMinKey = formatLocalDateKey(heatmapStartMs);
  const dailyMap = new Map();

  const modelMap = new Map();
  const activeSessions = new Set();
  let totalInput = 0;
  let totalCacheRead = 0;
  let totalOutput = 0;
  let callCount = 0;
  let desktopCalls = 0;
  let cliCalls = 0;
  let estimatedCostUsd = 0;
  let cacheSavedUsd = 0;
  let unpricedCalls = 0;

  for (const { cid, entry } of parsedEntries) {
    if (!entry || !Array.isArray(entry.buckets)) continue;
    const isCli = entry.sourceKind === 'cli';

    for (const b of entry.buckets) {
      const bTotal = (b.input || 0) + (b.cacheRead || 0) + (b.output || 0);
      if (bTotal <= 0) continue;

      const cost = estimateTokenCost({
        modelName: b.rawModel || b.modelKey,
        inputTokens: b.input,
        cacheReadTokens: b.cacheRead,
        outputTokens: b.output,
      });

      // 累计热力图每日汇总（始终覆盖近 84 天，不受周期切换影响）
      if (b.date >= heatmapMinKey && b.date <= todayKey) {
        let day = dailyMap.get(b.date);
        if (!day) {
          day = { totalTokens: 0, calls: 0, costUsd: 0 };
          dailyMap.set(b.date, day);
        }
        day.totalTokens += bTotal;
        day.calls += b.calls || 0;
        day.costUsd += cost.costUsd;
      }

      // 按当前所选周期过滤汇总统计
      if (minDateKey && b.date < minDateKey) continue;
      if (b.date > todayKey) continue;

      activeSessions.add(cid);
      totalInput += b.input || 0;
      totalCacheRead += b.cacheRead || 0;
      totalOutput += b.output || 0;
      callCount += b.calls || 0;
      if (isCli) cliCalls += b.calls || 0;
      else desktopCalls += b.calls || 0;

      if (cost.priced) {
        estimatedCostUsd += cost.costUsd;
        cacheSavedUsd += cost.cacheSavedUsd;
      } else {
        unpricedCalls += b.calls || 0;
      }

      const groupKey = cost.pricingKey || b.modelKey || 'unknown';
      let mAgg = modelMap.get(groupKey);
      if (!mAgg) {
        mAgg = {
          modelKey: groupKey,
          displayName: formatModelDisplayName(b.rawModel || b.modelKey, cost.pricingKey),
          calls: 0,
          inputTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          estimatedCostUsd: 0,
          cacheSavedUsd: 0,
          priced: cost.priced,
        };
        modelMap.set(groupKey, mAgg);
      }
      mAgg.calls += b.calls || 0;
      mAgg.inputTokens += b.input || 0;
      mAgg.cacheReadTokens += b.cacheRead || 0;
      mAgg.outputTokens += b.output || 0;
      mAgg.totalTokens += bTotal;
      mAgg.estimatedCostUsd += cost.costUsd;
      mAgg.cacheSavedUsd += cost.cacheSavedUsd;
      if (cost.priced) mAgg.priced = true;
    }
  }

  const totalTokens = totalInput + totalCacheRead + totalOutput;
  const totalPrompt = totalInput + totalCacheRead;
  const cacheHitRate = totalPrompt > 0 ? Number(((totalCacheRead / totalPrompt) * 100).toFixed(1)) : 0;

  const models = Array.from(modelMap.values())
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, 8)
    .map((m) => {
      const prompt = m.inputTokens + m.cacheReadTokens;
      return {
        modelKey: m.modelKey,
        displayName: m.displayName,
        calls: m.calls,
        inputTokens: m.inputTokens,
        cacheReadTokens: m.cacheReadTokens,
        outputTokens: m.outputTokens,
        totalTokens: m.totalTokens,
        cacheHitRate: prompt > 0 ? Number(((m.cacheReadTokens / prompt) * 100).toFixed(1)) : 0,
        estimatedCostUsd: Number(m.estimatedCostUsd.toFixed(4)),
        cacheSavedUsd: Number(m.cacheSavedUsd.toFixed(4)),
        priced: m.priced,
        sharePct: totalTokens > 0 ? Number(((m.totalTokens / totalTokens) * 100).toFixed(1)) : 0,
      };
    });

  // 生成 84 天热力图序列并计算自适应 4 档阈值
  const nonZeroValues = Array.from(dailyMap.values())
    .map((d) => d.totalTokens)
    .filter((v) => v > 0)
    .sort((a, b) => a - b);

  const pickQuantile = (q) => {
    if (nonZeroValues.length === 0) return 1;
    const idx = Math.min(nonZeroValues.length - 1, Math.floor(nonZeroValues.length * q));
    return Math.max(1, nonZeroValues[idx]);
  };
  const thresholds = [pickQuantile(0.35), pickQuantile(0.65), pickQuantile(0.88)];

  const days = [];
  let activeDays = 0;
  let maxDayTokens = 0;
  let total84dTokens = 0;

  for (let i = 0; i < 84; i++) {
    const curMs = heatmapStartMs + i * 86400_000;
    const curDate = new Date(curMs);
    const dateKey = formatLocalDateKey(curMs);
    const hit = dailyMap.get(dateKey);
    const dayTokens = hit ? hit.totalTokens : 0;
    const dayCalls = hit ? hit.calls : 0;
    const dayCost = hit ? Number(hit.costUsd.toFixed(4)) : 0;
    if (dayTokens > 0) {
      activeDays += 1;
      total84dTokens += dayTokens;
      if (dayTokens > maxDayTokens) maxDayTokens = dayTokens;
    }
    days.push({
      date: dateKey,
      weekday: curDate.getDay(),
      totalTokens: dayTokens,
      calls: dayCalls,
      costUsd: dayCost,
      level: computeHeatmapLevel(dayTokens, thresholds),
    });
  }

  return {
    period,
    generatedAt: new Date(nowMs).toISOString(),
    scannedFiles: discovered.length,
    summary: {
      totalTokens,
      inputTokens: totalInput,
      cacheReadTokens: totalCacheRead,
      outputTokens: totalOutput,
      cacheHitRate,
      sessionCount: activeSessions.size,
      callCount,
      desktopCalls,
      cliCalls,
      estimatedCostUsd: Number(estimatedCostUsd.toFixed(4)),
      cacheSavedUsd: Number(cacheSavedUsd.toFixed(4)),
      unpricedCalls,
    },
    models,
    heatmap: {
      days,
      activeDays,
      maxDayTokens,
      total84dTokens,
    },
  };
}

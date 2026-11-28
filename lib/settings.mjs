import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getPluginPaths } from './paths.mjs';

/**
 * 支持的 3 种精选视觉形态：
 * - bottle: 玻璃水瓶装水（含双层液面波浪与气泡，默认）
 * - caterpillar: 盘圈毛毛虫（沿圆周逐节爬行生长）
 * - ring: 极简细环（纤细进度圆环 + 中心光点）
 */
export const STYLE_MODES = Object.freeze([
  'bottle',
  'caterpillar',
  'ring',
]);

/**
 * 配色方案固定为自动三级语义告警（绿 <60% / 琥珀 60%-85% / 红 >=85%）
 */
export const COLOR_PALETTES = Object.freeze(['auto']);

/**
 * 支持的上下文窗口上限快捷档位（0=自动识别模型真实上限，其余为手动档位）
 */
export const CONTEXT_LIMITS = Object.freeze([
  0,
  256000,
  512000,
  1000000,
]);

export const MIN_CUSTOM_CONTEXT_LIMIT = 16000;
export const MAX_CUSTOM_CONTEXT_LIMIT = 10000000;
export const FALLBACK_CONTEXT_LIMIT = 512000;

/**
 * 默认插件设置
 */
export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  styleMode: 'bottle',
  palette: 'auto',
  contextLimit: 0,
  modelContextLimits: Object.freeze({}),
  showPercentText: true,
  showFooterQuota: true,
  showFooterSpeed: true,
  showFooterPlanning: true,
  animateEffects: true,
  placement: 'right',
});

/**
 * 将各种格式的模型名称（如 "Gemini 4 Neon (XHigh)" / "claude-opus-5-5-high"）
 * 归一化为稳定的系列键（如 "gemini-4-neon" / "claude-opus-5-5"），
 * 使同一模型系列在不同思考深度下共享上下文上限记忆。
 */
export function normalizeModelKey(rawModelName = '') {
  const raw = String(rawModelName || '').trim();
  if (!raw) return '';
  let cleaned = raw
    .replace(/\s*\((?:minimal|min|low|medium|med|high|xhigh|extra\s*high|max|ultra|thinking|adaptive|preview)\)\s*$/i, '')
    .replace(/[-_\s]+(?:minimal|low|medium|high|xhigh|extra[-_\s]?high|max|ultra)$/i, '')
    .trim()
    .toLowerCase();
  cleaned = cleaned
    .replace(/[.]+/g, '-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return cleaned.slice(0, 80);
}

/**
 * 校验并规范化按模型保存的上下文上限映射表
 */
export function normalizeModelContextLimits(rawMap) {
  if (!rawMap || typeof rawMap !== 'object' || Array.isArray(rawMap)) {
    return {};
  }
  const normalized = {};
  const entries = Object.entries(rawMap).slice(0, 64);
  for (const [rawKey, rawVal] of entries) {
    const key = normalizeModelKey(rawKey);
    const val = Math.round(Number(rawVal));
    if (!key) continue;
    if (Number.isFinite(val) && val >= MIN_CUSTOM_CONTEXT_LIMIT && val <= MAX_CUSTOM_CONTEXT_LIMIT) {
      normalized[key] = val;
    }
  }
  return normalized;
}

/**
 * 校验并规范化外部传入的设置对象，非法字段或已移除旧样式自动回退默认值
 */
export function normalizeSettings(input = {}) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const rawLimit = Number(raw.contextLimit);
  let contextLimit = DEFAULT_SETTINGS.contextLimit;
  if (raw.contextLimit !== undefined && raw.contextLimit !== null && raw.contextLimit !== '') {
    if (rawLimit === 0 || CONTEXT_LIMITS.includes(rawLimit)) {
      contextLimit = rawLimit;
    } else if (
      Number.isFinite(rawLimit) &&
      rawLimit >= MIN_CUSTOM_CONTEXT_LIMIT &&
      rawLimit <= MAX_CUSTOM_CONTEXT_LIMIT
    ) {
      contextLimit = Math.round(rawLimit);
    }
  }

  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_SETTINGS.enabled,
    styleMode: STYLE_MODES.includes(raw.styleMode) ? raw.styleMode : DEFAULT_SETTINGS.styleMode,
    palette: 'auto',
    contextLimit,
    modelContextLimits: normalizeModelContextLimits(raw.modelContextLimits),
    showPercentText:
      typeof raw.showPercentText === 'boolean' ? raw.showPercentText : DEFAULT_SETTINGS.showPercentText,
    showFooterQuota:
      typeof raw.showFooterQuota === 'boolean' ? raw.showFooterQuota : DEFAULT_SETTINGS.showFooterQuota,
    showFooterSpeed:
      typeof raw.showFooterSpeed === 'boolean' ? raw.showFooterSpeed : DEFAULT_SETTINGS.showFooterSpeed,
    showFooterPlanning:
      typeof raw.showFooterPlanning === 'boolean'
        ? raw.showFooterPlanning
        : DEFAULT_SETTINGS.showFooterPlanning,
    animateEffects:
      typeof raw.animateEffects === 'boolean' ? raw.animateEffects : DEFAULT_SETTINGS.animateEffects,
    placement: ['left', 'right'].includes(raw.placement) ? raw.placement : DEFAULT_SETTINGS.placement,
  };
}

/**
 * 解析当前会话实际生效的上下文上限：
 * 优先级：当前模型自定义记忆 > 全局手动上限（若 >0） > 宿主当前请求真实上限 > 模型目录上限 > 兜底 512k
 */
export function resolveEffectiveContextLimit({
  settings = DEFAULT_SETTINGS,
  modelName = '',
  detectedLimit = 0,
  catalogLimit = 0,
} = {}) {
  const safeSettings = normalizeSettings(settings);
  const modelKey = normalizeModelKey(modelName);
  const cleanDetected =
    Number.isFinite(Number(detectedLimit)) && Number(detectedLimit) >= MIN_CUSTOM_CONTEXT_LIMIT
      ? Math.round(Number(detectedLimit))
      : 0;
  const cleanCatalog =
    Number.isFinite(Number(catalogLimit)) && Number(catalogLimit) >= MIN_CUSTOM_CONTEXT_LIMIT
      ? Math.round(Number(catalogLimit))
      : 0;

  if (modelKey && safeSettings.modelContextLimits[modelKey]) {
    return {
      limit: safeSettings.modelContextLimits[modelKey],
      source: 'model-custom',
      auto: false,
      modelKey,
      detectedLimit: cleanDetected,
      catalogLimit: cleanCatalog,
    };
  }

  if (safeSettings.contextLimit > 0) {
    return {
      limit: safeSettings.contextLimit,
      source: 'global',
      auto: false,
      modelKey,
      detectedLimit: cleanDetected,
      catalogLimit: cleanCatalog,
    };
  }

  if (cleanDetected > 0) {
    return {
      limit: cleanDetected,
      source: 'detected',
      auto: true,
      modelKey,
      detectedLimit: cleanDetected,
      catalogLimit: cleanCatalog,
    };
  }

  if (cleanCatalog > 0) {
    return {
      limit: cleanCatalog,
      source: 'catalog',
      auto: true,
      modelKey,
      detectedLimit: cleanDetected,
      catalogLimit: cleanCatalog,
    };
  }

  return {
    limit: FALLBACK_CONTEXT_LIMIT,
    source: 'default',
    auto: true,
    modelKey,
    detectedLimit: 0,
    catalogLimit: 0,
  };
}

/**
 * 创建持久化设置管理器（原子写入 settings.json，支持增量更新、按模型上限记忆与重置）
 */
export function createSettingsStore(dataDir = getPluginPaths(os.homedir()).dataDir) {
  const filePath = path.join(dataDir, 'settings.json');

  // 读取当前磁盘上的有效设置
  function get() {
    try {
      if (!fs.existsSync(filePath)) {
        return normalizeSettings(DEFAULT_SETTINGS);
      }
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return normalizeSettings(parsed);
    } catch {
      return normalizeSettings(DEFAULT_SETTINGS);
    }
  }

  // 合并补丁并原子落盘
  function set(patch = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error('设置更新参数必须是对象');
    }
    const current = get();
    const nextRaw = {
      ...current,
      ...patch,
      modelContextLimits: { ...current.modelContextLimits },
    };

    if (patch.modelContextLimits && typeof patch.modelContextLimits === 'object' && !Array.isArray(patch.modelContextLimits)) {
      nextRaw.modelContextLimits = normalizeModelContextLimits(patch.modelContextLimits);
    }

    // 支持按单个模型增量设置或清除自定义上限：{ setModelContextLimit: { modelName, limit } }
    if (patch.setModelContextLimit && typeof patch.setModelContextLimit === 'object') {
      const targetKey = normalizeModelKey(
        patch.setModelContextLimit.modelKey || patch.setModelContextLimit.modelName || ''
      );
      const targetVal = Number(patch.setModelContextLimit.limit);
      if (targetKey) {
        if (!targetVal || targetVal <= 0) {
          delete nextRaw.modelContextLimits[targetKey];
        } else if (
          Number.isFinite(targetVal) &&
          targetVal >= MIN_CUSTOM_CONTEXT_LIMIT &&
          targetVal <= MAX_CUSTOM_CONTEXT_LIMIT
        ) {
          nextRaw.modelContextLimits[targetKey] = Math.round(targetVal);
        }
      }
      delete nextRaw.setModelContextLimit;
    }

    const merged = normalizeSettings(nextRaw);
    fs.mkdirSync(dataDir, { recursive: true });
    const tempFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempFile, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    try {
      fs.renameSync(tempFile, filePath);
    } catch {
      fs.copyFileSync(tempFile, filePath);
      try {
        fs.unlinkSync(tempFile);
      } catch {
        // 忽略临时文件清理失败
      }
    }
    return merged;
  }

  // 恢复默认设置
  function reset() {
    return set({
      ...DEFAULT_SETTINGS,
      modelContextLimits: {},
    });
  }

  return {
    filePath,
    get,
    set,
    reset,
  };
}

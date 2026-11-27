import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getPluginPaths } from './paths.mjs';

/**
 * 支持的 5 种视觉形态：
 * - ring: 极简细环
 * - donut: 经典双层甜甜圈
 * - caterpillar: 扭动毛毛虫
 * - bottle: 玻璃水瓶装水（含液面波浪与气泡）
 * - capsule: 液态胶囊进度条
 */
export const STYLE_MODES = Object.freeze([
  'ring',
  'donut',
  'caterpillar',
  'bottle',
  'capsule',
]);

/**
 * 支持的配色主题：
 * - auto: 随占用率自动绿/琥珀/红三级语义变色
 * - ocean: 极光冰蓝
 * - emerald: 翡翠森林
 * - sunset: 霓虹落日
 */
export const COLOR_PALETTES = Object.freeze([
  'auto',
  'ocean',
  'emerald',
  'sunset',
]);

/**
 * 支持的上下文窗口上限档位（256k / 512k / 1M）
 */
export const CONTEXT_LIMITS = Object.freeze([
  256000,
  512000,
  1000000,
]);

/**
 * 默认插件设置
 */
export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  styleMode: 'bottle',
  palette: 'auto',
  contextLimit: 512000,
  showPercentText: true,
  animateEffects: true,
  placement: 'right',
});

/**
 * 校验并规范化外部传入的设置对象，非法字段自动回退默认值
 */
export function normalizeSettings(input = {}) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};

  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_SETTINGS.enabled,
    styleMode: STYLE_MODES.includes(raw.styleMode) ? raw.styleMode : DEFAULT_SETTINGS.styleMode,
    palette: COLOR_PALETTES.includes(raw.palette) ? raw.palette : DEFAULT_SETTINGS.palette,
    contextLimit: CONTEXT_LIMITS.includes(Number(raw.contextLimit))
      ? Number(raw.contextLimit)
      : DEFAULT_SETTINGS.contextLimit,
    showPercentText:
      typeof raw.showPercentText === 'boolean' ? raw.showPercentText : DEFAULT_SETTINGS.showPercentText,
    animateEffects:
      typeof raw.animateEffects === 'boolean' ? raw.animateEffects : DEFAULT_SETTINGS.animateEffects,
    placement: ['left', 'right'].includes(raw.placement) ? raw.placement : DEFAULT_SETTINGS.placement,
  };
}

/**
 * 创建持久化设置管理器（原子写入 settings.json，支持增量更新与重置）
 */
export function createSettingsStore(dataDir = getPluginPaths(os.homedir()).dataDir) {
  const filePath = path.join(dataDir, 'settings.json');

  // 读取当前磁盘上的有效设置
  function get() {
    try {
      if (!fs.existsSync(filePath)) {
        return { ...DEFAULT_SETTINGS };
      }
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return normalizeSettings(parsed);
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  // 合并补丁并原子落盘
  function set(patch = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error('设置更新参数必须是对象');
    }
    const merged = normalizeSettings({ ...get(), ...patch });
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
    return set({ ...DEFAULT_SETTINGS });
  }

  return {
    filePath,
    get,
    set,
    reset,
  };
}

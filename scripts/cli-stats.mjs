#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPluginPaths } from '../lib/paths.mjs';
import { createSettingsStore, STYLE_MODES, COLOR_PALETTES, CONTEXT_LIMITS } from '../lib/settings.mjs';
import { getConversationUsage } from '../lib/transcript-parser.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, '..');

/**
 * 解析命令行参数并执行上下文统计查询或快速样式切换
 */
function runCli() {
  const args = process.argv.slice(2);
  const paths = getPluginPaths();
  const settingsStore = createSettingsStore(paths.dataDir);

  // 支持通过命令行快速修改样式/上限：--style bottle --limit 1000000
  const patch = {};
  let conversationId = '';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--style' && args[i + 1]) {
      patch.styleMode = args[++i];
    } else if (arg === '--limit' && args[i + 1]) {
      patch.contextLimit = Number(args[++i]);
    } else if (!arg.startsWith('--') && !conversationId) {
      conversationId = arg.trim();
    }
  }

  if (Object.keys(patch).length > 0) {
    const updated = settingsStore.set(patch);
    process.stdout.write(
      JSON.stringify(
        {
          action: 'settings.updated',
          settings: updated,
          availableStyles: STYLE_MODES,
          availablePalettes: COLOR_PALETTES,
          availableLimits: CONTEXT_LIMITS,
        },
        null,
        2
      ) + '\n'
    );
    return;
  }

  const knownDistrosFile = path.join(PLUGIN_ROOT, '.wsl-distros.json');
  const usage = getConversationUsage(conversationId, { knownDistrosFile });
  const settings = settingsStore.get();
  const limit = Number(settings.contextLimit || 512000);
  const usedPercent = limit > 0 ? Math.round((usage.totalTokens / limit) * 1000) / 10 : 0;

  process.stdout.write(
    JSON.stringify(
      {
        settings,
        usedPercent,
        usage,
      },
      null,
      2
    ) + '\n'
  );
}

runCli();

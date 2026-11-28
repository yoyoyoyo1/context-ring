#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPluginPaths } from '../lib/paths.mjs';
import {
  createSettingsStore,
  STYLE_MODES,
  COLOR_PALETTES,
  CONTEXT_LIMITS,
  resolveEffectiveContextLimit,
} from '../lib/settings.mjs';
import { getConversationUsage } from '../lib/transcript-parser.mjs';
import { enrichUsageWithTelemetry } from '../lib/ls-telemetry.mjs';
import { getUsageHistoryReport } from '../lib/usage-history.mjs';
import { getRehydrateStatus, setRehydrateEnabled } from '../lib/rehydrate-manager.mjs';
import {
  getPlanningStatus,
  setPlanningForConversation,
  clearAllPlanningSessions,
  isPlanningActiveFor,
} from '../lib/planning-manager.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, '..');

/**
 * 解析命令行参数并执行上下文统计、历史账本查询、样式/上限切换或防失忆 Hook 启停
 */
async function runCli() {
  const args = process.argv.slice(2);
  const paths = getPluginPaths();
  const settingsStore = createSettingsStore(paths.dataDir);
  const knownDistrosFile = path.join(PLUGIN_ROOT, '.wsl-distros.json');

  const patch = {};
  let conversationId = '';
  let historyPeriod = '';
  let rehydrateAction = '';
  let planAction = '';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--style' && args[i + 1]) {
      patch.styleMode = args[++i];
    } else if (arg === '--limit' && args[i + 1]) {
      const val = String(args[++i]).trim().toLowerCase();
      patch.contextLimit = val === 'auto' ? 0 : Number(val);
    } else if (arg === '--model-limit' && args[i + 1]) {
      const pair = String(args[++i]);
      const eqIdx = pair.indexOf('=');
      if (eqIdx > 0) {
        const modelName = pair.slice(0, eqIdx).trim();
        const rawLim = pair.slice(eqIdx + 1).trim().toLowerCase();
        patch.setModelContextLimit = {
          modelName,
          limit: rawLim === 'auto' || rawLim === '0' ? 0 : Number(rawLim),
        };
      }
    } else if (arg === '--history') {
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        historyPeriod = next.trim();
        i++;
      } else {
        historyPeriod = '30d';
      }
    } else if (arg === '--footer-quota' && args[i + 1]) {
      const v = String(args[++i]).trim().toLowerCase();
      patch.showFooterQuota = v === 'on' || v === 'true' || v === '1';
    } else if (arg === '--footer-speed' && args[i + 1]) {
      const v = String(args[++i]).trim().toLowerCase();
      patch.showFooterSpeed = v === 'on' || v === 'true' || v === '1';
    } else if (arg === '--footer-planning' && args[i + 1]) {
      const v = String(args[++i]).trim().toLowerCase();
      patch.showFooterPlanning = v === 'on' || v === 'true' || v === '1';
    } else if (arg === '--rehydrate' && args[i + 1]) {
      rehydrateAction = String(args[++i]).trim().toLowerCase();
    } else if (arg === '--plan' && args[i + 1]) {
      planAction = String(args[++i]).trim().toLowerCase();
    } else if (!arg.startsWith('--') && !conversationId) {
      conversationId = arg.trim();
    }
  }

  if (planAction) {
    const planOpts = { pluginRoot: PLUGIN_ROOT, dataDir: paths.dataDir };
    if (planAction === 'clear' || planAction === 'reset') {
      const res = clearAllPlanningSessions({ ...planOpts, emitExitNotices: true });
      process.stdout.write(`${JSON.stringify({ action: 'planning.cleared', ...res }, null, 2)}\n`);
      return;
    }
    if (planAction === 'on' || planAction === 'enable' || planAction === 'off' || planAction === 'disable') {
      const isEnable = planAction === 'on' || planAction === 'enable';
      const targetCid =
        conversationId === 'new'
          ? ''
          : conversationId || getConversationUsage('', { knownDistrosFile }).conversationId || '';
      const res = setPlanningForConversation({ conversationId: targetCid, enabled: isEnable }, planOpts);
      process.stdout.write(
        `${JSON.stringify(
          {
            action: isEnable ? 'planning.enabled' : 'planning.disabled',
            conversationId: targetCid || '(pending-new-session)',
            ...res,
          },
          null,
          2
        )}\n`
      );
      return;
    }
    const status = getPlanningStatus(planOpts);
    const currentCid = conversationId || getConversationUsage('', { knownDistrosFile }).conversationId || '';
    process.stdout.write(
      `${JSON.stringify(
        {
          action: 'planning.status',
          conversationId: currentCid,
          activeForConversation: isPlanningActiveFor(status, currentCid),
          status,
        },
        null,
        2
      )}\n`
    );
    return;
  }

  if (rehydrateAction) {
    if (rehydrateAction === 'on' || rehydrateAction === 'enable') {
      const res = setRehydrateEnabled(true, { pluginRoot: PLUGIN_ROOT });
      process.stdout.write(`${JSON.stringify({ action: 'rehydrate.enabled', ...res }, null, 2)}\n`);
      return;
    }
    if (rehydrateAction === 'off' || rehydrateAction === 'disable') {
      const res = setRehydrateEnabled(false, { pluginRoot: PLUGIN_ROOT });
      process.stdout.write(`${JSON.stringify({ action: 'rehydrate.disabled', ...res }, null, 2)}\n`);
      return;
    }
    const status = getRehydrateStatus({ pluginRoot: PLUGIN_ROOT });
    process.stdout.write(`${JSON.stringify({ action: 'rehydrate.status', status }, null, 2)}\n`);
    return;
  }

  if (historyPeriod) {
    const report = getUsageHistoryReport({
      period: historyPeriod,
      knownDistrosFile,
      cacheDir: paths.dataDir,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  if (Object.keys(patch).length > 0) {
    const updated = settingsStore.set(patch);
    process.stdout.write(
      `${JSON.stringify(
        {
          action: 'settings.updated',
          settings: updated,
          availableStyles: STYLE_MODES,
          availablePalettes: COLOR_PALETTES,
          availableLimits: CONTEXT_LIMITS,
        },
        null,
        2
      )}\n`
    );
    return;
  }

  const baseUsage = getConversationUsage(conversationId, { knownDistrosFile });
  const usage = await enrichUsageWithTelemetry(baseUsage);
  const settings = settingsStore.get();
  const resolvedLimit = resolveEffectiveContextLimit({
    settings,
    modelName: usage.modelName,
    detectedLimit: usage.detectedContextLimit,
    catalogLimit: usage.catalogContextLimit,
  });
  const usedPercent =
    resolvedLimit.limit > 0 ? Math.round((usage.totalTokens / resolvedLimit.limit) * 1000) / 10 : 0;

  const planning = getPlanningStatus({ pluginRoot: PLUGIN_ROOT, dataDir: paths.dataDir });

  process.stdout.write(
    `${JSON.stringify(
      {
        settings,
        effectiveLimit: resolvedLimit,
        usedPercent,
        rehydrate: getRehydrateStatus({ pluginRoot: PLUGIN_ROOT }),
        planning,
        planningActiveForCurrent: isPlanningActiveFor(planning, usage.conversationId),
        usage,
      },
      null,
      2
    )}\n`
  );
}

runCli().catch((err) => {
  console.error(err?.message || String(err));
  process.exitCode = 1;
});

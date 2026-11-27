---
name: context-ring
description: 管理与定制 Context Ring 无侵入上下文与用量监控插件（支持玻璃水瓶装水、盘圈毛毛虫、极简细环 3 种形态、实时生成速度体检、按模型上限记忆、历史用量热力图与预估费用、压缩后防失忆 Hook，兼容 Windows 本地与 WSL2 双模式）。
---

# Context Ring 技能指南

## 功能概览
Context Ring 通过客户端本地 CDP 接口（`--remote-debugging-port=0`）与标准 Sidecar 无侵入挂载在 Antigravity 输入框底部栏，**不修改 `app.asar`**，客户端自动升级也不会失效。

## 常用命令

1. **查看插件安装、挂载与防失忆 Hook 状态**：
   ```bash
   node "$HOME/.gemini/config/plugins/context-ring/scripts/install.mjs" status
   ```
2. **查看当前或指定会话的上下文占用、自动上限与实时生成速度**：
   ```bash
   node "$HOME/.gemini/config/plugins/context-ring/scripts/cli-stats.mjs" [conversationId]
   ```
3. **查询多周期历史用量、活跃热力图与预估 API 费用**：
   ```bash
   node "$HOME/.gemini/config/plugins/context-ring/scripts/cli-stats.mjs" --history 30d
   ```
4. **切换视觉样式 / 窗口上限 / 按模型记忆上限**：
   - 样式 `--style`：`bottle`（玻璃水瓶装水，默认）、`caterpillar`（盘圈毛毛虫）、`ring`（极简细环）
   - 上限 `--limit`：`auto`（自动识别模型真实上限，默认）、`256000`、`512000`、`1000000`
   - 按模型记忆：`--model-limit "gemini-4-neon=512000"`（设为 `auto` 或 `0` 恢复自动）
   ```bash
   node "$HOME/.gemini/config/plugins/context-ring/scripts/cli-stats.mjs" --style caterpillar --limit auto
   ```
5. **启停纯 Node.js 压缩后防失忆（Post-Compact Rehydration）Hook**：
   ```bash
   node "$HOME/.gemini/config/plugins/context-ring/scripts/cli-stats.mjs" --rehydrate on
   node "$HOME/.gemini/config/plugins/context-ring/scripts/cli-stats.mjs" --rehydrate off
   ```
6. **打开右侧可视化监控与样式工坊**：
   在回复中输出胶囊链接：`[Context Ring (上下文工坊)](sidecar://context-ring/monitor/ui.html)`

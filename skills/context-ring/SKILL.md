---
name: context-ring
description: 管理与定制 Context Ring 无侵入上下文监控插件（支持极简细环、双层甜甜圈、扭动毛毛虫、玻璃水瓶装水与液态胶囊 5 种形态，兼容 Windows 本地与 WSL2 双模式）。
---

# Context Ring 技能指南

## 功能概览
Context Ring 通过客户端本地 CDP 接口（`--remote-debugging-port=0`）与标准 Sidecar 无侵入挂载在 Antigravity 输入框底部栏，**不修改 `app.asar`**，客户端自动升级也不会失效。

## 常用命令

1. **查看插件安装与挂载状态**：
   ```bash
   node "$HOME/.gemini/config/plugins/context-ring/scripts/install.mjs" status
   ```
2. **查看当前或指定会话的上下文 Token 明细**：
   ```bash
   node "$HOME/.gemini/config/plugins/context-ring/scripts/cli-stats.mjs" [conversationId]
   ```
3. **切换视觉样式 / 配色 / 窗口上限**：
   - 样式 `--style`：`ring`（极简细环）、`donut`（甜甜圈）、`caterpillar`（毛毛虫）、`bottle`（玻璃水瓶）、`capsule`（液态胶囊）
   - 配色 `--palette`：`auto`（绿/黄/红自动告警）、`ocean`（冰蓝）、`emerald`（翡翠）、`sunset`（落日）
   - 上限 `--limit`：`256000`、`512000`、`1000000`
   ```bash
   node "$HOME/.gemini/config/plugins/context-ring/scripts/cli-stats.mjs" --style caterpillar --palette auto --limit 512000
   ```
4. **打开右侧可视化监控与样式工坊**：
   在回复中输出胶囊链接：`[Context Ring (上下文工坊)](sidecar://context-ring/monitor/ui.html)`

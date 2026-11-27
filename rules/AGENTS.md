---
trigger: model_decision
description: 当用户询问上下文占用、生成速度、历史用量热力图与预估 API 费用、压缩后防失忆 Hook、切换 Context Ring 样式（玻璃瓶/毛毛虫/细环）或打开右侧监控面板时使用
---

# Context Ring 使用规则

1. 查询当前会话的精确上下文占用、实时速度与模型自动上限时，运行：
   ```bash
   node "$HOME/.gemini/config/plugins/context-ring/scripts/cli-stats.mjs"
   ```
2. 查询多周期历史 Token 用量、热力图概要与预估 API 费用（支持 `today`、`7d`、`30d`、`all`）时，运行：
   ```bash
   node "$HOME/.gemini/config/plugins/context-ring/scripts/cli-stats.mjs" --history 30d
   ```
3. 通过命令行切换输入框监控样式（支持 `bottle`、`caterpillar`、`ring`）或按模型记忆上下文上限时，运行：
   ```bash
   node "$HOME/.gemini/config/plugins/context-ring/scripts/cli-stats.mjs" --style bottle --limit auto
   ```
4. 一键启停纯 Node.js 压缩后防失忆 Hook（`on` / `off` / `status`）：
   ```bash
   node "$HOME/.gemini/config/plugins/context-ring/scripts/cli-stats.mjs" --rehydrate status
   ```
5. 引导用户打开右侧实时监控与样式定制工坊时，提供以下 Sidecar 胶囊链接：
   ```markdown
   [Context Ring (上下文工坊)](sidecar://context-ring/monitor/ui.html)
   ```

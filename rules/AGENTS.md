---
trigger: model_decision
description: 当用户询问上下文占用、缓存命中率、切换 Context Ring 样式（细环/甜甜圈/毛毛虫/玻璃瓶/胶囊）或打开右侧监控面板时使用
---

# Context Ring 使用规则

1. 查询当前会话的精确上下文占用与缓存命中率时，运行：
   ```bash
   node "$HOME/.gemini/config/plugins/context-ring/scripts/cli-stats.mjs"
   ```
2. 通过命令行直接切换输入框监控样式（支持 `ring`、`donut`、`caterpillar`、`bottle`、`capsule`）时，运行：
   ```bash
   node "$HOME/.gemini/config/plugins/context-ring/scripts/cli-stats.mjs" --style bottle
   ```
3. 引导用户打开右侧实时监控与样式定制工坊时，提供以下 Sidecar 胶囊链接：
   ```markdown
   [Context Ring (上下文工坊)](sidecar://context-ring/monitor/ui.html)
   ```

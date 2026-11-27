# Context Ring — Antigravity 无侵入多形态上下文监控插件

面向 **Google Antigravity 2.0** 桌面客户端的零侵入上下文监控与视觉定制插件。直接挂载在聊天输入框底部工具栏，实时展示当前会话的上下文窗口占用百分比、缓存命中率、输入/输出 Token 明细，并内置 **5 种趣味可切换形态** 与 **右侧实时监控工坊**。

> **为什么做这个插件？**
> - **零侵入 `app.asar`**：通过本机调试接口（`--remote-debugging-port=0`）与官方标准 Sidecar 注入，**绝不修改客户端安装文件**，Antigravity 自动升级后依然直接可用。
> - **零 DOM 劫持**：不污染原生 `document.querySelectorAll`，与 `Agy Powertools`、`agy-fast` 等插件无冲突共存（卸载时还会自动检测同伴插件，不破坏共享的快捷方式调试参数）。
> - **零外部依赖**：纯 Node.js 原生模块实现，无需 `npm install`，开箱即装。

---

## 内置 5 种可切换形态

在输入框悬浮卡片或右侧工坊面板中可**一键秒切**，实时生效：

| 形态代号 | 名称 | 视觉效果说明 |
| :--- | :--- | :--- |
| `bottle` *(默认)* | **玻璃水瓶装水** 🧪 | 带软木塞与玻璃高光折射条的透明魔药瓶，瓶内双层正弦波浪液面随占用率升降晃动，附带上升小气泡 |
| `caterpillar` | **扭动毛毛虫** 🐛 | 5 节圆润身体 + 触角眨眼虫头，随上下文增长逐节点亮染色，带轻柔波浪蠕动动画 |
| `donut` | **双层甜甜圈** 🍩 | 外圈展示总上下文占用进度，内圈同心翠绿细环同步展示 Prompt 缓存命中率 |
| `ring` | **极简细环** ⭕ | 纤细圆环进度条 + 中心呼吸圆点，清爽克制 |
| `capsule` | **液态胶囊** 💊 | 横向玻璃胶囊进度槽，带高光流光条 |

同时支持 **4 套配色方案**（`自动绿/黄/红三级告警`、`极光冰蓝`、`翡翠森林`、`霓虹落日`；当上下文达到 `90%` 高危水位时均会自动切换红色预警）、**3 档窗口上限切换**（`256k` / `512k` / `1M`）以及 **一键复制 `/compact`**。

---

## 快速安装

**环境要求**：Node.js `20+`（Windows 下若已安装 Antigravity，会自动优先复用客户端内置 Node 运行时）。支持 **Windows / macOS / Linux / WSL2 双模**。

### Windows

```powershell
git clone https://github.com/<你的GitHub用户名>/context-ring.git
cd context-ring
.\install.cmd
```

*(或使用 PowerShell：`powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1`)*

### macOS / Linux / WSL2

```bash
git clone https://github.com/<你的GitHub用户名>/context-ring.git
cd context-ring
sh ./install.sh
```

### 生效说明
- 如果当前客户端已经开启了调试端口（例如已装过 `Agy Powertools`），安装完成后会**免重启直接热挂载**到当前窗口输入框！
- 如果是首次安装，请**完全退出 Antigravity 后从桌面或开始菜单快捷方式重新打开**（安装器已自动为快捷方式追加 `--remote-debugging-port=0`）。

---

## 卸载与状态诊断

```powershell
# 查看当前连接健康度、样式配置与最近会话统计
node scripts/install.mjs status

# Windows 一键无痕卸载（运行中窗口的组件也会即时移除）
.\uninstall.cmd

# 卸载但保留个人样式配置
powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1 -KeepSettings
```

---

## 推荐给朋友的一键口令模板

把仓库推到你的 GitHub 后，可以直接复制下面这段发给朋友（记得把 `<你的GitHub用户名>` 换成你自己的）：

```markdown
推荐一个 Antigravity 输入框上下文监控插件 **Context Ring**：
不改客户端 `app.asar`（客户端自动更新不失效），支持把上下文进度切换成 **玻璃瓶装水晃动、扭动毛毛虫、双层甜甜圈、极简细环、液态胶囊** 5 种样式，悬停能看缓存命中率、切 512k/1M 上限和一键复制 `/compact`，还兼容 WSL2。

安装命令（Windows）：
git clone https://github.com/<你的GitHub用户名>/context-ring.git
cd context-ring
.\install.cmd

装完重开一次 Antigravity 就能在输入框右下角看到小水瓶了！
```

---

## 开发与测试

```bash
# 运行内置自动化测试套件
npm test
```

## 开源协议

[MIT License](LICENSE)

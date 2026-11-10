# dsh-plugins

[![CI](https://github.com/26huitailang/dsh-plugins/actions/workflows/ci.yml/badge.svg)](https://github.com/26huitailang/dsh-plugins/actions/workflows/ci.yml)

DeepSeek Harness（DSH）插件集合。

## 界面预览

磁盘空间面板：主显示与 macOS「系统设置 → 储存空间」一致（可用空间含可清除空间），
并同时给出 `df`/`diskutil` 原始口径与可清除空间。

![磁盘医生面板](docs/screenshots/panel-overview.png)

「立即刷新」会重新执行一次脚本化采集，并显示 `已刷新 · 采样于 HH:mm:ss` 反馈：

![立即刷新反馈](docs/screenshots/panel-refresh.png)

## 安装

两个插件都在 DSH 的「插件」页安装（侧栏 **插件** → **添加插件**），支持三种来源。

### 1. GitHub 仓库（无需发布 npm，推荐试用）

粘贴带子目录的 Git 规格，**必须带 `#path:/<子目录>`**：

| 插件 | 在「添加插件」里粘贴 |
| --- | --- |
| 磁盘医生 | `github:26huitailang/dsh-plugins#path:/disk-doctor` |
| 霓虹秒速五厘米 | `github:26huitailang/dsh-plugins#path:/neon-5cms-theme` |

也可以写成完整 URL：
`https://github.com/26huitailang/dsh-plugins#path:/neon-5cms-theme`。

> **为什么不能只填仓库地址？** 本仓库是 monorepo，仓库根目录没有 `package.json` / `dsh.bundle`。
> pnpm 对没有 `package.json` 的仓库会生成一个占位包（`dsh-plugins 0.0.0`），插件管理器读不到
> bundle 声明，会以 `not-a-bundle` 回滚安装。`#path:` 告诉 pnpm 取仓库里的哪个子目录，
> 那个子目录才是完整插件包（有自己的 `package.json`、`cordis.patch.yml` 和 `dsh.client`）。

### 2. 本地目录（开发时推荐，改代码后自动热更新）

在「添加插件」里粘贴插件的**绝对路径**，例如：

```text
/Users/<你>/git-checkout/dsh-plugins/disk-doctor
/Users/<你>/git-checkout/dsh-plugins/neon-5cms-theme
```

这样安装成 `link:` 依赖，插件文件随保存热重载，不用重装。

### 3. npm 包（发布后）

两个插件的 `package.json` 目前是本地 bundle 写法（`private: true`、`@local/` 作用域）。
发布前需要改成公开包名、移除 `private` 并补 `repository`，之后可直接粘贴包名安装。

### 启用 / 关闭 / 卸载

- 安装后 bundle 默认启用；侧栏「插件」页里 bundle 开关和单个插件行开关都可以控制启用。
- **关闭**只从组合中摘掉（依赖仍保留），**卸载**才会移除依赖；两者都不影响 profile 里其他插件。
- 具体运行时行为（例如主题关闭后恢复官方主题）见各插件 README。

### 安装源（镜像）说明

「添加插件」里的安装源只影响 **npm 包名**的安装；Git 规格和本地目录不经过 npm registry。

## 插件

### disk-doctor（磁盘医生）

macOS 磁盘空间面板 + AI 清理建议：

- **左侧栏入口**：`sidebar.panellist` 中的「磁盘医生」，打开全局主面板（`main` 槽位）。
- **脚本化周期采集（不依赖大模型）**：Host 每 5 分钟用 `df`、`diskutil` 和 JXA（NSURL 容量）只读采集，
  同时给出两套口径：
  - macOS「系统设置 / Finder」口径：可用空间（含可清除空间）与已用空间，面板主显示；
  - `df`/`diskutil` 原始口径：实际占用与原始剩余，作为补充，并显示可清除空间及差异说明。
  十进制 GB（与 macOS 一致），保留最多 288 条采样历史。
- **手动 AI 巡检（依赖大模型）**：点击「AI 巡检并生成清理建议」后，Host 创建一个真实会话并投递巡检提示词，
  模型只读巡检后给出结构化清理建议；最终回答由 Host 监听会话事件捕获并回显在面板中，可跳转完整会话。
  插件只给建议，绝不自动删除任何文件。

安装：见上方 [安装](#安装)。Git 规格：`github:26huitailang/dsh-plugins#path:/disk-doctor`。
契约与设计见 [`disk-doctor/DESIGN.md`](disk-doctor/DESIGN.md)。

#### 测试

```bash
cd disk-doctor
node tests/collector.test.js   # 54 项 fixture 单测（离线、确定性）
```

CI（GitHub Actions）在 Node 18/20/22 上执行 `node --check`（全部 JS）、上述单测与
`package.json` 结构校验，见 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)。

#### 界面截图

`docs/screenshots/` 中的截图由本机实测截图裁剪脱敏而来（仅保留面板区域，移除了侧栏会话列表、
菜单栏等个人界面信息）。

### neon-5cms-theme（霓虹秒速五厘米主题）

给 DSH Web UI 的「霓虹秒速五厘米 / Neon 5cm/s」第三方主题（内部 id `anime`）：深紫罗兰"夜景"
底色 + 樱花粉主色 + 淡紫次色，柔光背景、樱花发送按钮；发送消息后飘落像素樱花雨，
鼠标划过可以切开花瓣。

![霓虹秒速五厘米主题：樱花雨与鼠标切片](docs/screenshots/theme-neon-5cms.gif)

- **不修改任何其他包**：主题通过官方 `theme.register()` / `theme.setTheme()` 扩展点注册，
  与旧版「改写官方 theme bundle」的补丁脚本不同，DSH 升级后无需重跑脚本。
- **真正的开关**：侧栏「插件」页中该 bundle / 行的开关即启用或关闭。关闭后插件注册的主题随即
  注销，样式表与樱花雨一并移除，Host 持久化的浅色 / 深色 / 跟随系统偏好重新生效。
- **稳定 DOM 契约**：樱花按钮与樱花雨使用 `[data-composer-seat] button[aria-busy]:not([aria-haspopup])`、
  `[data-composer-input]` 等语义属性定位（`aria-busy` 也出现在模型选择器上，用 `aria-haspopup` 排除），
  不用每次构建都会变化的 CSS Module 哈希类名。

安装：见上方 [安装](#安装)。Git 规格：`github:26huitailang/dsh-plugins#path:/neon-5cms-theme`。
契约、开关行为与已知限制见 [`neon-5cms-theme/README.md`](neon-5cms-theme/README.md)。

#### 测试

```bash
node neon-5cms-theme/tests/contract.test.js   # 14 项离线契约测试（假 Loader / 假 ctx / 假 theme 服务）
```

## 开发辅助

- `.tools/asar.py`：只读解析 DSH 桌面版 `app.asar`，用于查看安装包内的源码/文档（`ls` / `cat` / `grep`）。
  归档路径默认为 macOS 桌面版位置，可用环境变量 `DSH_ASAR=/path/to/app.asar` 覆盖。
- `.tools/harness-host.mjs`：Host 半的 mock-Cordis 集成验证（真实 df/diskutil/JXA 命令 + 路由 + AI 会话跟踪）。

`.verify/`（本机原始实测截图）已在 `.gitignore` 中忽略，不会进入仓库；对外展示使用
`docs/screenshots/` 中的脱敏裁剪版本。

## 开源与发布说明

- 许可证：[MIT](LICENSE)。
- 两个插件的 `package.json` 目前都是本地 DSH bundle 的写法（`"private": true`、`@local/` 作用域）。
  若要发布到 npm，需要改成公开作用域/包名、移除 `private`，并补上 `repository` 字段。
- `.tools/asar.py` 默认读取 macOS 桌面版 DSH 的 `app.asar`，可用 `DSH_ASAR` 指定其他路径。

## License

[MIT](LICENSE) © 2026 26huitailang

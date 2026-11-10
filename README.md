# dsh-plugins

DeepSeek Harness（DSH）插件集合。

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

安装：通过 DSH Plugin Manager 以本地目录安装本仓库的 `disk-doctor/` 目录（bundle patch 自动插入 Loader 行）。
契约与设计见 [`disk-doctor/DESIGN.md`](disk-doctor/DESIGN.md)。

#### 测试

```bash
cd disk-doctor
node tests/collector.test.js   # 54 项 fixture 单测（离线、确定性）
```

## 开发辅助

- `.tools/asar.py`：只读解析 DSH 桌面版 `app.asar`，用于查看安装包内的源码/文档（`ls` / `cat` / `grep`）。
  归档路径默认为 macOS 桌面版位置，可用环境变量 `DSH_ASAR=/path/to/app.asar` 覆盖。
- `.tools/harness-host.mjs`：Host 半的 mock-Cordis 集成验证（真实 df/diskutil/JXA 命令 + 路由 + AI 会话跟踪）。

`.verify/`（本机实测截图）已在 `.gitignore` 中忽略，不会进入仓库；如需分享截图请自行确认其中不含个人信息。

## 开源与发布说明

- 许可证：[MIT](LICENSE)。
- `disk-doctor/package.json` 目前是本地 DSH bundle 的写法（`"private": true`、`@local/` 作用域）。
  若要发布到 npm，需要改成公开作用域/包名、移除 `private`，并补上 `repository` 字段。
- `.tools/asar.py` 默认读取 macOS 桌面版 DSH 的 `app.asar`，可用 `DSH_ASAR` 指定其他路径。

## License

[MIT](LICENSE) © 2026 26huitailang

# 让 AI 助手安装 AI 短剧生成工作台

把下面这段话交给能操作你电脑的 AI 编程助手，例如 Codex、Claude Code 或 Cursor，让它安装 AI Short Drama Workbench 并验证本地流程。工作台面向 AI 短剧、AI 漫剧和剧情短片创作；模型由你自己选、自己付费。

```text
请帮我在本机安装并验证 AI 短剧生成工作台（AI Short Drama Workbench）：
https://github.com/CZ3744/ai-short-drama-workbench

先阅读仓库 README.md、docs/GETTING_STARTED.md 和 docs/AI_SETUP.md。
新安装时将仓库克隆到独立的 ai-short-drama-workbench 目录。
如果已有安装，先检查 Git 状态并保留 data/、outputs/、
config/local-settings.json 和 .env，不覆盖已有作品或凭据。

1. 检查 Node.js，推荐 24 LTS；运行 npm ci。
2. 运行 npm run doctor。要合成视频，还需 FFmpeg 和 FFprobe 在 PATH 中，
   并运行 npm run doctor -- --require-media。
3. 运行 npm run build。Windows 用 start-studio-hidden.vbs 静默启动；
   其他系统使用 npm run dev。Windows 不要留下弹出的后台终端窗口。
4. 打开 http://127.0.0.1:5173，检查页面与本地 API 都可用。
   新建一个明确标注为安装验收的系列，写一小段剧本，等待保存后刷新，
   确认内容仍在。只报告实际完成的步骤和失败原因。
5. 告诉我在哪里配置自己的模型。不要索取、打印或提交我的密钥；
   不要替我发起收费请求，不要暴露公网，不要修改其他程序的端口或进程。

遇到端口冲突先说明占用情况，不能结束其他项目的服务。
安装不顺利时先修复并复测，不要用 HTTP 200 或进程存在冒充验收成功。
```

## 给执行助手的核对信息

| 项目 | 约定 |
|---|---|
| 环境 | 推荐 Node.js 24；`npm ci` 使用仓库锁文件 |
| 只读自检 | `node scripts/doctor.mjs --json`；需要合成时加 `--require-media` |
| 本地页面 | `http://127.0.0.1:5173` |
| 本地 API | `http://127.0.0.1:8788`，`/healthz` 仅作服务健康检查 |
| Windows 启停 | `start-studio-hidden.vbs` / `stop-studio.vbs`，仅管理本项目服务 |
| 用户数据 | `data/`、`outputs/`、`config/local-settings.json`、可选 `.env` |
| 回归 | `npm test`；浏览器回归见 [开发说明](../CONTRIBUTING.md) |
| 支持范围 | Windows 已验收；macOS / Linux 尚未做同等程度的实机验收 |

不配置 API 也能编辑剧本、管理分镜、导入素材。真实的文字、图像、视频和语音生成需要对应服务；“本地演示卡片”只用于走流程。

这是供个人在本机运行的应用。仓库不包含公网部署、登录鉴权、多租户隔离或托管模型额度。

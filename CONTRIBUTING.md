# 一起把工作台做得更好用

欢迎提交问题、文档改进和小范围修复。优先处理创作中真正会卡住人的事：保存丢失、切镜串内容、错误说不清、按钮找不到、导出失败。

## 报告问题

请写清系统、Node.js 版本、操作步骤、预期结果和实际结果。尽量用新建的样例系列复现，再附上经过脱敏的截图或错误信息。不要上传 API Key、`.env`、`local-settings.json`、整个数据库或私人作品。

## 本地开发

```sh
npm ci
npm run doctor
npm run dev
```

提交前按改动范围运行检查：

```sh
npm run build
npm test
npm run health:codebase
npm run check:privacy
```

涉及界面时，再运行 `npm run test:browser`。首次运行需要 `npx playwright install chromium`；Windows 已安装 Edge 时，也可设置环境变量 `VIDEO_GENERATE_TEST_BROWSER=msedge`。测试使用临时数据和空凭据，输出保存在忽略的 `.quality-reports/` 目录。媒体回归需要 FFmpeg / FFprobe；部分本地执行器测试需要 Python。

一个修复尽量只解决一个问题。保留现有暖白、陶土色和简洁的控件层次；修改交互时照顾窄屏、键盘操作、加载和失败状态。不要把模拟数据当成生成成功，也不要以重置用户数据的方式修复问题。

新增配置优先提供空示例或公开默认值。`package.json` 的 `private: true` 用于防止误发到 npm，不影响 MIT 许可，也不决定 GitHub 仓库是否公开。

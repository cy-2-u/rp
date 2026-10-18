# 作者代码离线样本

这些文件来自 [STA1N156/RP-Hub](https://github.com/STA1N156/RP-Hub) main 分支，保留作者源文件，不在测试中改写 app.js。版权与许可归原作者及原项目；本目录不重新授权第三方源码，发布或复用须遵守原项目许可。

- 全部文件在 2026-10-18 从作者 GitHub 仓库 main 提交 `8403e875` 一次性取得，**属于同一提交**（git blob SHA-1 逐一核对）。
- `manifest.json` 记录每个文件的字节数与 SHA-256。
- `cloud-backup.js` 是作者 2026-10 新增模块（app.js 依赖 `window.RPHubCloudBackup`），测试按作者 HTML 动态加载器顺序在 runtime-services 之后加载它。

`external-author-integration.mjs` 用这些样本在 jsdom、真实 Vue 与 fake-indexeddb 中运行作者 setup/mount；测试用最小 root template 暴露 chatContainer，因此验证的是行为接入，不是完整作者 HTML/CSS 的视觉验收。`RPHUB_UPSTREAM_DIR` 可指定另一作者仓库目录来替换全部上游文件。

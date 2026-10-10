# 作者代码离线样本

这些文件来自 [sta1n156/RP-Hub](https://github.com/sta1n156/RP-Hub)，保留作者源文件，不在测试中改写 app.js。版权与许可归原作者及原项目；本目录不重新授权第三方源码，发布或复用须遵守原项目许可。

- `app.js`、`ui-components.js`、`index.html` 来自本机已有的 `RP-Hub-main` 快照。
- 其余五个模块在本次测试准备时从作者公开 GitHub Pages 的 `assets/js/` 下载；测试执行不再联网。
- 文件来自上述两个来源，**没有证明属于同一个 Git 提交**。本次集成已执行兼容验证，不能将它描述成固定某个上游 commit 的完整发行版。
- 每个文件的字节数、SHA-256 与来源记录在 [manifest.json](manifest.json)。

`external-author-integration.mjs` 默认用这些样本，在 jsdom、真实 Vue 与 fake-indexeddb 中运行作者 setup/mount；测试用最小 root template 暴露 chatContainer，因此验证的是行为接入，不是完整作者 HTML/CSS 的视觉验收。`RPHUB_UPSTREAM_DIR` 可指定另一作者仓库来替换 app.js/ui-components.js；补充模块仍取本目录。

# 外部适配脚本

当前维护入口是 [`rp-hub.js`](rp-hub.js)。它是可执行脚本，负责作者页面的定位、插入、Vue/存储接入，并把能力通过 `window.RPHubExternal` 提供给功能模块。作者 `app.js` 不再改写。

文件开头的 `RPHUB_ADAPTER_CONFIG` 注释包含 schema 2 元数据。Worker 只校验并读取元数据；脚本正文随当前 HTML 内联执行，顺序为 dirty-tracker、元数据、适配脚本、magic-extension、bootstrap。这样一次页面导航使用同一份适配版本，不会在后续加载 app.js 时切换行为。不是独立的浏览器 `src` 请求。

主要接口（`version: 1`）：

- `flush(): Promise<void>`：执行捕获的保存防抖任务，等待作者存储写入及事务完成。作者未就绪、切换/生成中或写入失败时拒绝，不宣称同步成功。
- `context(card)`：返回该卡片当前的完整上下文——角色（`characterId` / `characterName`）、分支（`storyScopeId`）、消息对象与序号、生图密钥、自动生图实时状态和忙碌标记；上下文不全（如消息未渲染）时返回 `null`。
- `describeCard(card)`：只返回槽位定位 `{messageIndex, occurrenceIndex}`，用于在一条消息里区分多张图片卡；找不到所属行时返回 `null`。它不返回角色或开关状态。
- `register('image-request', handler)`：功能模块注册图片任务；返回任务需有 `cards: Set` 与 `promise`，并通过传入的 `render(card, task, job)` 更新状态。
- `register('character-deleted', handler)`：清理功能模块的角色内存缓存。
- `imageKey()`：读取当前设置中的生图密钥。
- `capabilities()`：查询当前可用能力；`installUi()` 安装导航、设置、模型下拉和滚动按钮。

事件包括 `rphub:adapter`、`rphub:ready`、`rphub:flushed`、`rphub:image-rendered`。也可派发 `rphub:flush`，在 `detail.respond` 中接收保存 Promise。

当前桥接依赖 Vue 3 的 `createApp/setup/watch/onMounted`、作者导出的存储模块与 setup 状态，以及四种保存 watcher 的函数文本标记。它把作者依赖集中到了本文件，但作者更改运行时、变量名、保存机制或 DOM 时，仍需要更新适配并回归。没有用等待固定毫秒数来推测保存完成，也没有全局 fetch/XHR 生图劫持；图片任务在作者卡片观察回调之前接管。

Worker 的 last-good 是通过元数据和契约标记校验的脚本副本，不代表已验证任意脚本的 JavaScript 语法或浏览器行为。发布前必须运行语法检查、离线集成，并在实际作者页面验收。

`rp-hub.js` 是当前维护和生产使用的适配入口；Worker 不再改写作者 app.js，而是把该脚本的元数据和可执行桥接层按当前页面版本注入。

`rp-hub.json` 保留给仍在使用旧版适配协议的实例，不参与新版 `rp-hub.js` 的生产加载。

本轮已完成离线回归与本地发布归档校验；外部脚本已发布到 GitHub Raw URL，但未向 Cloudflare、Pages 或真实 R2 上传部署。

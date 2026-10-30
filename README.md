# RP Hub 魔改版 v2

一个 Cloudflare Pages Worker 项目：反向代理 [RP-Hub](https://github.com/STA1N156/RP-Hub)（作者的酒馆类角色扮演前端），在不修改作者代码的前提下加入**云同步、R2 聊天图片托管、图片管理**等功能。本目录是 v2 重写版，与旧版协议互不兼容（云端快照全新开始；图片库无缝沿用）。

- **免服务器运维**：部署到 Cloudflare Pages 免费版即可，数据存在自己的 R2 桶里。
- **数据自主**：聊天记录、角色卡、生成图片全部保存在自己的 Cloudflare 账号。
- **不改动作者代码**：作者前端原样代理；适配作者变化的手段是更新**一个外部可执行脚本**（见下）。

维护者文档（适配脚本链、同步 v2 协议、测试与发布）见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 功能

### 云同步（协议 v2）

- **上传到云端**：本机数据整体替换云端；数据按 4MiB 分片 gzip 压缩后内容寻址上传，**一次 HTTP 请求一片**，已存在于云端的分片自动跳过。首次上传 300MB 数据约 260 个请求、传输字节降约 75%（对比旧协议 581 个请求），大幅缓解国内访问 Cloudflare 的高延迟。
- **后台预先准备**：差分、重建与 gzip 分片在写入后自动于后台完成（页面加载时预热首次扫描），点"上传"时准备已就绪，几乎立即进入网络阶段。
- **无变化上传只发 1 个请求**；小改动只重传受影响分片（通常 1～5 个请求完成一次同步）。
- **从云端恢复**：读一份根清单 → 并发下载分片（边缘缓存加速）→ 校验 → 解压应用。已恢复部分缓存在本地，中断重试不重复下载。
- **自动保存**：1～1440 分钟间隔，仅前台计时；结果（成功/失败）显示在浮窗右下角徽标。
- **安全边界**：整体替换语义，设计给单设备单人使用；恢复跨 localStorage 和多个 IndexedDB 不是原子事务，失败后本地数据保持上一状态，重新恢复即可。

### 图片托管

- 聊天里的 AI 生成图片自动保存到自己的 R2，不再受图片站外链过期影响。
- **图片管理页**：按角色分组浏览、搜索、查看原图、批量删除。
- **固定生图**：每条消息的生图参数按槽位持久化，刷新页面、切换画风后旧图仍能原样重放。
- **生图门控**：跟随作者的"自动生图"世界书开关；关闭后新消息不再生图，已有图片照常显示。
- **YNAI 中转**：生图密钥以 `YNAI-` 开头时自动走第三方中转；两个提供商共享同一内容寻址缓存，历史图片键稳定。

### 适配脚本链（对作者改版的应对方式）

作者前端变化时，**只需更新一个外部适配脚本**（可执行 JS，实现 `window.RPHubExternal` v2 契约），系统其余部分与接口契约保持不变：

```
1. 外部适配脚本   ← page/config.json 的 adapter.externalUrl（如 GitHub Raw）
2. 部署兜底脚本   ← page/adapter/rp-hub-v2.js（随部署发布，开箱即用；仓库同时保留旧版单机脚本 page/adapter/rp-hub.js，旧版部署不受影响）
3. R2 last-good   ← 最近一次验证通过脚本的副本（外部源故障时兜底）
→ 全部失败：主页只注入变更日志，同步/图片显式报错
```

## 部署

### 前置要求

- 一个 Cloudflare 账号（免费版即可）。

### 手动部署

1. 创建一个 R2 桶。
2. 创建 Pages 项目，构建输出目录设为 `page`，构建命令留空。
3. 上传 [`page/`](page/) 目录（`_worker.js`、`_routes.json`、`_headers`、`config.json`、`gallery.html`、`magic-extension.js`、`adapter/` 与 `DB/`），或推送到仓库让 Pages 自动构建。
4. 在项目设置里绑定 R2 桶为 `RP_SYNC_R2`。

### 访问密码（可选）

设置环境变量 `RP_SYNC_PASSWORD` 后，站点打开时先显示验证锁页：输一次密码即可，之后同步与图片管理共用。不设置则免密开放——**公网部署建议设置**。

### 配置（page/config.json）

- `adapter.externalUrl`：外部适配脚本 URL，留空则使用部署兜底脚本。
- `image.ynai`：YNAI 中转端点（base/modelsPath/generatePath/defaultModel）。

### 在线自检

- 首页出现"同步"和"图片管理"，设置中出现"固定生图"。
- `GET /__rphub/adapter.json` 返回适配脚本链摘要：`{"ok":true,"origin":"external|bundled|last-good","sha256":"...","bytes":123}`；全部源失败时返回 503。
- 上传少量数据，在另一个浏览器（或隐身窗口）恢复一次，数据一致。

## 技术概览

- 同步协议 v2（`rp-sync/v2/`）：全量根清单（`manifest.json` 内含完整分片列表，一次 GET）+ gzip 内容寻址分片（`packs/<sha256>.bin`，Worker 把请求正文流式直通 R2，不进 isolate 内存）。无服务端会话、无分页清单、无 Bloom filter、无 GC 状态机——提交时按新旧根对比顺带回收孤儿分片，残余由显式 `sweep` 兜底。
- 部署形态：单个 `_worker.js`（Pages Worker，无构建步骤）+ `DB/`、`magic-extension.js`、`adapter/rp-hub-v2.js`、`config.json`、`gallery.html` 一起随 `page/` 发布。
- 测试：`cd tests && npm test`（协议冒烟、客户端端到端模拟、审计回归、图片回归、适配层契约）；`npm run scale` 以 `SCALE_MB`（默认 300）运行真实客户端代码路径的规模模拟；`npm run day` 跑"用户的一天"全行为随机交错模拟（虚拟时钟把 24 小时压缩到约 2 分钟，覆盖聊天/生图/删图/角色卡增删/会话删分/上传/自动上传/双设备拉取）。

## 许可

见 [LICENSE](LICENSE)（CC BY-NC 4.0）。作者前端版权归 [STA1N156/RP-Hub](https://github.com/STA1N156/RP-Hub) 原作者。

## 致谢

- [RP-Hub](https://github.com/STA1N156/RP-Hub) —— 原项目作者

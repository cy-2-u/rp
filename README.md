# RP Hub 魔改版

一个 Cloudflare Pages Worker 项目：反向代理 [RP-Hub](https://github.com/STA1N156/RP-Hub)（作者的酒馆类角色扮演前端），在不修改作者代码的前提下加入**云同步、R2 聊天图片托管、图片管理**等功能。

- **免服务器运维**：部署到 Cloudflare Pages 免费版即可，数据存在自己的 R2 桶里。
- **数据自主**：聊天记录、角色卡、生成图片全部保存在自己的 Cloudflare 账号。
- **不改动作者代码**：作者前端原样代理；适配作者变化的手段是更新**一个外部可执行脚本**（见下）。

维护者文档（适配脚本链、同步协议、测试与发布）见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 功能

### 云同步

- **上传到云端**：本机数据整体替换云端；数据按"源"组织、gzip 压缩后内容寻址上传，一次 HTTP 请求一片，未变化分片自动跳过（凭原始内容摘要，连压缩都不重复）。300MB 数据约 129 个分片。
- **后台预先准备**：差分、分片、gzip 在写入停止 8 秒后自动于后台完成（低占空比，手机不发热），点"上传"时几乎立即进入网络阶段。
- **无变化自动保存零请求**；小改动只重传受影响分片（通常 1~2 个请求完成一次同步）。
- **从云端恢复**：两遍语义（先全量校验再应用），已下载分片缓存在本地，中断重试不重复下载；恢复期间其他标签页冻结写入并显示遮罩。
- **自动保存**：1~1440 分钟间隔，仅前台计时；结果显示在面板徽标。
- **多标签页安全**：所有同步操作经浏览器 Web Locks 串行化。
- **安全边界**：整体替换语义，设计给单设备单人使用。

### 图片托管

- 聊天里的 AI 生成图片自动保存到自己的 R2，不再受图片站外链过期影响；聊天卡片恒显原图。
- **图片管理页**（`/image`）：按角色筛选、缩略图懒加载（按需回填）、查看原图、勾选删除、一键清空整个角色。
- **固定生图**：每条消息的生图参数按槽位持久化，刷新页面、切换画风后旧图仍能原样重放。
- **生图门控**：跟随作者的"自动生图"世界书开关；关闭后新消息不再生图，已有图片照常显示。
- **YNAI 中转**：生图密钥以 `YNAI-` 开头时自动走第三方中转；两个提供商共享同一内容寻址缓存，历史图片键稳定。

### 适配脚本链（对作者改版的应对方式）

作者前端变化时，**只需更新一个外部适配脚本**（可执行 JS，实现 `window.RPHubExternal` v2 契约），系统其余部分与接口契约保持不变：

```
1. 外部适配脚本   ← page/config.json 的 adapter.externalUrl（如 GitHub Raw）
2. 部署兜底脚本   ← page/adapter/rp-hub-v2.js（随部署发布，开箱即用）
3. R2 last-good   ← 最近一次验证通过脚本的副本（外部源故障时兜底）
→ 全部失败：主页只注入变更追踪，同步/图片显式报错
```

## 部署

### 前置要求

- 一个 Cloudflare 账号（免费版即可）。

### 手动部署

1. 创建一个 R2 桶。
2. 创建 Pages 项目，构建输出目录设为 `page`，构建命令留空。
3. 上传 [`page/`](page/) 目录的全部部署文件（`_worker.js`、`_routes.json`、`_headers`、`config.json`、`gallery.html`、`core.js`、`client.js`、`sync.js`、`images.js`、`gallery.js`、`adapter/rp-hub-v2.js`——共 11 个，保持 `adapter/` 子目录结构；`adapter/rp-hub.js` 是旧版契约存档，不参与部署，可不上传），或推送到仓库让 Pages 自动构建。
4. 在项目设置里绑定 R2 桶为 `RP_SYNC_R2`。

### 访问密码（可选）

设置环境变量 `RP_SYNC_PASSWORD` 后，站点打开时先显示验证锁页：输一次密码即可，之后同步与图片管理共用。不设置则免密开放——**公网部署建议设置**。

### 配置（page/config.json）

- `adapter.externalUrl`：外部适配脚本 URL，留空则使用部署兜底脚本。
- `image.ynai`：YNAI 中转端点（base/modelsPath/generatePath/defaultModel）。

### 在线自检

- 首页导航里出现"同步"和"图片管理"，设置中出现"固定生图"。
- `GET /__rphub/adapter.json` 返回适配脚本链摘要：`{"ok":true,"origin":"external|bundled|last-good","sha256":"...","bytes":123}`；全部源失败时返回 503。
- 上传少量数据，在另一个浏览器（或隐身窗口）恢复一次，数据一致。

## 本地开发与测试

```text
npm install
npm test          # 全部回归（协议/端到端/锚点审计）
npm run scale     # 300MiB 规模模拟
RP_FIXTURE=1 npm run serve   # 本地验收服务器（作者源站=真实线上版 fixture），浏览器打开 http://127.0.0.1:18791/
npm run lint      # 死代码门禁
```

## 许可

见 [LICENSE](LICENSE)（CC BY-NC 4.0）。作者前端版权归 [STA1N156/RP-Hub](https://github.com/STA1N156/RP-Hub) 原作者。

## 致谢

- [RP-Hub](https://github.com/STA1N156/RP-Hub) —— 原项目作者

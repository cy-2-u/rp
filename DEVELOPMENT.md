# 开发者文档（DEVELOPMENT）

面向维护者：架构约束、同步协议细节、测试体系与发布流程。功能介绍和部署教程见 [README.md](README.md)。

当前同步协议为 **schema 13 / `rp-sync-paged-jsonl-v4`**。它针对 Cloudflare Workers Free 的单请求 CPU、项目自定的 50 次子请求保守预算、6 个同时出站连接和 128MiB isolate 内存限制设计：每个 HTTP 请求只上传一个内容寻址分片，Worker 将 `request.body` 直接交给 R2；清单分页验证；最终只用常数大小的根清单切换版本；垃圾回收由独立、可续跑的 `gc-step` 请求完成。

最后更新：2026-10-22。`page/` 是唯一发布正本；根目录不再保留生产文件副本，发布前以 `page/` 为准运行全部回归与 lint。

## 1. 项目结构

| 路径 | 用途 |
|---|---|
| `page/_worker.js` | 唯一的 Pages Worker：作者站代理与适配、同步 API、图片 API 和图库页面 |
| `page/magic-extension.js` | 图片任务、固定记录和图片业务，通过外部适配接口取得作者上下文 |
| `page/DB/bootstrap.js` | 同步快照缓存、严格增量、分片上传、隔离恢复执行、同步面板与面板样式（启动时自注入 `<style>`） |
| `page/DB/dirty-tracker.js` | IndexedDB/localStorage 事务级变更日志与恢复期间写暂停 |
| `page/adapter/rp-hub.js` | 唯一的可执行外部适配脚本：作者页面插入、Vue/存储桥接、元数据和功能接口；随 `page/` 一起发布 |
| `page/_routes.json` | Pages 路由：`/DB/*` 与 `/magic-extension.js` 绕过静态资源、交给 Worker |
| `page/_headers` | 上述运行时文件的 `no-cache` 响应头 |
| `deployer/` | 一键部署器：`worker.js` 是部署页的后端源码（部署 + 项目列表 + 魔改版校验 + 在线更新），`make-page-zip.mjs` 重建 `page.zip`，其余为部署流程与 BLAKE3 测试 |
| `docs/` | 一键部署页（GitHub Pages 托管的前端）与部署教程截图 |
| `.sync-tests/` | 离线协议、运行时、恢复、性能和回归测试 |
| `MODIFICATIONS_TO_KEEP.txt` | 修改代码时必须保留的架构不变量 |
| `DEVELOPMENT.md` | 本文件：面向维护者的架构与流程文档 |
| `page/` | 唯一发布目录，包含 Worker、前端脚本、适配脚本与 Pages 路由/头文件 |
| `page.zip` | `page/` 的发布归档（本地构建产物，`.gitignore` 排除、不入仓库；用 `node deployer/make-page-zip.mjs` 重新生成） |

`page/` 必须保持以下结构：

```text
page/
├── _worker.js
├── _routes.json
├── _headers
├── magic-extension.js
├── adapter/
│   └── rp-hub.js
└── DB/
    ├── bootstrap.js
    └── dirty-tracker.js
```

`page/` 是唯一正本。适配脚本由 Worker 通过 Pages `ASSETS` 读取 `/adapter/rp-hub.js`，并随部署资产一起上传；同步客户端、适配脚本和 Worker 都在同一发布目录内，不再依赖 GitHub Raw 的在线脚本。上次成功加载的适配脚本仍会写入 R2 `rp-adapter/last-good-script-v1.js`，仅在 ASSETS 读取失败时兜底。

部署有两条等价路线：**一键部署**（打开 `docs/` 的部署页，填 Cloudflare API 令牌后由 `deployer/worker.js` 后端自动建桶、上传 `page/` 资产并创建 Pages 项目）与**手动部署**（见下节）。

## 2. 部署与发布（维护者）

部署使用路线见 README 第 2 节。本节记录维护者的配置约束与发布流程。

### 2.1 Cloudflare Pages 配置

必须配置：

- R2 bucket binding：`RP_SYNC_R2`

可选配置：

- 环境变量 `RP_SYNC_PASSWORD`：同步和图库共用密码；不设置则免密。
  设置后站点打开时先显示**访问验证锁页**：已保存的密码静默自动验证通过后直接进入站点；无保存或密码已失效时输入一次，之后同步与图片管理均复用该密码，正常使用中不再弹出密码框。云端不可达时锁页直接放行（数据防护由 Worker 端 401 承担），不会因网络故障锁死站点。

适配脚本随部署资产发布，Worker 通过 `env.ASSETS.fetch('/adapter/rp-hub.js')` 读取；不再使用 GitHub Raw 作为生产来源。`RPHUB_ADAPTER_URL` 仅用于本地测试时以 `file://` 覆盖。ASSETS 读取失败时回退 R2 中最近一次验证通过的 last-good 脚本，两者都不可用时同步与图片增强显式失败。

### 2.2 发布步骤

发布前直接修改 `page/` 下的文件；根目录不再保留需要同步的生产副本。

1. 在 `.sync-tests` 安装依赖并运行 `npm test`（`unit-regressions` + `runtime-regressions` + 外部作者集成）。
2. 运行 `npm run scale-sim` 完成默认 300MB 规模测试；根目录 `npm run lint` 过死代码门禁（首次先 `npm install`）。
3. 运行 `node deployer/make-page-zip.mjs` 重新生成 `page.zip`；工具以归档根级 + 正斜杠条目打包并回读校验。禁止用 PowerShell `Compress-Archive` 打包：它写出 `page\_worker.js` 这类反斜杠带前缀条目，Pages 导入后既没有根级 `_worker.js` 也没有 `DB/` 子目录，站点整体打不开。
4. 发布 `page/`，或让 Pages Git 集成把构建输出目录设置为 `page`；构建命令留空。`_routes.json` 与 `_headers` 必须一起发布。
5. 部署后执行第 7 节自检并观察 Cloudflare CPU 指标。

schema 13 第一次上传只进行**非破坏式初始化**：写入 `rp-sync/main/migration-v13.done`，记住原根清单 etag，随后以 CAS 提交新的 schema 13 根清单。初始化不会批量删除旧同步对象，也不会触碰 `rp-images/`。

## 3. 使用行为

- **上传到云端**：点击即用本机数据整体替换云端（最后点击的设备生效；本机为空则清空云端）。首次上传完整扫描本地数据并建立缓存；后续上传只读取事务日志中的候选键，未变化的包按哈希跳过。若索引缺失、过期或追踪 epoch 改变，会确认后自动完整重建。
- **自动保存**：同步浮窗中的开关和分钟间隔只保存在本地浏览器，默认关闭、默认 5 分钟，允许 1～1440 分钟。启用后每次打开或刷新页面重新计时，只累计前台可见时间；页面隐藏、离开或冻结时暂停，恢复可见后继续。到期仍执行完整上传检查，即使数据没有变化也显示“数据相同，已是最新”；自动上传不弹窗，不与手动上传、恢复或索引重建并发，失败后等待下一完整周期重试。
- **上次同步徽标**：自动保存区右下角（与“自动保存已关闭”同一行、对称排列），显示最近一次上传/恢复的结果，格式固定为 `16:30 同步成功` 或 `16:40 同步失败`（成功绿色、失败红色，无额外文案）。记录只存本机 localStorage，不参与同步；自动保存与手动上传同样计入。
- **在线更新**：部署页“部署”按钮下方新增“更新”按钮：用同一令牌拉取账号下全部 Pages 项目列表并标注魔改版身份（生产配置同时含 `RP_SYNC_PASSWORD` 变量与 `RP_SYNC_R2` R2 绑定才算魔改版）；点击魔改版项目时服务端实时复查配置，通过浏览器确认后把该项目刷新为 GitHub 仓库 `page/` 的最新版（不改密码、不动 R2 数据）；非魔改版项目在列表和点击时都会被拒绝。服务端在 `/api/update` 里二次校验，防止绕过前端直接刷新非魔改版项目。
- **从云端恢复**：确认覆盖后用云端数据整体替换本机，只显示一个连续进度条；云端没有数据时提示无可恢复内容。内部会卸载作者应用并进入隔离恢复上下文，但立即把地址栏还原为 `/`，用户不需要进入或理解专用页面。清单页与数据包最多 6 请求并发；全部数据先完整校验并写 staging，通过后设置恢复标记并等待 IndexedDB write barrier，再覆盖本地数据。恢复失败时保留已校验的 pack 缓存，只清空条目/状态，重试无需重新下载。其他同源标签页只在实际覆盖阶段暂停写入。
- **图片管理**：按角色分组、搜索、查看和批量删除。打开时整库一次性加载全部角色分组；每张角色卡默认只渲染 8 张缩略图（窄屏 6 张），卡内“显示更多”按钮纯前端追加，不发新请求。列表优先加载 480px WebP 缩略图，原图只在点开大图时读取；缩略图缺失时显示占位并后台补建。清空角色按服务端当前目录的 20 张游标分页处理。每请求最多处理 20 个目标，先写墓碑，再后台删除原图和缩略图；失败 tombstone 会保留在响应中供重试。
- **固定生图**：按 `storyScopeId`、消息和槽位持久化参数快照。刷新或换画风后旧图片仍能读取固定记录；“固定生图”开关只决定新结果是否写入固定记录，不改变 URL 规范化、YNAI/sta1n 路由或已有记录读取。
- **生图门控**：跟随作者世界书的“自动生图”开关，开关状态由适配层在每次图片任务时实时传入，不依赖本地存储。关闭时不再为新消息生图：没有已存图片的消息槽位不发起任何生成请求、不落任何记录，卡片以 `.magic-image-suppressed` 整体隐藏，不渲染占位；已有图片的消息照常显示旧图，reroll 也只保留旧图不重新生成。重新打开开关后，此前被隐藏的消息按作者原生行为重新生成。适配层未提供状态时按作者原生行为放行。
- **YNAI 中转生图**：生图密钥以 `YNAI-` 开头时自动路由到第三方中转（OpenAI images 形状，b64_json 应答）；设置页“生图版本”下拉被劫持为中转模型列表（经 Worker 从中转站拉取，仅接受 YNAI- 密钥），默认取适配脚本头部元数据 `image.ynai.defaultModel`，选择后覆盖作者页面的模型参数。中转地址/路径/默认模型**只**云端化在适配脚本头部元数据 `image.ynai` 段（修改脚本头部元数据，经 Worker 缓存刷新后生效；无代码兜底，配置缺失时 ynai 生图显式报错）。**缓存不区分来源**：路由只看密钥前缀，签名固定以 `sta1n` 计入，ynai 与 sta1n 相同参数共享同一 R2 对象，历史图键稳定。生成走 POST；GET 只读缓存（无缓存时 404）。YNAI JSON 响应和 base64 图片受有界读取与 16MiB 解码上限保护。固定记录重放使用生成时的模型。sta1n 密钥行为完全不变。
- **适配失败**：外部脚本拉取/元数据校验失败且没有有效的 last-good 脚本时，主页仅注入 dirty-tracker；作者 app.js 始终保持原文。源恢复后需刷新页面加载增强。作者保存能力未就绪或写入失败时，同步明确报错。

不参与同步的数据包括：

- `rp_hub_presets`
- `rp_hub_sync_password_v1`
- `rp_hub_sync_auto_save_enabled_v1`、`rp_hub_sync_auto_save_minutes_v1`
- `rp_hub_sync_last_result_v1`（同步浮窗"上次同步"徽标的本地记录）
- `RPHubSyncCache`、`RPHubSyncStaging`
- `__rp_sync_journal_v2`
- `rp_sync_intent_v2:*`、追踪 epoch、恢复标记与重建请求等同步簿记键

## 4. schema 13 同步设计

### 4.1 R2 对象布局

```text
rp-sync/main/manifest.json                         常数大小根清单
rp-sync/main/manifests/<root-checksum>/<page>.json  不可变清单页，每页最多 32 包
rp-sync/main/packs/<sha256>.bin                    内容寻址数据包，最多 1MiB
rp-sync/main/blooms/<sha256>.bin                   32KiB 引用 Bloom filter
rp-sync/main/uploads/<root-checksum>.json          可续传上传会话
rp-sync/main/maintenance/gc-v1.json                GC 四阶段游标与扫描状态（rp-sync-gc-state-v2）
rp-sync/main/migration-v13.done                    非破坏式初始化标记
```

根清单格式为 `rp-sync-manifest-root-v1`，只保存总字节数、包数、记录数、页数、最终页链 hash 和 Bloom checksum，因此提交开销不随数据量增长。

清单页格式为 `rp-sync-manifest-page-v1`。页 hash 同时绑定页号、前一页 hash 和所有包元数据；最后一页 hash 必须等于根清单的 `pageRoot`。

### 4.2 首次与严格增量

数据使用确定性 canonical JSON 编码。缓存使用 256 个稳定桶，大数组每 32 项分页；每个包最多 1MiB、512 条记录。硬上限：

- 快照总量 1GiB
- 8192 个包
- 单包 1MiB
- 单包 512 条
- 单个图片对象 24MiB、缩略图 2MiB

业务 IndexedDB 写入和 `__rp_sync_journal_v2` 变更记录在同一事务中提交或回滚。localStorage 在写入前创建独立意图键。上传成功后只确认本次水位；上传期间发生的新写入保留到下一轮。

首次上传允许全库扫描。正常增量上传：

- 只读日志候选键，不遍历业务 store；
- 同值 put、对象键顺序变化、改后改回、clear 后原样回填和仅数据库版本变化不产生新包；
- 候选键在单个数据库连接中每 64 键一批读取；
- 缓存 entry 修改前先持久化 `pendingBuckets`，保证崩溃后受影响桶一定会重建。

### 4.3 上传流程

1. `prepare-upload`：读取当前根状态并做 schema 门控。
2. `initialize-storage`：只在缺少 v13 标记时执行非破坏式初始化。
3. `begin-upload`：创建或恢复 `rp-sync-upload-session-v1` 会话；会话按快照 checksum 复用，不因当前云端根版本变化而拒绝个人存档。
4. `upload-bloom`：上传 32KiB Bloom；R2 按 SHA-256 校验。
5. `upload-manifest-page`：每页最多 32 包；Worker 验证页链、总量和 Bloom 包含关系，先持久化不可变页声明，再以最多 6 个并行 `head` 核对包大小和记录数；upload-pack 已在本 isolate 验证过的包按 checksum 记入验证缓存，页提交复核跳过这些包。有缺包时不推进会话。
6. 缺包时，客户端对每个缺包调用一次 `upload-pack`。每个请求只携带一个包，客户端在途并发为 6（重叠网络往返）；Worker 核对 checksum、length、entryCount 与当前或刚完成上一页的声明一致，已存在同元数据返回 204、不同元数据返回 409，不覆盖旧对象。新对象直接执行 `bucket.put(key, request.body, { sha256, onlyIf: { etagDoesNotMatch: '*' } })`：先写，写成功即返回；只有条件写返回空值时才 `head` 复核同元数据对象。Worker 不在 JavaScript 中复制或扫描正文，也不为每个新包多付一次 head。清单页不可变且按内容寻址，Worker 在 isolate 内按 (根校验码, 页码) 缓存页对象，逐包上传不再每包重读同一页。
7. 客户端重交当前清单页；页声明保持不可变，全包验证成功后会话以 etag CAS 推进；同一页的并发重试读回已推进会话并幂等成功。
8. `finalize-upload`：重新读取并校验 Bloom，并复核客户端上报的本次复用包（`reusedPacks`）：当前根 Bloom 已覆盖的包跳过，其余旧包逐个 `head` 验证存在；缺失时删除会话并返回 409，让下一次同步重新上传。随后使用当前根的 ETag 条件写入；若根在检查期间变化，Worker 重新读取当前根并继续提交，不向个人用户返回维护锁或普通版本冲突。只有数据校验失败、权限失败或写入结果无法确认时才返回错误。
9. 客户端在后台分批连续调用 `gc-step`（每批约 3 秒、最多 8 步，未完成时约 250ms 后继续），完成四阶段完整扫描。GC 失败不撤销已成功的提交。

同一个 snapshot checksum 可断点续传；丢失提交响应后重试会先核对当前根，确认已提交则直接返回，不重复写包。个人产品不做跨设备合并：每个完整上传快照都是整体替换目标，最后成功完成根切换的快照成为云端存档。根 ETag CAS 只用于防止不完整或未知写入覆盖当前根，CAS 竞争由 Worker 自动重读并重试，不要求用户重新点击上传。

### 4.4 下载与恢复

1. `pull-manifest` 取得常数大小根信息。
2. `pull-manifest-page` 以最多 6 页并发拉取，返回后仍按页号顺序验证完整 hash 链。
3. `pull-pack` 必须同时带根版本、页号、页内索引、checksum、长度和记录数；Worker 从已提交清单页核对这些字段后才返回对象。数据包按 checksum 走 Cache API（`ctx.waitUntil` 写入，immutable），命中时不重复读 R2。
4. 浏览器最多 6 包并发下载。下载批次直接在内存中校验长度、SHA-256、JSONL 记录数、对象顺序及 bucket/group 归属，再把同一份字节写入 staging；预校验失败时不触碰本地业务数据。恢复失败时保留已校验 pack 的本地缓存，只清空 entries/state 并重试。命中本地缓存的包只验证长度：这份字节在写入本地缓存前已按 checksum 完整验证过，恢复时不再重哈希；长度不符时回退到服务器下载。
5. 所有包预校验成功后才标记恢复活动；其他标签页收到标记后暂停写入并显示遮罩，恢复标签页先用写屏障等在途写事务收尾。每 6 包用一个只读事务从 staging 取回；普通记录写入同时受 64 条和约 8MiB 估算字节上限约束，每条记录只再解析一次；缓存中的 canonical 字节复制到独立、精确长度的 Uint8Array，避免 structured clone 携带整个 pack 的 backing buffer；同一遍同时恢复 localStorage/IndexedDB、重建条目索引并把原始包批量写入本地缓存。
6. 缓存只识别当前 256 桶布局；假想中的旧 32 桶/128 项快照会在放置校验处报错，而不是被静默转换。下一次上传沿用“确认后完整重建索引”的简单流程生成当前布局，不做自动迁移引擎。
7. 成功顺序是业务数据与本地缓存、水位确认、清除恢复标记、立即刷新应用。正常界面只显示“正在恢复”进度，不显示下载、校验、应用和索引等内部阶段。

staging 不能省略：300MB 数据不适合常驻内存；没有 staging 就只能在正式覆盖前后各下载一次。恢复仍不是跨 localStorage 和多个 IndexedDB 的原子事务；进入覆盖阶段后若异常中断，写暂停标记会保留，用户在同步入口重新恢复即可。

### 4.5 垃圾回收

GC 由持久化的四阶段扫描状态驱动（`rp-sync-gc-state-v2`）：按 `packs` → `manifest-pages` → `blooms` → `uploads` 顺序各自维护独立游标，根 checksum 变化时整体重置、从新根重新完整扫描（旧 `gc-v1` 状态只保留其 pack 游标，其余阶段从头开始）。Bloom filter 只用于安全保留：假阳性会多留垃圾，不会删除仍被引用的数据。每个 `gc-step`：

- 重读已提交根、Bloom 和 GC 状态；从当前阶段的持久游标继续列举对象。`packs` 阶段每步最多 64 个包（压缩“扫描后会话新建/复用包”的竞态窗口），`manifest-pages`/`blooms` 每步最多 256 个，`uploads` 阶段每步最多 16 个会话；
- `packs` 阶段同时检查未完成上传会话的 Bloom，把仍可能被 finalize 使用的分片加入保护集合。删除候选前做两轮当前根/活动会话复核：任一轮无法完整枚举或校验活动会话时返回 `blocked` 并保持游标不动，根在扫描期间变化时返回 `needsRescan` 并保持游标不动；
- 第二轮确认之后才逐个 `head` 复核 uploaded 时间（6 路并发），只有仍超过 24 小时宽限期的对象才进入删除；删除失败的候选不推进游标，下一轮按同样依据重判。正常一轮删除约 8–12 个对象，最坏约 40 个；
- `manifest-pages` / `blooms` 阶段清理不属于当前根、也不属于任何仍可恢复上传会话的旧控制对象；对象按内容寻址归属判断，且需超过 24 小时控制对象宽限期；
- `uploads` 阶段按「会话内 createdAt/updatedAt 与 R2 对象时间的最大值」判断过期，超过 7 天 TTL 的上传会话在删除前逐个重读复核；新鲜会话连同其 page/Bloom/pack 全部保留；损坏会话只有超过 TTL 才回收；
- 删除用幂等批量 `delete`，删除响应丢失时下一轮按同样依据重判；游标用 ETag CAS 持久化，与另一个 GC 并发时静默放弃本次推进，不向用户报冲突。GC 与 begin/finalize 可以并发运行，不使用会让用户看到“服务器正在完成另一项同步维护”的全局锁。

R2 写入或删除响应未知时，下一次请求通过根、会话和对象存在性复核结果；不能证明安全时保守地跳过删除或返回未知结果，不以永久维护锁阻塞后续个人存档。

一次成功上传后，客户端在后台分批连续调用 `gc-step`（每批约 3 秒、最多 8 步，未完成时约 250ms 后继续下一批），直到四个阶段全部 `done`；GC 不进入 finalize、不使用 Web Locks、不阻塞手动上传、自动保存或恢复，失败只结束当前批次，下一次成功上传或维护机会继续。

## 5. 测试

### 5.1 安装与默认回归

```text
cd .sync-tests
npm ci
npm test
```

死代码门禁（根目录，ESLint flat config：no-unused-vars / no-undef / no-redeclare / no-unreachable / no-dupe-keys）：

```text
npm install
npm run lint
```

`npm test` 依次运行：

- `unit-regressions`：`audit-regressions`（崩溃安全、恢复字节批次、自动保存 scheduler、跨文件协议常量、Worker/bootstrap 字段序）、`cache-entry-buffer-regression`（独立 backing buffer、无字节别名、两遍解析和 64MiB 边界）、`worker-regressions`（适配脚本 ASSETS/last-good/有界读取、YNAI 端点与大小限制、图片 ETag/墓碑/24MiB 有界读取上限、R2 拒绝流式写入的回归、同步 API）和 `image-task-regressions`（生图门控、固定记录、缩略图失败回退、重掷与角色清理）。
- `runtime-regressions`：按顺序运行 `runtime-smoke`（作者脚本原样代理、注入顺序、图库与图片 API）、`sync-v13-smoke`（上传会话、不可变清单页、CAS 竞争、缺包重试、Bloom 损坏、分页 GC、密码门控）、`sync-v13-budget`（小堆隔离环境下的请求预算；p95 ≤10ms、max ≤20ms、R2 并发 ≤6；GC 因逐候选 head 复核单独放宽到 ≤80 子请求）和 `restore-sim`（fake-indexeddb 上传/恢复、缓存命中与损坏回源、严格增量、水位、冲突、访问门禁、每条记录恰好解析两遍、每个 staging pack 只读一次）。
- `external-author-integration`：jsdom + 真 Vue + 未改写作者 app.js，覆盖 fixture SHA-256 校验、启动偏好、保存防抖与聊天/重掷落盘、图片接管与懒加载、实时开关、模型下拉重挂载、角色图片清理、事务失败与能力缺失诊断。使用最小 root template，不等同完整页面浏览器视觉验收。

`scale-sim` 仍单独运行，不并入默认回归；部署器流程测试由根目录 `npm run test:deployer-flow` / `test:deployer-blake3` 单独执行，不与 `.sync-tests` 合并。

作者源码按以下顺序查找：

1. `RPHUB_UPSTREAM_DIR`
2. `runtime-smoke` 可读取当前仓库同级 `RP-Hub-main`
3. 固定离线样本 `.sync-tests/fixtures/author`，来源与 SHA-256 见该目录说明；集成测试默认直接使用它，不依赖本机其他目录。

### 5.2 300MB 规模模拟

```text
npm run scale-sim
```

可用 `SCALE_MB=5`（Windows cmd：`set SCALE_MB=5&& npm run scale-sim`）进行快速预检。

默认 300MB 数据量下的模拟结果（2026-10-13）：

| 阶段 | 结果 |
|---|---|
| 首次上传 | 0.293GiB、530 包、448 字节根、581 请求、客户端并发 6 |
| 无变化上传 | 0 包、1 次 prepare-upload 探测 |
| 100 条等长修改 | 90 个新包、79.7MiB、136 请求、业务 store 全扫游标 0 |
| 20 加长 + 10 删除 + 10 新增 | 52 个新包、27.6MiB、101 请求 |
| 最终无变化上传 | 0 包、1 次 prepare-upload 探测 |
| 最终快照恢复 | 0.293GiB、530 包、38,820 条；547 个拉取请求、最大并发 6、89 个 staging 读取事务 |
| 恢复遍历约束 | 每条记录解析 2 次、每个 staging pack 读取 1 次、pack 事务每批最多 6 个 |
| 全程上限 | 子请求 34/50、客户端并发 6/6、单个 R2 put 1MiB |

规模模拟的墙钟只作宿主诊断，因为同一 Node 进程还持有约 300MB fake IndexedDB 和 R2 数据，V8 GC 停顿不等于 Cloudflare Worker CPU。完整模拟于 2026-10-22 通过，统计 1,457 个模拟请求、R2 Class A/B 分别 976/1,656（Class B 随宿主 gc-step 批次数小幅波动）；预算值不替代 Cloudflare 官方 CPU 测量。

独立预算套件结果（2026-10-22；本地墙钟代理）：

| 最大请求形状 | p95 | 最大值 | 子请求峰值 | 单请求 R2 并发峰值 |
|---|---:|---:|---:|---:|
| 1MiB upload-pack | 0.17ms | 0.89ms | 1 | 1 |
| 32 包 upload-manifest-page | 0.73ms | 2.73ms | 34 | 6 |
| finalize-upload | 0.45ms | 0.81ms | 5 | 1 |
| pull-manifest-page | 0.11ms | 0.11ms | 0 | 0 |
| pull-pack | 0.09ms | 0.10ms | 1 | 1 |
| 256 项 gc-step | 1.40ms | 1.57ms | 74 | 6 |
| 8 路并发 upload-pack | 2.55ms | 2.65ms | 3 | 1 |
| 4 推 + 4 拉混合 | 1.19ms | 1.22ms | 3 | 1 |

这些是本地高分辨率墙钟代理，不是 Cloudflare 官方 CPU 计量。上线后仍须以 Cloudflare Metrics 为准。

## 6. 适配与注入

外部配置本身是可执行的 `page/adapter/rp-hub.js`。作者相关的 DOM 选择器、样式、导航/同步入口、固定生图、YNAI 下拉、滚动按钮、Vue 保存与图片上下文桥接都集中在这里。`magic-extension.js` 保留图片业务，`DB/bootstrap.js` 通过版本化 `window.RPHubExternal.flush()` 请求保存。

Worker 优先通过 `env.ASSETS.fetch('/adapter/rp-hub.js')` 读取随部署发布的脚本，读取头部 `RPHUB_ADAPTER_CONFIG` 元数据并检查可执行桥接契约。ASSETS 缺失或读取失败时回退 R2 `rp-adapter/last-good-script-v1.js` 并再次检查契约。有效候选缓存 30 秒，失败缓存 5 秒。last-good 并不证明任意 JavaScript 的语法与浏览器运行正确，发布前仍需回归。

主页按以下顺序注入：

1. `/DB/dirty-tracker.js`
2. 当前页面固定的 `window.RPHUB_PAGE_ADAPTER` 元数据
3. 外部适配脚本正文（随 HTML 内联执行，不是第二次浏览器 src 请求）
4. `/magic-extension.js`
5. `/DB/bootstrap.js`

作者 HTML 中的动态加载器、全部作者 JavaScript（含 update-check）与更新检查 meta 均保留。主页加载失败时只注入 dirty-tracker；其他作者 HTML 也只注入它。后续 app.js 请求不重新判断适配、不改写源码。作者上游请求使用 `no-cache` 并透传 `If-None-Match` / `If-Modified-Since`，上游 304 原样返回；无 ETag/Last-Modified 的 200 图片/文本响应进入 Cache API 约 45 秒作为缓存缺失后的兜底。上游响应头 8 秒超时，正文空闲 30 秒超时。本项目 `/DB/*`、`/magic-extension.js` 与内联适配脚本都通过 `_headers`/Worker 使用 `no-cache`。

当前接入依赖 Vue 3 setup 返回状态、作者存储/组件导出和四种保存 watcher 的函数文本标记。保存会主动执行捕获的防抖回调、等待存储 Promise 与事务结束，不靠固定延迟猜测完成。作者变更内部接口或选择器时仍要适配；无法确认保存时显式拒绝同步。图片通过卡片观察入口接管，没有全局 fetch/XHR 拦截；缺少上下文时保留作者原生路径。

更新适配后，新导航取得新版本，现有页面保持原版本；没有客户端 6 秒动态补装。接口与能力说明见 [page/adapter/README.md](page/adapter/README.md)。YNAI 模型缓存与 select 元素分开记录，设置视图重挂载会重绘已有列表。

## 7. 部署后自检与排障

### 7.1 两分钟自检

1. 首页出现“同步”和“图片管理”，设置中出现“固定生图”。
2. `/__rphub/adapter.json` 返回当前适配摘要；外部脚本加载或元数据校验失败时先回退 last-good，只有源与 last-good 都不可用才返回 503；200 不能单独证明浏览器桥接已就绪。
3. 作者 app.js 保持原文；浏览器中 `RPHubExternal.version === 1`，就绪后 `capabilities().flush === true` 且 `capabilities().missing` 为空。若不为空，数组会列出缺失的保存入口/上下文/图片选择器，便于定位作者界面变更。
4. 上传少量数据，在另一浏览器或隐身窗口恢复一次。
5. 查看 Workers CPU time、错误率及 R2 Class A/B 操作数。

### 7.2 常见错误

| 现象 | 含义与处理 |
|---|---|
| 401 | 密码缺失或错误，在同步面板重新输入 |
| 409“服务器版本已变化，请重试” | 拉取清单页或数据包时云端根版本已变化；重新点击上传/恢复即可。上传/恢复的数据校验失败会返回各自的具体 409 文案（如“上传根清单校验失败”“下载数据包与已验证清单不一致”），此时停止操作并检查本地索引。 |
| 409 + `resetRequired` | v13 尚未初始化；在主页面执行一次上传，只写初始化标记，不批量删除旧对象 |
| “本地同步索引缺失/过期” | 确认后自动完整重建；只读本地，云端以上传开始时的状态为基准整体替换 |
| 503 | R2 或上游暂时失败；客户端按规则重试，持续失败时检查 Cloudflare 状态与日志 |
| 魔改按钮全部消失 | 外部脚本加载失败或作者页面接口变化；先检查适配端点和浏览器错误，再运行离线回归 |
| 恢复中断 | 再次点击“从云端恢复”；若已进入覆盖阶段，其他页面会继续暂停写入，直到完整重试成功 |

## 8. 已知边界

- 本地性能套件不能替代 Cloudflare 官方 CPU 指标；部署后继续观察真实 p95 和 1102 错误。
- GC 活动会话保护每次最多列举 16 个上传会话；超过 16 个并发会话时该轮保守跳过删除（个人使用远达不到该规模）。
- 图片删除墓碑不会自动回收；删除墓碑可能让旧请求重新生成已删除图片，因此不能当垃圾直接清理。
- 主 `/api/rp-image` 读取先查墓碑再查原图：删除后的生图读取立即返回占位图，即使原图的后台物理删除失败也不会泄漏旧图；图库管理端点的墓碑优先策略仍未统一，不能据此扩大权限或读取保护范围。残留原图在下次打开图库时被后台清理。
- localStorage 意图键在成功上传确认前必须保留；长期修改但不上传可能消耗浏览器配额。
- 恢复跨多种存储，不是原子提交；写暂停信号与写屏障只能缩小中断窗口。
- Web Locks 不再参与同步请求排队；同一页面仍用 `operationPending/syncing` 防止重复点击。恢复覆盖阶段继续使用 `RESTORE_ACTIVE_KEY` storage 信号和 IndexedDB write barrier，避免业务写入与恢复写入交错。
- 图片记录按角色使用短事务 Web Lock，只保护同一角色记录的读改写合并，避免两次保存互相覆盖；它不是服务器同步维护锁。
- 外部适配脚本不是作者公开稳定 API，实际新版页面仍须验收。

## 9. 维护约定

- Worker 保持单文件、无构建步骤，不引入 `import` 或顶层 `await`。
- 免费版限制优先于可读性和抽象美观；禁止把全量 pack、完整大清单或多个 1MiB 包装进单次 Worker JavaScript 内存。
- 改同步协议必须同时改 `page/_worker.js`、`page/DB/bootstrap.js`、协议测试、恢复模拟、本文件与 `MODIFICATIONS_TO_KEEP.txt`。
- `page/` 是唯一发布正本；不要重新建立根目录副本。正式发布时才重建 `page.zip`，未打包时明确标记归档仍是旧版。
- 不删除墓碑、未确认意图键或线上 R2 数据作为“清理工作区”。
- 未经明确要求不要推送 GitHub。

许可证：CC BY-NC 4.0，见 `LICENSE`。

# RP Hub 魔改版

这是一个 Cloudflare Pages Worker 项目：反代作者的 RP-Hub 前端，在不修改作者仓库的前提下加入云同步、R2 聊天图片托管、图片管理和少量 UI。

当前同步协议为 **schema 13 / `rp-sync-paged-jsonl-v4`**。它针对 Cloudflare Workers Free 的单请求 CPU、项目自定的 50 次子请求保守预算、6 个同时出站连接和 128MiB isolate 内存限制设计：每个 HTTP 请求只上传一个内容寻址分片，Worker 将 `request.body` 直接交给 R2；清单分页验证；最终只用常数大小的根清单切换版本；垃圾回收由独立、可续跑的 `gc-step` 请求完成。

最后更新：2026-10-10。本轮根目录生产文件、`page/` 部署副本与本地 `page.zip` 已更新并通过逐字节/归档校验；未执行 GitHub、Cloudflare 或真实 R2 上传部署。

## 1. 项目结构

| 路径 | 用途 |
|---|---|
| `_worker.js` | 唯一的 Pages Worker：作者站代理与适配、同步 API、图片 API 和图库页面 |
| `magic-extension.js` | 图片任务、固定记录和图片业务，通过外部适配接口取得作者上下文 |
| `DB/bootstrap.js` | 同步快照缓存、严格增量、分片上传、隔离恢复执行、同步面板与面板样式（启动时自注入 `<style>`） |
| `DB/dirty-tracker.js` | IndexedDB/localStorage 事务级变更日志与恢复期间写暂停 |
| `adapter/rp-hub.js` | 唯一的可执行外部适配脚本：作者页面插入、Vue/存储桥接、元数据和功能接口 |
| `deployer/` | 一键部署器：`worker.js` 是部署页的后端源码（部署 + 项目列表 + 魔改版校验 + 在线更新），`make-page-zip.mjs` 重建 `page.zip`，其余为部署流程与 BLAKE3 测试 |
| `docs/` | 一键部署页（GitHub Pages 托管的前端）与部署教程截图 |
| `.sync-tests/` | 离线协议、运行时、恢复、性能和回归测试 |
| `MODIFICATIONS_TO_KEEP.txt` | 修改代码时必须保留的架构不变量 |
| `page/` | 可直接部署的四个文件 |
| `page.zip` | `page/` 的发布归档（本地构建产物，`.gitignore` 排除、不入仓库；用 `node deployer/make-page-zip.mjs` 重新生成） |

`page/` 必须保持以下结构：

```text
page/
├── _worker.js
├── magic-extension.js
└── DB/
    ├── bootstrap.js
    └── dirty-tracker.js
```

根目录文件是维护正本，`page/` 是部署副本。外部适配脚本从固定 Raw URL 在线读取，不放进部署目录或 `page.zip`。

部署有两条等价路线：**一键部署**（打开 `docs/` 的部署页，填 Cloudflare API 令牌后由 `deployer/worker.js` 后端自动建桶、上传 `page/` 资产并创建 Pages 项目）与**手动部署**（第 2.1/2.2 节）。

## 2. 部署

### 2.1 Cloudflare Pages 配置

必须配置：

- R2 bucket binding：`RP_SYNC_R2`

可选配置：

- 环境变量 `RP_SYNC_PASSWORD`：同步和图库共用密码；不设置则免密。
  设置后站点打开时先显示**访问验证锁页**：已保存的密码静默自动验证通过后直接进入站点；无保存或密码已失效时输入一次，之后同步与图片管理均复用该密码，正常使用中不再弹出密码框。云端不可达时锁页直接放行（数据防护由 Worker 端 401 承担），不会因网络故障锁死站点。

外部适配脚本地址已在 `_worker.js` 的 `DEFAULT_ADAPTER_URL` 中固定为：

```text
https://raw.githubusercontent.com/cy-2-u/rp/main/adapter/rp-hub.js
```

`RPHUB_ADAPTER_URL` 仅用于本地测试时以 `file://` 覆盖，不用于生产地址切换。

### 2.2 发布步骤

以下是发布时的步骤。本轮完成全部本地检查并生成 `page.zip`，并已将唯一外部适配脚本 `adapter/rp-hub.js` 发布到固定 Raw URL；未向 Cloudflare、Pages 或真实 R2 上传部署。发布 Worker/page 前先确认该 Raw URL 可读取。

1. 在 `.sync-tests` 安装依赖并运行 `npm test`。
2. 运行 `npm run scale-sim` 完成默认 300MB 规模测试；根目录 `npm run lint` 过死代码门禁（首次先 `npm install`）。
3. 把四个根目录正本同步到 `page/`，逐字节核对。
4. 运行 `node deployer/make-page-zip.mjs` 重新生成 `page.zip`；工具会先核对 `page/` 与根目录正本逐字节一致，再以归档根级 + 正斜杠条目打包并回读校验。禁止用 PowerShell `Compress-Archive` 打包：它写出 `page\_worker.js` 这类反斜杠带前缀条目，Pages 导入后既没有根级 `_worker.js` 也没有 `DB/` 子目录，站点整体打不开。
5. 发布 `page/`，或让 Pages Git 集成把构建输出目录设置为 `page`；构建命令留空。
6. 部署后执行第 7 节自检并观察 Cloudflare CPU 指标。

schema 13 第一次上传只进行**非破坏式初始化**：写入 `rp-sync/main/migration-v13.done`，记住原根清单 etag，随后以 CAS 提交新的 schema 13 根清单。初始化不会批量删除旧同步对象，也不会触碰 `rp-images/`。

## 3. 使用行为

- **上传到云端**：点击即用本机数据整体替换云端（最后点击的设备生效；本机为空则清空云端）。首次上传完整扫描本地数据并建立缓存；后续上传只读取事务日志中的候选键，未变化的包按哈希跳过。若索引缺失、过期或追踪 epoch 改变，会确认后自动完整重建。
- **自动保存**：同步浮窗中的开关和分钟间隔只保存在本地浏览器，默认关闭、默认 5 分钟，允许 1～1440 分钟。启用后每次打开或刷新页面重新计时，只累计前台可见时间；页面隐藏、离开或冻结时暂停，恢复可见后继续。到期仍执行完整上传检查，即使数据没有变化也显示“数据相同，已是最新”；自动上传不弹窗，不与手动上传、恢复或索引重建并发，失败后等待下一完整周期重试。
- **上次同步徽标**：自动保存区右下角（与“自动保存已关闭”同一行、对称排列），显示最近一次上传/恢复的结果，格式固定为 `16:30 同步成功` 或 `16:40 同步失败`（成功绿色、失败红色，无额外文案）。记录只存本机 localStorage，不参与同步；自动保存与手动上传同样计入。
- **在线更新**：部署页“部署”按钮下方新增“更新”按钮：用同一令牌拉取账号下全部 Pages 项目列表并标注魔改版身份（生产配置同时含 `RP_SYNC_PASSWORD` 变量与 `RP_SYNC_R2` R2 绑定才算魔改版）；点击魔改版项目时服务端实时复查配置，通过浏览器确认后把该项目刷新为 GitHub 仓库 `page/` 的最新版（不改密码、不动 R2 数据）；非魔改版项目在列表和点击时都会被拒绝。服务端在 `/api/update` 里二次校验，防止绕过前端直接刷新非魔改版项目。
- **从云端恢复**：确认覆盖后用云端数据整体替换本机，只显示一个连续进度条；云端没有数据时提示无可恢复内容。内部会卸载作者应用并进入隔离恢复上下文，但立即把地址栏还原为 `/`，用户不需要进入或理解专用页面。清单页与数据包最多 4 请求并发；全部数据先完整校验并写 staging，通过后才取得写锁、覆盖本地数据。其他同源标签页只在实际覆盖阶段暂停写入。
- **图片管理**：按角色分组、搜索、查看和批量删除。打开时整库一次性加载全部角色分组；每张角色卡默认只渲染 8 张缩略图（窄屏 6 张），卡内“显示更多”按钮纯前端追加，不发新请求。清空角色按服务端当前目录的 20 张游标分页处理。每请求最多处理 20 个目标，先写墓碑，再后台删除原图和缩略图；失败 tombstone 会保留在响应中供重试。
- **固定生图**：按 `storyScopeId`、消息和槽位持久化参数快照。刷新或换画风后旧图片仍能读取固定记录；“固定生图”开关只决定新结果是否写入固定记录，不改变 URL 规范化、YNAI/sta1n 路由或已有记录读取。
- **生图门控**：跟随作者世界书的“自动生图”开关，开关状态由适配层在每次图片任务时实时传入，不依赖本地存储。关闭时不再为新消息生图：没有已存图片的消息槽位不发起任何生成请求、不落任何记录，卡片以 `.magic-image-suppressed` 整体隐藏，不渲染占位；已有图片的消息照常显示旧图，reroll 也只保留旧图不重新生成。重新打开开关后，此前被隐藏的消息按作者原生行为重新生成。适配层未提供状态时按作者原生行为放行。
- **YNAI 中转生图**：生图密钥以 `YNAI-` 开头时自动路由到第三方中转（OpenAI images 形状，b64_json 应答）；设置页“生图版本”下拉被劫持为中转模型列表（经 Worker 从中转站拉取，仅接受 YNAI- 密钥），默认取适配清单 `image.ynai.defaultModel`，选择后覆盖作者页面的模型参数。中转地址/路径/默认模型**只**云端化在适配清单 `image.ynai` 段（修改脚本头部元数据，经 Worker 缓存刷新后生效；无代码兜底，配置缺失时 ynai 生图显式报错）。**缓存不区分来源**：ynai 与 sta1n 相同参数共享同一 R2 对象，历史图键稳定。YNAI JSON 响应和 base64 图片受有界读取与 16MiB 解码上限保护。固定记录重放使用生成时的模型。sta1n 密钥行为完全不变。
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
rp-sync/main/maintenance/gc-v1.json                GC 游标与 generation
rp-sync/main/maintenance/mutation-lock.json        begin/finalize/GC 两阶段锁
rp-sync/main/migration-v13.done                    非破坏式初始化标记
```

根清单格式为 `rp-sync-manifest-root-v1`，只保存总字节数、包数、记录数、页数、最终页链 hash 和 Bloom checksum，因此提交开销不随数据量增长。

清单页格式为 `rp-sync-manifest-page-v1`。页 hash 同时绑定页号、前一页 hash 和所有包元数据；最后一页 hash 必须等于根清单的 `pageRoot`。

### 4.2 首次与严格增量

数据使用确定性 canonical JSON 编码。新缓存使用 256 个稳定桶，大数组每 32 项分页；旧云端快照仍识别 32 桶/128 项的 legacy bucket，恢复时按远端清单位置写回。每个包最多 1MiB、512 条记录。硬上限：

- 快照总量 1GiB
- 8192 个包
- 单包 1MiB
- 单包 512 条
- 单个支持对象 64MiB

业务 IndexedDB 写入和 `__rp_sync_journal_v2` 变更记录在同一事务中提交或回滚。localStorage 在写入前创建独立意图键。上传成功后只确认本次水位；上传期间发生的新写入保留到下一轮。

首次上传允许全库扫描。正常增量上传：

- 只读日志候选键，不遍历业务 store；
- 同值 put、对象键顺序变化、改后改回、clear 后原样回填和仅数据库版本变化不产生新包；
- 候选键在单个数据库连接中每 64 键一批读取；
- 缓存 entry 修改前先持久化 `pendingBuckets`，保证崩溃后受影响桶一定会重建。

### 4.3 上传流程

1. `prepare-upload`：读取当前根状态并做 schema 门控。
2. `initialize-storage`：只在缺少 v13 标记时执行非破坏式初始化。
3. `begin-upload`：创建或恢复 `rp-sync-upload-session-v1` 会话，固定 base version/checksum/etag 与 GC generation。
4. `upload-bloom`：上传 32KiB Bloom；R2 按 SHA-256 校验。
5. `upload-manifest-page`：每页最多 32 包；Worker 验证页链、总量和 Bloom 包含关系，先持久化不可变页声明，再以最多 6 个并行 `head` 核对包大小和记录数；有缺包时不推进会话。
6. 缺包时，客户端对每个缺包调用一次 `upload-pack`。每个请求只携带一个包，客户端在途并发为 4（重叠网络往返）；Worker 核对 checksum、length、entryCount 与当前或刚完成上一页的声明一致，已存在同元数据返回 204、不同元数据返回 409，不覆盖旧对象。新对象使用条件创建，Worker 直接执行 `bucket.put(key, request.body, { sha256 })`，不在 JavaScript 中复制或扫描正文。
7. 客户端重交当前清单页；页声明保持不可变，全包验证成功后会话以 etag CAS 推进。
8. `finalize-upload`：重新读取并校验 Bloom，取得 mutation lock，在写入前以 owner/etag CAS 从 preparing 升为 mutating，再以根清单 etag CAS 切换版本；GC 删除候选前先持久化新的 generation，若 finalize 发现 generation 在清单验证后变化，返回 `recheckRequired`，客户端刷新远端基线并重建会话。
9. 客户端在 3 秒窗口内最多调用 2 次 `gc-step`，把长尾回收留给下一次显式维护。GC 失败不撤销已成功的提交。

同一个 snapshot checksum 可断点续传；丢失提交响应后重试会返回已提交根，不重复写包。若 base version/etag 或 GC generation 已变化，begin-upload 会在旧会话 etag CAS 保护下重置进度并复用已有 pack。`baseVersion + baseChecksum + baseEtag` 阻止陈旧客户端静默覆盖另一端的新版本。

### 4.4 下载与恢复

1. `pull-manifest` 取得常数大小根信息。
2. `pull-manifest-page` 以最多 4 页并发拉取，返回后仍按页号顺序验证完整 hash 链。
3. `pull-pack` 必须同时带根版本、页号、页内索引、checksum、长度和记录数；Worker 从已提交清单页核对这些字段后才返回对象。
4. 浏览器最多 4 包并发下载。下载批次直接在内存中校验长度、SHA-256、JSONL 记录数、对象顺序及 bucket/group 归属，再把同一份字节写入 staging；预校验失败时不触碰本地业务数据。
5. 所有包预校验成功后才标记恢复活动；其他标签页收到标记后暂停写入并显示遮罩，恢复标签页先用写屏障等在途写事务收尾。每 4 包用一个只读事务从 staging 取回；普通记录写入同时受 64 条和约 8MiB 估算字节上限约束，每条记录只再解析一次；缓存中的 canonical 字节复制到独立、精确长度的 Uint8Array，避免 structured clone 携带整个 pack 的 backing buffer；同一遍同时恢复 localStorage/IndexedDB、重建条目索引并把原始包批量写入本地缓存。
6. 有效旧快照的 32 桶/128 项 legacy bucket 会按远端 bucket 位置恢复，并把缓存版本标为 7；下一次上传沿用“确认后完整重建索引”的简单流程生成当前 v8 布局，不做自动迁移引擎。
7. 成功顺序是业务数据与本地缓存、水位确认、清除恢复标记、立即刷新应用。正常界面只显示“正在恢复”进度，不显示下载、校验、应用和索引等内部阶段。

staging 不能省略：300MB 数据不适合常驻内存；没有 staging 就只能在正式覆盖前后各下载一次。恢复仍不是跨 localStorage 和多个 IndexedDB 的原子事务；进入覆盖阶段后若异常中断，写暂停标记会保留，用户在同步入口重新恢复即可。

### 4.5 垃圾回收

Bloom filter 只用于安全保留：假阳性会多留垃圾，不会删除仍被引用的数据。每个 `gc-step`：

- 与 begin/finalize 共用 mutation lock；preparing 30 秒后可被接管，写入/删除前 CAS 升为 mutating，临界区不按时间抢占；
- 重读已提交根和 Bloom；
- 从持久游标继续列举最多 256 个 `packs/` 对象；
- 仅删除 Bloom 明确不包含且上传时间超过 24 小时的包；
- 删除候选前先持久化新的 generation，使已经验证清单的旧上传在删除交错后不能直接 finalize；
- 批量删除后更新 GC 游标。

root、会话、GC generation/delete/cursor 写入结果未知时保留 mutating 锁，以免旧请求与新维护交错。该锁没有自动解锁 API；恢复前必须先确认原请求已经终止，再核对 root/GC 状态，不能只因等待超过 30 秒就删除锁。

当前 GC **只回收 pack**。过期上传会话、旧 manifest page 和旧 Bloom 尚无自动回收策略，见第 8 节。

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

`npm test` 包含：

- `sync-v13-smoke`：上传会话、不可变清单页、CAS 竞争、缺包重试、Bloom 损坏、分页 GC、清单绑定下载和密码门控。
- `sync-v13-budget`：小堆隔离环境下重复测量最大请求形状；硬门槛为 p95 ≤10ms、max ≤20ms、子请求 ≤50、R2 并发 ≤6。并发压力阶段（8 路同 isolate `upload-pack`、4 推 + 4 拉混合）逐请求套用同一硬门槛，检查本地模拟下的逐请求预算，不代表 Cloudflare 官方 CPU 测量。
- `runtime-smoke`：作者脚本原样代理、页面适配版本固定、失败/恢复与跨 isolate、注入顺序、图库整库加载与游标删除、图片 API 和上传引擎。
- `external-author-integration`：jsdom + 真 Vue + 未改写作者 app.js，覆盖启动偏好、保存防抖与聊天/重掷落盘、图片接管、实时开关、模型下拉重挂载、角色图片清理、事务失败与能力缺失。使用最小 root template，不等同完整页面浏览器视觉验收。
- `sync-consistency-regressions`：会话页绑定、不可覆盖元数据、并发重试、超过 30 秒的 owner fencing、空候选 GC、promotion/root/GC 结果未知时留锁。
- `cache-entry-buffer-regression`：独立 backing buffer、无字节别名、两遍解析和 64MiB 边界。
- `restore-sim`：fake-indexeddb 浏览器上传、恢复、缓存命中与损坏回源、schema 不兼容前置拒绝且本地数据不变、严格增量、水位、冲突、完整数组改写/缩短/空数组、追踪 epoch 与索引记录缺失后的完整本地重建、空快照和访问门禁；硬断言每条恢复记录恰好解析两遍、每个 staging pack 只读一次。
- `audit-regressions`、`worker-regressions`、`image-task-regressions`：生图门控（关闭时隐藏且零请求、已存图照常显示、reroll 保留旧图、重开后重新生成、固定关闭仍保持本项目路由但不持久化新记录）、YNAI 有界 JSON/base64 解码（声明长度、实际流超限、16MiB 边界、非法编码、超时取消）、资源释放、崩溃安全、恢复字节批次、客户端 GC recheck 基线刷新、自动保存前台 scheduler/后台暂停/休眠延迟/无变化上传与本地配置排除、图片流限额、代理认证隔离和图片任务并发。

作者源码按以下顺序查找：

1. `RPHUB_UPSTREAM_DIR`
2. `runtime-smoke` 可读取当前仓库同级 `RP-Hub-main`
3. 固定离线样本 `.sync-tests/fixtures/author`，来源与 SHA-256 见该目录说明；集成测试默认直接使用它，不依赖本机其他目录。

### 5.2 300MB 规模模拟

```text
npm run scale-sim
```

可用 `SCALE_MB=5`（Windows cmd：`set SCALE_MB=5&& npm run scale-sim`）进行快速预检。

2026-10-10 生产恢复代码默认 300MB 结果：

| 阶段 | 结果 |
|---|---|
| 首次上传 | 0.293GiB、530 包、448 字节根、571 请求、客户端并发 4、21.1 秒（本次宿主诊断） |
| 无变化上传 | 0 包、1 次 prepare-upload 探测 |
| 100 条等长修改 | 90 个新包、79.7MiB、130 请求、业务 store 全扫游标 0 |
| 20 条加长 + 10 删除 + 10 新增 | 52 个新包、27.6MiB、88 请求、业务 store 全扫游标 0 |
| 最终无变化上传 | 0 包、1 次 prepare-upload 探测 |
| 最终快照恢复 | 0.293GiB、530 包、38,820 条；547 个拉取请求、最大并发 4、133 个 staging 读取事务、7.3 秒（本次宿主诊断） |
| 恢复遍历约束 | 每条记录解析 2 次、每个 staging pack 读取 1 次、pack 事务每批最多 4 个 |
| 全程上限 | 子请求 36/50、客户端并发 4/6、单个 R2 put 1MiB |

规模模拟的墙钟只作宿主诊断，因为同一 Node 进程还持有约 300MB fake IndexedDB 和 R2 数据，V8 GC 停顿不等于 Cloudflare Worker CPU。完整模拟于 2026-10-10 通过，统计 1,424 个模拟请求、R2 Class A/B 分别 930/6,552；预算值不替代 Cloudflare 官方 CPU 测量。

独立预算套件结果（2026-10-10；本地墙钟代理）：

| 最大请求形状 | p95 | 最大值 | 子请求峰值 | 单请求 R2 并发峰值 |
|---|---:|---:|---:|---:|
| 1MiB upload-pack | 2.48ms | 2.83ms | 4 | 1 |
| 32 包 upload-manifest-page | 0.79ms | 0.97ms | 35 | 6 |
| finalize-upload | 0.52ms | 0.60ms | 11 | 3 |
| pull-manifest-page | 0.21ms | 0.46ms | 1 | 1 |
| pull-pack | 0.14ms | 1.41ms | 2 | 1 |
| 256 项 gc-step | 2.59ms | 3.69ms | 11 | 1 |
| 8 路并发 upload-pack | 1.72ms | 2.63ms | 4 | 1 |
| 4 推 + 4 拉混合 | 1.77ms | 1.80ms | 4 | 1 |

这些是本地高分辨率墙钟代理，不是 Cloudflare 官方 CPU 计量。上线后仍须以 Cloudflare Metrics 为准。

## 6. 适配与注入

外部配置本身是可执行的 `adapter/rp-hub.js`。作者相关的 DOM 选择器、样式、导航/同步入口、固定生图、YNAI 下拉、滚动按钮、Vue 保存与图片上下文桥接都集中在这里。`magic-extension.js` 保留图片业务，`DB/bootstrap.js` 通过版本化 `window.RPHubExternal.flush()` 请求保存。

Worker 从 GitHub Raw 直连读取脚本（10 秒超时），读取头部 `RPHUB_ADAPTER_CONFIG` 元数据并检查可执行桥接契约。失败会读取 R2 `rp-adapter/last-good-script-v1.js` 并再次检查契约。有效候选缓存 30 秒，加载失败缓存 5 秒。last-good 并不证明任意 JavaScript 的语法与浏览器运行正确，发布前仍需回归。

主页按以下顺序注入：

1. `/DB/dirty-tracker.js`
2. 当前页面固定的 `window.RPHUB_PAGE_ADAPTER` 元数据
3. 外部适配脚本正文（随 HTML 内联执行，不是第二次浏览器 src 请求）
4. `/magic-extension.js`
5. `/DB/bootstrap.js`

作者 HTML 中的动态加载器、全部作者 JavaScript（含 update-check）与更新检查 meta 均保留。主页加载失败时只注入 dirty-tracker；其他作者 HTML 也只注入它。后续 app.js 请求不重新判断适配、不改写源码。作者 HTML/JS 的 GET 与 HEAD 使用 no-store，本项目三个静态脚本仍使用 no-cache。

当前接入依赖 Vue 3 setup 返回状态、作者存储/组件导出和四种保存 watcher 的函数文本标记。保存会主动执行捕获的防抖回调、等待存储 Promise 与事务结束，不靠固定延迟猜测完成。作者变更内部接口或选择器时仍要适配；无法确认保存时显式拒绝同步。图片通过卡片观察入口接管，没有全局 fetch/XHR 拦截；缺少上下文时保留作者原生路径。

更新适配后，新导航取得新版本，现有页面保持原版本；没有客户端 6 秒动态补装。接口与能力说明见 [adapter/README.md](adapter/README.md)。YNAI 模型缓存与 select 元素分开记录，设置视图重挂载会重绘已有列表。

## 7. 部署后自检与排障

### 7.1 两分钟自检

1. 首页出现“同步”和“图片管理”，设置中出现“固定生图”。
2. `/__rphub/adapter.json` 返回当前适配摘要；503 表示外部脚本加载或元数据校验失败；200 不能单独证明浏览器桥接已就绪。
3. 作者 app.js 保持原文；浏览器中 `RPHubExternal.version === 1`，就绪后 `capabilities().flush === true`。
4. 上传少量数据，在另一浏览器或隐身窗口恢复一次。
5. 查看 Workers CPU time、错误率及 R2 Class A/B 操作数。

### 7.2 常见错误

| 现象 | 含义与处理 |
|---|---|
| 401 | 密码缺失或错误，在同步面板重新输入 |
| 409“服务器同步版本已变化” | 另一端已提交新版本；本项目是整体覆盖语义，不做自动合并。重新点击上传会以当前本机快照和最新云端基线重建会话；若是普通根 CAS 冲突，按提示再次点击上传。 |
| 409 + `resetRequired` | v13 尚未初始化；在主页面执行一次上传，只写初始化标记，不批量删除旧对象 |
| “本地同步索引缺失/过期” | 确认后自动完整重建；只读本地，云端以上传开始时的状态为基准整体替换 |
| 503 | R2 或上游暂时失败；客户端按规则重试，持续失败时检查 Cloudflare 状态与日志 |
| 魔改按钮全部消失 | 外部脚本加载失败或作者页面接口变化；先检查适配端点和浏览器错误，再运行离线回归 |
| 恢复中断 | 再次点击“从云端恢复”；若已进入覆盖阶段，其他页面会继续暂停写入，直到完整重试成功 |

## 8. 已知边界

- 本地性能套件不能替代 Cloudflare 官方 CPU 指标；部署后继续观察真实 p95 和 1102 错误。
- GC 只清理过期孤儿 pack，不清理过期上传会话、旧清单页或旧 Bloom。它们不会影响当前快照正确性，但会持续占用少量 R2 空间。
- 图片删除墓碑不会自动回收；删除墓碑可能让旧请求重新生成已删除图片，因此不能当垃圾直接清理。
- 主 `/api/rp-image` 读取先查墓碑再查原图：删除后的生图读取立即返回占位图，即使原图的后台物理删除失败也不会泄漏旧图；图库管理端点的墓碑优先策略仍未统一，不能据此扩大权限或读取保护范围。残留原图在下次打开图库时被后台清理。
- localStorage 意图键在成功上传确认前必须保留；长期修改但不上传可能消耗浏览器配额。
- 恢复跨多种存储，不是原子提交；写暂停信号与写屏障只能缩小中断窗口。
- Web Locks 不支持时，同步与恢复按无跨标签页锁降级执行。
- mutating 锁遇到未知写入结果会保留，需确认旧请求停止后核查恢复；没有按时间自动抢占或自动解锁。
- 外部适配脚本不是作者公开稳定 API，实际新版页面仍须验收；本轮未访问真实 R2、Cloudflare API 或生图服务。

## 9. 维护约定

- Worker 保持单文件、无构建步骤，不引入 `import` 或顶层 `await`。
- 免费版限制优先于可读性和抽象美观；禁止把全量 pack、完整大清单或多个 1MiB 包装进单次 Worker JavaScript 内存。
- 改同步协议必须同时改 `_worker.js`、`DB/bootstrap.js`、协议测试、恢复模拟和两份文档。
- 改根目录部署文件后必须同步 `page/`；正式发布时才重建 `page.zip`，未打包时明确标记归档仍是旧版。
- 不删除墓碑、未确认意图键或线上 R2 数据作为“清理工作区”。
- 未经明确要求不要推送 GitHub。

许可证：CC BY-NC 4.0，见 `LICENSE`。

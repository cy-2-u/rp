# RP Hub 魔改版

这是一个 Cloudflare Pages Worker 项目：反代作者的 RP-Hub 前端，在不修改作者仓库的前提下加入云同步、R2 聊天图片托管、图片管理和少量 UI。

当前同步协议为 **schema 13 / `rp-sync-paged-jsonl-v4`**。它针对 Cloudflare Workers Free 的单请求 CPU、50 个子请求、6 个同时出站连接和 128MiB isolate 内存限制设计：每个 HTTP 请求只上传一个内容寻址分片，Worker 将 `request.body` 直接交给 R2；清单分页验证；最终只用常数大小的根清单切换版本；垃圾回收由独立、可续跑的 `gc-step` 请求完成。

最后更新：2026-09-20。

## 1. 项目结构

| 路径 | 用途 |
|---|---|
| `_worker.js` | 唯一的 Pages Worker：作者站代理与适配、同步 API、图片 API 和图库页面 |
| `magic-extension.js` | 图片任务、固定生图、图片管理/同步入口及下滑按钮 |
| `DB/bootstrap.js` | 同步快照缓存、严格增量、分片上传、隔离恢复执行和同步面板 |
| `DB/dirty-tracker.js` | IndexedDB/localStorage 事务级变更日志与恢复期间写暂停 |
| `DB/styles.css` | 同步面板和恢复进度样式 |
| `adapter/rp-hub.json` | 外置适配清单，生产 Worker 从 GitHub Raw 读取 |
| `.sync-tests/` | 离线协议、运行时、恢复、性能和回归测试 |
| `MODIFICATIONS_TO_KEEP.txt` | 修改代码时必须保留的架构不变量 |
| `page/` | 可直接部署的五个文件 |
| `page.zip` | `page/` 的发布归档 |

`page/` 必须保持以下结构：

```text
page/
├── _worker.js
├── magic-extension.js
└── DB/
    ├── bootstrap.js
    ├── dirty-tracker.js
    └── styles.css
```

根目录文件是维护正本，`page/` 是部署副本。适配清单由 Worker 在线读取，不放进部署目录。

## 2. 部署

### 2.1 Cloudflare Pages 配置

必须配置：

- R2 bucket binding：`RP_SYNC_R2`

可选配置：

- 环境变量 `RP_SYNC_PASSWORD`：同步和图库共用密码；不设置则免密。

适配清单地址已在 `_worker.js` 的 `DEFAULT_ADAPTER_URL` 中固定为：

```text
https://raw.githubusercontent.com/cy-2-u/rp/main/adapter/rp-hub.json
```

`RPHUB_ADAPTER_URL` 仅用于本地测试时以 `file://` 覆盖，不用于生产地址切换。

### 2.2 发布步骤

1. 在 `.sync-tests` 安装依赖并运行 `npm test`。
2. 运行 `npm run scale-sim` 完成默认 300MB 规模测试。
3. 把五个根目录正本同步到 `page/`，逐字节核对。
4. 重新生成 `page.zip`，确认归档根目录直接包含 `_worker.js`；zip 条目路径必须用正斜杠（如 `DB/bootstrap.js`）。PowerShell `Compress-Archive` 写出的是反斜杠条目，Pages 导入后 `DB/` 子目录会整体丢失，站点表现为 `/DB/*` 全部 404，请用常规压缩工具打包。
5. 部署 `page/`，或让 Pages Git 集成把构建输出目录设置为 `page`；构建命令留空。
6. 部署后执行第 7 节自检并观察 Cloudflare CPU 指标。

schema 13 第一次上传只进行**非破坏式初始化**：写入 `rp-sync/main/migration-v13.done`，记住原根清单 etag，随后以 CAS 提交新的 schema 13 根清单。初始化不会批量删除旧同步对象，也不会触碰 `rp-images/`。

## 3. 使用行为

- **上传到云端**：首次上传完整扫描本地数据并建立缓存；后续上传只读取事务日志中的候选键。若索引缺失、过期或追踪 epoch 改变，会确认后自动完整重建；重建只读本地数据，云端仍受版本基线保护。
- **从云端恢复**：确认覆盖后只显示一个连续进度条。内部会卸载作者应用并进入隔离恢复上下文，但立即把地址栏还原为 `/`，用户不需要进入或理解专用页面。清单页与数据包最多 4 请求并发；全部数据先完整校验并写 staging，通过后才取得写锁、覆盖本地数据。其他同源标签页只在实际覆盖阶段暂停写入。
- **图片管理**：按角色分组、搜索、查看和批量删除。前端每批 20 张，Worker 每请求最多处理 20 个目标；先写墓碑，再后台删除原图和缩略图。
- **固定生图**：按 `storyScopeId`、消息和槽位持久化参数快照。刷新或换画风后旧图片仍能读取固定记录。
- **适配失败**：替换规则或 `sourceChecks` 任一失配时，作者页面整体回退，不返回半份修改。

不参与同步的数据包括：

- `rp_hub_presets`
- `rp_hub_sync_password_v1`
- `RPHubSyncCache`、`RPHubSyncStaging`
- `__rp_sync_journal_v2`
- `rp_sync_intent_v2:*`、追踪 epoch、baseline 等同步簿记键

## 4. schema 13 同步设计

### 4.1 R2 对象布局

```text
rp-sync/main/manifest.json                         常数大小根清单
rp-sync/main/manifests/<root-checksum>/<page>.json  不可变清单页，每页最多 32 包
rp-sync/main/packs/<sha256>.bin                    内容寻址数据包，最多 1MiB
rp-sync/main/blooms/<sha256>.bin                   32KiB 引用 Bloom filter
rp-sync/main/uploads/<root-checksum>.json          可续传上传会话
rp-sync/main/maintenance/gc-v1.json                GC 游标
rp-sync/main/maintenance/mutation-lock.json        finalize/GC 短锁
rp-sync/main/migration-v13.done                    非破坏式初始化标记
```

根清单格式为 `rp-sync-manifest-root-v1`，只保存总字节数、包数、记录数、页数、最终页链 hash 和 Bloom checksum，因此提交开销不随数据量增长。

清单页格式为 `rp-sync-manifest-page-v1`。页 hash 同时绑定页号、前一页 hash 和所有包元数据；最后一页 hash 必须等于根清单的 `pageRoot`。

### 4.2 首次与严格增量

数据使用确定性 canonical JSON 编码。小对象进入 32 个稳定桶，大数组每 128 项分页；每个包最多 1MiB、512 条记录。硬上限：

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
3. `begin-upload`：创建或恢复 `rp-sync-upload-session-v1` 会话，固定 base version/checksum/etag。
4. `upload-bloom`：上传 32KiB Bloom；R2 按 SHA-256 校验。
5. `upload-manifest-page`：每页最多 32 包；Worker 验证顺序、Bloom 包含关系，并以最多 6 个并行 `head` 核对包大小和记录数。
6. 缺包时，客户端逐个调用 `upload-pack`。每个请求只携带一个包，客户端并发为 1，Worker 直接执行 `bucket.put(key, request.body, { sha256 })`，不在 JavaScript 中复制或扫描正文。
7. 客户端重交当前清单页；页面以 `onlyIf: { etagDoesNotMatch: '*' }` 不可变写入，会话以 etag CAS 推进。
8. `finalize-upload`：重新读取并校验 Bloom，取得短 mutation lock，以根清单 etag CAS 切换版本。
9. 客户端串行调用 `gc-step`，每步最多列举 256 个包，直到完成或达到有界步数。GC 失败不撤销已成功的提交。

同一个 snapshot checksum 可断点续传；丢失提交响应后重试会返回已提交根，不重复写包。`baseVersion + baseChecksum + baseEtag` 阻止陈旧客户端覆盖另一端的新版本。

### 4.4 下载与恢复

1. `pull-manifest` 取得常数大小根信息。
2. `pull-manifest-page` 以最多 4 页并发拉取，返回后仍按页号顺序验证完整 hash 链。
3. `pull-pack` 必须同时带根版本、页号、页内索引、checksum、长度和记录数；Worker 从已提交清单页核对这些字段后才返回对象。
4. 浏览器最多 4 包并发下载。下载批次直接在内存中校验长度、SHA-256、JSONL 记录数、对象顺序及 bucket/group 归属，再把同一份字节写入 staging；预校验失败时不触碰本地业务数据。
5. 所有包预校验成功后才标记恢复活动并取得排他 Web Lock。每 4 包用一个只读事务从 staging 取回，每条记录只再解析一次；同一遍同时恢复 localStorage/IndexedDB、重建条目索引并把原始包批量写入本地缓存。
6. 成功顺序是业务数据、缓存与 baseline、水位确认、清除恢复标记、立即刷新应用。正常界面只显示“正在恢复”进度，不显示下载、校验、应用和索引等内部阶段。

staging 不能省略：300MB 数据不适合常驻内存；没有 staging 就只能在正式覆盖前后各下载一次。恢复仍不是跨 localStorage 和多个 IndexedDB 的原子事务；进入覆盖阶段后若异常中断，写暂停标记会保留，用户在同步入口重新恢复即可。

### 4.5 垃圾回收

Bloom filter 只用于安全保留：假阳性会多留垃圾，不会删除仍被引用的数据。每个 `gc-step`：

- 与 finalize 共用短 mutation lock；
- 重读已提交根和 Bloom；
- 从持久游标继续列举最多 256 个 `packs/` 对象；
- 仅删除 Bloom 明确不包含且上传时间超过 24 小时的包；
- 批量删除后更新 GC 游标。

当前 GC **只回收 pack**。过期上传会话、旧 manifest page 和旧 Bloom 尚无自动回收策略，见第 8 节。

## 5. 测试

### 5.1 安装与默认回归

```text
cd .sync-tests
npm ci
npm test
```

`npm test` 包含：

- `sync-v13-smoke`：上传会话、不可变清单页、CAS 竞争、缺包重试、Bloom 损坏、分页 GC、清单绑定下载和密码门控。
- `sync-v13-budget`：小堆隔离环境下重复测量最大请求形状；硬门槛为 p95 ≤10ms、max ≤20ms、子请求 ≤50、R2 并发 ≤6。
- `runtime-smoke`：真实作者源码适配、注入、代理、图库、图片 API 和浏览器上传引擎。
- `restore-sim`：两个 fake-indexeddb 浏览器的上传、恢复、严格增量、水位、冲突和空快照；硬断言每条记录恰好解析两遍、每个 staging pack 只读一次、pack 事务最多 4 个对象，并验证晚出现的坏 JSON 不会提前覆盖本地数据。
- `audit-regressions`、`worker-regressions`、`image-task-regressions`：资源释放、崩溃安全、图片流限额、代理认证隔离和图片任务并发。

作者源码按以下顺序查找：

1. `RPHUB_UPSTREAM_DIR`
2. 仓库同级 `RP-Hub-main`
3. 本机兼容路径 `C:\Users\my\Downloads\RP-Hub-main`

### 5.2 300MB 规模模拟

```text
npm run scale-sim
```

可用 `SCALE_MB=5`（Windows cmd：`set SCALE_MB=5&& npm run scale-sim`）进行快速预检。

2026-09-20 默认 300MB 结果：

| 阶段 | 结果 |
|---|---|
| 首次上传 | 0.293GiB、331 包、448 字节根、360 请求 |
| 无变化上传 | 0 包、1 请求 |
| 100 条等长修改 | 90 个新包、87.5MiB、117 请求、业务 store 全扫游标 0 |
| 20 条加长 + 10 删除 + 10 新增 | 125 个新包、110.5MiB、154 请求、业务 store 全扫游标 0 |
| 最终无变化上传 | 0 包、1 请求 |
| 最终快照恢复 | 0.293GiB、331 包、38,820 条；342 个拉取请求、最大并发 4、83 个 staging 读取事务、20.7 秒 |
| 恢复遍历约束 | 每条记录解析 2 次、每个 staging pack 读取 1 次、pack 事务每批最多 4 个 |
| 全程上限 | 子请求 36/50、客户端并发 4/6、单个 R2 put 1MiB |

规模模拟的墙钟只作宿主诊断，因为同一 Node 进程还持有约 300MB fake IndexedDB 和 R2 数据，V8 GC 停顿不等于 Cloudflare Worker CPU。

独立预算套件在 40 个计时样本中的最近结果：

| 最大请求形状 | p95 墙钟代理 | 最大墙钟代理 | 子请求峰值 | R2 并发峰值 |
|---|---:|---:|---:|---:|
| 1MiB `upload-pack` | 0.58ms | 1.04ms | 3 | 1 |
| 32 包 `upload-manifest-page` | 2.85ms | 3.43ms | 36 | 6 |
| 完整 `finalize-upload` | 1.60ms | 2.28ms | 10 | 1 |
| 32 包 `pull-manifest-page` | 1.55ms | 1.81ms | 4 | 1 |
| 1MiB `pull-pack` | 1.69ms | 2.13ms | 5 | 1 |
| 256 项 `gc-step` | 4.32ms | 6.33ms | 11 | 1 |

这些是本地高分辨率墙钟代理，不是 Cloudflare 官方 CPU 计量。上线后仍须以 Cloudflare Metrics 为准。

## 6. 适配与注入

适配规则完全外置。`sourceChecks` 会对照真实作者文件验证标记；任一失配时 app.js 不做部分替换，主页面也不注入魔改脚本。固定生图设置行复用作者 `settings-toggle-row` 语义类，行样式类同样来自适配清单：作者调整样式通常无需任何操作，改类名只需更新适配 JSON。

正常主页只注入 4 个节点：

1. `/DB/styles.css`
2. `/DB/dirty-tracker.js`
3. `/magic-extension.js`
4. `/DB/bootstrap.js`

其他通过适配检查的作者 HTML 页只注入 dirty tracker。未注册路径全部回源作者站，作者新增页面无需维护路由表。

更新作者版本时：

1. 更新本地 `RP-Hub-main`。
2. 运行 `npm test`。
3. 若 `sourceChecks` 或替换命中失败，更新 `adapter/rp-hub.json`；只有注入脚本或 Worker 逻辑变化才重新部署 Worker。
4. 检查 `/__rphub/adapter.json` 和真实页面。

## 7. 部署后自检与排障

### 7.1 两分钟自检

1. 首页出现“同步”和“图片管理”，设置中出现“固定生图”。
2. `/__rphub/adapter.json` 返回当前适配摘要；503 表示适配或 source check 失败。
3. app.js 响应中能搜到 `image_renders`。
4. 上传少量数据，在另一浏览器或隐身窗口恢复一次。
5. 查看 Workers CPU time、错误率及 R2 Class A/B 操作数。

### 7.2 常见错误

| 现象 | 含义与处理 |
|---|---|
| 401 | 密码缺失或错误，在同步面板重新输入 |
| 409“服务器同步版本已变化” | 另一端已提交新版本；先导出本地数据，再恢复并人工合并 |
| 409 + `resetRequired` | v13 尚未初始化；在主页面执行一次上传，只写初始化标记，不批量删除旧对象 |
| “本地同步索引缺失/过期” | 确认后自动完整重建；只读本地，不绕过云端基线保护 |
| 503 | R2 或上游暂时失败；客户端按规则重试，持续失败时检查 Cloudflare 状态与日志 |
| 魔改按钮全部消失 | 适配拉取、替换命中或 `sourceChecks` 失败；先访问适配端点，再运行 `npm test` |
| 恢复中断 | 再次点击“从云端恢复”；若已进入覆盖阶段，其他页面会继续暂停写入，直到完整重试成功 |

## 8. 已知边界

- 本地性能套件不能替代 Cloudflare 官方 CPU 指标；部署后继续观察真实 p95 和 1102 错误。
- GC 只清理过期孤儿 pack，不清理过期上传会话、旧清单页或旧 Bloom。它们不会影响当前快照正确性，但会持续占用少量 R2 空间。
- 图片删除墓碑不会自动回收；删除墓碑可能让旧请求重新生成已删除图片，因此不能当垃圾直接清理。
- 图片读取当前先查原图；若墓碑已写但后台物理删除失败，旧图片 URL 仍可能暂时返回原图。
- localStorage 意图键在成功上传确认前必须保留；长期修改但不上传可能消耗浏览器配额。
- 恢复跨多种存储，不是原子提交；写暂停与排他锁只能缩小中断窗口。
- Web Locks 是安全恢复的前提；不支持时拒绝恢复。

## 9. 维护约定

- Worker 保持单文件、无构建步骤，不引入 `import` 或顶层 `await`。
- 免费版限制优先于可读性和抽象美观；禁止把全量 pack、完整大清单或多个 1MiB 包装进单次 Worker JavaScript 内存。
- 改同步协议必须同时改 `_worker.js`、`DB/bootstrap.js`、协议测试、恢复模拟和两份文档。
- 改根目录部署文件后必须同步 `page/` 并重建 `page.zip`。
- 不删除墓碑、未确认意图键或线上 R2 数据作为“清理工作区”。
- 未经明确要求不要推送 GitHub。

许可证：CC BY-NC 4.0，见 `LICENSE`。

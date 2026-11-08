# 架构文档（ARCHITECTURE）

面向维护者：适配脚本链与契约、同步 v2 协议、测试体系与维护约定。

## 1. 设计前提

- **个人单用户**：同步是整体替换语义，不为并发设计任何机制。
- **国内高延迟**：一切协议决策向"更少请求、更少字节"倾斜。
- **Cloudflare 免费版**：分片正文永远由 Worker 把 `request.body` 流式直通 R2，不进 isolate 内存聚合。
- **作者前端会变**：应对手段是更新一个外部可执行脚本（第 2 节），不是自动探测魔法。

## 2. 适配脚本链（核心）

### 2.1 脚本链

```
1. 外部适配脚本   ← page/config.json 的 adapter.externalUrl（env RPHUB_ADAPTER_URL 可覆盖）
2. 部署兜底脚本   ← page/adapter/rp-hub-v2.js（开箱即用；仓库另保留旧版契约 v1 脚本
                    page/adapter/rp-hub.js 供旧版部署重部署，两者互不兼容）
3. R2 last-good   ← rp-adapter/last-good-script-v2.js（最近一次验证通过的副本）
→ 全部失败：主页只注入 dirty-tracker，同步/图片显式报错
```

- 外部脚本必定优先：Worker 拉取（10s 超时、512KiB 上限、成功缓存 30s/失败 5s），经 ASSETS 内联注入主页，浏览器不发第二次请求。**作者改版后的维护动作只有一个**：写新脚本 → 传到外部源，刷新即生效。
- 轻校验：非空、大小上限、含契约标记 `RPHubExternal`。不做字段级 schema 校验——可执行代码的任何字段级校验都是新的一票否决点。
- Worker 侧自有配置（外部 URL、ynai 端点）在 `page/config.json`（30s 缓存，R2 `last-good-config-v2.json` 兜底）。

### 2.2 稳定契约：window.RPHubExternal v2

系统侧只依赖契约，不依赖作者内部实现：

| 成员 | 语义 |
|---|---|
| `version` | 常量 `2`；不符按未适配处理 |
| `flush()` | 作者内存数据落盘；`{ok:true}` 或 `{ok:false,reason}`，不 throw |
| `context(card)` | 图片卡上下文（角色/分支/消息/自动生图开关/密钥/忙碌）；探测不到返回 `null` |
| `describeCard(card)` | 槽位 `{messageIndex, occurrenceIndex}` |
| `register(name, handler)` | `image-request` / `character-deleted` 回调；返回解绑函数 |
| `imageKey()` | 生图密钥 |
| `capabilities()` / `status()` | 逐能力健康度 + missing 列表 / 诊断摘要 |
| `installUi()` | 同步按钮、图片管理入口、固定生图开关、YNAI 下拉、滚动按钮 |

写新脚本的规范：锚点全集中在头部 `ANCHORS`（候选数组逐个尝试）；UI 安装每步独立 try/catch（reconcile）；**flush 无法确认作者保存完成必须拒绝**（数据安全底线）；上下文探测失败返回 null（图片退化、同步不受影响）；保存定时器经作用域化 `setTimeout` 捕获，flush 重放到"零写入、零待定事务、revision 稳定"。

注入顺序：dirty-tracker → 适配脚本（内联）→ magic-extension → bootstrap。降级矩阵：外部失败回兜底 → 回 last-good → 三层全败只注 dirty-tracker；契约版本不符则增强不启用；单锚点失效只缺该项。

## 3. 同步协议 v2（`rp-sync/v2/`）

### 3.1 布局与根清单

```
rp-sync/v2/manifest.json        全量根清单（JSON，内含完整分片列表）
rp-sync/v2/packs/<sha256>.bin   gzip 后内容寻址分片（customMetadata.entries = 记录数）
```

```json
{ "format": "rp-sync-manifest-v2", "version": 3, "updatedAt": 1730000000000,
  "compression": "gzip", "totalBytes": 980, "entryCount": 24, "checksum": "<hex64>",
  "packs": [{ "bucket": "store:RPHubDB/store:data|s012", "checksum": "<hex64>", "length": 101, "entries": 3 }] }
```

**canonical 校验和源（三方一致，顺序敏感）**：

```js
JSON.stringify(['rp-sync-manifest-v2', root.compression, root.totalBytes, root.entryCount,
  root.packs.map(p => [p.bucket, p.checksum, p.length, p.entries])])
```

- checksum **只覆盖内容**（不含 version/updatedAt）：同一内容重建根校验和恒定，"无变化上传"靠它 1 个 status 判等；version 单调递增 + CAS etag 防过期覆盖。
- 上限：快照 1GiB、4096 分片、单片 gzip 6MiB（原始 4MiB 客户端保证）、512 条。`entries` 允许 0：单条超分片缓冲先落纯字节填充片，记录跨片拼接，恢复按行重组。

### 3.2 端点

| 端点 | 方法 | 语义 |
|---|---|---|
| `/api/rp-sync` | POST | JSON 动作：`auth-status` / `status` / `commit` / `sweep` |
| `/api/rp-sync/pack` | PUT | 上传一片（sha256 校验、条件创建、流式直通 R2、幂等 204） |
| `/api/rp-sync/pack?c=<sha>` | GET | 下载一片（边缘 Cache API，immutable） |

认证：`RP_SYNC_PASSWORD` 设置后所有同步端点要求 `x-rp-sync-password` 头。

### 3.3 上传流程（客户端）

1. `flushAppState`（作者保存链路 → 图片记录 → 日志收尾）+ 写屏障等在途事务。
2. **无变化快速通道**（仅自动保存）：journal 全确认 + committed 记忆未过 1 小时验证间隔 ⇒ 跳过网络直接返回；手动上传永远走完整流程。
3. `status` 与本地快照准备**并行**。
4. **无变化判定**：本地根校验和 === 云端 ⇒ 只 acknowledge 水位，0 分片。
5. `PUT pack` ×N（并发 6；云端已有校验和跳过；本地缓存存 gzip 字节直接复用）。
6. `commit`：版本单调校验 → list 校验全部包存在（缺包 409 带回 missing，客户端按桶重建补传，最多 3 轮）→ etag CAS 切根（3 轮收敛）→ 对比新旧根顺带删除孤儿，响应带 `reclaimed`（未确认删除数）。
7. `reclaimed > 0` 才补发 `sweep`（正常零残留省一趟 RTT）；`acknowledge` 水位 + 记录上次提交校验和。

**后台预先准备**：写入防抖 8s / 加载预热 3s / 回前台 1s 触发；journal 水位增量消费（持续聊天时准备成本恒定）；差分 → 按桶组装 4MiB 分片 → gzip → 本地分片缓存，全程零网络。单飞互斥，上传前等在飞准备收尾再补一次增量。索引缺失/过期后台自动静默重建；上传路径"确认后重建"仅兜底。完整扫描用低占空比（6ms/8ms），上传全速。增量粒度是"桶"（256 个稳定桶，300MB 库约 1.2MiB/桶）。

### 3.4 恢复流程（客户端）

1. `status` → 客户端按同一 canonical 源重算校验和验证根清单。
2. `GET pack` ×N（6 路滑动窗口）：字节先验 SHA-256 与长度 → 解压写 staging；gzip 字节同时进本地缓存（命中只验长度）。
3. **两遍语义**：validateOnly 全量校验结构/顺序/桶归属/重复键 → 写恢复标记（其他标签页冻结+遮罩）→ 写屏障 → 第二遍应用：恢复 localStorage/IndexedDB、按包内行字节精确复制重建缓存索引、确认水位、清标记、刷新。
4. 失败保留已校验分片缓存，只清派生索引，重试不重新下载。

### 3.5 孤儿分片

"无用" = 不被当前根引用。提交即回收（Worker 对比新旧根批量删差集）+ sweep 兜底（list 全部、1 小时宽限期、删未引用过期对象）+ 本地 `pruneCachedPacks`。删除失败只留垃圾不留风险（下轮 sweep 重判）；单用户 + 全量根清单让引用判断变成一次内存差集——旧协议的 GC 状态机/Bloom/上传会话全部不需要。

## 4. 图片模块

- R2 键：`rp-images/characters/<角色名>/<签名sha256>`（缩略图 `thumbs/`、墓碑 `_deleted/`）。签名 provider 恒 `sta1n`——ynai/sta1n 共享内容寻址缓存，历史键稳定。
- 生图只接受 POST（GET/HEAD 只读或 404，爬虫不扣费）；24MiB/16MiB/2MiB 有界读取；墓碑优先（删除后旧链接返回占位 SVG）。
- 两阶段删除：先墓碑后台清理；每请求 ≤20 目标，清空角色游标续传。**墓碑不参与分片回收**（删墓碑会让旧链接重新生图）。
- `/image` = 静态资产 `gallery.html`；缩略图读写归图库端点（图库自带按需回填），**聊天卡片恒显原图**【产品决策，勿回退，详见 adapter ANCHORS 后区块注释】。
- ynai 端点只认 `page/config.json`，缺失时显式 503。

## 5. 测试

```text
cd tests && npm ci
npm test              # unit（audit/protocol/images/legacy/magic）+ runtime（client-sim/realistic-sim/adapter-contract）
npm run scale         # 规模模拟（SCALE_MB 默认 300）
npm run realistic     # 真实形态模拟（SIM_CHARS/SIM_CHATS/SIM_MSGS 可调）
npm run sync-perf     # 后台准备基准 + journal 增量消费正确性
npm run code-audit    # 死代码静态审计
```

| 文件 | 覆盖 |
|---|---|
| `audit-regressions.mjs` | 双写协议/UI 常量逐字一致、三方 canonical 一致、无旧协议残留、Worker 结构约束、page/ 文件集完整 |
| `protocol-smoke.mjs` | 脚本链注入/优先/回退/last-good、同步协议全形状、密码门禁 |
| `image-regressions.mjs` | 生图键稳定/缓存/ETag/GET 不生图/墓碑/上限/ynai 路由/模型列表/图库页 |
| `legacy-upgrade.mjs` | v1 遗留状态升级 + 中断续传元数据合法 |
| `magic-behavior.mjs` | 真实适配脚本+Vue+magic：生图全链路、复用不重生成、原图展示、flush |
| `realistic-sim.mjs` | 真实形态数据端到端（首次/无变化/增量/图片库/恢复字节级/缓存命中） |
| `client-sim.mjs` | jsdom+fake-indexeddb 真实三方端到端 + entries=0 填充片 + 规模模式 |
| `adapter-contract.mjs` | 契约 v2、能力报告、flush 稳定判定、忙碌拒绝、注册钩子 |
| `background-prepare-bench.mjs` | 后台准备耗时不随累积增长 |
| `journal-incremental-verify.mjs` | 水位推进、上传捕获未准备写入、恢复字节级对比 |
| `day-sim.mjs` | "用户的一天"全行为随机交错（虚拟时钟 24h≈2min），产出请求账单/快速通道命中/孤儿拓扑 |
| `dead-code-audit.mjs` | 零引用顶层函数候选 + 单调用点自审清单 |

测试基建：`lib/r2.mjs`（内存 R2 桶）、`lib/worker.mjs`（Worker 装载器 + HTMLRewriter 桩）。全部外网在测试内拦截。

## 6. 维护约定

- Worker 单文件、无构建、无 import/顶层 await。
- `page/` 是唯一发布正本；手动部署上传该目录；部署器（`deployer/worker.js`，线上独立 Worker 需手动同步）实时从仓库 `main` 的 `page/` 拉文件。**部署器 ASSETS 清单必须与 page/ 文件集一致**；改动后跑 `node deployer/test-blake3.mjs && node deployer/test-flow.mjs`（37+101 项断言）。
- 改同步协议必须同时改 `page/_worker.js`、`page/DB/bootstrap.js`、`tests/`；dirty-tracker 与 bootstrap 的协议常量是人肉双写副本（audit-regressions 逐字断言）。
- 改适配层：锚点变化只改 `ANCHORS`；契约变化必须升 `version` 并同步系统侧。
- 不推送 GitHub（除非明确要求）；不删除线上 R2 数据。
- 免费版上限优先于美观：禁止全量分片/完整根清单聚合进单次 Worker 内存（根清单除外，≤1MiB 有界读取）。

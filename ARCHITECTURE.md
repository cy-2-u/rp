# 架构文档（ARCHITECTURE）

面向维护者：适配脚本链与契约、同步 v2 协议规范、测试体系与维护约定。

## 1. 设计前提

- **个人单用户、无并发写者**：同步为整体替换语义（最后成功提交的快照即云端存档），不为多用户并发设计任何机制。
- **国内访问 Cloudflare 高延迟**：优化目标是**减少请求往返次数与传输字节**，而非单请求吞吐。所有协议决策都向"更少请求、更少字节"倾斜。
- **Cloudflare 免费版边界**：Workers 单请求 10ms CPU、每请求 50 个外部子请求（R2/KV 内部操作 1000）、6 个同时出站连接、128MiB isolate。分片正文永远由 Worker 把 `request.body` 流式直通 R2，绝不进入 isolate 内存聚合。
- **作者前端会变**：适配手段不是自动探测魔法，而是**更新一个外部可执行脚本**（第 2 节）。

## 2. 适配脚本链（核心）

### 2.1 脚本链与优先级

```
1. 外部适配脚本   ← page/config.json 的 adapter.externalUrl（可被环境变量 RPHUB_ADAPTER_URL 覆盖）
2. 部署兜底脚本   ← page/adapter/rp-hub-v2.js（随部署发布，开箱即用；仓库另保留旧版单机脚本 page/adapter/rp-hub.js 供旧版部署重部署使用，两者契约版本不同互不兼容）
3. R2 last-good   ← rp-adapter/last-good-script-v2.js（最近一次验证通过的副本）
→ 全部失败：主页只注入 dirty-tracker，同步/图片显式报错
```

- 外部脚本存在且可加载时**必定优先**。Worker 拉取外部脚本（10s 超时、512KiB 上限、成功缓存 30s / 失败缓存 5s），通过 Pages ASSETS 内联注入主页，浏览器不发第二次请求。
- **作者改版后的维护动作只有一个**：写新版适配脚本 → 传到外部源。Worker、magic-extension、bootstrap、部署全部不动，刷新页面即生效。
- 兜底脚本保证首次部署开箱即用；last-good 保证外部源故障时站点仍可用。
- Worker 对脚本只做**轻校验**：非空、大小上限、含契约标记 `RPHubExternal`。不做字段级 schema 校验——适配脚本整体是可执行代码，任何字段级校验都是新的"一票否决"断点。
- Worker 侧自有配置（外部脚本 URL、ynai 中转端点）放在 `page/config.json`（纯 JSON，30s 缓存，R2 `rp-adapter/last-good-config-v2.json` 兜底），与适配脚本解耦。

### 2.2 稳定契约：window.RPHubExternal v2

系统侧（_worker.js / magic-extension.js / DB/bootstrap.js）**只依赖这个契约**，不依赖作者内部实现。适配脚本是实现契约的可执行代码：

| 成员 | 签名与语义 |
|---|---|
| `version` | 常量 `2`；系统侧校验，版本不符按未适配处理 |
| `anchors` | 锚点表版本字符串（诊断用） |
| `flush()` | 把作者内存数据落盘。返回 `{ok:true}` 或 `{ok:false, reason}`，**不 throw** |
| `context(card)` | 图片卡上下文 `{characterId, characterName, storyScopeId, message, messageIndex, autoImageGen, imageGenKey, busy}`；探测不到返回 `null` |
| `describeCard(card)` | 卡片槽位 `{messageIndex, occurrenceIndex}`；返回 `null` 表示无槽位 |
| `register(name, handler)` | 注册系统侧回调：`image-request`（图片任务）、`character-deleted`（角色清理）；返回解绑函数 |
| `imageKey()` | 作者设置里的生图密钥（可能为空串） |
| `capabilities()` | 逐能力健康度 `{sync, images, ..., saveMarkers, context, storage, mounted, flush, missing:[...]}` |
| `status()` | 诊断摘要（锚点版本、Vue/storage/state 状态、保存标记命中、注册钩子） |
| `installUi()` | 安装 UI（同步按钮、图片管理入口、固定生图开关、YNAI 下拉、滚动按钮） |

### 2.3 适配脚本内部规范

改版后写新脚本时按此规范，保证是机械劳动：

- **锚点集中在脚本头部 `ANCHORS` 常量区**：候选选择器数组（逐个尝试取第一个命中）、Vue setup 属性名候选、保存标记、DOM 结构类名。逻辑与锚点表分离。
- **UI 安装每步独立 try/catch**（reconcile 模式）：单步失败不拖垮其余步骤；MutationObserver + rAF 节流补装。
- **flush 的数据安全底线不放松**：无法确认作者保存完成（存储桥接缺失、保存标记缺失、数据仍在变化、事务中止）必须拒绝并报 reason，宁可拒绝同步也不提交可能缺最近修改的快照。
- **上下文探测失败返回 null**：图片退化为无固定记录缓存，同步不受影响。
- 保存定时器经作用域化 `setTimeout` 捕获；`flush` 重放这些定时器驱动作者防抖保存链路，直到"一轮内零写入、零待定事务、revision 稳定"。

### 2.4 注入与降级矩阵

主页注入顺序（HTML head 内联/追加）：`/DB/dirty-tracker.js` → 适配脚本正文（内联）→ `/magic-extension.js` → `/DB/bootstrap.js`。

| 故障 | 行为 |
|---|---|
| 外部脚本加载失败 | 自动回退兜底脚本（每次请求级） |
| 外部 + 兜底失败 | 回退 R2 last-good |
| 三层全失败 | 主页只注入 dirty-tracker；作者 app.js 始终原文 |
| 适配契约版本不符 | magic-extension/bootstrap 不启用增强（`version !== 2` 直接 return） |
| 单个 UI 锚点失效 | 仅该 UI 项缺失（reconcile 每步独立兜底） |
| 上下文探测失败 | 图片无固定记录（仍走代理缓存），同步不受影响 |
| 存储桥接/保存标记缺失 | flush 拒绝并报原因（数据安全） |

## 3. 同步协议 v2（`rp-sync/v2/`）

### 3.1 R2 对象布局

```
rp-sync/v2/manifest.json        全量根清单（JSON）
rp-sync/v2/packs/<sha256>.bin   gzip 后的内容寻址分片（customMetadata.entries = 记录数）
```

与旧版前缀互不读写；云端快照全新开始，首次上传完整重建。图片库 `rp-images/` 不受影响。

### 3.2 根清单

```json
{
  "format": "rp-sync-manifest-v2",
  "version": 3,                  // 单调递增 = 远端当前版本 + 1（由客户端生成）
  "updatedAt": 1730000000000,
  "compression": "gzip",
  "totalBytes": 980,             // Σ pack.length（gzip 后）
  "entryCount": 24,              // Σ pack.entries
  "checksum": "<hex64>",         // 内容校验和（见下）
  "packs": [                     // 权威顺序，恢复按此顺序应用
    { "bucket": "store:RPHubDB/store:data|s012", "checksum": "<hex64>", "length": 101, "entries": 3 }
  ]
}
```

**canonical 校验和源（三方一致，顺序敏感）**：

```js
JSON.stringify([
  'rp-sync-manifest-v2', root.compression, root.totalBytes, root.entryCount,
  root.packs.map(p => [p.bucket, p.checksum, p.length, p.entries])
])
```

- 校验和**只覆盖内容**，不含 version/updatedAt：同一份内容无论何时重建根，校验和恒定，"无变化上传"才能稳定判等（1 个 status 请求即完成）。version/updatedAt 是元信息，由版本单调守卫与 CAS etag 保护。
- 容量上限：快照 1GiB、分片 4096 个、单片 gzip 后 6MiB（原始 4MiB 由客户端保证）、单片 512 条记录。`entries` 允许 0：单条记录超过 4MiB 分片缓冲时先落一个纯字节填充片，记录本体跨片拼接，恢复端按行重组（JSONL 行拼接按桶+序聚合，协议天然支持）。

### 3.3 端点

| 端点 | 方法 | 语义 |
|---|---|---|
| `/api/rp-sync` | POST | JSON 动作：`auth-status` / `status` / `commit` / `sweep` |
| `/api/rp-sync/pack` | PUT | 上传一片（query：checksum/length/entries；正文 gzip 字节流式直通 R2，sha256 参数校验，条件创建；同内容幂等 204） |
| `/api/rp-sync/pack?c=<sha>` | GET | 下载一片（边缘 Cache API，immutable） |

认证：`RP_SYNC_PASSWORD` 设置后所有同步端点要求 `x-rp-sync-password` 头，否则 401。

### 3.4 上传流程（客户端）

1. `flushAppState()`：经适配层 flush 作者保存链路 → 图片记录落盘 → 变更日志事务收尾；`waitForIndexedDbWriteBarrier` 等在途写事务。
2. **无变化自动保存快速通道**（仅 automatic）：变更日志已全部确认（数字键为空、epoch 未变、无 localStorage 意图）+ 有未过验证间隔（1 小时）的"上次提交校验和"记忆 → 数据与云端根必然一致，整次跳过网络，只确认水位。每满 1 小时放行一次完整验证兜底；手动上传永远走完整流程。
3. `status`：取云端根（无则 null；与步骤 4 的本地准备并行）。
4. `prepareForUpload`：**后台预先准备 + 上传时增量收尾**（见 3.4.1）。
5. **无变化判定**：本地内容校验和 === 云端根校验和 → 只确认水位（acknowledge 变更日志），0 分片上传。
6. `PUT pack` ×N（并发 6；云端已有的校验和直接跳过；本地缓存保存 gzip 字节，重传直接复用）。
7. `commit {manifest}`：Worker 读当前根 → 版本单调校验（落后 409）→ **list 校验全部分片存在且大小一致**（1-5 次 list，替代逐包 head；缺包 409 返回 missing 列表，客户端按桶重建补传后再提交，最多 3 轮）→ etag CAS 切根（CAS 失败自动重读重试，最多 3 轮）→ 对比新旧根**顺带批量删除孤儿分片**，响应带回未确认删除的残留数（`reclaimed`）。
8. `sweep` 兜底回收只在 `reclaimed > 0` 时补发（正常提交零残留时省一趟往返）。
9. `acknowledge` 水位 + 记录"上次提交校验和"（快速通道判定材料）。

#### 3.4.1 后台预先准备

"上传前才开始找文件、做差分、压缩分片"是上传等待的主要来源，解决方式是把整个准备阶段**提前到后台完成**：

- **触发器**：dirty-tracker 在每次受追踪业务写入后派发 `rphub:dirty` 事件 → 客户端防抖 8 秒触发后台准备；页面加载 3 秒后预热一次（首次使用无本地索引时，**提前完整扫描**，首次上传不再从零等待）；回到前台 1 秒内补一次。
- **变更日志增量消费**：本地缓存状态记录各库已消费的 journal 水位（`journalWatermark`，自增主键）。增量准备只扫描水位之后的新事件——历史事件早已差分进缓存，重放只会靠字节比较幂等地空转。持续聊天时后台准备成本恒定（只与新增量成正比），不随会话长度累积。水位在每次准备完成后原子推进；索引失效（版本/epoch/journal 重置）时水位随索引整体作废，恢复流程清空派生索引后自动回到全量扫描。
- **后台准备内容**：读变更日志候选键 → 缓存差分（严格增量）→ 按桶组装 4MiB 分片 → **逐片 gzip** → 内容寻址写入本地分片缓存。全部是纯本地操作，零网络请求。
- **单飞互斥**：后台准备与上传准备共用一个单飞 Promise，永不并发写缓存。上传调用 `prepareForUpload`：先等在飞的后台准备收尾（等待期间**解除低占空比**，剩余增量全速完成），再跑一次增量收尾（后台刚完成时差分为空、瞬间完成，同时保证覆盖最后几秒的新写入）。
- **status 与准备并行**：`commitObjectSnapshot` 的 `status` 网络往返与本地快照准备互不依赖，并行执行——高延迟线路上省一次串行往返（点击到开传之间最贵的一段）。
- **索引缺失/过期**：后台自动静默完整重建（只读本地数据）；上传路径的"确认后重建"仅作兜底。
- **效果**：稳态下点"上传"几乎立即进入网络阶段；期间打开同步面板可实时看到准备进度。上传开始时的 `flushAppState`（等作者保存链路落盘）是数据安全要求，不属于可提前的部分。
- **手机端资源占用**：
  - 增量准备（日常）：只处理真正变化的记录 + 重建受影响桶（300MB 库约 1.2MiB 的拷贝 + gzip），中端手机几十至几百毫秒 CPU，写入停止 8 秒后才跑、页面可见才跑、**零网络流量**，无感。
  - 完整扫描（首装/索引失效，一次性）：后台运行时启用**低占空比模式**（工作 6ms → 让出 8ms，约 43%），不持续烧 CPU、不抢作者前端性能；上传路径保持全速不受影响（点击上传还会解除在飞后台准备的低占空比）。
  - 页面切后台自动停（浏览器冻结隐藏页定时器，扫描自然暂停，回前台继续/重试）；内存有界：4MiB 分片缓冲复用、条目批量写 64 条/约 8MiB 估算、峰值约 20～30MiB。

**增量粒度说明**：分片按 256 个稳定桶组装，增量重传的粒度是"桶"（300MB 库约 1.2MiB/桶）。追加大消息/新消息只触及 1～2 个桶；若一次修改随机散布到大量记录（如批量改写旧消息），会触及较多桶并整桶重建——这与旧版桶布局特性一致，且请求字节数仍因 gzip 显著更小。

### 3.5 恢复流程（客户端）

1. `status` → 客户端按同一 canonical 源重算校验和验证根清单。
2. `GET pack` ×N（滑动窗口并发 6）：gzip 字节先按清单校验 SHA-256 与长度 → 解压出 raw JSONL → 写 staging（IndexedDB `RPHubSyncStaging`）；gzip 字节同时写入本地分片缓存（命中缓存只验长度，不再下载）。
3. **两遍安全语义**：第一遍（validateOnly）解析全部行、校验记录结构/顺序/桶归属/无重复键，不触碰业务数据；全部通过后才设置恢复标记（其他标签页暂停写入并显示遮罩），写屏障等在途写事务收尾。
4. 第二遍从 staging 逐片读取：恢复 localStorage/IndexedDB、重建缓存条目索引（canonical 行字节精确复制，禁止共享 backing buffer）、重建条目索引；随后确认水位、清除恢复标记、刷新页面。
5. 恢复失败保留已校验分片缓存，只清派生索引，重试无需重新下载。

### 3.6 无用（孤儿）分片的处理

分片是内容寻址的不可变对象，"无用" = 不被当前根清单引用。四道机制覆盖所有产生路径：

| 产生路径 | 处理机制 | 时机 |
|---|---|---|
| 提交新根后被替换掉的旧分片 | **提交即回收**：Worker 对比新旧根的校验和集合，批量删除差集（waitUntil，不阻塞提交响应） | 每次成功 commit |
| 上传了分片但从未 commit（中断/放弃的上传） | **sweep 兜底**：列出全部分片，删除当前根不引用且对象时间超过 **1 小时宽限期**的对象 | 每次成功 commit 后后台跑一次；宽限期防止误删并发上传中、尚未 commit 的分片 |
| commit 缺包补传后，新旧校验和不一致的旧分片 | 成为孤儿 → 同上被 sweep 回收 | 同上 |
| 客户端本地缓存的分片不在当前清单 | **pruneCachedPacks**：按当前清单清理本地缓存 | 每次上传准备 |

原则：删除失败只留垃圾、不留风险（下一轮 sweep 按同样依据重判）；宽限期内绝不删除，宁可多留也不误删正在上传的数据。旧版协议的四阶段 GC 状态机、Bloom filter、上传会话保护在此全部不需要——单用户 + 全量根清单让引用判断变成一次内存差集（sync 协议冒烟测试覆盖了提交回收、sweep 宽限与幂等重判）。

## 4. 图片模块

- R2 键：`rp-images/characters/<角色名>/<签名sha256>`（缩略图 `rp-images/thumbs/.../....webp`，墓碑 `rp-images/_deleted/.../*.json`）。签名 provider 恒 `sta1n`——ynai/sta1n 共享同一内容寻址缓存，历史键稳定。
- **与旧版部署逐字节兼容（重写期间经交叉测试验证后退役）**：图片键推导（参数集、默认值、签名 JSON、键路径、缩略图/墓碑派生键）与旧 Worker 逐字节一致，验证套件（原 `image-compat.mjs`）曾让新旧 Worker 共用同一 R2 桶交叉确认：同参数键一致、旧图直接命中缓存复用、缩略图跨版本读写、墓碑跨版本生效。兼容性成立后该套件连同旧 Worker 参考一并移除；同一 R2 桶先旧版后新版部署，已有图片库无缝沿用（生产已验证）。
- 生图只接受 POST（GET/HEAD 只读缓存或 404）；24MiB/16MiB（ynai JSON）/2MiB（缩略图）有界读取；墓碑优先读取（删除后的生图读取立即返回占位图，不泄漏旧图）。
- 两阶段删除：先写墓碑并返回，后台清理原图/缩略图；每请求 ≤20 目标，清空角色按游标续传。**图片墓碑不参与分片回收**——它们有自己的生命周期，删除墓碑会让旧链接重新生图。
- `/image` 图库页是静态资产 `page/gallery.html`（Worker 经 ASSETS 提供）；管理端点与聊天端点共用缩略图读写实现。
- ynai 中转端点只认 `page/config.json`（无代码兜底，配置缺失时 ynai 生图显式 503）。

## 5. 测试

```text
cd tests && npm ci
npm test              # audit + protocol + images + legacy + magic（unit）；client-sim + realistic-sim + adapter-contract（runtime）
npm run scale         # 真实客户端代码路径的规模模拟（SCALE_MB 默认 300，可用 5 预检）
npm run realistic     # 真实形态模拟（SIM_CHARS/SIM_CHATS/SIM_MSGS/SIM_B64_* 可调角色卡/长对话/内嵌图规模）
npm run sync-perf     # 同步性能：后台准备耗时基准 + journal 增量消费正确性验证
```

| 文件 | 覆盖 |
|---|---|
| `audit-regressions.mjs` | 双写协议常量逐字一致、三方 canonical 源一致、无旧协议残留、Worker 结构约束（单文件/无 import/脚本链顺序）、page/ 文件集完整 |
| `protocol-smoke.mjs` | 适配脚本链（注入顺序/外部优先/失败回退/last-good 持久化）、同步协议（上传/幂等/缺包 409/版本单调/CAS 收敛/孤儿回收/sweep/下载/密码门禁） |
| `image-regressions.mjs` | 生图签名与键稳定、缓存与 ETag、GET 不生图、角色名净化、缩略图、墓碑两阶段删除、24MiB 上限、ynai/sta1n 路由、模型列表、图库页 |
| `legacy-upgrade.mjs` | v1 遗留本地状态升级回归（旧缓存索引/旧日志/旧分片残留）+ 中断续传：分片元数据始终合法 |
| `magic-behavior.mjs` | **真实适配脚本 + 真实 Vue 桥接 + 真实 magic-extension**：生图全链路（hydrate→imageTask→上游一次→固定记录落库）、重渲染复用记录不重新生成、无记录 key 直读不打上游、缩略图回填通路、图片 flush |
| `realistic-sim.mjs` | 真实形态假数据（角色卡/长对话/内嵌 base64 图/设置键）端到端：首次上传、无变化 1 请求、会话续写增量、图片库全流程、全量恢复字节级抽查、恢复缓存命中 |
| `client-sim.mjs` | jsdom + fake-indexeddb + **真实** bootstrap/dirty-tracker/worker 端到端：首次上传、无变化 1 请求、严格增量、恢复、二次恢复缓存命中、单条超 4MiB 大记录（entries=0 填充片跨片拼接）、规模模式（分片数、压缩率、请求数） |
| `adapter-contract.mjs` | 真实 Vue + 真实适配脚本 + 模拟作者 app：契约 v2、能力报告、保存标记捕获、flush 稳定判定、忙碌拒绝、上下文/槽位、注册钩子 |
| `background-prepare-bench.mjs` | 后台索引维护基准：持续聊天（每轮追加消息）+ 周期后台准备，断言准备耗时恒定（增量消费生效，不随累积增长） |
| `journal-incremental-verify.mjs` | journal 增量消费正确性：水位推进、三轮后台准备增量进快照、上传捕获未准备写入、恢复后字节级对比、A 页 journal 清空 |
| `day-sim.mjs` | **"用户的一天"全行为随机交错模拟**（虚拟时钟 24h 压缩到约 2 分钟）：聊天/swipe/生图/重掷/删图/导入与删除角色卡/删除会话/分支新聊天/手动上传/真实自动保存调度器（虚拟时钟驱动，含页签隐藏暂停）/双设备拉取。固定种子可复现；产出请求账单、无变化同步占比、快速通道命中数、sweep 触发数、孤儿记录拓扑、全量恢复字节级抽查 |

测试基建：`lib/r2.mjs`（内存 R2 兼容桶：条件写/sha256 校验/list 游标）、`lib/worker.mjs`（Worker 装载器 + HTMLRewriter 桩 + 作者上游拦截）。全部外网在测试内拦截，不访问远端。

已知与旧套件的差异：旧版 300KB 套件中的预算套件（sync-v13-budget）与逐项崩溃回归未逐一移植——v2 协议的请求形状大幅减少（无会话/分页/GC 状态机），protocol-smoke 与 client-sim 已覆盖对应关键路径；规模模拟改用真实客户端代码路径，保真度更高。

## 6. 维护约定

- Worker 保持单文件、无构建步骤、无 `import`/顶层 `await`。
- `page/` 是唯一发布正本；本地手动部署直接上传该目录，部署器（`deployer/worker.js`）部署/更新时实时从仓库 `main` 的 `page/` 拉文件，无需打包 page.zip。
- 改同步协议必须同时改 `page/_worker.js`、`page/DB/bootstrap.js`、`tests/`（三方 canonical 校验和源逐字一致，audit-regressions 有断言）。
- `page/DB/dirty-tracker.js` 与 `page/DB/bootstrap.js` 的协议常量是**人肉双写副本**，任何一侧改名必须双侧同步（audit-regressions 静态断言逐字比较）。
- 改适配层时：锚点变化只改 `ANCHORS` 表；契约变化必须升 `version` 并同步系统侧。
- 不推送 GitHub（除非明确要求）；不删除线上 R2 数据作为"清理工作区"。
- 免费版资源上限优先于代码美观：禁止把全量分片、完整根清单聚进单次 Worker 内存（根清单除外，≤1MiB 有界读取）。

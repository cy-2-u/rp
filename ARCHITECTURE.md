# 架构文档（ARCHITECTURE）

面向维护者：适配脚本链与契约、同步协议、测试体系与维护约定。

## 1. 设计前提

- **个人单用户**：同步是整体替换语义，不为并发设计任何机制；多标签页靠一把 Web Locks 互斥锁串行化全部同步操作。
- **国内高延迟**：一切协议决策向"更少请求、更少字节"倾斜——分片 gzip 内容寻址、无变化零请求、增量只动受影响的桶。
- **Cloudflare 免费版**：分片正文永远由 Worker 把 `request.body` 流式直通 R2（FixedLengthStream + 条件写），不进 isolate 内存聚合。
- **作者前端会变**：应对手段是更新一个外部可执行脚本（第 2 节），不是自动探测魔法。
- **正文直通、计算给浏览器**：差分/分片/gzip 全部在客户端完成，Worker 只做校验与转发。

## 2. 适配脚本链（核心）

### 2.1 脚本链

```
1. 外部适配脚本   ← page/config.json 的 adapter.externalUrl（env RPHUB_ADAPTER_URL 可覆盖）
2. 部署兜底脚本   ← page/adapter/rp-hub-v2.js（开箱即用）
3. R2 last-good   ← rp-adapter/last-good-script-v2.js（最近一次验证通过的副本）
→ 全部失败：主页只注入协议内核与变更追踪，同步/图片显式报错
```

- 外部脚本必定优先：Worker 拉取（10s 超时、512KiB 上限、成功缓存 30s/失败 5s、按源 URL 键控），经 ASSETS 内联注入主页。**作者改版后的维护动作只有一个**：写新脚本 → 传到外部源，刷新即生效。
- 轻校验：非空、大小上限、含契约标记 `RPHubExternal`。可执行代码不做字段级 schema 校验——任何字段级校验都是新的一票否决点。
- **注入只在主页**（`/` 与 `/character`、`/novel` 等工坊页不注入）：作者把角色工坊拆成了独立页，那边没有聊天数据可同步。
- 旧版契约 v1 脚本 `page/adapter/rp-hub.js` **只存于 GitHub 仓库历史**（旧版部署的外部脚本源），本地正本与部署清单均不含它。【勿删远端文件】推送仓库时若本地无此文件会连带删除，旧版部署用户将断供。

### 2.2 稳定契约：window.RPHubExternal v2

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

### 2.3 与作者真实代码的对接事实（2026-11 实测）

- 作者存储层：`window.RPHubStorage = Object.freeze({...})`，方法为内联箭头函数直连 dbSet/dbGet；适配层经 `defineProperty` 拦截赋值并包装（冻结原对象不可写，包装出的是新对象）。app.js 在 data-services.js 之后装载，解构到的已是包装版。
- 写入追踪包装：`setStoredValue / deleteStoredValue / setScopedStoredValue / deleteScopedStoredValue`（作者还有裸 `deleteStoredValue`，必须一并包装，否则删除类写入不进 flush 等待）。
- **角色删除钩子**：作者删除角色时对 `CHARACTER_SCOPED_STORAGE_NAMES = ['chat','classic_memories','branches']` 的每个作用域名调用 `deleteScopedStoredValue(name, id)`，id 含裸角色 uuid 与分支 scopeId。适配层在 `name === 'branches'` 时触发 `character-deleted(id)`；分支 scopeId 传入属无害空操作（不匹配任何记录键）。
- 保存 watcher 标记：`_memorySettingsSaveTimer / debouncedCharacterSave / debouncedSave / scheduleChatHistorySave`，均存于 app.js；适配层经包装 `Vue.watch` 按函数文本捕获。
- 写新脚本的规范：锚点全集中在头部 `ANCHORS`；UI 安装经 MutationObserver + reconcile，每步独立容错；**flush 无法确认作者保存完成必须拒绝**；上下文探测失败返回 null（图片退化、同步不受影响）。
- 作者自己的 cloud-backup（键控式云端备份）与本项目并存不冲突。

注入顺序：core.js → client.js（事务日志/写屏障）→ 适配脚本（内联）→ images.js → sync.js（后两者 defer）。

## 3. 同步协议 v2（`rp-sync/v2/`）

### 3.1 布局与根清单

```
rp-sync/v2/manifest.json        全量根清单（JSON，内含完整分片列表）
rp-sync/v2/packs/<sha256>.bin   gzip 后内容寻址分片（customMetadata.entries = 记录数）
```

```json
{ "format": "rp-sync-manifest-v2", "version": 3, "updatedAt": 1730000000000,
  "compression": "gzip", "totalBytes": 980, "entryCount": 24, "checksum": "<hex64>",
  "packs": [{ "bucket": "source:<sha256>", "checksum": "<hex64>", "length": 101, "entries": 3 }] }
```

**canonical 校验和源（Worker 与 core.js 逐字双写，parity 测试断言）**：

```js
JSON.stringify([FORMAT, m.compression, m.totalBytes, m.entryCount,
  m.packs.map(p => [p.bucket, p.checksum, p.length, p.entries])])
```

- checksum 只覆盖内容（不含 version/updatedAt）：无变化上传靠它 1 个 status 判等；version 单调递增 + CAS etag 防过期覆盖。
- 上限：快照 1GiB、4096 分片、单片 gzip 6MiB（原始 4MiB）、512 条。`entries` 允许 0：单条记录超分片缓冲时先落纯字节填充片，记录跨片拼接，恢复按行重组。

### 3.2 源分片布局（客户端，与旧实现的差别）

快照不是"全库按桶切块"，而是**按源组织**：

```
localStorage            → 全部应用键值一组
header:<db>             → 数据库头（版本/store 定义）
bucket:<db>/<store>/<0..63> → 每个对象存储固定 64 桶（FNV-1a(canonical(key)) % 64）
footer:<db>/<store>     → storeEnd 标记
end:<db>                → databaseEnd 标记
```

- 每个源独立 4MiB 缓冲分片；**未变化分片凭原始内容摘要跳过压缩**（rawHashes 与上次对比），改一条记录只重压所在桶。
- 小记录库不再爆分片数：5000 条小记录 67 片（逐记录布局会 5000+ 片撞 4096 上限）；300MiB 库 129 片。
- 恢复端按 header → bucket → footer → end 顺序逐行校验（键序、内联键一致、无重复、跨桶不串），两遍语义：validateOnly 全量校验 → 写冻结标记（其他标签页被 client.js 拦截写入+遮罩）→ 写屏障 → 第二遍应用 → 清派生索引。
- 变更日志水位（journal 自增主键）随快照同一事务持久化：后台准备只扫水位之后的新事件，成本恒定；上传成功 acknowledge 合并水位。索引失效（layout/epoch/库集变化）自动全量重建自愈。

### 3.3 端点

| 端点 | 方法 | 语义 |
|---|---|---|
| `/api/rp-sync` | POST | JSON 动作：`auth-status` / `status` / `commit` / `sweep` |
| `/api/rp-sync/pack` | PUT | 上传一片（sha256 条件写、FixedLengthStream 定长直通、幂等 204） |
| `/api/rp-sync/pack?c=` | GET | 下载一片（边缘 Cache API，immutable，需密码头） |

认证：`RP_SYNC_PASSWORD` 设置后所有同步端点与图库管理端点要求 `x-rp-sync-password` 头。图库页面里图片经 fetch+blob 读取，密码不进 URL。

### 3.4 上传流程（客户端）

1. `RPHubExternal.flush()`（作者保存链路）→ `RPH_MAGIC_FLUSH_IMAGES`（图片记录落盘）→ 写屏障。
2. buildSnapshot 增量准备；status 与准备并行不了的部分省略——准备完成后本地算根校验和。
3. **无变化快速通道**（仅自动保存）：journal 已全部确认 + 未过 1 小时验证间隔 ⇒ 零网络直接 acknowledge。
4. status 判等 ⇒ "已是最新"；否则并发 6 路 PUT 缺失分片 → commit（版本单调 + 缺包 409 带回 missing 补传，最多 3 轮）。
5. commit 响应带 `reclaimed`：>0 或距上次清扫满 1 天 ⇒ sweep 兜底（清中断上传的孤儿，1 小时宽限）。
6. 本地分片缓存按新根修剪；acknowledge 水位。

### 3.5 多标签页与崩溃安全

- `navigator.locks.request('rp-sync-v2')` 串行化 prepare/upload/restore——快照从生成到确认期间不被并发修改。
- 恢复冻结：`rp_sync_restore_active` + epoch 双标记，client.js 在事务与 Storage 层直接抛错拦截写入，并显示遮罩。
- 触库写屏障：恢复前对每个库发起一次 readwrite 事务，确保在飞事务全部落盘再取水位。
- 后台准备低占空比（工作 6ms → 让出 8ms），上传路径全速；页面隐藏自动暂停。

## 4. 图片模块

- R2 键：`rp-images/characters/<角色名>/<签名sha256>`（缩略图 `thumbs/`、墓碑 `_deleted/`）。签名 provider 恒 `sta1n`——ynai/sta1n 共享内容寻址缓存，历史键稳定；参数表与默认值在 Worker 与 images.js 双写，parity 测试断言。
- 生图只接受 POST（GET/HEAD 只读或 404，爬虫不扣费）；24MiB/16MiB/2MiB 有界读取；墓碑优先（删除后旧链接返回占位 SVG）。
- 两阶段删除：先墓碑后台清理；每请求 ≤20 目标，清空角色游标续传。墓碑不参与分片回收。
- **聊天卡片恒显原图**（懒加载 IntersectionObserver）；图库页自带按需缩略图回填（320px WebP，并发 2），与聊天互不影响。
- ynai 端点只认 `page/config.json`，缺失时显式 503。

## 5. 测试

```text
npm test          # parity + worker(25) + client + adapter + sync + images + roundtrip + author(46)
npm run scale     # 300MiB 规模（RP_MIB 可调）
npm run serve     # 本地验收服务器；RP_FIXTURE=1 时作者源站=真实作者线上版 fixture
npm run lint      # ESLint 死代码门禁
```

| 文件 | 覆盖 |
|---|---|
| `tests/parity.mjs` | Worker↔core.js 协议双写（布局/校验和源/限额）、图片参数表、密码键、资产清单、契约版本 |
| `tests/worker.mjs` | 鉴权、缺包 409、条件写、长度不符、提交幂等、缓存鉴权、墓碑、删除故障、HEAD 透传、注入完整性 |
| `tests/client.mjs` | 事务日志原子性、中止不留脏、水位确认、恢复冻结 |
| `tests/adapter.mjs` | 真实 Vue UMD 初始化、4 个保存标记捕获、防抖定时器排空、flush |
| `tests/sync.mjs` | 全量建索引、重复准备稳定、单桶增量、分片缓存校验、长会话追加 |
| `tests/images.mjs` | 禁止生图语义、固定记录、已有图保留、角色删除清理 |
| `tests/roundtrip.mjs` | 上传→无变化零请求→恢复字节级→本地清理→预设保留 |
| `tests/author.mjs` | **真实作者线上版锚点审计**：适配层 ANCHORS 单源提取，逐项在 fixture 中核对 |
| `tests/scale.mjs` | 300MiB：分片数、耗时、无变化零压缩、增量 |
| `tests/serve.mjs` | 真实浏览器验收服务器（内存 R2）；`RP_FIXTURE=1` 切换真实作者 fixture |

测试基建：`tests/platform.mjs`（内存 R2 桶——含定长流与条件写拒绝语义、Cache、FixedLengthStream、HTMLRewriter 桩）。

## 6. 维护约定

- Worker 单文件、无构建、无 import/顶层 await；代理超时 = 8s 响应头 + 30s 正文空闲（bodyIdleGuard），慢线路长正文不断流。
- `page/` 是唯一发布正本（11 文件，其中 `adapter/rp-hub.js` 为旧版契约存档、不参与部署）；手动部署上传其余 10 个。
- 改同步协议必须同时改 `page/_worker.js` 与 `page/core.js`，跑 `npm test`（parity 会拦双写漂移）。
- 改适配层：锚点变化只改 `ANCHORS` 并跑 `npm test`（author 审计逐项核对 fixture）；契约变化必须升 `version` 并同步系统侧。
- 作者改版维护流程：`curl` 拉新版 → 覆盖 `tests/fixtures/author/` → `npm test` → 按失活项改 ANCHORS → 新脚本传外部源。fixture 是作者代码的本地快照，因版权不入公开仓库（.gitignore 已排除），换机器需重新拉取。
- 不推送 GitHub（除非明确要求）；不删除线上 R2 数据。
- 免费版上限优先于美观：禁止把全量分片聚合进单次 Worker 内存（根清单除外，≤1MiB 有界读取）。

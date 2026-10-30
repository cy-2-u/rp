// 客户端端到端模拟：真实 bootstrap.js + dirty-tracker.js 跑在 jsdom +
// fake-indexeddb 里，fetch 直连真实 _worker.js 与 fake R2。覆盖：
// 首次上传、无变化上传（1 请求）、严格增量、从云端恢复、恢复缓存命中。
// --scale 模式（npm run scale）以 SCALE_MB（默认 300）生成大数据量验证规模。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import {
    IDBFactory, IDBKeyRange, IDBDatabase, IDBObjectStore, IDBIndex,
    IDBTransaction, IDBRequest, IDBCursor, IDBVersionChangeEvent
} from 'fake-indexeddb';
import workerModule from '../page/_worker.js';
import { createR2Bucket } from './lib/r2.mjs';
import { assert, assertEqual } from './lib/worker.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pageDir = join(here, '..', 'page');
const DIRTY_SOURCE = readFileSync(join(pageDir, 'DB', 'dirty-tracker.js'), 'utf8');
const BOOTSTRAP_SOURCE = readFileSync(join(pageDir, 'DB', 'bootstrap.js'), 'utf8');

const SCALE_MODE = process.argv.includes('--scale');
const SCALE_MB = Number(process.env.SCALE_MB || 300);

function makeWorker() {
    const bucket = createR2Bucket();
    const env = {
        RP_SYNC_R2: bucket,
        ASSETS: {
            async fetch() {
                return new Response('asset not found', { status: 404 });
            }
        }
    };
    const ctx = { waitUntil(promise) { void Promise.resolve(promise).catch(() => { }); } };
    const counters = { syncPost: 0, packPut: 0, packGet: 0 };
    async function workerFetch(path, init) {
        return workerModule.fetch(new Request(`https://site.test${path}`, init), env, ctx);
    }
    return { bucket, workerFetch, counters };
}

const IDB_MEMBERS = [
    ['IDBKeyRange', IDBKeyRange], ['IDBFactory', IDBFactory], ['IDBDatabase', IDBDatabase],
    ['IDBObjectStore', IDBObjectStore], ['IDBIndex', IDBIndex], ['IDBTransaction', IDBTransaction],
    ['IDBRequest', IDBRequest], ['IDBCursor', IDBCursor], ['IDBVersionChangeEvent', IDBVersionChangeEvent]
];

function setupBrowser({ url, worker, seed } = {}) {
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', error => {
        if (!String(error?.message || '').includes('Not implemented')) throw error;
    });
    // 页面脚本里的 console 输出转发到 Node（诊断用）。
    virtualConsole.on('error', (...args) => console.error('[page]', ...args));
    virtualConsole.on('warn', (...args) => console.warn('[page]', ...args));
    virtualConsole.on('log', (...args) => console.log('[page]', ...args));
    const dom = new JSDOM('<!doctype html><html><head></head><body><div id="app"></div></body></html>', {
        url: `https://site.test${url}`,
        pretendToBeVisual: true,
        runScripts: 'outside-only',
        virtualConsole
    });
    const { window } = dom;
    const factory = new IDBFactory();
    window.indexedDB = factory;
    globalThis.indexedDB = factory;
    for (const [name, ctor] of IDB_MEMBERS) {
        window[name] = ctor;
        globalThis[name] = ctor;
    }
    // jsdom 缺失的 Web API 用 Node 本体补齐（脚本在 window 作用域求值）。
    // 类型构造器（Uint8Array/ArrayBuffer 等）也统一指向 Node 本体：
    // fake-indexeddb 以 Node 的 structuredClone 克隆值，读回的对象是 Node
    // realm 实例，页面内的 instanceof 判定必须与之同 realm 才可靠。
    for (const name of ['CompressionStream', 'DecompressionStream', 'TextEncoder', 'TextDecoder',
        'Blob', 'Response', 'Headers', 'Request', 'structuredClone', 'AbortController', 'AbortSignal',
        'Uint8Array', 'ArrayBuffer', 'DataView', 'Uint32Array', 'Int8Array']) {
        if (globalThis[name] && window[name] !== globalThis[name]) window[name] = globalThis[name];
    }
    Object.defineProperty(window, 'crypto', { value: globalThis.crypto, configurable: true });
    window.fetch = async (input, init) => {
        const resolved = new URL(typeof input === 'string' ? input : input.url, 'https://site.test');
        if (resolved.origin !== 'https://site.test') throw new Error(`unexpected client fetch: ${resolved.href}`);
        if (resolved.pathname === '/api/rp-sync/pack') {
            if ((init?.method || 'GET') === 'PUT') worker.counters.packPut += 1;
            else worker.counters.packGet += 1;
            return worker.workerFetch(resolved.pathname + resolved.search, init);
        }
        if (resolved.pathname === '/api/rp-sync') {
            worker.counters.syncPost += 1;
            return worker.workerFetch(resolved.pathname + resolved.search, init);
        }
        throw new Error(`unexpected client fetch: ${resolved.pathname}`);
    };
    window.confirm = () => true;
    window.alert = () => { };
    // 适配层桩：client-sim 不加载真实适配脚本，按契约 v2 提供最小实现
    //（flush 恒成功、无上下文），bootstrap 只依赖契约。
    window.RPHubExternal = {
        version: 2,
        async flush() { return { ok: true }; },
        describeCard() { return null; },
        context() { return null; },
        register() { return () => { }; },
        imageKey() { return ''; },
        capabilities() { return { flush: true, missing: [] }; },
        installUi() { }
    };
    globalThis.localStorage = window.localStorage;
    globalThis.document = window.document;
    globalThis.location = window.location;
    window.eval(DIRTY_SOURCE);
    window.eval(BOOTSTRAP_SOURCE);
    return { window, dom, idb: factory };
}

function openRaw(factory, name, upgrade) {
    return new Promise((resolve, reject) => {
        const request = factory.open(name);
        if (upgrade) request.onupgradeneeded = () => upgrade(request.result);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
    });
}

async function seedData(window, { records = 3, recordBytes = 2000, localStorageKeys = 2 } = {}) {
    await pageEvalAsync(window, `(async () => {
        const records = ${records}, recordBytes = ${recordBytes}, localStorageKeys = ${localStorageKeys};
        const filler = 'x'.repeat(recordBytes);
        await new Promise((resolve, reject) => {
            const request = indexedDB.open('RPHubDB', 1);
            request.onupgradeneeded = () => { request.result.createObjectStore('store'); };
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const db = request.result;
                const tx = db.transaction(['store'], 'readwrite');
                for (let index = 0; index < records; index += 1) {
                    tx.objectStore('store').put(
                        { id: 'chat:' + index, messages: [{ role: 'user', text: '你好 ' + index + ' ' + filler }, { role: 'ai', text: '回复 ' + index + ' ' + filler }] },
                        'chat:' + index
                    );
                }
                tx.oncomplete = () => { db.close(); resolve(); };
                tx.onerror = () => reject(tx.error);
            };
        });
        for (let index = 0; index < localStorageKeys; index += 1) {
            localStorage.setItem('rp_hub_pref_' + index, JSON.stringify({ index, note: filler.slice(0, 64) }));
        }
        return true;
    })()`);
}

async function updateRecordInPage(window, key, valueSource) {
    await pageEvalAsync(window, `(async () => {
        await new Promise((resolve, reject) => {
            const request = indexedDB.open('RPHubDB');
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const db = request.result;
                const tx = db.transaction(['store'], 'readwrite');
                tx.objectStore('store').put((${valueSource}), ${JSON.stringify(key)});
                tx.oncomplete = () => { db.close(); resolve(); };
                tx.onerror = () => reject(tx.error);
            };
        });
        return true;
    })()`);
}

async function readAllRecords(factory, dbName, storeName) {
    const db = await openRaw(factory, dbName);
    try {
        const tx = db.transaction([storeName], 'readonly');
        const request = tx.objectStore(storeName).getAll();
        return await new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    } finally {
        db.close();
    }
}

async function journalRowCount(factory, dbName) {
    const db = await openRaw(factory, dbName);
    try {
        const tx = db.transaction(['__rp_sync_journal_v2'], 'readonly');
        const request = tx.objectStore('__rp_sync_journal_v2').count();
        return await new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    } finally {
        db.close();
    }
}

async function waitForSyncDone(window, timeoutMs = 60_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const badge = window.localStorage.getItem('rp_hub_sync_last_result_v1');
        if (badge) {
            const record = JSON.parse(badge);
            if (record.ok === false) throw new Error('同步失败：' + (window.document.querySelector('.rp-sync-modal__status')?.textContent || ''));
            if (record.ok === true) return record;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('等待同步完成超时');
}

async function readCloudManifest(bucket) {
    const object = await bucket.get('rp-sync/v2/manifest.json');
    return object ? JSON.parse(await object.text()) : null;
}

async function intentKeyCount(window) {
    let count = 0;
    for (let index = 0; index < window.localStorage.length; index += 1) {
        const key = window.localStorage.key(index);
        if (key?.startsWith('rp_sync_intent_v2:')) count += 1;
    }
    return count;
}

// 在页面 realm 内执行异步代码并等待完成：业务数据必须由 jsdom realm 创建，
// 否则 Node 侧对象的原型链会让 bootstrap 的 canonical 序列化器跨 realm 误判。
function pageEvalAsync(window, code) {
    window.__pageResult = null;
    window.eval(`(async () => {
        try {
            const result = await (${code});
            window.__pageResult = { ok: true, value: result === undefined ? null : result };
        } catch (error) {
            window.__pageResult = { ok: false, error: String((error && error.message) || error) };
        }
    })()`);
    return (async () => {
        for (let waited = 0; waited < 60000 && !window.__pageResult; waited += 5) {
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        const result = window.__pageResult;
        if (!result) throw new Error('page eval 超时');
        if (!result.ok) throw new Error('page eval 失败: ' + result.error);
        return result.value;
    })();
}

function clearBadge(window) {
    window.localStorage.removeItem('rp_hub_sync_last_result_v1');
}

async function uploadViaUi(window) {
    clearBadge(window);
    window.RPH_R2_OPEN_SYNC();
    // 等锁页静默验证与面板装配完成后再点击。
    for (let waited = 0; waited < 5000; waited += 20) {
        if (window.document.querySelector('[data-action="push"]')) break;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    const push = window.document.querySelector('[data-action="push"]');
    if (!push) throw new Error('同步面板未装配');
    push.click();
    return waitForSyncDone(window);
}

async function defaultRun() {
    const worker = makeWorker();
    const seedSnapshot = {};

    // ---- 场景 A：首次上传 ----
    const a = setupBrowser({ url: '/', worker });
    await seedData(a.window, { records: 3, recordBytes: 2000, localStorageKeys: 2 });
    seedSnapshot.records = await readAllRecords(a.idb, 'RPHubDB', 'store');
    seedSnapshot.prefs = Object.fromEntries([...Array(a.window.localStorage.length)].map((_, index) => {
        const key = a.window.localStorage.key(index);
        return [key, a.window.localStorage.getItem(key)];
    }));

    const first = await uploadViaUi(a.window);
    assert(first.ok, '首次上传成功');
    const manifest1 = await readCloudManifest(worker.bucket);
    assert(manifest1 && manifest1.packs.length >= 1, '云端出现根清单与分片');
    assertEqual(await intentKeyCount(a.window), 0, '上传后 localStorage 意图键清空');
    assertEqual(await journalRowCount(a.idb, 'RPHubDB'), 1, '上传后日志只余 epoch 行');
    const packCount1 = (await worker.bucket.list({ prefix: 'rp-sync/v2/packs/' })).objects.length;
    assertEqual(packCount1, manifest1.packs.length, '云端分片与清单一致（提交即回收）');

    // ---- 无变化上传：1 个 JSON 请求、0 个分片 ----
    worker.counters.syncPost = 0;
    worker.counters.packPut = 0;
    await uploadViaUi(a.window);
    assertEqual(worker.counters.packPut, 0, '无变化上传 0 分片');
    assertEqual(worker.counters.syncPost, 1, '无变化上传仅 1 次 status 请求');

    // ---- 严格增量：改 1 条记录（页面 realm 内写入）+ 新增 1 条 localStorage ----
    await updateRecordInPage(a.window, 'chat:0', "{ id: 'chat:0', messages: [{ role: 'user', text: '修改后的消息' }] }");
    a.window.localStorage.setItem('rp_hub_pref_extra', '增量');
    worker.counters.syncPost = 0;
    worker.counters.packPut = 0;
    const incremental = await uploadViaUi(a.window);
    assert(incremental.ok, '增量上传成功');
    assert(worker.counters.packPut <= 3, `增量上传只重传受影响分片（实际 ${worker.counters.packPut}）`);
    assert(worker.counters.syncPost >= 2, '增量上传含 status 与 commit');

    // ---- 场景 B：全新浏览器从云端恢复 ----
    const b = setupBrowser({ url: '/sync-restore', worker });
    await waitForSyncDone(b.window);
    const restoredRecords = await readAllRecords(b.idb, 'RPHubDB', 'store');
    assertEqual(restoredRecords.length, seedSnapshot.records.length, '恢复后记录数一致');
    const restoredChat0 = restoredRecords.find(record => record.id === 'chat:0');
    assertEqual(restoredChat0?.messages?.[0]?.text, '修改后的消息', '恢复的是最新增量版本');
    assertEqual(b.window.localStorage.getItem('rp_hub_pref_extra'), '增量', 'localStorage 一并恢复');
    assertEqual(b.window.localStorage.getItem('rp_hub_pref_0'), seedSnapshot.prefs['rp_hub_pref_0'], 'localStorage 原值一致');

    // ---- 恢复缓存命中：第二次恢复 0 次分片下载 ----
    worker.counters.packGet = 0;
    clearBadge(b.window);
    b.window.document.querySelector('[data-action="pull"]').click();
    await waitForSyncDone(b.window);
    assertEqual(worker.counters.packGet, 0, '二次恢复命中本地分片缓存');

    // ---- 场景 C：单条记录超过 4MiB 分片缓冲 → 产生 entries=0 填充片 ----
    // 回归"上传数据包记录数量异常"：单条记录超缓冲时 buildCachedPacks 先落
    // 纯字节填充片、记录本体跨片拼接（v1 允许 entries=0）；v2 校验一度收紧
    // 为 >=1 导致这类真实聊天记录（内嵌 base64 大图）上传必败。用顶层数组
    // 记录复现用户实际报错的数组桶（|a…|q…）填充片形态。
    await updateRecordInPage(a.window, 'chat:1',
        "{ id: 'chat:1', messages: ['data:image/png;base64,' + 'B'.repeat(5 * 1024 * 1024)] }");
    worker.counters.packPut = 0;
    const bigUpload = await uploadViaUi(a.window);
    assert(bigUpload.ok, '单条 5MiB 数组记录上传成功（填充片被接受）');
    const bigManifest = await readCloudManifest(worker.bucket);
    assert(bigManifest && bigManifest.packs.some(pack => Number(pack.entries) === 0),
        '云端清单包含 entries=0 填充片');
    const fillPacks = bigManifest.packs.filter(pack => Number(pack.entries) === 0);
    console.log(`  [场景C] 填充片 ${fillPacks.length} 个：`, fillPacks.map(pack => `${pack.bucket}(${pack.length}B)`).join(', '));
    // 用户生产报错的填充片落在数组桶（|a…|q…，前面行恰好填满缓冲后紧跟大
    // item 行）；桶形态只是行边界巧合，本场景大行在稳定桶第一行，协议语义
    // 相同：entries=0 填充片被接受、记录本体跨片拼接。

    const c = setupBrowser({ url: '/sync-restore', worker });
    await waitForSyncDone(c.window);
    const bigRestored = (await readAllRecords(c.idb, 'RPHubDB', 'store')).find(record => record.id === 'chat:1');
    const bigPrefix = 'data:image/png;base64,';
    assert(bigRestored
        && Array.isArray(bigRestored.messages)
        && bigRestored.messages[0]?.length === bigPrefix.length + 5 * 1024 * 1024
        && bigRestored.messages[0].startsWith(bigPrefix),
        '跨片大记录恢复字节完整');

    console.log('client-sim: 默认规模全部通过');
}

async function scaleRun() {
    console.log(`scale-sim: SCALE_MB=${SCALE_MB}（真实客户端代码路径）`);
    const worker = makeWorker();
    const recordBytes = 10 * 1024;
    const recordCount = Math.max(1, Math.round((SCALE_MB * 1024 * 1024) / recordBytes));

    const a = setupBrowser({ url: '/', worker });
    // 页面 realm 内分批写入，避免单事务过大。
    await pageEvalAsync(a.window, `(async () => {
        const recordCount = ${recordCount}, recordBytes = ${recordBytes};
        await new Promise((resolve, reject) => {
            const request = indexedDB.open('RPHubDB', 1);
            request.onupgradeneeded = () => { request.result.createObjectStore('store'); };
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const db = request.result;
                const batchSize = 2000;
                let start = 0;
                const writeBatch = () => {
                    if (start >= recordCount) { db.close(); resolve(); return; }
                    const tx = db.transaction(['store'], 'readwrite');
                    const store = tx.objectStore('store');
                    for (let index = start; index < Math.min(recordCount, start + batchSize); index += 1) {
                        store.put({ id: index, text: '记录 ' + index + ' ' + 'y'.repeat(recordBytes) }, 'item:' + index);
                    }
                    start += batchSize;
                    tx.oncomplete = writeBatch;
                    tx.onerror = () => reject(tx.error);
                };
                writeBatch();
            };
        });
        return true;
    })()`);
    const firstStart = Date.now();
    await uploadViaUi(a.window);
    const manifest = await readCloudManifest(worker.bucket);
    assert(manifest && manifest.packs.length > 0, '规模上传产出分片');
    // 分片按 256 个稳定桶组装（桶内超过 4MiB 再拆），分片数 ≈ 触及桶数 + 头尾。
    const expectedPacks = Math.min(256, recordCount) + 4;
    assert(manifest.packs.length >= expectedPacks * 0.8 && manifest.packs.length <= expectedPacks * 1.3,
        `分片数量符合桶布局预期（实际 ${manifest.packs.length}，估算 ${expectedPacks}）`);
    // gzip 压缩必须显著小于原始字节数（JSONL 高冗余）。
    const rawEstimate = recordCount * (recordBytes + 64);
    assert(manifest.totalBytes < rawEstimate * 0.6,
        `gzip 压缩有效（${(manifest.totalBytes / 1048576).toFixed(1)}MiB / 原始约 ${(rawEstimate / 1048576).toFixed(0)}MiB）`);
    const packListing = await worker.bucket.list({ prefix: 'rp-sync/v2/packs/', limit: 100000 });
    assertEqual(packListing.objects.length, manifest.packs.length, '云端无孤儿分片');
    console.log(`  首次上传：原始约 ${(rawEstimate / 1048576).toFixed(0)}MiB → gzip ${(manifest.totalBytes / 1048576).toFixed(1)}MiB / ${manifest.packs.length} 分片 / ${Date.now() - firstStart}ms`);

    worker.counters.syncPost = 0;
    worker.counters.packPut = 0;
    const noChangeStart = Date.now();
    await uploadViaUi(a.window);
    assertEqual(worker.counters.packPut, 0, '规模无变化上传 0 分片');
    assertEqual(worker.counters.syncPost, 1, '规模无变化上传 1 请求');
    console.log(`  无变化上传：${Date.now() - noChangeStart}ms / 1 请求`);

    // 修改 1% 记录（页面 realm 内写入）
    await pageEvalAsync(a.window, `(async () => {
        const recordCount = ${recordCount}, recordBytes = ${recordBytes};
        const changed = Math.max(1, Math.round(recordCount / 100));
        await new Promise((resolve, reject) => {
            const request = indexedDB.open('RPHubDB');
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const db = request.result;
                const batchSize = 2000;
                let start = 0;
                const writeBatch = () => {
                    if (start >= changed) { db.close(); resolve(); return; }
                    const tx = db.transaction(['store'], 'readwrite');
                    const store = tx.objectStore('store');
                    for (let index = start; index < Math.min(changed, start + batchSize); index += 1) {
                        store.put({ id: index, text: '修改 ' + index + ' ' + 'z'.repeat(recordBytes) }, 'item:' + index);
                    }
                    start += batchSize;
                    tx.oncomplete = writeBatch;
                    tx.onerror = () => reject(tx.error);
                };
                writeBatch();
            };
        });
        return true;
    })()`);
    const incrementalStart = Date.now();
    await uploadViaUi(a.window);
    console.log(`  1% 修改上传：${Date.now() - incrementalStart}ms / ${worker.counters.packPut} 分片 / ${worker.counters.syncPost} 请求`);
    const manifest2 = await readCloudManifest(worker.bucket);
    const listing2 = await worker.bucket.list({ prefix: 'rp-sync/v2/packs/', limit: 100000 });
    assertEqual(listing2.objects.length, manifest2.packs.length, '增量提交后无孤儿残留');

    // 恢复
    const b = setupBrowser({ url: '/sync-restore', worker });
    const restoreStart = Date.now();
    await waitForSyncDone(b.window, 300_000);
    const restoredCount = await readAllRecords(b.idb, 'RPHubDB', 'store');
    assertEqual(restoredCount.length, recordCount, '规模恢复记录数一致');
    const spot = restoredCount[Math.floor(recordCount / 2)];
    assert(spot.text.startsWith('记录 ') || spot.text.startsWith('修改 '), '规模恢复抽查内容有效');
    console.log(`  恢复：${Date.now() - restoreStart}ms`);

    console.log('client-sim --scale: 全部通过');
}

const mode = SCALE_MODE ? scaleRun : defaultRun;
mode().catch(error => {
    console.error(`client-sim${SCALE_MODE ? ' --scale' : ''} 失败:`, error);
    process.exit(1);
});

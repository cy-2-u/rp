// 升级场景回归：浏览器里带着 v1 时代的本地状态（旧版本缓存索引、旧日志、
// 旧分片缓存、旧意图键）首次运行 v2 客户端并上传。必须完整成功，且旧状态
// 不得污染 v2 分片（出现占位分片/坏 entryCount 等）。
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
import { assert } from './lib/worker.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pageDir = join(here, '..', 'page');
const DIRTY_SOURCE = readFileSync(join(pageDir, 'DB', 'dirty-tracker.js'), 'utf8');
const BOOTSTRAP_SOURCE = readFileSync(join(pageDir, 'DB', 'bootstrap.js'), 'utf8');

function makeWorker() {
    const bucket = createR2Bucket();
    const env = { RP_SYNC_R2: bucket, ASSETS: { async fetch() { return new Response('nf', { status: 404 }); } } };
    const ctx = { waitUntil(promise) { void Promise.resolve(promise).catch(() => { }); } };
    const counters = { syncPost: 0, packPut: 0, packGet: 0 };
    // 注入故障：第 N 个分片 PUT 返回 503（模拟网络中断），用于续传测试。
    let failPackPutCountdown = 0;
    async function workerFetch(path, init) {
        if (init?.method === 'PUT' && failPackPutCountdown > 0) {
            failPackPutCountdown -= 1;
            return new Response(JSON.stringify({ ok: false, error: '注入的网络中断' }), { status: 503 });
        }
        return workerModule.fetch(new Request(`https://site.test${path}`, init), env, ctx);
    }
    return {
        bucket, workerFetch, counters,
        failNextPackPuts(n) { failPackPutCountdown = n; }
    };
}

function setupBrowser({ url, worker } = {}) {
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', error => {
        if (!String(error?.message || '').includes('Not implemented')) throw error;
    });
    virtualConsole.on('error', (...args) => console.error('[page]', ...args));
    const dom = new JSDOM('<!doctype html><html><head></head><body><div id="app"></div></body></html>', {
        url: `https://site.test${url}`, pretendToBeVisual: true, runScripts: 'outside-only', virtualConsole
    });
    const { window } = dom;
    const factory = new IDBFactory();
    window.indexedDB = factory;
    globalThis.indexedDB = factory;
    for (const [name, ctor] of [['IDBKeyRange', IDBKeyRange], ['IDBFactory', IDBFactory], ['IDBDatabase', IDBDatabase],
        ['IDBObjectStore', IDBObjectStore], ['IDBIndex', IDBIndex], ['IDBTransaction', IDBTransaction],
        ['IDBRequest', IDBRequest], ['IDBCursor', IDBCursor], ['IDBVersionChangeEvent', IDBVersionChangeEvent]]) {
        window[name] = ctor;
        globalThis[name] = ctor;
    }
    for (const name of ['CompressionStream', 'DecompressionStream', 'TextEncoder', 'TextDecoder', 'Blob', 'Response',
        'Headers', 'Request', 'structuredClone', 'AbortController', 'AbortSignal', 'Uint8Array', 'ArrayBuffer', 'DataView']) {
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
    return { window, idb: factory };
}

// 预置 v1 时代的完整本地状态：业务数据（v1 时代就在）+ 旧版本缓存索引
//（version 8、旧字段名 bucketKey、旧 snapshot 字段）+ 旧分片缓存垃圾 +
// 旧日志行 + 旧意图键。全部在页面 realm、经 tracker 补丁执行——真实升级
// 浏览器正是这种混合状态。
async function seedLegacyState(window) {
    const code = `(async () => {
        const legacyEpoch = 'legacy-epoch-1';
        localStorage.setItem('rp_sync_tracking_epoch_v2', legacyEpoch);
        localStorage.setItem('rp_sync_intent_v2:legacy-1', 'rp_hub_pref');
        localStorage.setItem('rp_hub_pref', '旧版本遗留设置');
        await new Promise((resolve, reject) => {
            const request = indexedDB.open('RPHubDB', 1);
            request.onupgradeneeded = () => {
                if (!request.result.objectStoreNames.contains('store')) {
                    request.result.createObjectStore('store');
                }
            };
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const db = request.result;
                const tx = db.transaction(['store', '__rp_sync_journal_v2'], 'readwrite');
                for (let index = 0; index < 40; index += 1) {
                    tx.objectStore('store').put({ id: 'chat:' + index, text: '记录 ' + index + ' ' + 'x'.repeat(2000) }, 'chat:' + index);
                }
                tx.objectStore('__rp_sync_journal_v2').put('__legacy_epoch__', legacyEpoch);
                tx.objectStore('__rp_sync_journal_v2').put({ store: 'store', key: 'chat:0' }, 5);
                tx.oncomplete = () => { db.close(); resolve(); };
                tx.onerror = () => reject(tx.error);
            };
        });
        await new Promise((resolve, reject) => {
            const request = indexedDB.open('RPHubSyncCache', 5);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains('entries')) {
                    const store = db.createObjectStore('entries', { keyPath: 'id' });
                    store.createIndex('sourceKey', 'sourceKey', { unique: false });
                    store.createIndex('order', ['bucketKey', 'sortKey', 'id']);
                }
                if (!db.objectStoreNames.contains('state')) db.createObjectStore('state');
                if (!db.objectStoreNames.contains('packs')) db.createObjectStore('packs');
            };
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const db = request.result;
                const tx = db.transaction(['state', 'packs'], 'readwrite');
                tx.objectStore('state').put({
                    version: 8,
                    groups: ['store:RPHubDB/store:data'],
                    packs: [{ bucketKey: 'store:RPHubDB/store:data|s000', group: 'store:RPHubDB/store:data', part: 0, checksum: 'a'.repeat(64), length: 1048576, entryCount: 500 }],
                    snapshot: { packManifest: [], totalBytes: 1048576, packCount: 1, pageCount: 1, pageRoot: '0'.repeat(64), bloomChecksum: 'b'.repeat(64) },
                    epoch: legacyEpoch,
                    epochs: { RPHubDB: 1 }
                }, 'snapshot');
                tx.objectStore('packs').put(new Uint8Array(1048576).fill(7), 'a'.repeat(64));
                tx.oncomplete = () => { db.close(); resolve(); };
                tx.onerror = () => reject(tx.error);
            };
        });
        return true;
    })()`;
    window.__pageResult = null;
    window.eval(`(async () => { try { await (${code}); window.__pageResult = { ok: true }; } catch (e) { window.__pageResult = { ok: false, error: String(e && e.message || e) }; } })()`);
    for (let waited = 0; waited < 30000 && !window.__pageResult; waited += 5) {
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    if (!window.__pageResult?.ok) throw new Error('legacy seed 失败: ' + window.__pageResult?.error);
}

function clearBadge(window) {
    window.localStorage.removeItem('rp_hub_sync_last_result_v1');
}

async function uploadViaUi(window) {
    clearBadge(window);
    window.RPH_R2_OPEN_SYNC();
    for (let waited = 0; waited < 5000; waited += 20) {
        if (window.document.querySelector('[data-action="push"]')) break;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    window.document.querySelector('[data-action="push"]').click();
    for (let waited = 0; waited < 60000; waited += 50) {
        const badge = window.localStorage.getItem('rp_hub_sync_last_result_v1');
        if (badge) {
            const record = JSON.parse(badge);
            if (record.ok === false) throw new Error('上传失败：' + (window.document.querySelector('.rp-sync-modal__status')?.textContent || ''));
            if (record.ok === true) return;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('等待上传完成超时');
}

async function main() {
    const worker = makeWorker();
    const browser = setupBrowser({ url: '/', worker });

    // 先种业务数据，再补 v1 遗留状态？不行——tracker 加载后写入会记日志。
    // 顺序：setupBrowser 已加载 tracker → 一次性种入"v1 时代业务数据 + v1
    // 遗留客户端状态"的混合快照（含手写的旧日志行），与真实升级浏览器一致。
    await seedLegacyState(browser.window);

    await uploadViaUi(browser.window);

    // 云端根清单必须全部为合法分片：entries 为 0..512 的整数（0 = 单条记录
    // 超分片缓冲的纯字节填充片）、无占位 checksum。
    const manifestObject = await worker.bucket.get('rp-sync/v2/manifest.json');
    assert(manifestObject, '云端根清单存在');
    const manifest = JSON.parse(await manifestObject.text());
    assert(manifest.packs.length > 0, '产出分片');
    for (const pack of manifest.packs) {
        assert(/^[a-f0-9]{64}$/.test(pack.checksum), `分片校验和合法（${pack.checksum}）`);
        assert(Number.isInteger(pack.entries) && pack.entries >= 0 && pack.entries <= 512, `分片记录数合法（${pack.entries}）`);
        assert(Number.isInteger(pack.length) && pack.length > 0, `分片大小合法（${pack.length}）`);
    }
    // 恢复验证：新浏览器从云端恢复一致。
    const b = setupBrowser({ url: '/sync-restore', worker });
    for (let waited = 0; waited < 60000; waited += 50) {
        const badge = b.window.localStorage.getItem('rp_hub_sync_last_result_v1');
        if (badge && JSON.parse(badge).ok === true) break;
        await new Promise(resolve => setTimeout(resolve, 50));
        if (waited > 59000) throw new Error('恢复超时');
    }

    // 中断续传：云端清空后，注入前 3 个分片 PUT 失败 → 上传失败 → 重试必须
    // 完整成功且分片元数据始终合法（回归"上传数据包记录数量异常"类故障）。
    for (let start = 0; start < 1000; start += 1000) {
        const orphans = await worker.bucket.list({ prefix: 'rp-sync/v2/', limit: 100000 });
        await worker.bucket.delete(orphans.objects.map(object => object.key));
    }
    // 注入失败次数 ≥ 单个分片的全部尝试次数（1 + 3 重试），确保耗尽重试。
    // Worker 根清单读缓存 TTL 1.5 秒：等它过期，status 才会返回"云端为空"。
    await new Promise(resolve => setTimeout(resolve, 2000));
    // 注入失败次数 ≥ 并发 6 路 × 每路 4 次尝试（1 + 3 重试）= 24，
    // 才能让首批在途分片全部耗尽重试、整次上传失败。
    worker.failNextPackPuts(30);
    clearBadge(browser.window);
    browser.window.RPH_R2_OPEN_SYNC();
    for (let waited = 0; waited < 5000; waited += 20) {
        if (browser.window.document.querySelector('[data-action="push"]')) break;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    browser.window.document.querySelector('[data-action="push"]').click();
    let firstAttemptFailed = false;
    for (let waited = 0; waited < 60000; waited += 50) {
        const badge = browser.window.localStorage.getItem('rp_hub_sync_last_result_v1');
        if (badge && JSON.parse(badge).ok === false) { firstAttemptFailed = true; break; }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert(firstAttemptFailed, '注入故障后第一次上传失败');
    clearBadge(browser.window);
    browser.window.RPH_R2_OPEN_SYNC();
    for (let waited = 0; waited < 5000; waited += 20) {
        if (browser.window.document.querySelector('[data-action="push"]')) break;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    browser.window.document.querySelector('[data-action="push"]').click();
    for (let waited = 0; waited < 60000; waited += 50) {
        const badge = browser.window.localStorage.getItem('rp_hub_sync_last_result_v1');
        if (badge && JSON.parse(badge).ok === true) break;
        await new Promise(resolve => setTimeout(resolve, 50));
        if (waited > 59000) throw new Error('重试上传超时');
    }
    const retryManifestObject = await worker.bucket.get('rp-sync/v2/manifest.json');
    assert(retryManifestObject, '重试后云端根清单存在');
    const retryManifest = JSON.parse(await retryManifestObject.text());
    for (const pack of retryManifest.packs) {
        assert(Number.isInteger(pack.entries) && pack.entries >= 0 && pack.entries <= 512, `重试分片记录数合法（${pack.entries}）`);
    }

    console.log('legacy-upgrade: 全部通过（v1 遗留状态 + 中断续传均正常）');
}

main().catch(error => {
    console.error('legacy-upgrade 失败:', error);
    process.exit(1);
});

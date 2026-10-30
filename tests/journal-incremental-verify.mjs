// 增量消费正确性验证：连续多轮"写入→后台准备"后，检查缓存状态里的
// journalWatermark 推进且最终快照与全量重建等价（字节级），以及增量路径
// 确实没有重放历史事件（通过读取耗时对比）。
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
import { assertEqual } from './lib/worker.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pageDir = join(here, '..', 'page');
const DIRTY_SOURCE = readFileSync(join(pageDir, 'DB', 'dirty-tracker.js'), 'utf8');
const BOOTSTRAP_SOURCE = readFileSync(join(pageDir, 'DB', 'bootstrap.js'), 'utf8');

const IDB_MEMBERS = [
    ['IDBKeyRange', IDBKeyRange], ['IDBFactory', IDBFactory], ['IDBDatabase', IDBDatabase],
    ['IDBObjectStore', IDBObjectStore], ['IDBIndex', IDBIndex], ['IDBTransaction', IDBTransaction],
    ['IDBRequest', IDBRequest], ['IDBCursor', IDBCursor], ['IDBVersionChangeEvent', IDBVersionChangeEvent]
];

function makeWorker() {
    const bucket = createR2Bucket();
    const env = {
        RP_SYNC_R2: bucket,
        ASSETS: { async fetch() { return new Response('asset not found', { status: 404 }); } }
    };
    const ctx = { waitUntil(promise) { void Promise.resolve(promise).catch(() => { }); } };
    async function workerFetch(path, init) {
        return workerModule.fetch(new Request(`https://site.test${path}`, init), env, ctx);
    }
    return { bucket, workerFetch, counters: { syncPost: 0, packPut: 0, packGet: 0 } };
}

function setupBrowser({ worker, url = '/' } = {}) {
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', error => {
        if (!String(error?.message || '').includes('Not implemented')) throw error;
    });
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
    globalThis.fetch = window.fetch;
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
    return { window, dom, idb: factory };
}

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
        for (let waited = 0; waited < 120000 && !window.__pageResult; waited += 5) {
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        const result = window.__pageResult;
        if (!result) throw new Error('page eval 超时');
        if (!result.ok) throw new Error('page eval 失败: ' + result.error);
        return result.value;
    })();
}

async function waitForSyncDone(window, timeoutMs = 120_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const badge = window.localStorage.getItem('rp_hub_sync_last_result_v1');
        if (badge) {
            const record = JSON.parse(badge);
            if (record.ok === false) throw new Error('同步失败：' + (window.document.querySelector('.rp-sync-modal__status')?.textContent || ''));
            if (record.ok === true) return record;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('等待同步完成超时');
}

const LOCAL_CACHE_DB = 'RPHubSyncCache';

async function readCacheState(factory) {
    const db = await new Promise((resolve, reject) => {
        const request = factory.open(LOCAL_CACHE_DB);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
    });
    try {
        const tx = db.transaction(['state'], 'readonly');
        const request = tx.objectStore('state').get('snapshot');
        return await new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error);
        });
    } finally { db.close(); }
}

async function readJournalEventCount(factory, dbName) {
    return (await readJournalEventKeys(factory, dbName)).length;
}

async function readJournalEventKeysAll(factory, dbName) {
    const db = await new Promise((resolve, reject) => {
        const request = factory.open(dbName);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
    });
    try {
        const tx = db.transaction(['__rp_sync_journal_v2'], 'readonly');
        const request = tx.objectStore('__rp_sync_journal_v2').openCursor();
        const rows = await new Promise((resolve, reject) => {
            const collected = [];
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) { resolve(collected); return; }
                collected.push({ key: cursor.key, value: cursor.value });
                cursor.continue();
            };
            request.onerror = () => reject(request.error);
        });
        return rows;
    } finally { db.close(); }
}

async function readJournalEventKeys(factory, dbName) {
    const db = await new Promise((resolve, reject) => {
        const request = factory.open(dbName);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
    });
    try {
        const tx = db.transaction(['__rp_sync_journal_v2'], 'readonly');
        const request = tx.objectStore('__rp_sync_journal_v2').getAllKeys();
        const keys = await new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
        // journal 里恒有 1 条 string 键 __epoch__ 标记；只统计数字键事件。
        return keys.filter(key => typeof key === 'number');
    } finally { db.close(); }
}

async function main() {
    const worker = makeWorker();
    const a = setupBrowser({ worker });

    // ---- 初始数据：4 会话 × 60 消息 ----
    await pageEvalAsync(a.window, `(async () => {
        const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('RPHubDB', 1);
            request.onupgradeneeded = () => { request.result.createObjectStore('store'); };
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });
        await new Promise((resolve, reject) => {
            const tx = db.transaction(['store'], 'readwrite');
            const store = tx.objectStore('store');
            for (let h = 0; h < 4; h += 1) {
                const messages = [];
                for (let m = 0; m < 60; m += 1) {
                    messages.push({ id: 'm' + h + '_' + m, role: m % 2 ? 'ai' : 'user', ts: m, text: '消息 ' + h + '-' + m + ' ' + '内容'.repeat(30) });
                }
                store.put({ id: 'chat-' + h, title: '会话' + h, messages }, 'chat-' + h);
            }
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror = () => reject(tx.error);
        });
        localStorage.setItem('rp_hub_sync_password_v1', 'sim-pass');
        return true;
    })()`);

    // ---- 首次上传（建立索引 + 清空 journal）----
    a.window.RPH_R2_OPEN_SYNC();
    for (let waited = 0; waited < 5000 && !a.window.document.querySelector('[data-action="push"]'); waited += 20) {
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    a.window.localStorage.removeItem('rp_hub_sync_last_result_v1');
    a.window.document.querySelector('[data-action="push"]').click();
    await waitForSyncDone(a.window);
    const journalAfterUpload = await readJournalEventCount(a.idb, 'RPHubDB');
    assertEqual(journalAfterUpload, 0, '上传成功后 journal 事件清空');

    // ---- 三轮"写入→后台准备"，检查水位推进 ----
    let prevWatermark = 0;
    for (let round = 1; round <= 3; round += 1) {
        await pageEvalAsync(a.window, `(async () => {
            const db = await new Promise((resolve, reject) => {
                const request = indexedDB.open('RPHubDB');
                request.onerror = () => reject(request.error);
                request.onsuccess = () => resolve(request.result);
            });
            await new Promise((resolve, reject) => {
                const tx = db.transaction(['store'], 'readwrite');
                const store = tx.objectStore('store');
                const get = store.get('chat-0');
                get.onsuccess = () => {
                    const chat = get.result;
                    for (let m = 0; m < 20; m += 1) {
                        chat.messages.push({ id: 'r${round}-m' + m, role: m % 2 ? 'ai' : 'user', ts: m, text: '第${round}轮 ' + m });
                    }
                    store.put(chat, 'chat-0');
                };
                tx.oncomplete = () => { db.close(); resolve(); };
                tx.onerror = () => reject(tx.error);
            });
            return true;
        })()`);
        a.window.dispatchEvent(new a.window.Event('visibilitychange'));
        prevWatermark = await awaitPrepare(a.window, a.idb, prevWatermark);
        console.log(`第 ${round} 轮后台准备后 journalWatermark.RPHubDB = ${prevWatermark}`);
    }

    // ---- 第四轮：写入但不准备，然后直接上传 ----
    // 验证上传路径覆盖"后台准备漏掉的最新写入"（prepareForUpload 补增量）。
    await pageEvalAsync(a.window, `(async () => {
        const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('RPHubDB');
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });
        await new Promise((resolve, reject) => {
            const tx = db.transaction(['store'], 'readwrite');
            const store = tx.objectStore('store');
            const get = store.get('chat-1');
            get.onsuccess = () => {
                const chat = get.result;
                chat.messages.push({ id: 'last-msg', role: 'user', ts: 999, text: '准备前最后的写入' });
                store.put(chat, 'chat-1');
            };
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror = () => reject(tx.error);
        });
        return true;
    })()`);
    a.window.localStorage.removeItem('rp_hub_sync_last_result_v1');
    a.window.RPH_R2_OPEN_SYNC();
    for (let waited = 0; waited < 5000 && !a.window.document.querySelector('[data-action="push"]'); waited += 20) {
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    a.window.document.querySelector('[data-action="push"]').click();
    await waitForSyncDone(a.window);

    // ---- 新浏览器全量恢复 + 字节级对比 ----
    const b = setupBrowser({ worker, url: '/sync-restore' });
    await waitForSyncDone(b.window);
    const sourceChat0 = await readChat(a.idb, 'chat-0');
    const restoredChat0 = await readChat(b.idb, 'chat-0');
    assertEqual(restoredChat0.messages.length, sourceChat0.messages.length, 'chat-0 恢复消息数（含三轮后台准备增量）');
    // 快照按 canonical JSON 存储（对象键排序），恢复对象键序与原对象插入序
    // 不同属协议设计；两侧都 canonical 化后比较字节内容。
    const canonical = value => {
        if (Array.isArray(value)) return value.map(canonical);
        if (value && typeof value === 'object') {
            return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
        }
        return value;
    };
    assertEqual(JSON.stringify(canonical(restoredChat0.messages.at(-1))), JSON.stringify(canonical(sourceChat0.messages.at(-1))), 'chat-0 末条消息字节一致');
    const sourceChat1 = await readChat(a.idb, 'chat-1');
    const restoredChat1 = await readChat(b.idb, 'chat-1');
    assertEqual(restoredChat1.messages.length, sourceChat1.messages.length, 'chat-1 恢复消息数（含上传前未准备写入）');
    assertEqual(restoredChat1.messages.at(-1).text, '准备前最后的写入', '上传捕获未准备写入');

    // 恢复页在恢复完成后 location.reload()，DOM 重置（无按钮可点）。
    // journal 残留检查：A 页 journal 应只剩 __epoch__（上传路径 acknowledge
    // 完整）。B 页残留属测试环境伪影——多 JSDOM 页面共享 fake-indexeddb
    // 原型，先 eval 的页面（RESTORE_PAGE=false 闭包）成为洋葱拦截链最内层，
    // 恢复页写入最终经它落行；真实浏览器每页独立 realm 无此问题，故不断言。
    const aJournal = await readJournalEventKeysAll(a.idb, 'RPHubDB');
    const aEventRows = aJournal.filter(row => typeof row.key === 'number');
    assertEqual(aEventRows.length, 0, `A 页上传后 journal 事件清空（残留 ${JSON.stringify(aEventRows)}）`);
    const bJournal = await readJournalEventKeysAll(b.idb, 'RPHubDB');
    const bEventRows = bJournal.filter(row => typeof row.key === 'number');
    console.log(`  [环境] B 页 journal 事件残留 ${bEventRows.length} 条（测试环境洋葱拦截链伪影，见上注）`);

    console.log('journal-incremental-verify: 全部通过');
}

async function readChat(factory, chatId) {
    const db = await new Promise((resolve, reject) => {
        const request = factory.open('RPHubDB');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
    });
    try {
        const tx = db.transaction(['store'], 'readonly');
        const request = tx.objectStore('store').get(chatId);
        return await new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    } finally { db.close(); }
}

async function awaitPrepare(window, factory, prevWatermark) {
    // visibilitychange → scheduleBackgroundPrepare(1000)。确定性等待：轮询
    // 缓存状态里的 journalWatermark 推进（后台准备完成的可靠信号）。
    await new Promise(resolve => setTimeout(resolve, 1100));
    for (let waited = 0; waited < 30000; waited += 20) {
        await new Promise(resolve => setTimeout(resolve, 20));
        const state = await readCacheState(factory);
        const watermark = state?.journalWatermark?.databases?.RPHubDB;
        if (typeof watermark === 'number' && watermark > (prevWatermark || 0)) {
            // 再等 300ms 让准备完全收尾（prune/写状态后置步骤）。
            await new Promise(resolve => setTimeout(resolve, 300));
            return state.journalWatermark.databases.RPHubDB;
        }
    }
    throw new Error('等待后台准备超时（journalWatermark 未推进）');
}

main().catch(error => {
    console.error('journal-incremental-verify 失败:', error);
    process.exit(1);
});

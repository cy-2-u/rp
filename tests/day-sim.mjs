// “用户的一天”全行为随机交错模拟：jsdom + fake-indexeddb + 虚拟时钟 +
// 真实 bootstrap/dirty-tracker/magic-extension/worker 端到端。
// 行为覆盖：聊天追加、swipe、生成图片、重掷图片、删除图片、导入角色卡、
// 删除角色卡、删除会话、分支新聊天、手动上传、自动上传（真实调度器由
// 虚拟时钟驱动，5 分钟周期）、页签隐藏/回前台、双设备拉取（全量恢复 +
// 同缓存二次恢复）。行为顺序由固定种子随机抽取，与自动保存/后台准备
// 自然交错（不存在先后之分）。
// 产出：请求账单（按路径/动作）、每次同步的分片上传数、后台准备对 dirty
// 事件的合并、journal 水位推进、恢复字节级抽查、拓扑观察（孤儿图片记录
// 等）→ 不足/优化点清单。
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
const MAGIC_SOURCE = readFileSync(join(pageDir, 'magic-extension.js'), 'utf8');

// ---- 可调参数 ----
const DAY_MS = Number(process.env.DAY_MS || 24 * 3600 * 1000); // 模拟一天
const SEED = Number(process.env.SEED || 20261026);
const AUTOSAVE_MIN = Number(process.env.AUTOSAVE_MIN || 5);    // 自动保存周期（分钟）
const SIM_QUIET = process.env.SIM_QUIET === '1';
const BASE_EPOCH = new Date('2026-10-26T08:00:00+08:00').getTime();

// ---- 固定种子随机（调度器，与页面内数据随机相互独立）----
function mulberry32(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const rand = mulberry32(SEED);
const pick = list => list[Math.floor(rand() * list.length)];
const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

const realSetTimeout = globalThis.setTimeout.bind(globalThis);

// ---- 虚拟时钟：页面的 setTimeout/performance.now/Date.now 全部虚拟化。
// 自动保存调度器（5 分钟周期、30s tick、墙钟交叉校验）、后台准备防抖
// （8s）、低占空比让出（6/8ms 交替）都按真实时序在虚拟时间里运行；
// fake-indexeddb 的真实调度与 Promise 链在每个虚拟 timer 步进之间被 drain。
function createVirtualClock() {
    let vnow = 0;
    let seq = 0;
    const queue = [];
    const setTimeout = (fn, ms) => {
        const id = ++seq;
        queue.push({ id, at: vnow + Math.max(0, Number(ms) || 0), fn });
        return id;
    };
    const clearTimeout = id => {
        const index = queue.findIndex(timer => timer.id === id);
        if (index >= 0) queue.splice(index, 1);
    };
    const setInterval = (fn, ms) => {
        const id = ++seq;
        queue.push({ id, at: vnow + Math.max(1, Number(ms) || 1), fn, every: Math.max(1, Number(ms) || 1) });
        return id;
    };
    const clearInterval = clearTimeout;
    const drainTick = async () => {
        // 让微任务与 fake-indexeddb 的真实调度跑完；连续多轮以覆盖较深的
        // Promise 链（一次上传 = status→准备→PUT→commit→acknowledge）。
        for (let round = 0; round < 8; round += 1) {
            await new Promise(resolve => setImmediate(resolve));
            await new Promise(resolve => realSetTimeout(resolve, 1));
        }
    };
    // 推进虚拟时间到 targetMs：按序执行途中全部到期 timer（含其间新注册的）。
    const advance = async targetMs => {
        for (;;) {
            if (queue.length) queue.sort((a, b) => a.at - b.at || a.id - b.id);
            const next = queue[0];
            if (!next || next.at > targetMs) {
                vnow = Math.max(vnow, targetMs);
                break;
            }
            vnow = next.at;
            queue.shift();
            if (next.every) queue.push({ ...next, at: vnow + next.every });
            try { next.fn(); } catch (error) {
                console.error('[virtual-timer]', error);
            }
            await drainTick();
        }
        await drainTick();
    };
    const nowMs = () => vnow;
    const epochNow = () => BASE_EPOCH + vnow;
    return { advance, setTimeout, clearTimeout, setInterval, clearInterval, nowMs, epochNow };
}

// ---- Worker（内存 R2 + 生图上游桩 + 请求计数）----
function makeWorker() {
    const bucket = createR2Bucket();
    let upstreamCalls = 0;
    const env = {
        RP_SYNC_R2: bucket,
        ASSETS: {
            async fetch(input) {
                const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
                if (path === '/config.json') {
                    return new Response(JSON.stringify({ adapter: { externalUrl: '' }, image: { ynai: null } }), {
                        status: 200, headers: { 'content-type': 'application/json' }
                    });
                }
                if (path === '/gallery.html') return new Response('<html>gallery</html>', { status: 200 });
                return new Response('asset not found', { status: 404 });
            }
        }
    };
    const ctx = { waitUntil(promise) { void Promise.resolve(promise).catch(() => { }); } };
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        const parsed = new URL(url);
        if (parsed.hostname === 'nai.sta1n.cn') {
            upstreamCalls += 1;
            const size = 2048;
            const bytes = new Uint8Array(size);
            bytes[0] = 0x89; bytes[1] = 0x50;
            for (let index = 2; index < size; index += 1) bytes[index] = index & 0xff;
            return new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' } });
        }
        return realFetch(input, init);
    };
    const counters = { syncPost: 0, packPut: 0, packPutBytes: 0, packGet: 0, actions: {} };
    async function workerFetch(path, init) {
        return workerModule.fetch(new Request(`https://site.test${path}`, init), env, ctx);
    }
    return { bucket, workerFetch, counters, upstreamCount: () => upstreamCalls };
}

const IDB_MEMBERS = [
    ['IDBKeyRange', IDBKeyRange], ['IDBFactory', IDBFactory], ['IDBDatabase', IDBDatabase],
    ['IDBObjectStore', IDBObjectStore], ['IDBIndex', IDBIndex], ['IDBTransaction', IDBTransaction],
    ['IDBRequest', IDBRequest], ['IDBCursor', IDBCursor], ['IDBVersionChangeEvent', IDBVersionChangeEvent]
];

// ---- 虚拟时钟浏览器 ----
function setupVirtualBrowser({ url, worker, clock, metrics, idb = null }) {
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', error => {
        const message = String(error?.message || '');
        if (message.includes('Not implemented')) return;
        throw error;
    });
    if (!SIM_QUIET) {
        virtualConsole.on('error', (...args) => console.error('[page]', ...args));
        virtualConsole.on('warn', (...args) => console.warn('[page]', ...args));
    }
    const dom = new JSDOM('<!doctype html><html><head></head><body><div id="app"></div></body></html>', {
        url: `https://site.test${url}`,
        pretendToBeVisual: true,
        runScripts: 'outside-only',
        virtualConsole
    });
    const { window } = dom;
    const factory = idb || new IDBFactory();
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
    // ---- 注入虚拟时钟（eval 业务脚本之前，调度器/防抖/让出全部保真）----
    if (clock) {
        window.setTimeout = clock.setTimeout;
        window.clearTimeout = clock.clearTimeout;
        window.setInterval = clock.setInterval;
        window.clearInterval = clock.clearInterval;
        const virtualPerformance = Object.create(null);
        virtualPerformance.now = () => clock.nowMs();
        try {
            Object.defineProperty(window, 'performance', { value: virtualPerformance, configurable: true });
        } catch (_) {
            window.performance.now = () => clock.nowMs();
        }
        window.Date.now = () => clock.epochNow();
    }
    // ---- 同步徽标账本：包装 Storage.prototype.setItem（早于 tracker 的
    // 原型补丁，tracker 捕获到的正是这层包装——语义完全保留），
    // 每次成功/失败同步都记录虚拟时刻 + 当时的请求计数快照 ----
    {
        const nativeSet = window.Storage.prototype.setItem;
        window.Storage.prototype.setItem = function (key, value) {
            if (key === 'rp_hub_sync_last_result_v1') {
                let parsed = {};
                try { parsed = JSON.parse(value); } catch (_) { }
                badgeLog.push({
                    device: url.startsWith('/sync-restore') ? 'restore' : 'main',
                    at: parsed.at ?? null, ok: parsed.ok === true,
                    syncPost: worker.counters.syncPost, packPut: worker.counters.packPut
                });
            }
            return nativeSet.call(this, key, value);
        };
    }
    // ---- 页面 fetch：直连 Worker 并记录请求明细 ----
    window.fetch = async (input, init) => {
        const resolved = new URL(typeof input === 'string' ? input : input.url, 'https://site.test');
        if (resolved.origin !== 'https://site.test') throw new Error(`unexpected client fetch: ${resolved.href}`);
        const method = (init?.method || 'GET').toUpperCase();
        const body = init?.body;
        const reqBytes = typeof body === 'string' ? body.length
            : body instanceof Uint8Array ? body.length
                : body && body.size ? body.size : 0;
        let response;
        if (resolved.pathname === '/api/rp-sync') {
            worker.counters.syncPost += 1;
            if (method === 'POST' && typeof body === 'string') {
                try {
                    const action = JSON.parse(body).action || '?';
                    worker.counters.actions[action] = (worker.counters.actions[action] || 0) + 1;
                } catch (_) { /* 二进制或异常体不计数 */ }
            }
            response = await worker.workerFetch(resolved.pathname + resolved.search, init);
        } else if (resolved.pathname === '/api/rp-sync/pack') {
            if (method === 'PUT') { worker.counters.packPut += 1; worker.counters.packPutBytes += reqBytes; }
            else worker.counters.packGet += 1;
            response = await worker.workerFetch(resolved.pathname + resolved.search, init);
        } else if (resolved.pathname === '/api/rp-image' || resolved.pathname === '/image/api/delete') {
            response = await worker.workerFetch(resolved.pathname + resolved.search, init);
        } else {
            throw new Error(`unexpected client fetch: ${resolved.pathname}`);
        }
        metrics.requests.push({ at: clock ? clock.nowMs() : 0, path: resolved.pathname, method, reqBytes, status: response.status });
        return response;
    };
    window.confirm = () => true;
    window.alert = () => { };
    // ---- stub 适配层：捕获 magic 注册的真实回调，其余契约直通 ----
    window.__rphActions = { imageRequest: null, characterDeleted: null };
    window.RPHubExternal = {
        version: 2,
        async flush() { return { ok: true }; },
        describeCard(card) {
            if (!card?.dataset?.messageIndex) return null;
            return { messageIndex: Number(card.dataset.messageIndex), occurrenceIndex: Number(card.dataset.occurrenceIndex || 0) };
        },
        context() { return null; },
        register(name, handler) {
            if (name === 'image-request') window.__rphActions.imageRequest = handler;
            if (name === 'character-deleted') window.__rphActions.characterDeleted = handler;
            return () => { };
        },
        imageKey() { return 'KEY'; },
        capabilities() { return { flush: true, missing: [] }; },
        installUi() { }
    };
    globalThis.localStorage = window.localStorage;
    globalThis.document = window.document;
    globalThis.location = window.location;
    window.eval(DIRTY_SOURCE);
    const isRestore = url.startsWith('/sync-restore');
    if (!isRestore) window.eval(MAGIC_SOURCE);
    window.eval(BOOTSTRAP_SOURCE);
    // 页签可见性切换（真实用户会切走/切回：自动保存暂停、后台准备跳过）
    window.__setVisible = visible => {
        Object.defineProperty(window.document, 'visibilityState', {
            value: visible ? 'visible' : 'hidden', configurable: true
        });
        window.document.dispatchEvent(new window.Event('visibilitychange'));
    };
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
            await new Promise(resolve => realSetTimeout(resolve, 5));
        }
        const result = window.__pageResult;
        if (!result) throw new Error('page eval 超时');
        if (!result.ok) throw new Error('page eval 失败: ' + result.error);
        return result.value;
    })();
}

// 模块级同步徽标账本：每个浏览器页的 Storage 原型包装在 badge 写入时追加。
const badgeLog = [];
// 模块级虚拟时钟引用：等待同步时**同步推进虚拟时间**——上传/恢复链路中的
// wait(0)/wait(8) 让出是页面虚拟 timer，不推进时钟就会真死锁。这也贴合真实
// 语义：用户在面板前等待时墙钟在走、页面定时器在触发。
let pumpClock = null;
// 等待一次**新**同步完成：baselineBadge 之后出现 ok:true 徽标才算数。
// 只看"存在徽标"会把上一次自动保存的成功误判为本次点击的结果。
async function waitForSyncDone(window, timeoutMs = 120_000, baselineBadge = 0) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (badgeLog.length > baselineBadge) {
            const latest = badgeLog[badgeLog.length - 1];
            if (!latest.ok) {
                throw new Error('同步失败：' + (window.document.querySelector('.rp-sync-modal__status')?.textContent || 'badge ok=false'));
            }
            return latest;
        }
        if (pumpClock) await pumpClock.advance(pumpClock.nowMs() + 25);
        await new Promise(resolve => realSetTimeout(resolve, 0));
    }
    throw new Error('等待同步完成超时');
}
const badgeBaseline = () => badgeLog.length;

// 经真实面板路径上传：打开面板 → 等按钮空闲（同步进行中禁用）→ 点击 →
// 等待**新**成功徽标。manualPush 行为与收尾上传共用。
async function pushViaPanel(a, timeoutMs = 90000) {
    const baseline = badgeBaseline();
    a.window.RPH_R2_OPEN_SYNC();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const pushButton = a.window.document.querySelector('[data-action="push"]');
        if (pushButton && !pushButton.disabled) {
            pushButton.click();
            try {
                await waitForSyncDone(a.window, 60000, baseline);
                return { pushed: true };
            } catch (error) {
                // 60s 内徽标未动：可能点击瞬间又进入同步（如自动保存抢跑），
                // 回到等空闲循环重试，直到总超时。
                if (!String(error.message).includes('超时')) throw error;
            }
        }
        await new Promise(resolve => realSetTimeout(resolve, 25));
    }
    throw new Error(`面板上传总超时（badge 基线 ${baseline}，当前 ${badgeLog.length}）`);
}

// ---- Node 侧读取工具 ----
async function openRaw(factory, name) {
    return new Promise((resolve, reject) => {
        const request = factory.open(name);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
    });
}
async function readStoreAll(factory, dbName, storeName) {
    const db = await openRaw(factory, dbName);
    try {
        const tx = db.transaction([storeName], 'readonly');
        const keys = tx.objectStore(storeName).getAllKeys();
        const values = tx.objectStore(storeName).getAll();
        return await new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve({ keys: [...keys.result], values: [...values.result] });
            tx.onerror = () => reject(tx.error);
        });
    } finally { db.close(); }
}
async function readJournalCount(factory, dbName) {
    const db = await openRaw(factory, dbName);
    try {
        const tx = db.transaction(['__rp_sync_journal_v2'], 'readonly');
        const request = tx.objectStore('__rp_sync_journal_v2').getAllKeys();
        return await new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result.filter(key => typeof key === 'number').length);
            request.onerror = () => reject(request.error);
        });
    } finally { db.close(); }
}
async function readJournalEntries(factory, dbName) {
    const db = await openRaw(factory, dbName);
    try {
        const tx = db.transaction(['__rp_sync_journal_v2'], 'readonly');
        const keys = tx.objectStore('__rp_sync_journal_v2').getAllKeys();
        const values = tx.objectStore('__rp_sync_journal_v2').getAll();
        return await new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve(keys.result
                .map((key, index) => ({ key, value: values.result[index] }))
                .filter(entry => typeof entry.key === 'number'));
            tx.onerror = () => reject(tx.error);
        });
    } finally { db.close(); }
}
async function readSyncCacheState(factory) {
    let db;
    try {
        db = await openRaw(factory, 'RPHubSyncCache');
    } catch (_) { return null; }
    try {
        if (!db.objectStoreNames.contains('state')) return null;
        const tx = db.transaction(['state'], 'readonly');
        const request = tx.objectStore('state').get('snapshot');
        return await new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error);
        });
    } catch (_) {
        return null;
    } finally { db.close(); }
}
async function readCloudManifest(bucket) {
    const object = await bucket.get('rp-sync/v2/manifest.json');
    return object ? JSON.parse(await object.text()) : null;
}
const canonical = value => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    }
    return value;
};
const appLocalStorageEntries = window_ => Object.fromEntries(Object.entries({
    ...window_.localStorage
}).filter(([key]) => (key.startsWith('rp_hub_') && !key.startsWith('rp_hub_sync_')) || key.startsWith('ai_chargen_')).sort());

// ---- 初始数据（页面 realm 内生成，3 角色 × 2 会话 × 40 消息）----
async function seedInitialData(window) {
    return pageEvalAsync(window, `(async () => {
        let seed = 987654321;
        const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
        const pick = list => list[Math.floor(rand() * list.length)];
        const words = ['剑光', '夜色', '低语', '回响', '星图', '余烬', '门扉', '灰雾', '誓言', '微光', '残响', '长街'];
        const sentence = () => Array.from({ length: 4 + Math.floor(rand() * 8) }, () => pick(words)).join('');
        const b64 = () => {
            const header = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg';
            const body = (Math.floor(rand() * 0xffffff).toString(36) + 'Q').repeat(Math.ceil(16 * 1024 / 40));
            return header + body.slice(0, 16 * 1024 - header.length);
        };
        const charDb = await new Promise((resolve, reject) => {
            const request = indexedDB.open('AICharGen', 1);
            request.onupgradeneeded = () => { request.result.createObjectStore('characters'); };
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });
        const charIds = [];
        await new Promise((resolve, reject) => {
            const tx = charDb.transaction(['characters'], 'readwrite');
            const store = tx.objectStore('characters');
            for (let c = 0; c < 3; c += 1) {
                const id = 'char-' + String(c).padStart(4, '0');
                charIds.push(id);
                store.put({
                    id, name: '角色' + c,
                    greeting: Array.from({ length: 2 }, sentence).join('　'),
                    description: Array.from({ length: 3 }, sentence).join('\\n'),
                    variants: Array.from({ length: 2 }, (_, v) => ({ id: 'v' + v, text: sentence() })),
                    memory: { facts: Array.from({ length: 10 }, sentence), summary: sentence() },
                    createdAt: Date.now() - c * 86400000
                }, id);
            }
            tx.oncomplete = () => { charDb.close(); resolve(); };
            tx.onerror = () => reject(tx.error);
        });
        const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('RPHubDB', 1);
            request.onupgradeneeded = () => { request.result.createObjectStore('store'); };
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });
        let msgSeq = 0;
        const chatIds = [];
        await new Promise((resolve, reject) => {
            const tx = db.transaction(['store'], 'readwrite');
            const store = tx.objectStore('store');
            for (let c = 0; c < 3; c += 1) {
                for (let h = 0; h < 2; h += 1) {
                    const messages = [];
                    for (let m = 0; m < 40; m += 1) {
                        msgSeq += 1;
                        const role = m % 2 === 0 ? 'user' : 'ai';
                        const text = sentence() + '。' + sentence();
                        const message = { id: 'm' + msgSeq, role, ts: Date.now() - (40 - m) * 60000, text };
                        if (role === 'ai') {
                            message.swipes = [text, sentence(), sentence()];
                            message.swipeId = 0;
                        }
                        if (m % 8 === 0) message.images = [b64()];
                        messages.push(message);
                    }
                    const chatId = 'chat-' + c + '-' + h;
                    chatIds.push(chatId);
                    store.put({
                        id: chatId, characterId: charIds[c],
                        title: '会话' + c + '-' + h, createdAt: Date.now() - h * 3600000, messages
                    }, chatId);
                }
            }
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror = () => reject(tx.error);
        });
        localStorage.setItem('rp_hub_settings', JSON.stringify({ autosave: ${AUTOSAVE_MIN}, theme: 'dark' }));
        localStorage.setItem('ai_chargen_ui', JSON.stringify({ sidebar: true, lastChar: charIds[0] }));
        return { chars: charIds, chatIds };
    })()`);
}

// ---- 用户行为实现（顺序由调度器随机决定；池状态在 Node 侧维护）----
function buildActions(a) {
    const writeChat = (chatId, mutate) => pageEvalAsync(a.window, `(async () => {
        const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('RPHubDB');
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(['store'], 'readwrite');
            const store = tx.objectStore('store');
            const getKey = store.get(${JSON.stringify(chatId)});
            getKey.onerror = () => reject(getKey.error);
            getKey.onsuccess = () => {
                const chat = getKey.result;
                if (!chat) { resolve({ skipped: true }); return; }
                const outcome = (${mutate})(chat);
                if (outcome && outcome.skipped) { resolve(outcome); return; }
                store.put(chat, ${JSON.stringify(chatId)});
                tx.oncomplete = () => { db.close(); resolve(outcome || { ok: true }); };
                tx.onerror = () => reject(tx.error);
            };
        });
    })()`);
    return {
        // 聊天追加：1~6 条消息（AI 带 swipes，偶尔内嵌图/世界书）
        chatAppend: {
            weight: 22,
            run: async () => {
                if (!a.state.chatIds.length) return { skipped: true };
                const chatId = pick(a.state.chatIds);
                const seed = Math.floor(rand() * 1e9);
                const outcome = await writeChat(chatId, `(chat) => {
                    let s = ${seed};
                    const rand = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
                    const words = ['剑光', '夜色', '低语', '回响', '星图', '余烬', '门扉', '灰雾', '誓言', '微光', '残响', '长街'];
                    const sentence = () => Array.from({ length: 4 + Math.floor(rand() * 8) }, () => words[Math.floor(rand() * words.length)]).join('');
                    const b64 = () => {
                        const header = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg';
                        const body = (Math.floor(rand() * 0xffffff).toString(36) + 'Q').repeat(Math.ceil(16 * 1024 / 40));
                        return header + body.slice(0, 16 * 1024 - header.length);
                    };
                    const added = [];
                    for (let n = 0, count = 1 + Math.floor(rand() * 6); n < count; n += 1) {
                        const role = (chat.messages.length % 2 === 0) ? 'user' : 'ai';
                        const text = sentence() + '。' + sentence();
                        const message = { id: 'm' + Date.now() + '_' + n + '_' + Math.floor(rand() * 1e9), role, ts: Date.now(), text };
                        if (role === 'ai') { message.swipes = [text, sentence()]; message.swipeId = 0; }
                        if (rand() < 0.08) message.images = [b64()];
                        if (rand() < 0.04) message.book = { name: words[Math.floor(rand() * words.length)], entries: [sentence()] };
                        chat.messages.push(message);
                        added.push(role);
                    }
                    return { chatId: chat.id, added: added.length };
                }`);
                return outcome;
            }
        },
        // 换一条 AI 回复的 swipe
        chatSwipe: {
            weight: 7,
            run: async () => {
                if (!a.state.chatIds.length) return { skipped: true };
                return writeChat(pick(a.state.chatIds), `(chat) => {
                    const aiMessages = chat.messages.filter(message => message.swipes);
                    if (!aiMessages.length) return { skipped: true };
                    const target = aiMessages[aiMessages.length - 1];
                    target.swipeId = (target.swipeId + 1) % target.swipes.length;
                    return { swiped: chat.id, swipeId: target.swipeId };
                }`);
            }
        },
        // 生成图片：真实 magic imageTask 链路（生成→R2→固定记录落库）；35% 重掷
        imageGen: {
            weight: 10,
            run: async () => {
                if (!a.state.chars.length) return { skipped: true };
                const character = pick(a.state.chars);
                const characterName = a.state.charNames.get(character) || '角色';
                const messageIndex = between(1, 30);
                const tag = encodeURIComponent(pick(['sunset', 'forest', 'city', 'ocean', 'night']) + between(0, 99));
                const fresh = rand() < 0.35 ? 'true' : 'false';
                const outcome = await pageEvalAsync(a.window, `(async () => {
                    const requestUrl = '/api/rp-image?tag=${tag}&token=TOK&character_name=${encodeURIComponent(characterName)}';
                    const card = document.createElement('div');
                    card.dataset.messageIndex = '${messageIndex}';
                    card.dataset.occurrenceIndex = '0';
                    const img = document.createElement('img');
                    card.appendChild(img);
                    const label = document.createElement('div');
                    label.className = 'generated-image-progress-label';
                    card.appendChild(label);
                    document.body.appendChild(card);
                    const task = window.__rphActions.imageRequest({
                        card, requestUrl, fresh: ${fresh},
                        message: { id: 'm${messageIndex}', content: '生图上下文' },
                        storyScopeId: 'default',
                        characterId: '${character}', characterName: ${JSON.stringify(characterName)},
                        autoImageGen: true,
                        render: (c, t, job) => { c.dataset.imageJobState = job?.status || ''; }
                    });
                    const job = await task.promise;
                    card.remove();
                    return { status: job?.status, imageKey: job?.imageKey || '', error: job?.error || '', fresh: ${fresh} };
                })()`);
                if (outcome.status === 'done' && outcome.imageKey) a.state.imageKeys.add(outcome.imageKey);
                return outcome;
            }
        },
        // 删除图片（图库页两阶段删除：云端墓碑；本地固定记录保留——真实拓扑）
        imageDelete: {
            weight: 5,
            run: async () => {
                if (!a.state.imageKeys.size) return { skipped: true };
                const keys = [...a.state.imageKeys];
                const target = keys[Math.floor(rand() * keys.length)];
                const response = await a.window.fetch('/image/api/delete', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ keys: [target] })
                });
                const payload = await response.json();
                if (payload.ok) {
                    a.state.imageKeys.delete(target);
                    a.state.deletedImageKeys.push(target);
                }
                return { ok: payload.ok === true };
            }
        },
        // 导入角色卡
        charImport: {
            weight: 8,
            run: async () => {
                const id = 'char-' + Math.floor(rand() * 1e12).toString(36) + a.state.importSeq;
                a.state.importSeq += 1;
                const name = '导入角色' + a.state.importSeq;
                await pageEvalAsync(a.window, `(async () => {
                    const db = await new Promise((resolve, reject) => {
                        const request = indexedDB.open('AICharGen');
                        request.onerror = () => reject(request.error);
                        request.onsuccess = () => resolve(request.result);
                    });
                    await new Promise((resolve, reject) => {
                        const tx = db.transaction(['characters'], 'readwrite');
                        tx.objectStore('characters').put({
                            id: ${JSON.stringify(id)}, name: ${JSON.stringify(name)},
                            greeting: '你好，旅人。', description: '一段导入的设定文本。'.repeat(30),
                            variants: [], memory: { facts: [], summary: '' }, createdAt: Date.now()
                        }, ${JSON.stringify(id)});
                        tx.oncomplete = () => { db.close(); resolve(); };
                        tx.onerror = () => reject(tx.error);
                    });
                    return true;
                })()`);
                a.state.chars.push(id);
                a.state.charNames.set(id, name);
                return { imported: id };
            }
        },
        // 删除角色卡：删角色 + 触发 magic character-deleted 清理（记录键是否残留由拓扑观察回答）
        charDelete: {
            weight: 4,
            run: async () => {
                const candidates = a.state.chars.filter(id => !a.state.protectedChars.has(id));
                if (!candidates.length) return { skipped: true };
                const victim = candidates[Math.floor(rand() * candidates.length)];
                await pageEvalAsync(a.window, `(async () => {
                    const db = await new Promise((resolve, reject) => {
                        const request = indexedDB.open('AICharGen');
                        request.onerror = () => reject(request.error);
                        request.onsuccess = () => resolve(request.result);
                    });
                    await new Promise((resolve, reject) => {
                        const tx = db.transaction(['characters'], 'readwrite');
                        tx.objectStore('characters').delete(${JSON.stringify(victim)});
                        tx.oncomplete = () => { db.close(); resolve(); };
                        tx.onerror = () => reject(tx.error);
                    });
                    await window.__rphActions.characterDeleted(${JSON.stringify(victim)});
                    return true;
                })()`);
                a.state.chars = a.state.chars.filter(id => id !== victim);
                a.state.charNames.delete(victim);
                a.state.deletedChars.push(victim);
                return { deletedChar: victim };
            }
        },
        // 删除会话
        chatDelete: {
            weight: 5,
            run: async () => {
                if (!a.state.chatIds.length) return { skipped: true };
                const chatId = pick(a.state.chatIds);
                const outcome = await pageEvalAsync(a.window, `(async () => {
                    const db = await new Promise((resolve, reject) => {
                        const request = indexedDB.open('RPHubDB');
                        request.onerror = () => reject(request.error);
                        request.onsuccess = () => resolve(request.result);
                    });
                    return await new Promise((resolve, reject) => {
                        const tx = db.transaction(['store'], 'readwrite');
                        tx.objectStore('store').delete(${JSON.stringify(chatId)});
                        tx.oncomplete = () => { db.close(); resolve({ deleted: ${JSON.stringify(chatId)} }); };
                        tx.onerror = () => reject(tx.error);
                    });
                })()`);
                if (outcome?.deleted) a.state.chatIds = a.state.chatIds.filter(id => id !== chatId);
                return outcome;
            }
        },
        // 分支新聊天：复制现有会话，截断到随机分叉点并加一条分歧消息
        chatFork: {
            weight: 8,
            run: async () => {
                if (!a.state.chatIds.length) return { skipped: true };
                const sourceId = pick(a.state.chatIds);
                const forkAt = between(1, 30);
                const forkId = sourceId + '-fork' + a.state.forkSeq;
                a.state.forkSeq += 1;
                const outcome = await pageEvalAsync(a.window, `(async () => {
                    const db = await new Promise((resolve, reject) => {
                        const request = indexedDB.open('RPHubDB');
                        request.onerror = () => reject(request.error);
                        request.onsuccess = () => resolve(request.result);
                    });
                    return await new Promise((resolve, reject) => {
                        const tx = db.transaction(['store'], 'readwrite');
                        const store = tx.objectStore('store');
                        const getKey = store.get(${JSON.stringify(sourceId)});
                        getKey.onsuccess = () => {
                            const chat = getKey.result;
                            if (!chat) { resolve({ skipped: true }); return; }
                            const cut = Math.min(${forkAt}, chat.messages.length);
                            const copy = {
                                ...chat, id: ${JSON.stringify(forkId)}, title: chat.title + ' · 分支',
                                createdAt: Date.now(),
                                messages: chat.messages.slice(0, cut).concat([{
                                    id: 'm' + Date.now() + '_fork', role: 'user', ts: Date.now(), text: '（分支）我们换个走法。'
                                }])
                            };
                            store.put(copy, ${JSON.stringify(forkId)});
                            tx.oncomplete = () => { db.close(); resolve({ forked: ${JSON.stringify(forkId)}, from: ${JSON.stringify(sourceId)}, at: cut }); };
                        };
                        tx.onerror = () => reject(tx.error);
                    });
                })()`);
                if (outcome?.forked) a.state.chatIds.push(forkId);
                return outcome;
            }
        },
        // 手动上传：真实面板按钮路径（pushViaPanel 处理同步互斥/自动保存抢跑）
        manualPush: {
            weight: 9,
            run: async () => pushViaPanel(a)
        },
        // 纯空档：推进时钟，让自动保存/后台准备按真实节奏自然运行
        idleAdvance: {
            weight: 12,
            run: async () => {
                const gap = between(4, 12) * 60 * 1000;
                await a.clock.advance(a.clock.nowMs() + gap);
                return { advanced: Math.round(gap / 60000) + 'min' };
            }
        }
    };
}
const ACTION_NAMES = ['chatAppend', 'chatSwipe', 'imageGen', 'imageDelete', 'charImport', 'charDelete', 'chatDelete', 'chatFork', 'manualPush', 'idleAdvance'];
function makePicker(actions) {
    const total = ACTION_NAMES.reduce((sum, name) => sum + actions[name].weight, 0);
    return () => {
        let roll = rand() * total;
        for (const name of ACTION_NAMES) {
            roll -= actions[name].weight;
            if (roll <= 0) return name;
        }
        return 'idleAdvance';
    };
}

const fmtMs = ms => `${(ms / 1000).toFixed(1)}s`;

async function main() {
    const worker = makeWorker();
    const clock = createVirtualClock();
    pumpClock = clock;
    const metrics = { requests: [] };
    const report = { rounds: 0, actionCounts: {}, prepares: [], hiddenRounds: 0 };

    // ---- 设备 A：主设备，度过一天 ----
    const a = {
        ...setupVirtualBrowser({ url: '/', worker, clock, metrics }),
        clock,
        state: {
            chars: [], charNames: new Map(), protectedChars: new Set(),
            chatIds: [], imageKeys: new Set(), deletedImageKeys: [], deletedChars: [],
            importSeq: 0, forkSeq: 0
        }
    };
    const t0 = Date.now();
    const seeded = await seedInitialData(a.window);
    a.state.chars = [...seeded.chars];
    seeded.chars.forEach((id, index) => { a.state.protectedChars.add(id); a.state.charNames.set(id, '角色' + index); });
    a.state.chatIds = [...seeded.chatIds];
    console.log(`[种子] ${seeded.chars.length} 角色 / ${seeded.chatIds.length} 会话 × 40 消息`);

    // ---- 首次手动上传：建立云端基线 ----
    await pushViaPanel(a);
    const manifest0 = await readCloudManifest(worker.bucket);
    console.log(`[基线] 云端 v${manifest0.version}：${manifest0.packs.length} 分片 / ${(manifest0.totalBytes / 1024).toFixed(0)}KiB（gzip）`);

    // ---- 开启自动保存（真实 UI 路径，5 分钟周期）----
    const toggle = a.window.document.querySelector('[data-action="auto-save-toggle"]');
    assert(toggle, '自动保存开关存在');
    toggle.checked = true;
    toggle.dispatchEvent(new a.window.Event('change'));
    const minutesInput = a.window.document.querySelector('[data-action="auto-save-minutes"]');
    if (minutesInput) {
        minutesInput.value = String(AUTOSAVE_MIN);
        minutesInput.dispatchEvent(new a.window.Event('change'));
    }

    // ---- 一天的随机调度：行为与自动保存/后台准备/页签隐藏自然交错 ----
    const actions = buildActions(a);
    const pickAction = makePicker(actions);
    let lastWatermark = '';
    let dirtyEventsSincePrepare = 0;
    a.window.addEventListener('rphub:dirty', () => { dirtyEventsSincePrepare += 1; });
    const dayStart = clock.nowMs();
    let round = 0;
    while (clock.nowMs() - dayStart < DAY_MS && round < 600) {
        round += 1;
        const wallStart = Date.now();
        const roundActions = [];
        const actionCount = between(1, 3);
        for (let i = 0; i < actionCount; i += 1) {
            const name = pickAction();
            const journalBefore = await readJournalCount(a.idb, 'RPHubDB');
            const outcome = await actions[name].run();
            const journalAfter = await readJournalCount(a.idb, 'RPHubDB');
            report.actionCounts[name] = (report.actionCounts[name] || 0) + 1;
            roundActions.push({ name, outcome, journalDelta: journalAfter - journalBefore });
        }
        // 30% 的空档页签处于后台（自动保存暂停、后台准备跳过——真实用户行为）
        const hidden = rand() < 0.3;
        if (hidden) {
            report.hiddenRounds += 1;
            a.window.__setVisible(false);
        }
        const gap = between(3, 14) * 60 * 1000;
        await clock.advance(clock.nowMs() + gap);
        if (hidden) a.window.__setVisible(true);
        // 观察后台准备：journalWatermark 变化 = 有一次准备消费了新事件
        const cacheState = await readSyncCacheState(a.idb);
        const watermark = cacheState?.journalWatermark?.databases || {};
        const watermarkKey = JSON.stringify(watermark);
        if (cacheState && watermarkKey !== lastWatermark) {
            report.prepares.push({ at: Math.round(clock.nowMs() / 60000), dirtyEvents: dirtyEventsSincePrepare, watermark });
            lastWatermark = watermarkKey;
        }
        dirtyEventsSincePrepare = 0;
        const journalNow = await readJournalCount(a.idb, 'RPHubDB');
        if (journalNow > 400) throw new Error(`journal 积压异常：${journalNow} 条（轮 ${round}）`);
        report.rounds = round;
        if (Date.now() - wallStart > 30000) throw new Error(`轮 ${round} 墙钟耗时异常：${Date.now() - wallStart}ms`);
    }
    const dayMinutes = Math.round((clock.nowMs() - dayStart) / 60000);
    const autoSaveFires = badgeLog.length;
    console.log(`[一天结束] 虚拟 ${dayMinutes} 分钟 / ${round} 轮行为；同步成功 ${autoSaveFires} 次；journal 剩余 ${await readJournalCount(a.idb, 'RPHubDB')} 条`);

    // ---- 收尾：最终手动上传（捕获一切未准备写入）----
    await pushViaPanel(a, 120000);
    const journalFinalA = await readJournalCount(a.idb, 'RPHubDB');
    const journalFinalChars = await readJournalCount(a.idb, 'AICharGen');
    if (journalFinalA !== 0 || journalFinalChars !== 0) {
        // 诊断转储：残留事件（键+值）与水位
        console.error('[诊断] RPHubDB journal 事件:', JSON.stringify(await readJournalEntries(a.idb, 'RPHubDB')));
        console.error('[诊断] AICharGen journal 事件:', JSON.stringify(await readJournalEntries(a.idb, 'AICharGen')));
        const state = await readSyncCacheState(a.idb);
        console.error('[诊断] 水位:', JSON.stringify(state?.journalWatermark));
        console.error('[诊断] 最后 3 次 badge:', JSON.stringify(badgeLog.slice(-3)));
    }
    assertEqual(journalFinalA, 0, `A 设备 RPHubDB journal 全部确认（实际 ${journalFinalA}）`);
    assertEqual(journalFinalChars, 0, `A 设备 AICharGen journal 全部确认（实际 ${journalFinalChars}）`);

    // ---- 设备 B1：全新浏览器全量恢复 ----
    const b1PackGetBefore = worker.counters.packGet;
    const b1 = setupVirtualBrowser({ url: '/sync-restore', worker, clock, metrics });
    await waitForSyncDone(b1.window, 120000, badgeBaseline());
    const b1PackGets = worker.counters.packGet - b1PackGetBefore;
    assert(b1PackGets > 0, 'B1 首次恢复走网络下载');

    // ---- 设备 B2：同一浏览器几小时后再开恢复页（分片缓存命中 → 0 下载）----
    const b2PackGetBefore = worker.counters.packGet;
    const b2 = setupVirtualBrowser({ url: '/sync-restore', worker, clock, metrics, idb: b1.idb });
    await waitForSyncDone(b2.window, 120000, badgeBaseline());
    const b2PackGets = worker.counters.packGet - b2PackGetBefore;
    assertEqual(b2PackGets, 0, `B2 二次恢复命中本地分片缓存（实际 GET ${b2PackGets}）`);

    // ---- 字节级抽查：A 本地 vs B2 恢复（IndexedDB 全量 + localStorage 应用键）----
    const aRph = await readStoreAll(a.idb, 'RPHubDB', 'store');
    const bRph = await readStoreAll(b2.idb, 'RPHubDB', 'store');
    assertEqual(bRph.keys.length, aRph.keys.length, `RPHubDB 记录数一致（A=${aRph.keys.length}，B=${bRph.keys.length}）`);
    let mismatched = 0;
    for (let index = 0; index < aRph.keys.length; index += 1) {
        if (aRph.keys[index] !== bRph.keys[index]
            || JSON.stringify(canonical(aRph.values[index])) !== JSON.stringify(canonical(bRph.values[index]))) {
            mismatched += 1;
            console.error(`  [差异] RPHubDB key=${aRph.keys[index]}`);
        }
    }
    assertEqual(mismatched, 0, 'RPHubDB 全部记录字节级一致（canonical）');
    const aChars = await readStoreAll(a.idb, 'AICharGen', 'characters');
    const bChars = await readStoreAll(b2.idb, 'AICharGen', 'characters');
    assertEqual(bChars.keys.length, aChars.keys.length, `AICharGen 角色卡数一致（A=${aChars.keys.length}）`);
    mismatched = 0;
    for (let index = 0; index < aChars.keys.length; index += 1) {
        if (aChars.keys[index] !== bChars.keys[index]
            || JSON.stringify(canonical(aChars.values[index])) !== JSON.stringify(canonical(bChars.values[index]))) {
            mismatched += 1;
            console.error(`  [差异] AICharGen key=${aChars.keys[index]}`);
        }
    }
    assertEqual(mismatched, 0, 'AICharGen 全部角色卡字节级一致（canonical）');
    const aStorage = appLocalStorageEntries(a.window);
    const bStorage = appLocalStorageEntries(b2.window);
    assertEqual(JSON.stringify(bStorage), JSON.stringify(aStorage),
        `localStorage 应用键一致（A=${Object.keys(aStorage).length}，B=${Object.keys(bStorage).length}）`);

    // ---- 拓扑观察：孤儿图片记录（删除角色卡后 rp_hub_image_renders_<id> 是否残留）----
    const orphanReport = [];
    for (let index = 0; index < aRph.keys.length; index += 1) {
        const key = String(aRph.keys[index]);
        if (key.startsWith('rp_hub_image_renders_')) {
            const charId = key.slice('rp_hub_image_renders_'.length);
            const stillExists = aChars.keys.includes(charId);
            orphanReport.push({
                charId, charStillExists: stillExists,
                records: Array.isArray(aRph.values[index]) ? aRph.values[index].length : 0,
                deletedThisDay: a.state.deletedChars.includes(charId)
            });
        }
    }
    console.log('[拓扑] 图片固定记录槽位：', JSON.stringify(orphanReport));

    // ---- 指标报告 ----
    const manifestFinal = await readCloudManifest(worker.bucket);
    const requestSummary = {};
    for (const request of metrics.requests) {
        const key = `${request.method} ${request.path}`;
        const entry = requestSummary[key] = requestSummary[key] || { count: 0, bytes: 0 };
        entry.count += 1;
        entry.bytes += request.reqBytes;
    }
    // 每次同步的分片上传增量（0 = 无变化同步，只花了一次 status 往返）。
    // 第一条 badge 之前的 PUT 都属于基线上传，单独剔除。
    const deviceBadges = badgeLog.filter(entry => entry.device === 'main');
    const firstPushBaseline = deviceBadges.length ? deviceBadges[0].packPut : worker.counters.packPut;
    let noChangeSyncs = 0;
    const perSync = deviceBadges.map((badge, index) => {
        const packDelta = badge.packPut - (index > 0 ? deviceBadges[index - 1].packPut : firstPushBaseline);
        if (packDelta === 0) noChangeSyncs += 1;
        return packDelta;
    });
    console.log('\n========== 一天模拟指标 ==========');
    console.log(`虚拟时长：${dayMinutes} 分钟（目标 ${Math.round(DAY_MS / 60000)}）；行为轮数：${round}；页签隐藏空档：${report.hiddenRounds}`);
    console.log(`行为分布：`, JSON.stringify(report.actionCounts));
    console.log(`同步成功 ${autoSaveFires} 次（含手动），其中无变化同步 ${noChangeSyncs} 次（仍各花 1 次 status 往返）`);
    console.log(`请求账单：`, JSON.stringify(Object.fromEntries(Object.entries(requestSummary).map(([key, value]) => [key, `${value.count}次/${(value.bytes / 1024).toFixed(0)}KiB`]))));
    console.log(`同步动作分解：`, JSON.stringify(worker.counters.actions));
    console.log(`分片 PUT：${worker.counters.packPut} 次 / ${(worker.counters.packPutBytes / 1024).toFixed(0)}KiB gzip；分片 GET：${worker.counters.packGet} 次（B1 全量 ${b1PackGets} + B2 缓存 0）`);
    console.log(`云端终态：v${manifestFinal.version}，${manifestFinal.packs.length} 分片，${manifestFinal.entryCount} 条目，${(manifestFinal.totalBytes / 1024).toFixed(0)}KiB`);
    console.log(`生图上游调用：${worker.upstreamCount()} 次`);
    console.log(`后台准备消费事件：${report.prepares.length} 次水位推进，dirty 事件合并率 ${report.prepares.reduce((sum, p) => sum + p.dirtyEvents, 0)}→${report.prepares.length}`);
    console.log(`每轮同步分片数分布：0片=${perSync.filter(n => n === 0).length} 1-2片=${perSync.filter(n => n >= 1 && n <= 2).length} 3片+=${perSync.filter(n => n > 2).length}`);
    console.log(`真实墙钟：${fmtMs(Date.now() - t0)}`);
    console.log('==================================');

    console.log('day-sim: 全部通过');
}

main().catch(error => {
    console.error('day-sim 失败:', error);
    process.exit(1);
});

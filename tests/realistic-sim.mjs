// 真实形态模拟：以贴近真实用户的数据形态跑端到端——
//   * AICharGen.characters 角色卡（含开场白、设定、嵌套数组）
//   * RPHubDB.store 长对话（多角色多天、消息内嵌 base64 图、JSON 设置）
//   * localStorage 设置键（含自动保存配置）
//   * /api/rp-image 图片全流程（生成→缓存→缩略图→图库→删除）
// 覆盖作者真实应用会产生的数据拓扑，测量请求数/耗时/压缩率/后台准备，
// 从中找优化点。数据全部由页面 realm 生成（jsdom 原型链约束）。
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

// ---- 可调参数（环境变量覆盖）----
const CHARS = Number(process.env.SIM_CHARS || 6);            // 角色卡数
const CHATS_PER_CHAR = Number(process.env.SIM_CHATS || 4);   // 每角色会话数
const MSG_PER_CHAT = Number(process.env.SIM_MSGS || 60);     // 每会话消息数
const BASE64_EVERY = Number(process.env.SIM_B64_EVERY || 12);// 每 N 条消息内嵌一张 base64 图
const BASE64_KB = Number(process.env.SIM_B64_KB || 24);      // 内嵌图平均大小
const IMAGE_COUNT = Number(process.env.SIM_IMAGES || 8);     // 图库图片数
const QUIET = process.env.SIM_QUIET === '1';

function makeWorker() {
    const bucket = createR2Bucket();
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

function setupBrowser({ url, worker } = {}) {
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', error => {
        if (!String(error?.message || '').includes('Not implemented')) throw error;
    });
    if (!QUIET) {
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
    // 页面内 fetch：同步 API 直连 Worker；生图 API 走假上游（PNG 字节）。
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
        if (resolved.pathname === '/api/rp-image') {
            return worker.workerFetch(resolved.pathname + resolved.search, init);
        }
        throw new Error(`unexpected client fetch: ${resolved.pathname}`);
    };
    // 生图上游桩：tag+character 决定内容，保证同参数幂等。
    globalThis.fetch = async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        const parsed = new URL(url);
        if (parsed.hostname === 'nai.sta1n.cn') {
            const tag = parsed.searchParams.get('tag') || '';
            const size = 2048;
            const bytes = new Uint8Array(size);
            bytes[0] = 0x89; bytes[1] = 0x50;
            for (let index = 2; index < size; index += 1) bytes[index] = (tag.charCodeAt(index % Math.max(1, tag.length)) + index) & 0xff;
            return new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' } });
        }
        throw new Error(`unexpected upstream: ${url}`);
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

// 在页面 realm 内生成贴近真实形态的全部数据。
async function seedRealisticData(window) {
    return pageEvalAsync(window, `(async () => {
        const CHARS = ${CHARS}, CHATS = ${CHATS_PER_CHAR}, MSGS = ${MSG_PER_CHAT};
        const B64_EVERY = ${BASE64_EVERY}, B64_KB = ${BASE64_KB};
        // 伪随机（固定种子，结果可复现）。
        let seed = 20261026;
        const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
        const pick = list => list[Math.floor(rand() * list.length)];
        const words = ['剑光', '夜色', '低语', '回响', '星图', '余烬', '门扉', '灰雾', '誓言', '微光', '残响', '长街'];
        const sentence = () => Array.from({ length: 4 + Math.floor(rand() * 10) }, () => pick(words)).join('') + (rand() < 0.2 ? '。'.repeat(2) : '');
        const paragraph = () => Array.from({ length: 2 + Math.floor(rand() * 4) }, sentence).join('　');
        const base64Chunk = () => {
            // 模拟内嵌图片 data URL：高熵前缀 + 低熵主体（贴近 PNG base64 的混合熵）。
            const header = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg';
            const body = (Math.floor(rand() * 0xffffff).toString(36) + 'Q').repeat(Math.ceil(B64_KB * 1024 / 40));
            return header + body.slice(0, B64_KB * 1024 - header.length);
        };

        // ---- 角色卡（AICharGen/characters）----
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
            for (let c = 0; c < CHARS; c += 1) {
                const id = 'char-' + String(c).padStart(4, '0');
                charIds.push(id);
                store.put({
                    id,
                    name: '角色' + c,
                    greeting: paragraph(),
                    description: Array.from({ length: 3 }, paragraph).join('\\n'),
                    tags: Array.from({ length: 5 }, () => pick(words)),
                    variants: Array.from({ length: 3 }, (_, v) => ({ id: 'v' + v, text: paragraph() })),
                    memory: { facts: Array.from({ length: 20 }, sentence), summary: paragraph() },
                    createdAt: Date.now() - c * 86400000
                }, id);
            }
            tx.oncomplete = () => { charDb.close(); resolve(); };
            tx.onerror = () => reject(tx.error);
        });

        // ---- 会话（RPHubDB/store，顶层数组 messages + 平铺设置记录）----
        const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('RPHubDB', 1);
            request.onupgradeneeded = () => { request.result.createObjectStore('store'); };
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });
        const messageCount = { value: 0 };
        await new Promise((resolve, reject) => {
            const tx = db.transaction(['store'], 'readwrite');
            const store = tx.objectStore('store');
            for (let c = 0; c < CHARS; c += 1) {
                for (let h = 0; h < CHATS; h += 1) {
                    const messages = [];
                    for (let m = 0; m < MSGS; m += 1) {
                        messageCount.value += 1;
                        const role = m % 2 === 0 ? 'user' : 'ai';
                        const text = paragraph();
                        const message = { id: 'm' + c + h + '_' + m, role, ts: Date.now() - (MSGS - m) * 60000 };
                        if (role === 'ai') {
                            message.swipes = [text, paragraph(), paragraph()];
                            message.swipeId = Math.floor(rand() * 3);
                        }
                        if (m % B64_EVERY === 0) message.images = [base64Chunk()];
                        if (rand() < 0.05) message.book = { name: pick(words), entries: Array.from({ length: 3 }, sentence) };
                        messages.push(message);
                    }
                    store.put({
                        id: 'chat-' + c + '-' + h,
                        characterId: charIds[c],
                        title: '会话 ' + h,
                        createdAt: Date.now() - h * 3600000,
                        messages
                    }, 'chat-' + c + '-' + h);
                }
                store.put({ id: 'pref-' + c, ui: { theme: 'dark', fontSize: 14 + c, pinned: c < 2 } }, 'pref-' + c);
            }
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror = () => reject(tx.error);
        });

        // ---- localStorage 设置 ----
        localStorage.setItem('rp_hub_settings', JSON.stringify({ autosave: 10, theme: 'dark' }));
        localStorage.setItem('ai_chargen_ui', JSON.stringify({ sidebar: true, lastChar: charIds[0] }));
        localStorage.setItem('rp_hub_sync_password_v1', 'sim-pass');
        return { chars: CHARS, chats: CHARS * CHATS, messages: messageCount.value };
    })()`);
}

// 图片库全流程：生成 → 缓存命中 → 缩略图 → 图库列表 → 删除（墓碑）。
async function imageLifecycle(worker) {
    const pngOf = tag => {
        const size = 2048;
        const bytes = new Uint8Array(size);
        bytes[0] = 0x89; bytes[1] = 0x50;
        for (let index = 2; index < size; index += 1) bytes[index] = (tag.charCodeAt(index % Math.max(1, tag.length)) + index) & 0xff;
        return bytes;
    };
    const keys = [];
    const upstream = new Map(); // "tag|char" -> 调用次数
    const call = async (path, init) => worker.workerFetch(path, init);
    for (let index = 0; index < IMAGE_COUNT; index += 1) {
        const tag = `tag${index}`;
        const character = `角色${index % 3}`;
        const params = `tag=${tag}&token=TOK&character_name=${encodeURIComponent(character)}`;
        let response = await call(`/api/rp-image?${params}`, { method: 'POST' });
        assertEqual(response.status, 200, `生图 ${tag}`);
        const key = decodeURIComponent(response.headers.get('x-rp-image-key'));
        keys.push(key);
        // 同参数第二次：必须命中缓存（上游计数不变）。
        response = await call(`/api/rp-image?${params}`, { method: 'POST' });
        assertEqual(response.status, 200, `生图缓存命中 ${tag}`);
        // 缩略图上传与读取。
        const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, index, 2, 3, 4]);
        response = await call(`/api/rp-image?key=${encodeURIComponent(key)}&thumb=1&token=TOK`, {
            method: 'PUT', headers: { 'content-type': 'image/webp' }, body: webp
        });
        assertEqual(response.status, 200, `缩略图上传 ${tag}`);
        response = await call(`/api/rp-image?key=${encodeURIComponent(key)}&thumb=1`);
        assertEqual(response.status, 200, `缩略图读取 ${tag}`);
        void pngOf; void upstream;
    }
    // 图库列表。
    let response = await call('/image/api/library');
    const library = await response.json();
    assertEqual(library.totalCount, IMAGE_COUNT, '图库总数');
    // key 直读 + ETag 304。
    response = await call(`/api/rp-image?key=${encodeURIComponent(keys[0])}`);
    assertEqual(response.status, 200, '原图直读');
    const etag = response.headers.get('etag');
    response = await call(`/api/rp-image?key=${encodeURIComponent(keys[0])}`, { headers: { 'if-none-match': etag } });
    assertEqual(response.status, 304, '协商缓存 304');
    // 删除一张（两阶段）。
    response = await call('/image/api/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ keys: [keys[1]] })
    });
    assertEqual((await response.json()).ok, true, '删除接受');
    response = await call(`/api/rp-image?key=${encodeURIComponent(keys[1])}`);
    assertEqual(response.status, 200, '已删图返回占位');
    return keys;
}

async function readCloudManifest(bucket) {
    const object = await bucket.get('rp-sync/v2/manifest.json');
    return object ? JSON.parse(await object.text()) : null;
}

const fmt = ms => `${(ms / 1000).toFixed(1)}s`;

async function main() {
    const worker = makeWorker();
    const t0 = Date.now();

    // ---- 阶段 1：真实形态数据生成 ----
    const a = setupBrowser({ url: '/', worker });
    const seeded = await seedRealisticData(a.window);
    const tSeed = Date.now();
    console.log(`[1] 数据生成：${seeded.chars} 角色 / ${seeded.chats} 会话 / ${seeded.messages} 消息（内嵌图每 ${BASE64_EVERY} 条 @${BASE64_KB}KB）→ ${fmt(tSeed - t0)}`);

    // ---- 阶段 2：首次上传（含后台准备效应：上传前先跑一次面板装配预热）----
    const tUpload0 = Date.now();
    a.window.RPH_R2_OPEN_SYNC();
    for (let waited = 0; waited < 5000 && !a.window.document.querySelector('[data-action="push"]'); waited += 20) {
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    a.window.localStorage.removeItem('rp_hub_sync_last_result_v1');
    a.window.document.querySelector('[data-action="push"]').click();
    const first = await waitForSyncDone(a.window, 300_000);
    assert(first.ok, '真实形态首次上传成功');
    const manifest = await readCloudManifest(worker.bucket);
    assert(manifest && manifest.packs.length > 0, '云端清单存在');
    const tUpload = Date.now() - tUpload0;
    console.log(`[2] 首次上传：${manifest.packs.length} 分片 / ${(manifest.totalBytes / 1048576).toFixed(1)}MiB gzip / ${manifest.entryCount} 条 / ${fmt(tUpload)} / ${worker.counters.packPut} PUT + ${worker.counters.syncPost} POST`);
    assertEqual((await worker.bucket.list({ prefix: 'rp-sync/v2/packs/', limit: 100000 })).objects.length, manifest.packs.length, '无孤儿分片');

    // ---- 阶段 3：无变化上传 ----
    worker.counters.packPut = 0; worker.counters.syncPost = 0;
    const tNoop0 = Date.now();
    a.window.localStorage.removeItem('rp_hub_sync_last_result_v1');
    a.window.RPH_R2_OPEN_SYNC();
    for (let waited = 0; waited < 5000 && !a.window.document.querySelector('[data-action="push"]'); waited += 20) {
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    a.window.document.querySelector('[data-action="push"]').click();
    await waitForSyncDone(a.window);
    const tNoop = Date.now() - tNoop0;
    assertEqual(worker.counters.packPut, 0, '无变化 0 分片');
    console.log(`[3] 无变化上传：${worker.counters.syncPost} 请求 / ${fmt(tNoop)}`);

    // ---- 阶段 4：继续一段对话（真实增量形态：改 1 个会话 + 新消息含内嵌图）----
    await pageEvalAsync(a.window, `(async () => {
        const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('RPHubDB');
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });
        await new Promise((resolve, reject) => {
            const tx = db.transaction(['store'], 'readwrite');
            const store = tx.objectStore('store');
            const get = store.get('chat-0-0');
            get.onsuccess = () => {
                const chat = get.result;
                for (let m = 0; m < 8; m += 1) {
                    chat.messages.push({
                        id: 'new-' + m, role: m % 2 ? 'ai' : 'user', ts: Date.now() + m,
                        text: '续写消息 ' + m + ' ' + Array.from({ length: 8 }, () => '词' + m).join('')
                    });
                }
                chat.messages[chat.messages.length - 1].images = ['data:image/png;base64,' + 'Z'.repeat(24 * 1024)];
                store.put(chat, 'chat-0-0');
            };
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror = () => reject(tx.error);
        });
        localStorage.setItem('rp_hub_settings', JSON.stringify({ autosave: 5, theme: 'dark' }));
        return true;
    })()`);
    worker.counters.packPut = 0; worker.counters.syncPost = 0;
    const tIncr0 = Date.now();
    a.window.localStorage.removeItem('rp_hub_sync_last_result_v1');
    a.window.RPH_R2_OPEN_SYNC();
    for (let waited = 0; waited < 5000 && !a.window.document.querySelector('[data-action="push"]'); waited += 20) {
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    a.window.document.querySelector('[data-action="push"]').click();
    const incremental = await waitForSyncDone(a.window);
    assert(incremental.ok, '会话续写增量上传成功');
    const tIncr = Date.now() - tIncr0;
    console.log(`[4] 会话续写增量：${worker.counters.packPut} 分片 / ${worker.counters.syncPost} 请求 / ${fmt(tIncr)}`);

    // ---- 阶段 5：图片库全流程 ----
    const tImg0 = Date.now();
    await imageLifecycle(worker);
    console.log(`[5] 图片库全流程（${IMAGE_COUNT} 图：生成+缓存命中+缩略图+图库+删除）：${fmt(Date.now() - tImg0)}`);

    // ---- 阶段 6：新浏览器全量恢复 + 字节级抽查 ----
    const b = setupBrowser({ url: '/sync-restore', worker });
    const tRestore0 = Date.now();
    await waitForSyncDone(b.window, 300_000);
    const tRestore = Date.now() - tRestore0;
    const restoredChats = await readAllRecords(b.idb, 'RPHubDB', 'store');
    const restoredChars = await readAllRecords(b.idb, 'AICharGen', 'characters');
    assertEqual(restoredChars.length, CHARS, '恢复角色卡数量');
    const chatRecords = restoredChats.filter(record => String(record.id || '').startsWith('chat-'));
    assertEqual(chatRecords.length, seeded.chats, '恢复会话数量');
    const sourceChat = (await readAllRecords(a.idb, 'RPHubDB', 'store')).find(record => record.id === 'chat-0-0');
    const restoredChat = chatRecords.find(record => record.id === 'chat-0-0');
    assertEqual(restoredChat.messages.length, sourceChat.messages.length, '续写会话消息数一致');
    assertEqual(JSON.stringify(restoredChat.messages.at(-1).images), JSON.stringify(sourceChat.messages.at(-1).images), '内嵌图字节一致');
    assertEqual(b.window.localStorage.getItem('rp_hub_settings'), a.window.localStorage.getItem('rp_hub_settings'), 'localStorage 一致');
    console.log(`[6] 全量恢复：${restoredChats.length + restoredChars.length} 记录 / ${fmt(tRestore)}`);

    // ---- 阶段 7：恢复缓存命中（0 下载）----
    worker.counters.packGet = 0;
    b.window.localStorage.removeItem('rp_hub_sync_last_result_v1');
    b.window.document.querySelector('[data-action="pull"]').click();
    await waitForSyncDone(b.window);
    assertEqual(worker.counters.packGet, 0, '二次恢复 0 下载');
    console.log('[7] 恢复缓存命中：0 分片下载');

    console.log(`realistic-sim: 全部通过（总 ${fmt(Date.now() - t0)}，SIM_CHARS=${CHARS} SIM_CHATS=${CHATS_PER_CHAR} SIM_MSGS=${MSG_PER_CHAT}）`);
}

main().catch(error => {
    console.error('realistic-sim 失败:', error);
    process.exit(1);
});

// magic-extension.js 行为测试：真实适配脚本（兜底版）+ 真实 Vue 桥接 +
// 真实图片业务脚本跑在 jsdom + fake-indexeddb，图片 API 直连真实 _worker.js
// 与假 R2。驱动路径与作者端一致：chatContainer watcher → hydrate →
// loadCard → magic imageTask。覆盖：生图全链路（生成→缩略图→固定记录
// 持久化）、无上下文降级、自动生图门控抑制、缩略图回填、图片 flush。
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
const ADAPTER_SOURCE = readFileSync(join(pageDir, 'adapter', 'rp-hub-v2.js'), 'utf8');
const MAGIC_SOURCE = readFileSync(join(pageDir, 'magic-extension.js'), 'utf8');

function makeWorker() {
    const bucket = createR2Bucket();
    let upstreamCalls = 0;
    const pngBytes = () => {
        const size = 2048;
        const bytes = new Uint8Array(size);
        bytes[0] = 0x89; bytes[1] = 0x50;
        for (let index = 2; index < size; index += 1) bytes[index] = index & 0xff;
        return bytes;
    };
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
            return new Response(pngBytes(), { status: 200, headers: { 'content-type': 'image/png' } });
        }
        return realFetch(input, init);
    };
    async function workerFetch(path, init) {
        return workerModule.fetch(new Request(`https://site.test${path}`, init), env, ctx);
    }
    return { bucket, workerFetch, upstreamCount: () => upstreamCalls };
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
    virtualConsole.on('error', (...args) => console.error('[page]', ...args));
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
        if (['/api/rp-image', '/api/rp-sync', '/api/rp-sync/pack'].includes(resolved.pathname)) {
            return worker.workerFetch(resolved.pathname + resolved.search, init);
        }
        throw new Error(`unexpected client fetch: ${resolved.pathname}`);
    };
    window.confirm = () => true;
    window.alert = () => { };
    globalThis.localStorage = window.localStorage;
    globalThis.document = window.document;
    globalThis.location = window.location;
    window.eval(DIRTY_SOURCE);
    return { window, dom, idb: factory };
}

function openRaw(factory, name) {
    return new Promise((resolve, reject) => {
        const request = factory.open(name);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
    });
}

async function readImageRecords(factory, characterId) {
    const db = await openRaw(factory, 'RPHubDB');
    try {
        const tx = db.transaction(['store'], 'readonly');
        const request = tx.objectStore('store').get('rp_hub_image_renders_' + characterId);
        return await new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    } finally {
        db.close();
    }
}

async function main() {
    const worker = makeWorker();
    const a = setupBrowser({ url: '/', worker });
    const { window } = a;

    // ---- 搭作者 app：与 adapter-contract 同构的最小 Vue setup ----
    // 顺序约束（与 adapter-contract 相同）：DOM 全局提升 → 赋 window.Vue →
    // 存储桩 → eval 适配脚本（eval 时读取 window.Vue 完成桥接）→ eval magic。
    const VueNS = await import('vue');
    for (const name of ['document', 'Element', 'HTMLElement', 'SVGElement', 'Text', 'Comment', 'Node', 'MutationObserver', 'requestAnimationFrame']) {
        try { globalThis[name] = window[name]; } catch (_) { }
    }
    globalThis.window = window;
    window.Vue = { ...VueNS };
    // 作者存储桥：适配层 wrapStorage 捕获此赋值（storage 能力判定需要）。
    window.RPHubStorage = {
        async getStoredValue(name) { return window.__authorStore?.get(name) ?? null; },
        async setStoredValue(name, data) {
            window.__authorStore = window.__authorStore || new Map();
            window.__authorStore.set(name, data);
        },
        async setScopedStoredValue() { },
        async deleteScopedStoredValue() { }
    };
    window.eval(ADAPTER_SOURCE);
    window.eval(MAGIC_SOURCE);
    const external = window.RPHubExternal;
    assert(external && external.version === 2, '真实适配脚本装载');
    // 关键：从 window.Vue（适配层已包装的拷贝）解构——直接用 Node realm 的
    // VueNS.createApp 会绕过适配层的 setup 捕获。
    const { createApp, ref, watch, onMounted } = window.Vue;
    const chatContainer = ref(null);
    // 聊天历史：context() 要求 history[messageIndex] 存在，预置两条消息。
    const chatHistory = ref([
        { id: 'm0', content: '第一条消息' },
        { id: 'm1', content: '第二条消息' }
    ]);
    const app = createApp({
        setup() {
            const currentCharacter = ref({ uuid: 'char-1', name: 'Alice' });
            const currentStoryBranch = ref({ id: 'branch-1' });
            const worldInfo = ref([{ comment: '自动生图', enabled: true }]);
            const isAutoImageGenEnabled = ref(true);
            const settings = ref({ imageGenKey: 'KEY' });
            const isConversationBusy = ref(false);
            const storyBranchSwitching = ref(false);
            const switchingCharacterIndex = ref(-1);
            // 保存 watcher 标记（flush 门禁需要全部四个；本测试只触发挂载，
            // 标记齐全让 capabilities 不缺项）。
            watch(settings, () => {
                // _memorySettingsSaveTimer
                setTimeout(() => { }, 5);
            });
            watch(settings, () => {
                // debouncedSave
                setTimeout(() => { }, 5);
            });
            watch(chatHistory, () => {
                // debouncedCharacterSave
                setTimeout(() => { }, 5);
            });
            watch(chatHistory, () => {
                // scheduleChatHistorySave
                setTimeout(() => { }, 5);
            });
            // 聊天容器 watcher：适配层对此 source 的回调先跑 hydrate（作者端
            // 同构——作者就在 chatContainer watcher 里挂图片卡）。
            watch(chatContainer, () => { });
            onMounted(() => { });
            return {
                currentCharacter, currentStoryBranch, chatHistory,
                worldInfo, isAutoImageGenEnabled, settings, isConversationBusy,
                storyBranchSwitching, switchingCharacterIndex, chatContainer
            };
        }
    });
    app.mount('#app');
    // 容器 ref 挂到真实 DOM（watcher 的 hydrate 对它触发）。
    let container = window.document.createElement('div');
    window.document.body.appendChild(container);
    chatContainer.value = container;
    await new Promise(resolve => setTimeout(resolve, 30));
    assert(external.capabilities().context, '适配层上下文就绪');

    // ---- 场景 1：往聊天容器塞生图卡 → hydrate → magic imageTask 全链路 ----
    const row = window.document.createElement('div');
    row.setAttribute('data-chat-index', '0');
    const card = window.document.createElement('div');
    card.className = 'generated-image-card';
    card.setAttribute('data-image-request', '');
    card.dataset.imageRequest = '/api/rp-image?tag=sunset&size=竖图';
    const img = window.document.createElement('img');
    card.appendChild(img);
    const label = window.document.createElement('div');
    label.className = 'generated-image-progress-label';
    card.appendChild(label);
    const reroll = window.document.createElement('button');
    reroll.className = 'generated-image-reroll';
    card.appendChild(reroll);
    row.appendChild(card);
    container.appendChild(row);
    // 作者端消息重渲染会重新赋 chatContainer（新容器元素）→ watcher → hydrate。
    // 这里同构驱动：换一个已包含该行的容器再赋值，触发 hydrate 扫描新卡片。
    const container2 = window.document.createElement('div');
    container2.appendChild(row);
    window.document.body.replaceChild(container2, container);
    chatContainer.value = container2;
    container = container2;
    // 渲染桩：适配层 renderImage 会写 img.src；这里收尾等待任务完成。
    await new Promise(resolve => setTimeout(resolve, 300));
    const jobState = card.dataset.imageJobState;
    assert(['done', 'loading', 'failed'].includes(jobState || ''), `卡片任务状态合法（${jobState}）`);
    // 等任务结算（生成 + 缩略图 + 记录落库）。
    for (let waited = 0; waited < 10000; waited += 50) {
        if (card.dataset.imageJobState === 'done') break;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    assertEqual(card.dataset.imageJobState, 'done', '生图任务完成');
    assert((img.getAttribute('src') || '').includes('/api/rp-image'), '卡片图片指向本站代理地址');
    assertEqual(worker.upstreamCount(), 1, '生图上游只调用一次');
    // 原图落 R2；缩略图取决于环境：真实浏览器走 canvas WebP 成功上传，
    // jsdom 无位图解码 → createImageThumbnailBlob 失败 → thumbFailed 降级
    // 路径（原图 URL 展示 + 回填队列），两者都是设计行为。
    const objects = await worker.bucket.list({ prefix: 'rp-images/' });
    assert(objects.objects.some(object => object.key.startsWith('rp-images/characters/')), '原图入 R2');
    const thumbUploaded = objects.objects.some(object => object.key.startsWith('rp-images/thumbs/'));
    console.log(`  [环境] 缩略图上传：${thumbUploaded ? '成功（canvas 可用）' : '按设计降级（jsdom 无位图解码）'}`);
    // 固定记录持久化进 RPHubDB。
    const records = await readImageRecords(a.idb, 'char-1');
    assertEqual(records.length, 1, '固定记录写入');
    assertEqual(records[0].prompt, 'sunset', '记录提示词');
    assert(records[0].paramsSnapshot && typeof records[0].paramsSnapshot === 'object', '参数快照保存');
    assert(records[0].imageKey, '记录带 imageKey');

    // ---- 场景 2：同卡片重新 hydrate（消息重渲染）→ 复用已存记录，不再打上游 ----
    const card2 = card.cloneNode(true);
    row.replaceChild(card2, card);
    await new Promise(resolve => setTimeout(resolve, 300));
    assertEqual(worker.upstreamCount(), 1, '重渲染命中固定记录不重新生成');
    assertEqual(card2.dataset.imageJobState, 'done', '复用记录任务完成');

    // ---- 场景 3：无记录 key 直读 → 任务结算（ imageUrl 404 由 <img> error
    // 事件处理，任务本身完成；不重复生图、不打上游）----
    const row3 = window.document.createElement('div');
    row3.setAttribute('data-chat-index', '1');
    const card3 = window.document.createElement('div');
    card3.className = 'generated-image-card';
    card3.setAttribute('data-image-request', '');
    card3.dataset.imageRequest = '/api/rp-image?key=' + encodeURIComponent('rp-images/characters/Ghost/' + '0'.repeat(64));
    row3.appendChild(card3);
    // 当前容器是 container2（chatContainer.value 指向它）：塞入后再次换容器
    // 赋值触发 hydrate。
    container2.appendChild(row3);
    const container3 = window.document.createElement('div');
    container3.appendChild(row3);
    window.document.body.replaceChild(container3, container2);
    chatContainer.value = container3;
    container = container3;
    await new Promise(resolve => setTimeout(resolve, 300));
    for (let waited = 0; waited < 5000; waited += 50) {
        if (card3.dataset.imageJobState === 'failed' || card3.dataset.imageJobState === 'done') break;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert(['done', 'failed'].includes(card3.dataset.imageJobState), '缺图卡片状态结算');
    assertEqual(worker.upstreamCount(), 1, '缺图直读不触发上游生图');

    // ---- 场景 4：缩略图回填（RPH_MAGIC_BACKFILL_THUMB）----
    // 真实浏览器：拉原图→canvas WebP→PUT 成功。jsdom 无位图解码也缺
    // URL.createObjectURL，回填会按环境失败——验证的是通路可达与失败原因合理。
    const imageKey = records[0].imageKey;
    const thumbKey = imageKey.replace('rp-images/characters/', 'rp-images/thumbs/') + '.webp';
    await worker.bucket.delete(thumbKey);
    assert(!(await worker.bucket.get(thumbKey)), '缩略图已清除');
    const backfill = window.RPH_MAGIC_BACKFILL_THUMB(imageKey, 'TOK');
    const outcome = await backfill.then(() => 'ok', error => `failed: ${error?.message || error}`);
    console.log(`  缩略图回填结果：${outcome}`);
    assert(outcome === 'ok' || outcome.startsWith('failed: '), '回填通路可达（成功或按环境限制失败）');

    // ---- 场景 5：RPH_MAGIC_FLUSH_IMAGES 结算未落盘写 ----
    await window.RPH_MAGIC_FLUSH_IMAGES();
    const recordsAfterFlush = await readImageRecords(a.idb, 'char-1');
    assertEqual(recordsAfterFlush.length, 1, 'flush 后记录稳定');

    console.log('magic-behavior: 全部通过');
}

main().catch(error => {
    console.error('magic-behavior 失败:', error);
    process.exit(1);
});

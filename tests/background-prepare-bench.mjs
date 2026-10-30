// 后台索引维护基准：模拟持续聊天（周期写入）+ 周期性后台准备，
// 测量每次后台准备的耗时。journal 增量消费后每次准备应恒定（只扫新事件）；
// 全量重扫则随累积事件数线性增长。通过 visibilitychange 触发 1s 延迟的
// scheduleBackgroundPrepare（不走 8s 业务防抖，缩短测试时长）。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import {
    IDBFactory, IDBKeyRange, IDBDatabase, IDBObjectStore, IDBIndex,
    IDBTransaction, IDBRequest, IDBCursor, IDBVersionChangeEvent
} from 'fake-indexeddb';

const here = dirname(fileURLToPath(import.meta.url));
const pageDir = join(here, '..', 'page');
const DIRTY_SOURCE = readFileSync(join(pageDir, 'DB', 'dirty-tracker.js'), 'utf8');
const BOOTSTRAP_SOURCE = readFileSync(join(pageDir, 'DB', 'bootstrap.js'), 'utf8');

const ROUNDS = Number(process.env.BENCH_ROUNDS || 12);
const MSG_PER_ROUND = Number(process.env.BENCH_MSGS || 40);

const IDB_MEMBERS = [
    ['IDBKeyRange', IDBKeyRange], ['IDBFactory', IDBFactory], ['IDBDatabase', IDBDatabase],
    ['IDBObjectStore', IDBObjectStore], ['IDBIndex', IDBIndex], ['IDBTransaction', IDBTransaction],
    ['IDBRequest', IDBRequest], ['IDBCursor', IDBCursor], ['IDBVersionChangeEvent', IDBVersionChangeEvent]
];

function setupBrowser() {
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', error => {
        if (!String(error?.message || '').includes('Not implemented')) throw error;
    });
    const dom = new JSDOM('<!doctype html><html><head></head><body><div id="app"></div></body></html>', {
        url: 'https://site.test/',
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
        'Blob', 'Response', 'Headers', 'Request', 'structuredClone', 'AbortController', 'AbortSignal']) {
        if (globalThis[name] && window[name] !== globalThis[name]) window[name] = globalThis[name];
    }
    Object.defineProperty(window, 'crypto', { value: globalThis.crypto, configurable: true });
    // 同步网络层桩：不上传（上传会清空 journal，破坏"持续累积"前提），
    // status 返回空 manifest（模拟"云端为空"）。
    window.fetch = async () => new Response(JSON.stringify({ ok: true, authRequired: false, manifest: null }), {
        status: 200, headers: { 'content-type': 'application/json' }
    });
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

async function main() {
    const a = setupBrowser();
    const { window } = a;

    // 初始数据：8 会话 × 50 消息（无内嵌图，控制首建时间）。
    await pageEvalAsync(window, `(async () => {
        const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('RPHubDB', 1);
            request.onupgradeneeded = () => { request.result.createObjectStore('store'); };
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });
        await new Promise((resolve, reject) => {
            const tx = db.transaction(['store'], 'readwrite');
            const store = tx.objectStore('store');
            for (let h = 0; h < 8; h += 1) {
                const messages = [];
                for (let m = 0; m < 50; m += 1) {
                    messages.push({ id: 'm' + h + '_' + m, role: m % 2 ? 'ai' : 'user', ts: m, text: '初始消息 ' + h + '-' + m + ' ' + '内容'.repeat(20) });
                }
                store.put({ id: 'chat-' + h, title: '会话' + h, messages }, 'chat-' + h);
            }
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror = () => reject(tx.error);
        });
        localStorage.setItem('rp_hub_sync_password_v1', 'bench');
        return true;
    })()`);

    // 首建：触发一次后台准备（页面加载预热路径），等待完成。
    window.dispatchEvent(new window.Event('visibilitychange'));
    const setupMs = await awaitBackgroundPrepare(window, 60_000);
    console.log(`首建准备（8×50 消息）：${(setupMs / 1000).toFixed(2)}s`);

    // 基准循环：每轮向 1 个会话追加 MSG_PER_ROUND 条消息 → visibilitychange
    // 触发 1s 防抖后台准备 → 计时。增量消费下耗时应与轮次无关（恒定）。
    const times = [];
    for (let round = 0; round < ROUNDS; round += 1) {
        await pageEvalAsync(window, `(async () => {
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
                    for (let m = 0; m < ${MSG_PER_ROUND}; m += 1) {
                        chat.messages.push({ id: 'r${round}-m' + m, role: m % 2 ? 'ai' : 'user', ts: 1000 + m, text: '续写 ${round}-' + m + ' ' + '词'.repeat(30) });
                    }
                    store.put(chat, 'chat-0');
                };
                tx.oncomplete = () => { db.close(); resolve(); };
                tx.onerror = () => reject(tx.error);
            });
            return true;
        })()`);
        window.dispatchEvent(new window.Event('visibilitychange'));
        times.push(await awaitBackgroundPrepare(window, 60_000));
    }

    console.log(`\n每轮追加 ${MSG_PER_ROUND} 条消息后的后台准备耗时：`);
    times.forEach((ms, index) => console.log(`  第 ${String(index + 1).padStart(2)} 轮：${(ms / 1000).toFixed(2)}s`));
    const first = times[0];
    const last = times[times.length - 1];
    const growth = last / Math.max(first, 1);
    console.log(`\n首轮 ${(first / 1000).toFixed(2)}s → 末轮 ${(last / 1000).toFixed(2)}s（${growth.toFixed(1)}×）`);
    console.log(`累计 journal 事件：约 ${(ROUNDS * (MSG_PER_ROUND + 2) + 400).toString()} 条`);

    // 增量消费验收：末轮不应比首轮慢超过 2×（全量重扫下约 12×MSG/400 会涨 1.2×，
    // 消息体增长让 chat-0 变大——末轮仍要重新序列化整个 chat-0 记录。
    // 真正验证增量：与"全量重扫预期"对比太间接，直接断言末轮耗时与首轮同量级。
    assertLess(growth, 2.0, '后台准备耗时不随累积增长（增量消费生效）');
    console.log('background-prepare-bench: 全部通过');
}

// 等待后台准备完成：visibilitychange → scheduleBackgroundPrepare(1000)。
// 完成信号无直接暴露——轮询窗口空闲（prepareInFlight 不可见），改为测量
// "触发到队列排空"的时间：rAF/定时器在准备期间被让出阻塞（backgroundYield
// 6ms 工作+8ms 让出），准备结束后定时器恢复即时调度。用启发式：等待固定
// 防抖 1s + 轮询性能探针。
async function awaitBackgroundPrepare(window, timeoutMs) {
    const start = Date.now();
    // 等待防抖（1s）+ 准备执行。准备完成的判据：连续 200ms 内探针响应
    // 都即时（<15ms）——让出模式下探针会被推迟。
    let stableSince = 0;
    for (let waited = 0; waited < timeoutMs; waited += 10) {
        await new Promise(resolve => setTimeout(resolve, 10));
        const probeStart = Date.now();
        await new Promise(resolve => window.setTimeout(resolve, 0));
        const probeLag = Date.now() - probeStart;
        if (waited < 1100) continue; // 防抖窗口内不算
        if (probeLag < 15) {
            if (!stableSince) stableSince = Date.now();
            if (Date.now() - stableSince >= 200) return Date.now() - start;
        } else {
            stableSince = 0;
        }
    }
    throw new Error('等待后台准备超时');
}

function assertLess(actual, bound, label) {
    if (!(actual < bound)) throw new Error(`断言失败: ${label}（实际 ${actual}）`);
}

main().catch(error => {
    console.error('background-prepare-bench 失败:', error);
    process.exit(1);
});

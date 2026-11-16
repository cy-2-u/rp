import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import worker from '../page/_worker.js';
import { Bucket, FixedLengthStream, context } from './platform.mjs';
const require = createRequire(import.meta.url);
const { JSDOM, VirtualConsole } = require('jsdom'), idb = require('fake-indexeddb');
const gunzip = async bytes => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
const dom = new JSDOM('<!doctype html><html data-rp-sync-restore><head></head><body></body></html>', { url: 'https://test.local/sync-restore', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
const w = dom.window, bucket = new Bucket(), ctx = context();
globalThis.FixedLengthStream = FixedLengthStream;
const env = { RP_SYNC_R2: bucket, RP_SYNC_PASSWORD: 'roundtrip' };
for (const name of ['IDBFactory', 'IDBDatabase', 'IDBObjectStore', 'IDBCursor', 'IDBTransaction', 'IDBKeyRange']) w[name] = idb[name];
let calls = 0, injectMissing = true;
Object.assign(w, { indexedDB: new idb.IDBFactory(), TextEncoder, TextDecoder, CompressionStream, DecompressionStream, Blob, structuredClone, AbortController, RPHubExternal: { version: 2, flush: async () => ({ ok: true }) }, fetch: async (path, init) => {
    calls++;
    if (injectMissing && init?.method === 'POST' && typeof init.body === 'string' && JSON.parse(init.body).action === 'commit') {
        injectMissing = false;
        const root = JSON.parse(init.body).manifest;
        bucket.objects.delete('rp-sync/v2/packs/' + root.packs[0].checksum + '.bin');
    }
    return worker.fetch(new Request(new URL(path, 'https://test.local'), init), env, ctx);
} });
Object.defineProperty(w, 'crypto', { value: globalThis.crypto });
// 控制首次启动，往返直接调用正式同步入口。
w.document.addEventListener('DOMContentLoaded', event => event.stopImmediatePropagation(), { once: true });
for (const file of ['core.js', 'client.js']) w.eval(await readFile(new URL('../page/' + file, import.meta.url), 'utf8'));
w.localStorage.setItem('rp_hub_sync_password_v1', 'roundtrip');
w.localStorage.setItem('rp_hub_settings', '{"stream":true}');
const P = w.RPClient, db = await P.open('RPHubDB', target => target.createObjectStore('store'), 1);
const expected = new Map([['profile', { name: 'test', enabled: true }], ['chat', Array.from({ length: 1100 }, (_, i) => ({ id: i, content: 'message-' + i }))], ['empty', []], ['huge', 'h'.repeat(5 * 1024 * 1024)]]);
let tx = db.transaction('store', 'readwrite');
for (const [key, value] of expected) tx.objectStore('store').put(value, key);
tx.objectStore('store').put('keep', 'rp_hub_presets'); await P.txDone(tx);
w.eval(await readFile(new URL('../page/sync.js', import.meta.url), 'utf8'));
await w.RPSync.operate('push');
assert.equal(w.RPSync.getState().text, '上传完成');
// 盲区断言 1：密码键与密码值绝不允许出现在云端任何分片字节里（appKey 排除链的对错在此重合）。
{
    const decoder = new TextDecoder();
    for (const [key, entry] of bucket.objects) {
        if (!key.startsWith('rp-sync/v2/packs/')) continue;
        const text = decoder.decode(await gunzip(entry.bytes));
        assert.ok(!text.includes('rp_hub_sync_password_v1') && !text.includes('roundtrip'), '云端分片不得包含同步密码（键或值）：' + key);
    }
}
// 盲区断言 2：单条 >4MiB 记录必然跨片，行未结束的满片是 entries=0 的填充片。
{
    const manifest = JSON.parse(new TextDecoder().decode(bucket.objects.get('rp-sync/v2/manifest.json').bytes));
    assert.ok(manifest.packs.some(p => p.entries === 0), '超过 4MiB 缓冲的记录应产生 entries=0 填充片');
}
const before = calls;
await w.RPSync.operate('push', true);
assert.equal(calls, before, 'automatic unchanged upload makes no requests');
tx = db.transaction('store', 'readwrite');
tx.objectStore('store').clear(); tx.objectStore('store').put('local-preset', 'rp_hub_presets'); tx.objectStore('store').put('remove', 'extra'); await P.txDone(tx);
w.localStorage.setItem('rp_hub_settings', 'changed');
w.localStorage.setItem('rp_hub_extra', 'remove');
const originalPut = w.IDBObjectStore.prototype.put;
let failRestore = true;
w.IDBObjectStore.prototype.put = function (...args) {
    if (failRestore && this.transaction.db.name === 'RPHubDB' && this.name === 'store' && args[1] !== 'rp_hub_presets') {
        failRestore = false;
        throw new w.DOMException('injected restore quota failure', 'QuotaExceededError');
    }
    return originalPut.apply(this, args);
};
await assert.rejects(w.RPSync.operate('pull'), /injected restore quota failure/);
assert.ok(w.localStorage.getItem(w.RPCore.KEYS.active), 'failed application keeps the write barrier');
assert.equal(w.RPSync.getState().busy, false, 'failed restore releases the operation');
w.IDBObjectStore.prototype.put = originalPut;
await w.RPSync.operate('pull');
assert.equal(w.RPSync.getState().text, '恢复完成');
for (const [key, value] of expected) {
    tx = db.transaction('store', 'readonly'); const r = tx.objectStore('store').get(key);
    assert.deepEqual(await P.txDone(tx, () => r.result), value);
}
tx = db.transaction('store', 'readonly'); const extra = tx.objectStore('store').get('extra'), preset = tx.objectStore('store').get('rp_hub_presets');
await P.txDone(tx); assert.equal(extra.result, undefined); assert.equal(preset.result, 'local-preset');
assert.equal(w.localStorage.getItem('rp_hub_settings'), '{"stream":true}');
assert.equal(w.localStorage.getItem('rp_hub_extra'), null);
assert.equal(w.localStorage.getItem(w.RPCore.KEYS.active), null);
const afterRestore = calls;
await w.RPSync.operate('push', true);
assert.equal(calls, afterRestore, 'restore pre-writes committed so the first auto upload is request-free');
// 一锤定音：主页（非恢复页）上 store.clear() 后的增量上传必须把删除传到云端（item.clear
// 三态分支）。恢复页写入设计上不进 journal，所以本断言必须在普通页面语境下跑；若旧桶源
// 残留，旧键仍躺在云端分片里——恢复到任何设备都会让已删数据复活。
{
    const dom3 = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://test.local/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
    const w3 = dom3.window;
    for (const name of ['IDBFactory', 'IDBDatabase', 'IDBObjectStore', 'IDBCursor', 'IDBTransaction', 'IDBKeyRange']) w3[name] = idb[name];
    Object.assign(w3, { indexedDB: w.indexedDB, TextEncoder, TextDecoder, CompressionStream, DecompressionStream, Blob, structuredClone, AbortController, RPHubExternal: { version: 2, flush: async () => ({ ok: true }) }, fetch: (path, init) => worker.fetch(new Request(new URL(path, 'https://test.local'), init), env, ctx) });
    Object.defineProperty(w3, 'crypto', { value: globalThis.crypto });
    w3.document.addEventListener('DOMContentLoaded', event => event.stopImmediatePropagation(), { once: true });
    for (const file of ['core.js', 'client.js']) w3.eval(await readFile(new URL('../page/' + file, import.meta.url), 'utf8'));
    w3.localStorage.setItem('rp_hub_sync_password_v1', 'roundtrip');
    // w3 是新页面：先对齐追踪纪元并预热一次 push（恢复预写 state 的 epochs 为空必然触发
    // 首轮 full 重建，这是已知行为），建立增量基线后才轮到 clear 增量分支登场。
    w3.localStorage.setItem(w.RPCore.KEYS.epoch, w.localStorage.getItem(w.RPCore.KEYS.epoch));
    const appDb = await w3.RPClient.open('RPHubDB');
    const warmTx = appDb.transaction('store', 'readwrite');
    warmTx.objectStore('store').put('warm', 'warm-key');
    await w3.RPClient.txDone(warmTx);
    w3.eval(await readFile(new URL('../page/sync.js', import.meta.url), 'utf8'));
    await w3.RPSync.operate('push');
    const clearTx = appDb.transaction('store', 'readwrite');
    clearTx.objectStore('store').clear();
    clearTx.objectStore('store').put('after-clear', 'rebuilt');
    await w3.RPClient.txDone(clearTx);
    w3.localStorage.setItem('rp_hub_settings', '{"stream":false}');
    await w3.RPSync.operate('push');
    assert.equal(w3.RPSync.getState().text, '上传完成');
    const manifest = JSON.parse(new TextDecoder().decode(bucket.objects.get('rp-sync/v2/manifest.json').bytes));
    let cloudText = '';
    for (const p of manifest.packs) cloudText += new TextDecoder().decode(await gunzip(bucket.objects.get('rp-sync/v2/packs/' + p.checksum + '.bin').bytes));
    assert.ok(!cloudText.includes('"profile"'), 'clear 后云端不得再有已删键 profile');
    assert.ok(!cloudText.includes('"chat"'), 'clear 后云端不得再有已删键 chat');
    assert.ok(cloudText.includes('"rebuilt"'), 'clear 后新键必须上云');
    appDb.close(); w3.close();
}
db.close(); w.close(); await ctx.drain();
// 盲区断言 3：全新空实例（无应用键、无 IDB 库）的完整往返——空对空时指针错乱与正确处理输出重合，
// 唯一区分手段是云端清单形状与恢复流程本身。
{
    const emptyBucket = new Bucket(), emptyCtx = context();
    const emptyEnv = { RP_SYNC_R2: emptyBucket, RP_SYNC_PASSWORD: 'roundtrip' };
    const dom2 = new JSDOM('<!doctype html><html data-rp-sync-restore><head></head><body></body></html>', { url: 'https://test.local/sync-restore', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
    const w2 = dom2.window;
    for (const name of ['IDBFactory', 'IDBDatabase', 'IDBObjectStore', 'IDBCursor', 'IDBTransaction', 'IDBKeyRange']) w2[name] = idb[name];
    Object.assign(w2, { indexedDB: new idb.IDBFactory(), TextEncoder, TextDecoder, CompressionStream, DecompressionStream, Blob, structuredClone, AbortController, RPHubExternal: { version: 2, flush: async () => ({ ok: true }) }, fetch: (path, init) => worker.fetch(new Request(new URL(path, 'https://test.local'), init), emptyEnv, emptyCtx) });
    Object.defineProperty(w2, 'crypto', { value: globalThis.crypto });
    w2.document.addEventListener('DOMContentLoaded', event => event.stopImmediatePropagation(), { once: true });
    for (const file of ['core.js', 'client.js']) w2.eval(await readFile(new URL('../page/' + file, import.meta.url), 'utf8'));
    w2.localStorage.setItem('rp_hub_sync_password_v1', 'roundtrip');
    w2.eval(await readFile(new URL('../page/sync.js', import.meta.url), 'utf8'));
    await w2.RPSync.operate('push');
    assert.equal(w2.RPSync.getState().text, '上传完成');
    const manifest = JSON.parse(new TextDecoder().decode(emptyBucket.objects.get('rp-sync/v2/manifest.json').bytes));
    assert.equal(manifest.entryCount, 0, '空实例上传的清单条目数为 0');
    assert.equal(manifest.packs.length, 0, '空实例上传无分片');
    await w2.RPSync.operate('pull');
    assert.equal(w2.RPSync.getState().text, '恢复完成');
    assert.equal(w2.localStorage.getItem(w2.RPCore.KEYS.password), 'roundtrip', '空快照恢复保留基础设施键');
    w2.close(); await emptyCtx.drain();
}
console.log(JSON.stringify({ test: 'roundtrip', result: 'upload, zero-request unchanged auto upload, 1100-message restore, 5MiB cross-pack record, password never in cloud bytes, empty-instance roundtrip, local cleanup and preset exclusion passed', requests: calls, r2: bucket.calls }));

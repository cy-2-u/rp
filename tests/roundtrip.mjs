import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import worker from '../page/_worker.js';
import { Bucket, FixedLengthStream, context } from './platform.mjs';
const require = createRequire(import.meta.url);
const { JSDOM, VirtualConsole } = require('jsdom'), idb = require('fake-indexeddb');
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
const expected = new Map([['profile', { name: 'test', enabled: true }], ['chat', Array.from({ length: 1100 }, (_, i) => ({ id: i, content: 'message-' + i }))], ['empty', []]]);
let tx = db.transaction('store', 'readwrite');
for (const [key, value] of expected) tx.objectStore('store').put(value, key);
tx.objectStore('store').put('keep', 'rp_hub_presets'); await P.txDone(tx);
w.eval(await readFile(new URL('../page/sync.js', import.meta.url), 'utf8'));
await w.RPSync.operate('push');
assert.equal(w.RPSync.getState().text, '上传完成');
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
db.close(); w.close(); await ctx.drain();
console.log(JSON.stringify({ test: 'roundtrip', result: 'upload, zero-request unchanged auto upload, 1100-message restore, local cleanup and preset exclusion passed', requests: calls, r2: bucket.calls }));

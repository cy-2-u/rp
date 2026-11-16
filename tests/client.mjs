import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const { IDBFactory, IDBDatabase, IDBObjectStore, IDBCursor, IDBTransaction, IDBKeyRange } = require('fake-indexeddb');
const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://test.local/', runScripts: 'outside-only' });
const w = dom.window;
Object.assign(w, { indexedDB: new IDBFactory(), IDBFactory, IDBDatabase, IDBObjectStore, IDBCursor, IDBTransaction, IDBKeyRange, TextEncoder, TextDecoder, CompressionStream, DecompressionStream, Blob, structuredClone });
Object.defineProperty(w, 'crypto', { value: globalThis.crypto });
for (const file of ['core.js', 'client.js']) w.eval(await readFile(new URL('../page/' + file, import.meta.url), 'utf8'));
const P = w.RPClient, C = w.RPCore;
const db = await P.open('RPHubDB', target => target.createObjectStore('store'), 1);
assert.ok(db.objectStoreNames.contains(C.KEYS.journal));
let tx = db.transaction('store', 'readwrite');
tx.objectStore('store').put({ content: 'first' }, 'chat');
await P.txDone(tx);
await P.flush();
let dirty = await P.dirty();
assert.equal(dirty.stores.get('RPHubDB/store').keys.get('"chat"'), 'chat');
await P.acknowledge({ databases: dirty.databases });
assert.equal((await P.dirty()).stores.size, 0);
// 一锤定音：epoch 记录保住 autoIncrement 不重置。journal 数字记录全清后 store 仍非空（剩
// '__epoch__'），键生成器必须继续递增——若重置回卷，水位增量扫描永远捕不到新写入 = 增量静默失效。
{
    const watermark = dirty.databases.RPHubDB;
    tx = db.transaction('store', 'readwrite');
    tx.objectStore('store').put({ content: 'after-ack' }, 'k-next');
    await P.txDone(tx);
    await P.flush();
    const delta = await P.dirty({ RPHubDB: watermark });
    assert.ok(delta.stores.get('RPHubDB/store'), 'acknowledge 后增量扫描仍捕到新写入');
    assert.ok(delta.databases.RPHubDB > watermark, '键生成器未重置：新水位必须大于旧水位');
    await P.acknowledge(delta);
}
tx = db.transaction('store', 'readwrite');
tx.objectStore('store').put('discarded', 'aborted');
const aborted = P.txDone(tx).catch(() => {});
tx.abort(); await aborted; await P.flush();
assert.equal((await P.dirty()).stores.size, 0);
w.localStorage.setItem('rp_hub_test', 'a');
dirty = await P.dirty();
assert.ok(dirty.local.has('rp_hub_test'));
await P.acknowledge(dirty);
assert.equal((await P.dirty()).intents.length, 0);
w.localStorage.setItem(C.KEYS.active, 'restore');
assert.throws(() => db.transaction('store', 'readwrite'), /暂停写入/);
assert.throws(() => w.localStorage.setItem('rp_hub_test', 'b'), /暂停写入/);
w.localStorage.removeItem(C.KEYS.active);
// 应用级 clear 保留同步基础设施键：密码与自动保存设置不能被作者应用重置波及。
w.localStorage.setItem(C.KEYS.password, 'keep-me');
w.localStorage.setItem('rp_hub_sync_auto_save_enabled_v1', '1');
w.localStorage.clear();
assert.equal(w.localStorage.getItem(C.KEYS.password), 'keep-me', 'clear keeps the sync password');
assert.equal(w.localStorage.getItem('rp_hub_sync_auto_save_enabled_v1'), '1', 'clear keeps autosave settings');
assert.equal(w.localStorage.getItem('rp_hub_test'), null, 'clear removes app keys');
await P.acknowledge(await P.dirty());
db.close(); dom.window.close();
console.log('client: 15 journal, abort, acknowledgment, freeze, clear-scope and key-generator monotonicity checks passed');

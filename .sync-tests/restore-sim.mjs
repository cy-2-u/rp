// Full sync lifecycle simulation on fake IndexedDB + in-memory R2:
//   browser A uploads, browser B restores over its own data, browser A
//   uploads an increment. Exercises bootstrap.js end to end, including the
//   restore state machine, exclusions and the bounded upload engine.
// Phase 4 additionally pins the incremental upload contract: only changed
// keys are read (in bounded batches through one connection), invalid changes
// (same-value puts, change-and-revert, clear+identical refill, version-only
// schema churn) touch neither the snapshot cache nor the remote, and pushes
// never enumerate historical packs in R2.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = relative => fs.readFile(path.join(root, relative), 'utf8');

const loadFdbClass = async name => {
    const mod = await import(`fake-indexeddb/lib/${name}`);
    return mod.default ?? mod[name];
};
const FDBFactory = await loadFdbClass('FDBFactory');
const FDBDatabase = await loadFdbClass('FDBDatabase');
const FDBObjectStore = await loadFdbClass('FDBObjectStore');
const FDBTransaction = await loadFdbClass('FDBTransaction');
const FDBIndex = await loadFdbClass('FDBIndex');
const FDBRequest = await loadFdbClass('FDBRequest');
const FDBOpenDBRequest = await loadFdbClass('FDBOpenDBRequest');
const FDBVersionChangeEvent = await loadFdbClass('FDBVersionChangeEvent');
const FDBKeyRange = await loadFdbClass('FDBKeyRange');
const FDBCursor = await loadFdbClass('FDBCursor');
const FDBCursorWithValue = await loadFdbClass('FDBCursorWithValue');

const MANIFEST_KEY = 'rp-sync/main/manifest.json';

// ---------------------------------------------------------------- mocks ----

function createMemBucket() {
    const objects = new Map();
    let etagSequence = 0;
    const asBytes = async value => {
        if (value instanceof Uint8Array) return value;
        if (value instanceof ArrayBuffer) return new Uint8Array(value);
        return new Uint8Array(await new Response(value).arrayBuffer());
    };
    return {
        objects,
        async head(key) {
            const object = objects.get(key);
            return object
                ? {
                    key,
                    etag: object.etag,
                    size: object.size,
                    uploaded: object.uploaded,
                    httpMetadata: object.httpMetadata,
                    customMetadata: object.customMetadata
                }
                : null;
        },
        async get(key) {
            const object = objects.get(key);
            if (!object) return null;
            return {
                key,
                etag: object.etag,
                size: object.size,
                uploaded: object.uploaded,
                customMetadata: object.customMetadata,
                body: new Uint8Array(object.bytes),
                text: async () => Buffer.from(object.bytes).toString('utf8')
            };
        },
        async put(key, value, options = {}) {
            const bytes = await asBytes(value);
            if (options.onlyIf) {
                const current = objects.get(key);
                const etag = current ? current.etag : null;
                if (options.onlyIf.etagMatches !== undefined && etag !== options.onlyIf.etagMatches) return null;
                if (options.onlyIf.etagDoesNotMatch === '*' && etag !== null) return null;
            }
            if (options.sha256) {
                const expected = options.sha256 instanceof ArrayBuffer
                    ? Buffer.from(options.sha256).toString('hex')
                    : String(options.sha256).toLowerCase();
                const digest = await crypto.subtle.digest('SHA-256', bytes);
                assert.equal(Buffer.from(digest).toString('hex'), expected, `R2 checksum mismatch for ${key}`);
            }
            etagSequence += 1;
            const etag = `etag-${String(etagSequence).padStart(6, '0')}`;
            objects.set(key, {
                key,
                bytes,
                etag,
                size: bytes.byteLength,
                uploaded: new Date(),
                httpMetadata: options.httpMetadata,
                customMetadata: options.customMetadata
            });
            return { key, etag };
        },
        async delete(keys) {
            const list = Array.isArray(keys) ? keys : [keys];
            let deleted = 0;
            for (const key of list) if (objects.delete(key)) deleted += 1;
            return deleted;
        },
        async list({ prefix = '', cursor, limit = 1000 } = {}) {
            const keys = [...objects.keys()].filter(key => key.startsWith(prefix)).sort();
            const found = cursor ? keys.findIndex(key => key > cursor) : 0;
            const start = found < 0 ? keys.length : found;
            const page = keys.slice(start, start + limit);
            const truncated = start + limit < keys.length;
            return {
                objects: page.map(key => ({ key, size: objects.get(key).size, uploaded: objects.get(key).uploaded })),
                truncated,
                cursor: truncated ? page[page.length - 1] : undefined
            };
        }
    };
}

function makeStorageClass() {
    return class Storage {
        #map = new Map();
        getItem(key) { key = String(key); return this.#map.has(key) ? this.#map.get(key) : null; }
        setItem(key, value) { this.#map.set(String(key), String(value)); }
        removeItem(key) { this.#map.delete(String(key)); }
        clear() { this.#map.clear(); }
        key(index) { return [...this.#map.keys()][index] ?? null; }
        get length() { return this.#map.size; }
    };
}

function createDomElement(tag) {
    const listeners = {};
    const queries = new Map();
    const element = {
        tagName: tag,
        children: [],
        parentElement: null,
        style: {},
        dataset: {},
        textContent: '',
        innerHTML: '',
        classList: {
            set: new Set(),
            add(...names) { names.forEach(name => this.set.add(name)); },
            remove(...names) { names.forEach(name => this.set.delete(name)); },
            toggle(name, force) {
                const enable = force === undefined ? !this.set.has(name) : Boolean(force);
                if (enable) this.set.add(name); else this.set.delete(name);
            },
            contains(name) { return this.set.has(name); }
        },
        appendChild(child) { element.children.push(child); child.parentElement = element; return child; },
        addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
        removeEventListener() { },
        setAttribute() { },
        getAttribute() { return null; },
        remove() { },
        focus() { },
        select() { },
        querySelector(selector) {
            if (!queries.has(selector)) queries.set(selector, createDomElement(selector));
            return queries.get(selector);
        },
        querySelectorAll() { return []; },
        click() { for (const handler of listeners.click || []) handler({ preventDefault() { }, target: element }); }
    };
    return element;
}

function createDocumentStub() {
    const body = createDomElement('body');
    return {
        readyState: 'complete',
        body,
        head: createDomElement('head'),
        createElement: tag => createDomElement(tag),
        getElementById: () => null,
        addEventListener() { },
        removeEventListener() { }
    };
}

// ----------------------------------------------------------- prototypes ----

const PATCHED_MEMBERS = [
    [FDBObjectStore.prototype, 'put'],
    [FDBObjectStore.prototype, 'add'],
    [FDBObjectStore.prototype, 'delete'],
    [FDBObjectStore.prototype, 'clear'],
    [FDBDatabase.prototype, 'transaction'],
    [FDBCursor.prototype, 'update'],
    [FDBCursor.prototype, 'delete'],
    [FDBTransaction.prototype, 'commit']
];
const snapshotPrototypes = () => PATCHED_MEMBERS.map(([proto, name]) => ({
    proto,
    name,
    descriptor: Object.getOwnPropertyDescriptor(proto, name)
}));
const restorePrototypes = snapshot => {
    for (const { proto, name, descriptor } of snapshot) {
        if (descriptor) Object.defineProperty(proto, name, descriptor);
        else delete proto[name];
    }
};

// ------------------------------------------------------------ utilities ----

const setGlobal = (name, value) => {
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
};

function installBrowserGlobals({ storageClass, localStorage, factory, document, location, fetchShim, locks }) {
    const globals = {
        indexedDB: factory,
        IDBKeyRange: FDBKeyRange,
        IDBDatabase: FDBDatabase,
        IDBObjectStore: FDBObjectStore,
        IDBTransaction: FDBTransaction,
        IDBIndex: FDBIndex,
        IDBCursor: FDBCursor,
        IDBCursorWithValue: FDBCursorWithValue,
        IDBRequest: FDBRequest,
        IDBOpenDBRequest: FDBOpenDBRequest,
        IDBVersionChangeEvent: FDBVersionChangeEvent,
        Storage: storageClass,
        localStorage,
        document,
        location,
        navigator: locks ? { locks } : {},
        fetch: fetchShim,
        confirm: () => true,
        alert: () => { },
        requestAnimationFrame: handler => setTimeout(handler, 0),
        addEventListener() { },
        removeEventListener() { },
        window: globalThis
    };
    for (const [name, value] of Object.entries(globals)) setGlobal(name, value);
    delete globalThis.__RPH_SYNC_DIRTY_TRACKING__;
}

async function runScripts(names) {
    for (const name of names) {
        vm.runInThisContext(await read(name), { filename: path.join(root, name) });
    }
}

async function waitFor(getResult, timeoutMs, label) {
    const startedAt = Date.now();
    for (;;) {
        const value = getResult();
        if (value) return value;
        if (Date.now() - startedAt > timeoutMs) throw new Error(`timeout waiting for ${label}`);
        await new Promise(resolve => setTimeout(resolve, 50));
    }
}

function idbOpen(factory, dbName, version, stores) {
    return new Promise((resolve, reject) => {
        const request = version ? factory.open(dbName, version) : factory.open(dbName);
        request.onupgradeneeded = () => {
            const db = request.result;
            for (const storeName of stores) {
                if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function idbPut(factory, dbName, storeName, key, value) {
    const db = await idbOpen(factory, dbName, 1, [storeName]);
    try {
        await new Promise((resolve, reject) => {
            const tx = db.transaction([storeName], 'readwrite');
            tx.objectStore(storeName).put(value, key);
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
    } finally {
        db.close();
    }
}

async function idbGetAll(factory, dbName, storeName) {
    const db = await idbOpen(factory, dbName, undefined, [storeName]);
    try {
        if (!db.objectStoreNames.contains(storeName)) return new Map();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction([storeName], 'readonly');
            const records = new Map();
            const cursorRequest = tx.objectStore(storeName).openCursor();
            cursorRequest.onsuccess = () => {
                const cursor = cursorRequest.result;
                if (cursor) {
                    records.set(String(cursor.key), cursor.value);
                    cursor.continue();
                }
            };
            tx.oncomplete = () => resolve(records);
            tx.onerror = () => reject(tx.error);
        });
    } finally {
        db.close();
    }
}

async function readManifest(bucket) {
    const object = await bucket.get(MANIFEST_KEY);
    return object ? JSON.parse(Buffer.from(object.body).toString('utf8')) : null;
}

async function readManifestPacks(bucket, manifest) {
    const packs = [];
    for (let pageIndex = 0; pageIndex < manifest.pageCount; pageIndex += 1) {
        const key = `rp-sync/main/manifests/${manifest.checksum}/${String(pageIndex).padStart(4, '0')}.json`;
        const object = await bucket.get(key);
        assert.ok(object, `manifest page ${pageIndex} missing from R2`);
        const page = JSON.parse(await object.text());
        packs.push(...page.packs);
    }
    assert.equal(packs.length, manifest.packCount, 'manifest pages must contain every pack');
    return packs;
}

async function readManifestPackText(bucket, manifest) {
    const chunks = [];
    for (const pack of await readManifestPacks(bucket, manifest)) {
        const object = await bucket.get(`rp-sync/main/packs/${pack.checksum}.bin`);
        assert.ok(object, `pack ${pack.checksum} missing from R2`);
        chunks.push(Buffer.from(object.body));
    }
    return Buffer.concat(chunks).toString('utf8');
}

const waitForUploadDone = (modal, label) => waitFor(() => {
    const text = modal.querySelector('.rp-sync-modal__status').textContent;
    if (modal.classList.contains('is-error')) throw new Error(`${label} failed: ${text}`);
    return /已完成|已是最新/.test(text) ? text : null;
}, 60000, label);

// ---------------------------------------------------------------- setup ----

const bucket = createMemBucket();
const env = { RP_SYNC_R2: bucket };
const workerSource = await read('_worker.js');
const worker = new Function('fetch', workerSource.replace('export default {', 'return {'))(globalThis.fetch);
const makeFetchShim = (label, targetEnv = env) => async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith('/api/rp-sync')) throw new Error(`unexpected fetch in ${label}: ${url}`);
    const request = new Request(`https://local.test${url}`, init);
    const response = await worker.fetch(request, targetEnv, { waitUntil() { } });
    return response;
};

// ------------------------------------------------- phase 1: browser A ------

// Business database open counter: incremental pushes must reuse one
// connection per database instead of reopening per changed key. Installed
// before any dirty-tracker capture so every native open is counted.
const nativeFactoryOpen = FDBFactory.prototype.open;
let businessOpens = 0;
FDBFactory.prototype.open = function (name, ...rest) {
    if (['RPHubDB', 'AICharGen'].includes(name)) businessOpens += 1;
    return nativeFactoryOpen.call(this, name, ...rest);
};

const factoryA = new FDBFactory();
const StorageA = makeStorageClass();
const localStorageA = new StorageA();

await idbPut(factoryA, 'RPHubDB', 'store', 'chat1', 'hello');
await idbPut(factoryA, 'RPHubDB', 'store', 'settings', { theme: 'dark', nested: { a: 1, b: [1, 2, 3] } });
await idbPut(factoryA, 'RPHubDB', 'store', 'chat_big',
    Array.from({ length: 300 }, (_, index) => ({ index, text: `msg-${index}`, tags: ['a', 'b'] })));
await idbPut(factoryA, 'RPHubDB', 'store', 'rp_hub_presets', { keep: true, fromLocal: true });
await idbPut(factoryA, 'AICharGen', 'characters', 'c1', { id: 'c1', name: 'Alice', hp: 10 });
// More separate records than one full-scan batch (CONFIG.scanBatchRecords = 64),
// to prove the batched cursor never skips the record at a batch boundary.
const BULK_RECORD_COUNT = 300;
for (let index = 0; index < BULK_RECORD_COUNT; index += 1) {
    await idbPut(factoryA, 'RPHubDB', 'store', `bulk_${String(index).padStart(3, '0')}`, { index });
}
localStorageA.setItem('rp_hub_settings', 'v1');
localStorageA.setItem('rp_hub_theme', 'dark');
localStorageA.setItem('rp_hub_sync_password_v1', 'secret-a');
localStorageA.setItem('ai_chargen_flag', 'on');
localStorageA.setItem('unrelated', 'keep');

const documentA = createDocumentStub();
const locationA = {
    pathname: '/', replaced: null, assigned: null,
    replace(url) { this.replaced = url; },
    assign(url) { this.assigned = url; }
};
const requestsA = [];
const recordAction = init => {
    if (typeof init?.body !== 'string') return null;
    try { return JSON.parse(init.body).action ?? null; } catch { return null; }
};
const fetchShimA = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    assert.ok(url.startsWith('/api/rp-sync'), `unexpected fetch in browser A: ${url}`);
    const action = new URL(url, 'https://local.test').searchParams.get('action') || recordAction(init);
    if (action === 'upload-pack') {
        const requestUrl = new URL(url, 'https://local.test');
        requestsA.push({
            kind: 'pack',
            checksum: requestUrl.searchParams.get('checksum'),
            length: Number(requestUrl.searchParams.get('length'))
        });
    } else {
        requestsA.push({ kind: url, action });
    }
    return makeFetchShim('browser A')(input, init);
};
const savedPrototypes = snapshotPrototypes();
installBrowserGlobals({
    storageClass: StorageA,
    localStorage: localStorageA,
    factory: factoryA,
    document: documentA,
    location: locationA,
    fetchShim: fetchShimA,
    locks: null
});
await runScripts(['DB/dirty-tracker.js', 'DB/bootstrap.js']);
globalThis.RPHubAuthorSaveData = async () => { };

const modalA = documentA.body.children[0];
assert.ok(modalA, 'sync modal should be created on load');
modalA.querySelector('[data-action="push"]').click();
await waitForUploadDone(modalA, 'browser A initial upload');

const manifestV1 = await readManifest(bucket);
assert.ok(manifestV1 && manifestV1.version >= 1, 'manifest must exist after the first upload');
const packsV1Text = await readManifestPackText(bucket, manifestV1);
assert.ok(packsV1Text.includes('"hello"'), 'chat1 value must be uploaded');
assert.ok(packsV1Text.includes('"msg-299"'), 'large array record must be uploaded across pages');
assert.ok(packsV1Text.includes('rp_hub_theme'), 'app localStorage keys must be uploaded');
assert.ok(packsV1Text.includes('ai_chargen_flag'), 'prefixed localStorage keys must be uploaded');
for (let index = 0; index < BULK_RECORD_COUNT; index += 1) {
    const key = `bulk_${String(index).padStart(3, '0')}`;
    assert.ok(packsV1Text.includes(`"${key}"`), `record ${key} must survive the batched full scan`);
}
assert.ok(!packsV1Text.includes('rp_hub_presets'), 'rp_hub_presets must be excluded from sync');
assert.ok(!packsV1Text.includes('rp_hub_sync_password_v1'), 'sync password key must never be uploaded');
assert.ok(!packsV1Text.includes('secret-a'), 'sync password value must never be uploaded');
assert.ok(!packsV1Text.includes('unrelated'), 'non-app localStorage keys must not be uploaded');
console.log('phase 1 (upload): ok');

restorePrototypes(savedPrototypes);

// ------------------------------------------------- phase 2: browser B ------

const factoryB = new FDBFactory();
const StorageB = makeStorageClass();
const localStorageB = new StorageB();

await idbPut(factoryB, 'RPHubDB', 'store', 'chat1', 'changed-locally');
await idbPut(factoryB, 'RPHubDB', 'store', 'chat_extra', 'extra-record');
await idbPut(factoryB, 'RPHubDB', 'store', 'rp_hub_presets', { keep: true, fromLocal: true });
await idbPut(factoryB, 'AICharGen', 'characters', 'c1', { id: 'c1', name: 'Local-B' });
await idbPut(factoryB, 'AICharGen', 'characters', 'c2', { id: 'c2', name: 'Extra-B' });
localStorageB.setItem('rp_hub_settings', 'v2');
localStorageB.setItem('rp_hub_extra_local', 'x');
localStorageB.setItem('rp_hub_sync_password_v1', 'secret-b');
localStorageB.setItem('unrelated', 'keep-b');

const restoreMetrics = {
    snapshotParses: 0,
    stagingReads: [],
    stagingWrites: [],
    cachePackWrites: [],
    pullInflight: 0,
    maxPullInflight: 0
};
const snapshotTypes = new Set([
    'localStorage', 'database', 'record', 'recordArrayStart', 'recordArrayItem',
    'recordArrayEnd', 'storeEnd', 'databaseEnd'
]);
const nativeJsonParse = JSON.parse;
JSON.parse = function (...args) {
    const value = nativeJsonParse.apply(this, args);
    if (snapshotTypes.has(value?.type)) restoreMetrics.snapshotParses += 1;
    return value;
};
const restoreTransactions = new WeakMap();
const nativeRestoreTransaction = FDBDatabase.prototype.transaction;
FDBDatabase.prototype.transaction = function (names, mode, ...rest) {
    const tx = nativeRestoreTransaction.call(this, names, mode, ...rest);
    const scope = typeof names === 'string' ? [names] : Array.from(names);
    let records = null;
    if (this.name === 'RPHubSyncStaging' && scope.length === 1 && scope[0] === 'packs') {
        records = mode === 'readonly' ? restoreMetrics.stagingReads : restoreMetrics.stagingWrites;
    } else if (this.name === 'RPHubSyncCache' && mode === 'readwrite'
        && scope.length === 1 && scope[0] === 'packs') {
        records = restoreMetrics.cachePackWrites;
    }
    if (records) {
        const record = { count: 0 };
        records.push(record);
        restoreTransactions.set(tx, record);
    }
    return tx;
};
const nativeRestoreGet = FDBObjectStore.prototype.get;
FDBObjectStore.prototype.get = function (...args) {
    const record = restoreTransactions.get(this.transaction);
    if (record) record.count += 1;
    return nativeRestoreGet.apply(this, args);
};
const nativeRestorePut = FDBObjectStore.prototype.put;
FDBObjectStore.prototype.put = function (...args) {
    const record = restoreTransactions.get(this.transaction);
    if (record) record.count += 1;
    return nativeRestorePut.apply(this, args);
};
const fetchShimB = async (input, init) => {
    const action = recordAction(init);
    const counted = action === 'pull-manifest-page' || action === 'pull-pack';
    if (counted) {
        restoreMetrics.pullInflight += 1;
        restoreMetrics.maxPullInflight = Math.max(restoreMetrics.maxPullInflight, restoreMetrics.pullInflight);
    }
    try {
        return await makeFetchShim('browser B')(input, init);
    } finally {
        if (counted) restoreMetrics.pullInflight -= 1;
    }
};

const documentB = createDocumentStub();
const locationB = {
    pathname: '/sync-restore', replaced: null, assigned: null,
    replace(url) { this.replaced = url; },
    assign(url) { this.assigned = url; }
};
const locksB = {
    request: (name, options, callback) => Promise.resolve().then(callback),
    query: async () => ({ held: [] })
};
installBrowserGlobals({
    storageClass: StorageB,
    localStorage: localStorageB,
    factory: factoryB,
    document: documentB,
    location: locationB,
    fetchShim: fetchShimB,
    locks: locksB
});
await runScripts(['DB/dirty-tracker.js', 'DB/bootstrap.js']);

const modalB = documentB.body.children[0];
await waitFor(() => {
    const text = modalB.querySelector('.rp-sync-modal__status').textContent;
    if (modalB.classList.contains('is-error')) throw new Error(`restore failed: ${text}`);
    return locationB.replaced ? 'reloaded' : null;
}, 60000, 'browser B restore');

const recordsB = await idbGetAll(factoryB, 'RPHubDB', 'store');
for (let index = 0; index < BULK_RECORD_COUNT; index += 1) {
    assert.deepEqual(recordsB.get(`bulk_${String(index).padStart(3, '0')}`), { index },
        'every independent record must survive scan and restore');
}
assert.equal(recordsB.get('chat1'), 'hello', 'restored record must overwrite local value');
assert.deepEqual(recordsB.get('settings'), { theme: 'dark', nested: { a: 1, b: [1, 2, 3] } },
    'object record must survive the round trip exactly');
const chatBig = recordsB.get('chat_big');
assert.ok(Array.isArray(chatBig) && chatBig.length === 300, 'array record length must be restored');
assert.equal(chatBig[0].index, 0);
assert.equal(chatBig[299].text, 'msg-299');
assert.ok(!recordsB.has('chat_extra'), 'records missing remotely must be deleted locally');
assert.deepEqual(recordsB.get('rp_hub_presets'), { keep: true, fromLocal: true },
    'rp_hub_presets must survive a restore untouched');
const charactersB = await idbGetAll(factoryB, 'AICharGen', 'characters');
assert.deepEqual(charactersB.get('c1'), { id: 'c1', name: 'Alice', hp: 10 });
assert.ok(!charactersB.has('c2'), 'extra characters must be deleted by restore');
assert.equal(localStorageB.getItem('rp_hub_settings'), 'v1', 'localStorage entry must be restored');
assert.equal(localStorageB.getItem('rp_hub_theme'), 'dark', 'localStorage entry must be restored');
assert.equal(localStorageB.getItem('ai_chargen_flag'), 'on', 'prefixed localStorage entry must be restored');
assert.equal(localStorageB.getItem('rp_hub_extra_local'), null, 'app keys missing remotely must be removed');
assert.equal(localStorageB.getItem('rp_hub_sync_password_v1'), 'secret-b', 'sync password key must survive restore');
assert.equal(localStorageB.getItem('unrelated'), 'keep-b', 'non-app keys must survive restore');
assert.equal(restoreMetrics.snapshotParses, manifestV1.entryCount * 2,
    'each snapshot entry must be parsed exactly once for validation and once for restore');
const stagingReadBatches = restoreMetrics.stagingReads.filter(batch => batch.count > 0);
const stagingWriteBatches = restoreMetrics.stagingWrites.filter(batch => batch.count > 0);
assert.equal(stagingReadBatches.reduce((sum, batch) => sum + batch.count, 0), manifestV1.packCount,
    'each staged pack must be read exactly once');
assert.equal(stagingReadBatches.length, Math.ceil(manifestV1.packCount / 4),
    'staged packs must be read in batches of four');
assert.equal(stagingWriteBatches.reduce((sum, batch) => sum + batch.count, 0), manifestV1.packCount,
    'each downloaded pack must be staged exactly once');
assert.equal(stagingWriteBatches.length, Math.ceil(manifestV1.packCount / 4),
    'downloaded packs must be staged in batches of four');
assert.equal(restoreMetrics.cachePackWrites.reduce((sum, batch) => sum + batch.count, 0), manifestV1.packCount,
    'each restored pack must be cached exactly once');
assert.equal(restoreMetrics.cachePackWrites.length, Math.ceil(manifestV1.packCount / 4),
    'restored packs must be cached in batches of four');
assert.ok([...stagingReadBatches, ...stagingWriteBatches, ...restoreMetrics.cachePackWrites]
    .every(batch => batch.count > 0 && batch.count <= 4), 'all pack transactions must stay bounded to four objects');
assert.ok(restoreMetrics.maxPullInflight >= 1 && restoreMetrics.maxPullInflight <= 4,
    `pull concurrency must stay within four requests, observed ${restoreMetrics.maxPullInflight}`);
assert.match(modalB.innerHTML, /rp-sync-restore-actions/);
assert.doesNotMatch(modalB.innerHTML, /上传到云端|重建本地索引|重新恢复/,
    'restore mode must expose only progress until an error occurs');
JSON.parse = nativeJsonParse;
console.log(`phase 2 (restore): ok - ${manifestV1.entryCount} entries parsed twice, ${manifestV1.packCount} staged packs read once`);

// A pack whose length, SHA-256 and manifest hashes are all valid can still end
// with malformed JSON. Full validation must reject it before the first valid
// entry is allowed to overwrite local data.
restorePrototypes(savedPrototypes);
const corruptBucket = createMemBucket();
const corruptEnv = { RP_SYNC_R2: corruptBucket };
const sha256Hex = async bytes => Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
const stableHashForTest = value => {
    let hash = 2166136261;
    for (const character of String(value)) {
        hash ^= character.charCodeAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
};
const corruptKey = 'rp_hub_corrupt_guard';
const validLine = JSON.stringify({ type: 'localStorage', key: corruptKey, value: 'remote-value' });
const corruptBytes = new TextEncoder().encode(`${validLine}\n{"type":broken}\n`);
const corruptPackChecksum = await sha256Hex(corruptBytes);
const corruptPack = {
    bucketKey: `localStorage|r${String(stableHashForTest(`ls:${corruptKey}`) % 32).padStart(3, '0')}`,
    group: 'localStorage',
    part: 0,
    checksum: corruptPackChecksum,
    length: corruptBytes.byteLength,
    entryCount: 2
};
const chainSeed = '0'.repeat(64);
const corruptPageHash = await sha256Hex(new TextEncoder().encode(JSON.stringify([
    'rp-sync-manifest-page-v1', 0, chainSeed,
    [[corruptPack.bucketKey, corruptPack.group, 0, corruptPack.checksum, corruptPack.length, 2]]
])));
const corruptBloom = new Uint8Array(32 * 1024);
const corruptBloomChecksum = await sha256Hex(corruptBloom);
const corruptRootChecksum = await sha256Hex(new TextEncoder().encode(JSON.stringify([
    'rp-sync-paged-jsonl-v4', 13, corruptPack.length, 1, 2, 1, corruptPageHash, corruptBloomChecksum
])));
await corruptBucket.put('rp-sync/main/migration-v13.done', JSON.stringify({
    format: 'rp-sync-migration-v13', legacyEtag: null, createdAt: Date.now()
}));
await corruptBucket.put(`rp-sync/main/packs/${corruptPackChecksum}.bin`, corruptBytes, {
    customMetadata: { entryCount: '2' }
});
await corruptBucket.put(`rp-sync/main/blooms/${corruptBloomChecksum}.bin`, corruptBloom);
await corruptBucket.put(`rp-sync/main/manifests/${corruptRootChecksum}/0000.json`, JSON.stringify({
    format: 'rp-sync-manifest-page-v1',
    checksum: corruptRootChecksum,
    pageIndex: 0,
    previousPageHash: chainSeed,
    pageHash: corruptPageHash,
    packs: [corruptPack]
}));
await corruptBucket.put(MANIFEST_KEY, JSON.stringify({
    format: 'rp-sync-manifest-root-v1',
    version: 1,
    checksum: corruptRootChecksum,
    updatedAt: Date.now(),
    totalBytes: corruptPack.length,
    packCount: 1,
    entryCount: 2,
    pageCount: 1,
    pageRoot: corruptPageHash,
    bloomChecksum: corruptBloomChecksum,
    snapshotFormat: 'rp-sync-paged-jsonl-v4',
    schemaVersion: 13
}));
const factoryD = new FDBFactory();
const StorageD = makeStorageClass();
const localStorageD = new StorageD();
localStorageD.setItem(corruptKey, 'local-value');
const documentD = createDocumentStub();
const locationD = {
    pathname: '/sync-restore', replaced: null, assigned: null,
    replace(url) { this.replaced = url; },
    assign(url) { this.assigned = url; }
};
installBrowserGlobals({
    storageClass: StorageD,
    localStorage: localStorageD,
    factory: factoryD,
    document: documentD,
    location: locationD,
    fetchShim: makeFetchShim('corrupt restore', corruptEnv),
    locks: locksB
});
await runScripts(['DB/dirty-tracker.js', 'DB/bootstrap.js']);
const modalD = documentD.body.children[0];
await waitFor(() => modalD.classList.contains('is-error'), 60000, 'corrupt restore rejection');
assert.equal(localStorageD.getItem(corruptKey), 'local-value',
    'late malformed JSON must be rejected before any valid entry overwrites local data');
assert.equal(localStorageD.getItem('rp_sync_restore_active'), null,
    'preflight validation failures must not leave the browser paused');
assert.equal(locationD.replaced, null, 'a failed restore must stay on the progress surface');
console.log('phase 2b (late corruption leaves local data untouched): ok');

// A restore that cannot obtain the exclusive app-writer lock has not started
// overwriting data. It must preserve an older interruption marker (if any) and
// leave business data unchanged.
restorePrototypes(savedPrototypes);
const factoryE = new FDBFactory();
const StorageE = makeStorageClass();
const localStorageE = new StorageE();
await idbPut(factoryE, 'RPHubDB', 'store', 'chat1', 'lock-blocked-local');
localStorageE.setItem('rp_sync_restore_active', 'older-interrupted-restore');
const documentE = createDocumentStub();
const locationE = {
    pathname: '/sync-restore', replaced: null,
    replace(url) { this.replaced = url; },
    assign() { }
};
const blockedLocks = {
    request(name, options, callback) {
        if (name === 'rp-hub-app-writers-v1' && options?.mode === 'exclusive') {
            return Promise.reject(new DOMException('blocked', 'AbortError'));
        }
        return Promise.resolve().then(callback);
    },
    query: async () => ({ held: [] })
};
installBrowserGlobals({
    storageClass: StorageE,
    localStorage: localStorageE,
    factory: factoryE,
    document: documentE,
    location: locationE,
    fetchShim: makeFetchShim('blocked-lock restore'),
    locks: blockedLocks
});
await runScripts(['DB/dirty-tracker.js', 'DB/bootstrap.js']);
const modalE = documentE.body.children[0];
await waitFor(() => modalE.classList.contains('is-error'), 60000, 'blocked restore lock');
assert.equal((await idbGetAll(factoryE, 'RPHubDB', 'store')).get('chat1'), 'lock-blocked-local',
    'failure before the writer lock must not alter business data');
assert.equal(localStorageE.getItem('rp_sync_restore_active'), 'older-interrupted-restore',
    'failure before the writer lock must restore the prior interruption marker');
console.log('phase 2c (writer lock failure preserves local state): ok');

// Once the exclusive lock callback starts, a write failure can leave a partial
// cross-database restore. The active marker must remain so normal app tabs keep
// refusing writes until a complete retry succeeds.
restorePrototypes(savedPrototypes);
const factoryF = new FDBFactory();
const StorageF = makeStorageClass();
const localStorageF = new StorageF();
await idbPut(factoryF, 'RPHubDB', 'store', 'chat1', 'write-failure-local');
const documentF = createDocumentStub();
const locationF = {
    pathname: '/sync-restore', replaced: null,
    replace(url) { this.replaced = url; },
    assign() { }
};
installBrowserGlobals({
    storageClass: StorageF,
    localStorage: localStorageF,
    factory: factoryF,
    document: documentF,
    location: locationF,
    fetchShim: makeFetchShim('write-failure restore'),
    locks: locksB
});
await runScripts(['DB/dirty-tracker.js', 'DB/bootstrap.js']);
const trackedPutBeforeFailure = FDBObjectStore.prototype.put;
let injectedWriteFailure = false;
FDBObjectStore.prototype.put = function (...args) {
    if (!injectedWriteFailure && this.transaction?.db?.name === 'RPHubDB' && this.name === 'store') {
        injectedWriteFailure = true;
        throw new Error('injected restore write failure');
    }
    return trackedPutBeforeFailure.apply(this, args);
};
const modalF = documentF.body.children[0];
await waitFor(() => modalF.classList.contains('is-error'), 60000, 'restore write failure');
assert.ok(injectedWriteFailure, 'the failure must be injected after the exclusive writer lock starts');
assert.ok(localStorageF.getItem('rp_sync_restore_active'),
    'a failure after restore writes begin must keep the active marker');
assert.equal(locationF.replaced, null, 'a partial restore must not navigate into the app');
console.log('phase 2d (partial restore remains paused): ok');

// ------------------------------------------- phase 3: browser A increment --

restorePrototypes(savedPrototypes);
installBrowserGlobals({
    storageClass: StorageA,
    localStorage: localStorageA,
    factory: factoryA,
    document: documentA,
    location: locationA,
    fetchShim: fetchShimA,
    locks: null
});
delete globalThis.__RPH_SYNC_DIRTY_TRACKING__;
await runScripts(['DB/dirty-tracker.js']);

await idbPut(factoryA, 'RPHubDB', 'store', 'chat1', 'hello-2');
localStorageA.setItem('rp_hub_theme', 'light');

const packRequestsBefore = requestsA.filter(entry => entry.kind === 'pack').length;
modalA.querySelector('[data-action="push"]').click();
await waitForUploadDone(modalA, 'browser A incremental upload');

const manifestV2 = await readManifest(bucket);
assert.equal(manifestV2.version, manifestV1.version + 1, 'manifest version must increase');
const uploadedPacks = requestsA.filter(entry => entry.kind === 'pack').slice(packRequestsBefore);
assert.ok(uploadedPacks.length >= 1 && uploadedPacks.length <= 8,
    `incremental upload must stay small, sent ${uploadedPacks.length} packs`);
const packsV2Text = await readManifestPackText(bucket, manifestV2);
assert.ok(packsV2Text.includes('"hello-2"'), 'changed record must be uploaded');
assert.ok(packsV2Text.includes('"value":"light"'), 'changed localStorage value must be uploaded');
assert.ok(!packsV2Text.includes('"hello"'), 'old record value must disappear from the new manifest packs');
assert.ok(!packsV2Text.includes('rp_hub_presets'), 'presets stay excluded on incremental uploads');
console.log('phase 3 (incremental upload): ok');

const reads = { cursors: 0, keys: [] };
const nativeReadCursor = FDBObjectStore.prototype.openCursor;
const nativeReadGet = FDBObjectStore.prototype.get;
FDBObjectStore.prototype.openCursor = function (...args) {
    if (this.transaction.mode === 'readonly' && ['store', 'characters'].includes(this.name)) reads.cursors += 1;
    return nativeReadCursor.apply(this, args);
};
FDBObjectStore.prototype.get = function (key) {
    if (this.transaction.mode === 'readonly' && ['store', 'characters'].includes(this.name)) reads.keys.push(key);
    return nativeReadGet.call(this, key);
};
// Cache mutation counters: invalid changes must not touch the snapshot cache
// at all, so writes and deletes on RPHubSyncCache/entries are counted per push.
const cacheWrites = { puts: 0, deletes: 0 };
const nativeStorePut = FDBObjectStore.prototype.put;
const nativeStoreDelete = FDBObjectStore.prototype.delete;
FDBObjectStore.prototype.put = function (...args) {
    if (this.transaction.db.name === 'RPHubSyncCache' && this.name === 'entries') cacheWrites.puts += 1;
    return nativeStorePut.apply(this, args);
};
FDBObjectStore.prototype.delete = function (...args) {
    if (this.transaction.db.name === 'RPHubSyncCache' && this.name === 'entries') cacheWrites.deletes += 1;
    return nativeStoreDelete.apply(this, args);
};
// Readonly-transaction counter on the main business store: proves changed
// keys are read back in bounded batches instead of one transaction per key.
const nativeDbTransaction = FDBDatabase.prototype.transaction;
let readonlyStoreTxs = 0;
FDBDatabase.prototype.transaction = function (names, mode) {
    const scope = typeof names === 'string' ? [names] : Array.from(names || []);
    if (this.name === 'RPHubDB' && mode === 'readonly' && scope.includes('store')) readonlyStoreTxs += 1;
    return nativeDbTransaction.apply(this, arguments);
};
async function push(label) {
    modalA.querySelector('[data-action="push"]').click();
    await waitForUploadDone(modalA, label);
    assert.equal(reads.cursors, 0, 'later uploads may not full-scan business stores');
}
const packRequestCount = () => requestsA.filter(entry => entry.kind === 'pack').length;

await idbPut(factoryA, 'RPHubDB', 'store', 'settings', { nested: { b: [1, 2, 3], a: 1 }, theme: 'dark' });
const noOpBatches = packRequestCount();
await push('object order only');
assert.equal(packRequestCount(), noOpBatches, 'same content must send zero packs');
assert.equal((await readManifest(bucket)).version, manifestV2.version, 'no-op must not commit a new version');
assert.ok(!reads.keys.includes('chat_big'), 'unchanged conversations must not be read');
{
    const puts = cacheWrites.puts;
    const deletes = cacheWrites.deletes;
    assert.equal(puts, 0, 'object-order no-op must not rewrite cache entries');
    assert.equal(deletes, 0, 'object-order no-op must not delete cache entries');
}

// A put with byte-identical content is an invalid change: the journal records
// it, but neither the snapshot cache nor the upload may be touched.
await idbPut(factoryA, 'RPHubDB', 'store', 'chat1', 'hello-2');
{
    const puts = cacheWrites.puts;
    const deletes = cacheWrites.deletes;
    await push('same-value put');
    assert.equal(packRequestCount(), noOpBatches, 'same-value put must send zero packs');
    assert.equal(cacheWrites.puts, puts, 'same-value put must not rewrite cache entries');
    assert.equal(cacheWrites.deletes, deletes, 'same-value put must not delete cache entries');
    assert.equal((await readManifest(bucket)).version, manifestV2.version, 'same-value put must not commit');
}
// Changing a value and reverting it inside one journal window is also an
// invalid change: the final bytes equal the cached bytes.
await idbPut(factoryA, 'RPHubDB', 'store', 'chat1', 'temporary');
await idbPut(factoryA, 'RPHubDB', 'store', 'chat1', 'hello-2');
{
    const puts = cacheWrites.puts;
    const deletes = cacheWrites.deletes;
    await push('change and revert');
    assert.equal(packRequestCount(), noOpBatches, 'change-and-revert must send zero packs');
    assert.equal(cacheWrites.puts, puts, 'change-and-revert must not rewrite cache entries');
    assert.equal(cacheWrites.deletes, deletes, 'change-and-revert must not delete cache entries');
    assert.equal((await readManifest(bucket)).version, manifestV2.version, 'change-and-revert must not commit');
}

async function writeTransaction(name, store, action, { abort = false } = {}) {
    const db = await idbOpen(factoryA, name, 1, [store]);
    try {
        await new Promise((resolve, reject) => {
            const tx = db.transaction(store, 'readwrite');
            tx.oncomplete = resolve;
            tx.onabort = () => abort ? resolve() : reject(tx.error);
            action(tx.objectStore(store), tx);
        });
    } finally { db.close(); }
}
await writeTransaction('RPHubDB', 'store', (store, tx) => { store.put('must-not-upload', 'aborted'); tx.abort(); }, { abort: true });
await push('aborted transaction');
assert.equal(packRequestCount(), noOpBatches, 'aborted write must not generate packs');
await writeTransaction('RPHubDB', 'store', store => {
    const request = store.openCursor(IDBKeyRange.only('chat1'));
    request.onsuccess = () => { if (request.result) request.result.update('cursor-value'); };
});
await push('cursor update');
assert.ok((await readManifestPackText(bucket, await readManifest(bucket))).includes('cursor-value'));
await writeTransaction('RPHubDB', 'store', store => store.delete(IDBKeyRange.bound('bulk_000', 'bulk_064')));
await push('range delete');
let text = await readManifestPackText(bucket, await readManifest(bucket));
assert.ok(!text.includes('bulk_000') && !text.includes('bulk_064') && text.includes('bulk_065'));
await writeTransaction('AICharGen', 'characters', store => { store.clear(); store.put({ id: 'after-clear' }, 'new'); });
await push('clear and new record');
text = await readManifestPackText(bucket, await readManifest(bucket));
assert.ok(!text.includes('Alice') && text.includes('after-clear'));
// clear followed by putting the identical records back is an invalid change:
// the final key set matches the cache, so nothing may be deleted or rewritten.
await writeTransaction('AICharGen', 'characters', store => { store.clear(); store.put({ id: 'after-clear' }, 'new'); });
{
    const puts = cacheWrites.puts;
    const deletes = cacheWrites.deletes;
    const version = (await readManifest(bucket)).version;
    const refillBatches = packRequestCount();
    await push('clear and identical refill');
    assert.equal(packRequestCount(), refillBatches, 'identical refill must send zero packs');
    assert.equal(cacheWrites.puts, puts, 'identical refill must not rewrite cache entries');
    assert.equal(cacheWrites.deletes, deletes, 'identical refill must not delete surviving cache entries');
    assert.equal((await readManifest(bucket)).version, version, 'identical refill must not commit');
}
await writeTransaction('RPHubDB', 'store', store => {
    for (let index = 0; index < 5105; index += 1) store.put({ index }, `many_${index}`);
});
{
    // Bounded incremental reading: one connection per database and one
    // readonly transaction per 64 changed keys, not one of each per key.
    const opensBefore = businessOpens;
    const txsBefore = readonlyStoreTxs;
    await push('more than 5000 keys');
    const openDelta = businessOpens - opensBefore;
    const txDelta = readonlyStoreTxs - txsBefore;
    assert.ok(openDelta <= 8, `5105 changed keys must not reopen the database per key (${openDelta} opens)`);
    assert.ok(txDelta >= 80 && txDelta <= 160,
        `5105 changed keys must be read in 64-key batches (${txDelta} readonly transactions)`);
}
text = await readManifestPackText(bucket, await readManifest(bucket));
for (let index = 0; index < 5105; index += 1) assert.ok(text.includes(`"many_${index}"`));

const fetchBeforeWatermark = globalThis.fetch;
let wroteDuringUpload = false;
globalThis.fetch = async (input, init) => {
    if (new URL(String(input), 'https://local.test').searchParams.get('action') === 'upload-pack' && !wroteDuringUpload) {
        wroteDuringUpload = true;
        await idbPut(factoryA, 'RPHubDB', 'store', 'during-upload', 'later-write');
        localStorageA.setItem('rp_hub_during_upload', 'later-local');
    }
    return fetchBeforeWatermark(input, init);
};
await idbPut(factoryA, 'RPHubDB', 'store', 'chat1', 'before-watermark');
await push('write during upload');
globalThis.fetch = fetchBeforeWatermark;
text = await readManifestPackText(bucket, await readManifest(bucket));
assert.ok(!text.includes('later-write'));
await push('watermark follow-up');
text = await readManifestPackText(bucket, await readManifest(bucket));
assert.ok(text.includes('later-write') && text.includes('later-local'));

// A returned commit can be lost; retry acknowledges the identical remote plan.
const fetchBeforeFailure = globalThis.fetch;
let failCommit = true;
globalThis.fetch = async (input, init) => {
    if (init?.body && typeof init.body === 'string' && JSON.parse(init.body).action === 'finalize-upload' && failCommit) {
        failCommit = false;
        await fetchBeforeFailure(input, init);
        return new Response(JSON.stringify({ ok: false, error: 'lost commit response' }), { status: 409 });
    }
    return fetchBeforeFailure(input, init);
};
await idbPut(factoryA, 'RPHubDB', 'store', 'chat1', 'retry-value');
modalA.querySelector('[data-action="push"]').click();
await waitFor(() => modalA.classList.contains('is-error'), 60000, 'lost commit response');
globalThis.fetch = fetchBeforeFailure;
const retryBatches = packRequestCount();
await push('commit retry');
assert.equal(packRequestCount(), retryBatches, 'retry must reuse committed packs');

// Bumping the internal IndexedDB version without store changes is an invalid
// change source: the cached header must be reused instead of rebuilding the
// header bucket every push. AICharGen is used because later tests keep opening
// RPHubDB at version 1.
{
    const bumpDb = await idbOpen(factoryA, 'AICharGen', 2, ['characters']);
    bumpDb.close();
    const putDb = await idbOpen(factoryA, 'AICharGen', undefined, ['characters']);
    try {
        await new Promise((resolve, reject) => {
            const tx = putDb.transaction('characters', 'readwrite');
            tx.objectStore('characters').put({ id: 'after-clear' }, 'new');
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
    } finally { putDb.close(); }
    const puts = cacheWrites.puts;
    const deletes = cacheWrites.deletes;
    const version = (await readManifest(bucket)).version;
    const bumpBatches = packRequestCount();
    await push('same content under bumped db version');
    assert.equal(packRequestCount(), bumpBatches, 'version-only churn must send zero packs');
    assert.equal(cacheWrites.puts, puts, 'version-only churn must not rewrite cache entries');
    assert.equal(cacheWrites.deletes, deletes, 'version-only churn must not delete cache entries');
    assert.equal((await readManifest(bucket)).version, version, 'version-only churn must not commit');
}

const remoteBeforeConflict = await readManifest(bucket);
const altered = { ...remoteBeforeConflict, version: remoteBeforeConflict.version + 1 };
await bucket.put(MANIFEST_KEY, JSON.stringify(altered));
await idbPut(factoryA, 'RPHubDB', 'store', 'chat1', 'stale-client');
const conflictBatches = packRequestCount();
modalA.querySelector('[data-action="push"]').click();
await waitFor(() => modalA.classList.contains('is-error'), 60000, 'stale baseline conflict');
assert.equal(packRequestCount(), conflictBatches, 'stale client must not upload packs');
assert.equal((await readManifest(bucket)).checksum, remoteBeforeConflict.checksum, 'stale client must not replace remote');
// Uploads must seed missing packs from the baseline manifest instead of
// enumerating every historical pack in R2 on each push.
assert.ok(requestsA.some(entry => entry.action === 'prepare-upload'), 'action recording must observe uploads');
assert.equal(requestsA.filter(entry => entry.action === 'list-upload-packs').length, 0,
    'uploads must not enumerate historical packs');

// A zero-record schema 13 snapshot is a valid replacement for a non-empty
// remote snapshot. The restore path must clear synchronized application data
// while preserving excluded records and credentials.
const emptyBloom = new Uint8Array(32 * 1024);
const emptyBloomDigest = await crypto.subtle.digest('SHA-256', emptyBloom);
const emptyBloomChecksum = Buffer.from(emptyBloomDigest).toString('hex');
const emptyPageRoot = '0'.repeat(64);
const emptyChecksumSource = JSON.stringify([
    'rp-sync-paged-jsonl-v4',
    13,
    0,
    0,
    0,
    0,
    emptyPageRoot,
    emptyBloomChecksum
]);
const emptyDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(emptyChecksumSource));
const emptyChecksum = Buffer.from(emptyDigest).toString('hex');
const emptyManifest = {
    format: 'rp-sync-manifest-root-v1',
    version: remoteBeforeConflict.version + 1,
    checksum: emptyChecksum,
    updatedAt: Date.now(),
    totalBytes: 0,
    packCount: 0,
    entryCount: 0,
    pageCount: 0,
    pageRoot: emptyPageRoot,
    bloomChecksum: emptyBloomChecksum,
    snapshotFormat: 'rp-sync-paged-jsonl-v4',
    schemaVersion: 13
};
await bucket.put(`rp-sync/main/blooms/${emptyBloomChecksum}.bin`, emptyBloom);
await bucket.put(MANIFEST_KEY, JSON.stringify(emptyManifest));
const factoryC = new FDBFactory();
const StorageC = makeStorageClass();
const localStorageC = new StorageC();
restorePrototypes(savedPrototypes);
await idbPut(factoryC, 'RPHubDB', 'store', 'to-clear', 'local-value');
await idbPut(factoryC, 'RPHubDB', 'store', 'rp_hub_presets', { keep: true });
await idbPut(factoryC, 'AICharGen', 'characters', 'local-character', { name: 'Local' });
localStorageC.setItem('rp_hub_local_only', 'remove-me');
localStorageC.setItem('rp_hub_sync_password_v1', 'keep-password');
localStorageC.setItem('unrelated', 'keep-unrelated');
const documentC = createDocumentStub();
const locationC = {
    pathname: '/sync-restore', replaced: null, assigned: null,
    replace(url) { this.replaced = url; },
    assign(url) { this.assigned = url; }
};
installBrowserGlobals({
    storageClass: StorageC,
    localStorage: localStorageC,
    factory: factoryC,
    document: documentC,
    location: locationC,
    fetchShim: makeFetchShim('browser C'),
    locks: locksB
});
restorePrototypes(savedPrototypes);
await runScripts(['DB/dirty-tracker.js', 'DB/bootstrap.js']);
const modalC = documentC.body.children[0];
await waitFor(() => {
    const text = modalC.querySelector('.rp-sync-modal__status').textContent;
    if (modalC.classList.contains('is-error')) throw new Error(`empty restore failed: ${text}`);
    return locationC.replaced ? 'reloaded' : null;
}, 60000, 'browser C empty restore');
const recordsC = await idbGetAll(factoryC, 'RPHubDB', 'store');
assert.ok(!recordsC.has('to-clear'), 'empty restore must remove synchronized business records');
assert.deepEqual(recordsC.get('rp_hub_presets'), { keep: true }, 'excluded records must survive empty restore');
const charactersC = await idbGetAll(factoryC, 'AICharGen', 'characters');
assert.equal(charactersC.size, 0, 'empty restore must clear known database stores');
assert.equal(localStorageC.getItem('rp_hub_local_only'), null, 'empty restore must remove synchronized localStorage keys');
assert.equal(localStorageC.getItem('rp_hub_sync_password_v1'), 'keep-password', 'sync password must survive empty restore');
assert.equal(localStorageC.getItem('unrelated'), 'keep-unrelated', 'unrelated localStorage must survive empty restore');
console.log('phase 5 (empty snapshot restore): ok');

FDBObjectStore.prototype.openCursor = nativeReadCursor;
FDBObjectStore.prototype.get = nativeReadGet;
FDBObjectStore.prototype.put = nativeStorePut;
FDBObjectStore.prototype.delete = nativeStoreDelete;
FDBDatabase.prototype.transaction = nativeDbTransaction;
FDBFactory.prototype.open = nativeFactoryOpen;
console.log('phase 4 (strict increments, invalid changes, clear diff, batched reads, version churn, watermark, retry, conflict): ok');
console.log('restore-sim: ok');

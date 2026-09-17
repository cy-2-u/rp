// Full sync lifecycle simulation on fake IndexedDB + in-memory R2:
//   browser A uploads, browser B restores over its own data, browser A
//   uploads an increment. Exercises bootstrap.js end to end, including the
//   restore state machine, exclusions and the bounded upload engine.
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
                ? { key, etag: object.etag, size: object.size, uploaded: object.uploaded, httpMetadata: object.httpMetadata }
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
                httpMetadata: object.httpMetadata,
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
            etagSequence += 1;
            const etag = `etag-${String(etagSequence).padStart(6, '0')}`;
            objects.set(key, { key, bytes, etag, size: bytes.byteLength, uploaded: new Date(), httpMetadata: options.httpMetadata });
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
            const start = cursor ? keys.indexOf(cursor) + 1 : 0;
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
    [FDBDatabase.prototype, 'transaction']
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

function parseBatchBody(buffer) {
    const view = new DataView(buffer);
    const headerLength = view.getUint32(0, false);
    return JSON.parse(Buffer.from(buffer, 4, headerLength).toString('utf8'));
}

async function readManifest(bucket) {
    const object = await bucket.get(MANIFEST_KEY);
    return object ? JSON.parse(Buffer.from(object.body).toString('utf8')) : null;
}

async function readManifestPackText(bucket, manifest) {
    const chunks = [];
    for (const pack of manifest.packManifest) {
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
const makeFetchShim = label => async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith('/api/rp-sync')) throw new Error(`unexpected fetch in ${label}: ${url}`);
    const request = new Request(`https://local.test${url}`, init);
    const response = await worker.fetch(request, env, { waitUntil() { } });
    if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(`worker rejected ${url}: HTTP ${response.status} ${payload.error || ''}`);
    }
    return response;
};

// ------------------------------------------------- phase 1: browser A ------

const factoryA = new FDBFactory();
const StorageA = makeStorageClass();
const localStorageA = new StorageA();

await idbPut(factoryA, 'RPHubDB', 'store', 'chat1', 'hello');
await idbPut(factoryA, 'RPHubDB', 'store', 'settings', { theme: 'dark', nested: { a: 1, b: [1, 2, 3] } });
await idbPut(factoryA, 'RPHubDB', 'store', 'chat_big',
    Array.from({ length: 300 }, (_, index) => ({ index, text: `msg-${index}`, tags: ['a', 'b'] })));
await idbPut(factoryA, 'RPHubDB', 'store', 'rp_hub_presets', { keep: true, fromLocal: true });
await idbPut(factoryA, 'AICharGen', 'characters', 'c1', { id: 'c1', name: 'Alice', hp: 10 });
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
const fetchShimA = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    assert.ok(url.startsWith('/api/rp-sync'), `unexpected fetch in browser A: ${url}`);
    if (url.includes('upload-pack-batch') && init?.body instanceof Blob) {
        const packs = parseBatchBody(await init.body.arrayBuffer());
        requestsA.push({ kind: 'batch', packs });
        return makeFetchShim('browser A')(input, init);
    }
    requestsA.push({ kind: url.includes('upload-pack-batch') ? 'batch' : url });
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
await runScripts(['DB/dirty-tracker.js', 'DB/persistence-bridge.js', 'DB/upload-engine.js', 'DB/bootstrap.js']);
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
    fetchShim: makeFetchShim('browser B'),
    locks: locksB
});
await runScripts(['DB/bootstrap.js']);

const modalB = documentB.body.children[0];
await waitFor(() => {
    const text = modalB.querySelector('.rp-sync-modal__status').textContent;
    if (modalB.classList.contains('is-error')) throw new Error(`restore failed: ${text}`);
    return locationB.replaced ? 'reloaded' : null;
}, 60000, 'browser B restore');

const recordsB = await idbGetAll(factoryB, 'RPHubDB', 'store');
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
console.log('phase 2 (restore): ok');

// ------------------------------------------- phase 3: browser A increment --

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

const batchesBefore = requestsA.filter(entry => entry.kind === 'batch').length;
modalA.querySelector('[data-action="push"]').click();
await waitForUploadDone(modalA, 'browser A incremental upload');

const manifestV2 = await readManifest(bucket);
assert.equal(manifestV2.version, manifestV1.version + 1, 'manifest version must increase');
const batchesAfter = requestsA.filter(entry => entry.kind === 'batch').slice(batchesBefore);
assert.ok(batchesAfter.length >= 1 && batchesAfter.length <= 3,
    `incremental upload must stay small, sent ${batchesAfter.length} batches`);
const uploadedPacks = batchesAfter.reduce((sum, entry) => sum + entry.packs.length, 0);
assert.ok(uploadedPacks <= 8, `incremental upload must not resend everything (${uploadedPacks} packs)`);
const packsV2Text = await readManifestPackText(bucket, manifestV2);
assert.ok(packsV2Text.includes('"hello-2"'), 'changed record must be uploaded');
assert.ok(packsV2Text.includes('"value":"light"'), 'changed localStorage value must be uploaded');
assert.ok(!packsV2Text.includes('"hello"'), 'old record value must disappear from the new manifest packs');
assert.ok(!packsV2Text.includes('rp_hub_presets'), 'presets stay excluded on incremental uploads');
console.log('phase 3 (incremental upload): ok');

console.log('restore-sim: ok');

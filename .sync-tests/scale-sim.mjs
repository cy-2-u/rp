// Scale simulation (default 300MB, tune SCALE_MB): free-plan Workers limits
// are enforced on EVERY request.
//   phase 1: first upload of the full dataset (full baseline scan + pack + bounded upload)
//   phase 2: re-push with no changes (must be a zero-pack no-op)
//   phase 3a: 100 same-length edits -> incremental upload (content-addressed packs)
//   phase 3b: 20 drift edits + 10 deletes + 10 inserts -> incremental upload
//   phase 4: re-push again (must stay a zero-pack no-op)
//   phase 5: restore the final committed snapshot into a fresh browser profile
// Per-request subrequests, client connections, R2 usage, snapshot size, and
// incremental behavior are asserted here. Exact 10ms request-budget proxies
// run in sync-v13-budget.mjs on a small isolated heap; wall timings in this
// process stay diagnostic because a 300MB fake IndexedDB can pause for host GC.
// NOTE: keep this file ASCII-only; Chinese text must use \uXXXX escapes so the
// status regex can never be corrupted by toolchain encoding round-trips.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { AsyncLocalStorage } from 'node:async_hooks';
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
const FDBIndex = await loadFdbClass('FDBIndex');
const FDBRequest = await loadFdbClass('FDBRequest');
const FDBOpenDBRequest = await loadFdbClass('FDBOpenDBRequest');
const FDBVersionChangeEvent = await loadFdbClass('FDBVersionChangeEvent');
const FDBCursor = await loadFdbClass('FDBCursor');
const FDBCursorWithValue = await loadFdbClass('FDBCursorWithValue');
const FDBTransaction = await loadFdbClass('FDBTransaction');
const FDBKeyRange = await loadFdbClass('FDBKeyRange');

const PATCHED_MEMBERS = [
    [FDBObjectStore.prototype, 'put'],
    [FDBObjectStore.prototype, 'add'],
    [FDBObjectStore.prototype, 'delete'],
    [FDBObjectStore.prototype, 'clear'],
    [FDBObjectStore.prototype, 'get'],
    [FDBObjectStore.prototype, 'openCursor'],
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
const savedPrototypes = snapshotPrototypes();

const MANIFEST_KEY = 'rp-sync/main/manifest.json';
// The panel completion status text, matched via unicode escapes below.
const DONE_STATUS = /\u5df2\u5b8c\u6210|\u5df2\u662f\u6700\u65b0/;
const LIMITS = {
    subrequestsPerRequest: 50,
    outboundConnections: 6,
    r2ClassAMonthly: 1_000_000,
    r2ClassBMonthly: 10_000_000,
    requestsPerDay: 100_000,
    maxSnapshotBytes: 1024 ** 3,
    maxPackCount: 8192
};

// ---------------------------------------------------------------- mocks ----

// In-memory R2 bucket: put/list count as class A, get/head as class B,
// delete is unbilled. Every op is charged against the "current request"
// subrequest budget; ops outside a request lifecycle fail loudly so worker
// code cannot sneak subrequests out of band. Test-side verification reads
// go through peek() and stay unbilled.
function createAccountedBucket() {
    const objects = new Map();
    let etagSequence = 0;
    const requestContext = new AsyncLocalStorage();
    let inflightPutBytes = 0;
    const stagedPackBodies = new Map();
    const stats = { maxSubrequests: 0, classA: 0, classB: 0, maxInflightPutBytes: 0, maxObjectBytes: 0 };
    const asBytes = async value => {
        if (value instanceof Uint8Array) return value;
        if (value instanceof ArrayBuffer) return new Uint8Array(value);
        return new Uint8Array(await new Response(value).arrayBuffer());
    };
    const charge = op => {
        const current = requestContext.getStore();
        assert.ok(current, `${op} outside a request lifecycle`);
        current.subrequests += 1;
        if (current.subrequests > stats.maxSubrequests) stats.maxSubrequests = current.subrequests;
        return current;
    };
    return {
        objects,
        stats,
        runRequest(accounting, task) { return requestContext.run(accounting, task); },
        stagePack(checksum, bytes) { stagedPackBodies.set(checksum, bytes); },
        // Test-side verification read: not part of any request, unbilled.
        peek(key) {
            const object = objects.get(key);
            if (!object) return null;
            return {
                key, etag: object.etag, size: object.size, uploaded: object.uploaded,
                bytes: object.bytes,
                text: async () => Buffer.from(object.bytes).toString('utf8')
            };
        },
        async head(key) {
            const accounting = charge('head');
            accounting.classB += 1;
            const object = objects.get(key);
            return object ? {
                key,
                etag: object.etag,
                size: object.size,
                uploaded: object.uploaded,
                httpMetadata: object.httpMetadata,
                customMetadata: object.customMetadata
            } : null;
        },
        async get(key) {
            const accounting = charge('get');
            accounting.classB += 1;
            const object = objects.get(key);
            if (!object) return null;
            return {
                key, etag: object.etag, size: object.size, uploaded: object.uploaded,
                httpMetadata: object.httpMetadata,
                customMetadata: object.customMetadata,
                body: new Uint8Array(object.bytes),
                text: async () => Buffer.from(object.bytes).toString('utf8')
            };
        },
        async put(key, value, options = {}) {
            const accounting = charge('put');
            accounting.classA += 1;
            const packMatch = key.match(/^rp-sync\/main\/packs\/([a-f0-9]{64})\.bin$/);
            const stagedPack = packMatch ? stagedPackBodies.get(packMatch[1]) : null;
            const bytes = stagedPack || await asBytes(value);
            if (packMatch) stagedPackBodies.delete(packMatch[1]);
            if (options.onlyIf) {
                const existing = objects.get(key);
                const etag = existing ? existing.etag : null;
                if (options.onlyIf.etagMatches !== undefined && etag !== options.onlyIf.etagMatches) return null;
                if (options.onlyIf.etagDoesNotMatch === '*' && etag !== null) return null;
            }
            if (options.sha256) {
                const expected = options.sha256 instanceof ArrayBuffer
                    ? Buffer.from(options.sha256).toString('hex')
                    : String(options.sha256).toLowerCase();
                if (packMatch) {
                    assert.equal(expected, packMatch[1], `R2 checksum option mismatch for ${key}`);
                } else {
                    const digest = await crypto.subtle.digest('SHA-256', bytes);
                    assert.equal(Buffer.from(digest).toString('hex'), expected, `R2 checksum mismatch for ${key}`);
                }
            }
            inflightPutBytes += bytes.byteLength;
            if (inflightPutBytes > stats.maxInflightPutBytes) stats.maxInflightPutBytes = inflightPutBytes;
            try {
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
                if (bytes.byteLength > stats.maxObjectBytes) stats.maxObjectBytes = bytes.byteLength;
                return { key, etag };
            } finally {
                inflightPutBytes -= bytes.byteLength;
            }
        },
        async delete(keys) {
            charge('delete');
            const list = Array.isArray(keys) ? keys : [keys];
            let deleted = 0;
            for (const key of list) if (objects.delete(key)) deleted += 1;
            return deleted;
        },
        async list({ prefix = '', cursor, limit = 1000 } = {}) {
            const accounting = charge('list');
            accounting.classA += 1;
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
        removeItem(key) { this.#map.delete(key); }
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

const setGlobal = (name, value) => {
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
};

function installBrowserGlobals({ storageClass, localStorage, factory, document, location, fetchShim, locks = null }) {
    const globals = {
        indexedDB: factory,
        IDBKeyRange: FDBKeyRange,
        IDBDatabase: FDBDatabase,
        IDBObjectStore: FDBObjectStore,
        IDBTransaction: FDBTransaction,
        IDBIndex: FDBIndex,
        IDBRequest: FDBRequest,
        IDBOpenDBRequest: FDBOpenDBRequest,
        IDBVersionChangeEvent: FDBVersionChangeEvent,
        IDBCursor: FDBCursor,
        IDBCursorWithValue: FDBCursorWithValue,
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

// ---------------------------------------------------------- idb helpers ----

async function idbOpen(factory, dbName, version, stores) {
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

// Seeding bulk put: one connection, 500 records per transaction.
async function idbBulkPut(factory, dbName, storeName, records) {
    const db = await idbOpen(factory, dbName, 1, [storeName]);
    try {
        for (let start = 0; start < records.length; start += 500) {
            const batch = records.slice(start, start + 500);
            await new Promise((resolve, reject) => {
                const tx = db.transaction([storeName], 'readwrite');
                for (const [key, value] of batch) tx.objectStore(storeName).put(value, key);
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
            });
        }
    } finally { db.close(); }
}

async function idbGet(factory, dbName, storeName, key) {
    const db = await idbOpen(factory, dbName, undefined, [storeName]);
    try {
        const tx = db.transaction(storeName, 'readonly');
        const request = tx.objectStore(storeName).get(key);
        return await new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve(request.result);
            tx.onerror = () => reject(tx.error);
        });
    } finally { db.close(); }
}

// Incremental-phase writes must go through this entry: after bootstrap.js
// loads, factory.open is the dirty-tracker facade, so these writes land in
// the change journal and get picked up by the next push.
async function writeTransaction(name, store, action) {
    const db = await idbOpen(globalThis.indexedDB, name, 1, [store]);
    try {
        await new Promise((resolve, reject) => {
            const tx = db.transaction(store, 'readwrite');
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
            action(tx.objectStore(store), tx);
        });
    } finally { db.close(); }
}

// ------------------------------------------------------------- setup ------

const bucket = createAccountedBucket();
const env = { RP_SYNC_R2: bucket };
const workerSource = await read('_worker.js');
const worker = new Function('fetch', workerSource.replace('export default {', 'return {'))(globalThis.fetch);

const requests = [];
let clientInflight = 0;
let maxClientInflight = 0;
let totalUploadedBytes = 0;
const accountings = [];
// One accounting record per Worker request. waitUntil work is billed to that
// request, matching free-plan accounting. Wall time is retained as a useful
// diagnostic, but it is not a CPU gate here: this process also owns the large
// fake browser database, so V8 host-GC pauses can land inside a request window.
const requestGc = typeof globalThis.gc === 'function' ? () => globalThis.gc() : null;
async function accountedFetch(input, init) {
    const url = typeof input === 'string' ? input : input.url;
    const request = new Request(`https://local.test${url}`, init);
    const urlAction = new URL(url, 'https://local.test').searchParams.get('action');
    const bodyBytes = init?.body instanceof Uint8Array
        ? init.body.byteLength
        : init?.body instanceof ArrayBuffer
            ? init.body.byteLength
            : init?.body instanceof Blob
                ? init.body.size
                : 0;
    const kind = urlAction || kindOf(init);
    const accounting = { subrequests: 0, classA: 0, classB: 0, waitUntil: [] };
    clientInflight += 1;
    if (clientInflight > maxClientInflight) maxClientInflight = clientInflight;
    const wallStart = process.hrtime.bigint();
    try {
        return await bucket.runRequest(accounting, async () => {
            if (kind !== 'upload-pack' && kind !== 'pull-pack') {
                console.log(`    [req] ${kind} (#${accountings.length + 1})`);
            }
            const response = await worker.fetch(request, env, {
                waitUntil: promise => accounting.waitUntil.push(Promise.resolve(promise).catch(() => { }))
            });
            while (accounting.waitUntil.length) await accounting.waitUntil.shift();
            accountings.push({
                kind,
                bodyBytes,
                wallMs: Number(process.hrtime.bigint() - wallStart) / 1e6,
                subrequests: accounting.subrequests,
                classA: accounting.classA,
                classB: accounting.classB
            });
            return response;
        });
    } finally {
        clientInflight -= 1;
    }
}
const kindOf = init => {
    try { return JSON.parse(typeof init?.body === 'string' ? init.body : '{}').action ?? 'other'; } catch { return 'other'; }
};
const fetchShim = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    assert.ok(url.startsWith('/api/rp-sync'), `unexpected fetch: ${url}`);
    const requestUrl = new URL(url, 'https://local.test');
    const action = requestUrl.searchParams.get('action') || kindOf(init);
    if (action === 'upload-pack') {
        const pack = {
            checksum: requestUrl.searchParams.get('checksum'),
            length: Number(requestUrl.searchParams.get('length')),
            entryCount: Number(requestUrl.searchParams.get('entryCount'))
        };
        totalUploadedBytes += pack.length;
        requests.push({ kind: 'pack', pack });
        bucket.stagePack(pack.checksum, init.body);
    } else {
        requests.push({ kind: action, action });
    }
    return accountedFetch(input, init);
};
const uploadedPackCount = () => requests.filter(entry => entry.kind === 'pack').length;
const readManifestDirect = async () => {
    const object = bucket.peek(MANIFEST_KEY);
    assert.ok(object, 'manifest must exist');
    return JSON.parse(Buffer.from(object.bytes).toString('utf8'));
};
const readManifestPacksDirect = manifest => {
    const packs = [];
    for (let pageIndex = 0; pageIndex < manifest.pageCount; pageIndex += 1) {
        const key = `rp-sync/main/manifests/${manifest.checksum}/${String(pageIndex).padStart(4, '0')}.json`;
        const object = bucket.peek(key);
        assert.ok(object, `manifest page ${pageIndex} missing from R2`);
        packs.push(...JSON.parse(Buffer.from(object.bytes).toString('utf8')).packs);
    }
    assert.equal(packs.length, manifest.packCount);
    return packs;
};
const readPackTextDirect = async checksum => {
    const object = bucket.peek(`rp-sync/main/packs/${checksum}.bin`);
    assert.ok(object, `pack ${checksum} missing from R2`);
    return Buffer.from(object.bytes).toString('utf8');
};

// Business-store readonly cursor counter: incremental pushes must full-scan
// nothing (zero readonly cursors on RPHubDB/store while a push is in flight).
let businessCursors = 0;
let countCursors = false;
const nativeStoreCursor = FDBObjectStore.prototype.openCursor;
FDBObjectStore.prototype.openCursor = function (...args) {
    // Journal reads also open readonly cursors inside RPHubDB; only the
    // business stores count as a full scan.
    if (countCursors && this.transaction?.db?.name === 'RPHubDB' && this.transaction.mode === 'readonly'
        && ['store', 'characters'].includes(this.name)) businessCursors += 1;
    return nativeStoreCursor.apply(this, args);
};

const factory = new FDBFactory();
const Storage = makeStorageClass();
const localStorage = new Storage();

// ------------------------------------------------- phase 0: seed data ----

const SCALE_MB = Number(process.env.SCALE_MB) || 300;
const TARGET_BYTES = SCALE_MB * 1024 * 1024;
const PAYLOAD_BYTES = 8000;
// Per-line estimate: payload + canonical JSON envelope overhead
// (type/database/store/key/id/rev/tags fields).
const RECORD_COUNT = Math.floor(TARGET_BYTES / (PAYLOAD_BYTES + 170));
const recordKey = index => `rec_${String(index).padStart(7, '0')}`;
const makeRecord = (index, rev) => ({
    id: recordKey(index),
    kind: 'chat',
    rev,
    payload: `${String.fromCharCode(97 + (index % 26))}${String.fromCharCode(65 + (index % 26))}${'x'.repeat(PAYLOAD_BYTES - 3)}`,
    tags: ['t1', 't2']
});
console.log(`seeding ${RECORD_COUNT} records x ~${PAYLOAD_BYTES}B ...`);
{
    const records = [];
    for (let index = 0; index < RECORD_COUNT; index += 1) records.push([recordKey(index), makeRecord(index, 1)]);
    await idbBulkPut(factory, 'RPHubDB', 'store', records);
}
await idbBulkPut(factory, 'RPHubDB', 'store', [
    ['settings', { theme: 'dark', nested: { a: 1, b: [1, 2, 3] } }],
    ['chat_big', Array.from({ length: 300 }, (_, index) => ({ index, text: `msg-${index}`, tags: ['a', 'b'] }))],
    ['rp_hub_presets', { keep: true, fromLocal: true }]
]);
await idbBulkPut(factory, 'AICharGen', 'characters', [['c1', { id: 'c1', name: 'Alice', hp: 10 }]]);
localStorage.setItem('rp_hub_settings', 'v1');
localStorage.setItem('rp_hub_sync_password_v1', 'secret');
localStorage.setItem('unrelated', 'keep');

const documentStub = createDocumentStub();
const locationStub = { pathname: '/', replaced: null, assign() { }, replace() { } };
installBrowserGlobals({
    storageClass: Storage,
    localStorage,
    factory,
    document: documentStub,
    location: locationStub,
    fetchShim
});
await runScripts(['DB/dirty-tracker.js', 'DB/bootstrap.js']);
globalThis.RPHubAuthorSaveData = async () => { };

const modal = documentStub.body.children[0];
assert.ok(modal, 'sync modal should be created on load');

const waitForUploadDone = (label, timeoutMs = 20 * 60_000) => new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
        const status = modal.querySelector('.rp-sync-modal__status').textContent;
        if (Date.now() - startedAt > 30000 && Math.floor((Date.now() - startedAt) / 30000) !== Math.floor((Date.now() - startedAt - 500) / 30000)) {
            console.log(`    [wait ${label}] ${Math.round((Date.now() - startedAt) / 1000)}s status="${status}"`);
        }
        if (modal.classList.contains('is-error')) {
            clearInterval(timer);
            reject(new Error(`${label} failed: ${status}`));
        } else if (DONE_STATUS.test(status)) {
            clearInterval(timer);
            resolve(status);
        } else if (Date.now() - startedAt > timeoutMs) {
            clearInterval(timer);
            reject(new Error(`timeout waiting for ${label}: ${status}`));
        }
    }, 500);
});
async function push(label) {
    if (requestGc) requestGc();
    const mark = accountings.length;
    modal.querySelector('[data-action="push"]').click();
    await waitForUploadDone(label);
    return accountings.slice(mark);
}
// Report timings without treating host-GC pauses as Worker CPU. The isolated
// budget suite applies the hard 10ms p95 / 20ms max gates to maximum-size
// request shapes in a separate process.
function reportRequestTimings(slices, label) {
    const byKind = new Map();
    for (const entry of slices) {
        const list = byKind.get(entry.kind) || [];
        list.push(entry);
        byKind.set(entry.kind, list);
    }
    for (const [kind, list] of byKind) {
        const walls = list.map(e => e.wallMs).sort((a, b) => a - b);
        const p95Index = Math.max(0, Math.ceil(walls.length * 0.95) - 1);
        const stats = {
            kind,
            wallMin: walls[0],
            wallP50: walls[Math.floor(walls.length / 2)],
            wallP95: walls[p95Index],
            wallMax: walls[walls.length - 1],
            samples: list.length
        };
        console.log(`    [timing] ${label} ${kind}: wall min ${stats.wallMin.toFixed(2)} / p50 ${stats.wallP50.toFixed(2)} / p95 ${stats.wallP95.toFixed(2)} / max ${stats.wallMax.toFixed(2)} ms (n=${stats.samples}, host diagnostic)`);
    }
}

// --------------------------------------------- phase 1: first full upload ----

console.log(`phase 1: first upload of ~${SCALE_MB}MB (${RECORD_COUNT} records) ...`);
const phase1Mark = { requests: requests.length, packs: uploadedPackCount() };
const phase1Start = Date.now();
const phase1Slices = await push('phase 1 first upload');
const phase1DurationMs = Date.now() - phase1Start;
const phase1Requests = requests.length - phase1Mark.requests;
const phase1PackCount = uploadedPackCount() - phase1Mark.packs;

const manifestV1 = await readManifestDirect();
const packsV1 = readManifestPacksDirect(manifestV1);
const manifestObject = bucket.objects.get(MANIFEST_KEY);
console.log(`  snapshot: ${(manifestV1.totalBytes / 1024 ** 3).toFixed(3)} GiB, ${manifestV1.packCount} packs, root ${manifestObject.size} bytes, ${(phase1DurationMs / 1000).toFixed(1)} s`);
assert.ok(manifestV1.totalBytes <= LIMITS.maxSnapshotBytes, 'snapshot must fit the 1GiB client limit');
assert.ok(manifestV1.totalBytes > 0.9 * TARGET_BYTES, 'dataset must actually exercise the target scale');
assert.ok(manifestV1.packCount <= LIMITS.maxPackCount, 'pack count must fit the 8192 limit');
assert.ok(manifestObject.size <= 16 * 1024, 'root manifest must stay constant-size');
assert.equal(manifestV1.packCount, packsV1.length);
assert.equal(manifestV1.pageCount, Math.ceil(manifestV1.packCount / 32));
assert.equal(phase1PackCount, manifestV1.packCount, 'first upload must send every pack');
// Content spot checks: stream every pack in manifest order until both
// markers are found (early exit; never materializes the whole snapshot).
{
    let sawBulk = false;
    let sawArrayItem = false;
    for (const pack of packsV1) {
        if (sawBulk && sawArrayItem) break;
        const text = await readPackTextDirect(pack.checksum);
        if (text.includes('rec_0000001')) sawBulk = true;
        if (text.includes('msg-299')) sawArrayItem = true;
    }
    assert.ok(sawBulk, 'bulk record must be present in packed snapshot');
    assert.ok(sawArrayItem, 'large-array record must be present');
}

reportRequestTimings(phase1Slices, 'phase1');
const phase1MaxSubrequests = Math.max(...phase1Slices.map(entry => entry.subrequests));
assert.ok(phase1MaxSubrequests <= LIMITS.subrequestsPerRequest,
    `subrequest budget exceeded: ${phase1MaxSubrequests}`);
assert.ok(maxClientInflight <= LIMITS.outboundConnections, 'client concurrency must stay within 6 outbound connections');
assert.equal(maxClientInflight, 1, 'the bounded engine must keep exactly one batch in flight');
assert.ok(bucket.stats.maxInflightPutBytes <= 3 * 1024 * 1024 + 1024, 'R2 writes must stay within the 3-put concurrency bound');
console.log(`  requests: ${phase1Requests} (~${(phase1Requests / LIMITS.requestsPerDay * 100).toFixed(3)}% of daily 100k), max wall ${Math.max(...phase1Slices.map(e=>e.wallMs)).toFixed(2)} ms, max subrequests ${phase1MaxSubrequests}`);
console.log(`  R2 ops this phase: A=${phase1Slices.reduce((t, e) => t + e.classA, 0)}, B=${phase1Slices.reduce((t, e) => t + e.classB, 0)}`);
console.log(`phase 1 (first ${SCALE_MB}MB upload): ok`);

// ------------------------------------------- phase 2: no-change re-push ----

const phase2Mark = { requests: requests.length, packs: uploadedPackCount() };
await push('phase 2 no-change upload');
const phase2PackCount = uploadedPackCount() - phase2Mark.packs;
assert.equal(phase2PackCount, 0, 'a no-change push must upload zero packs');
assert.equal(requests.length - phase2Mark.requests, 1, 'a no-change push is a single prepare-upload probe (client short-circuits on matching checksum)');
assert.equal(bucket.peek(MANIFEST_KEY).size, manifestObject.size, 'no-change push must not rewrite the manifest');
console.log('phase 2 (no-change push): ok - 0 packs, 1 request');

// --------------------------------- phase 3a: 100 same-length edits ----

console.log('phase 3a: 100 same-length edits ...');
{
    const edits = [];
    for (let i = 0; i < 100; i += 1) {
        const index = i * 1013 % RECORD_COUNT;
        const record = makeRecord(index, 2);
        // Flip characters only: the serialized byte length stays identical.
        record.payload = `B${record.payload.slice(1)}`;
        record.payload = record.payload.slice(0, 2) + 'Z' + record.payload.slice(3);
        edits.push([recordKey(index), record]);
    }
    await idbBulkPut(factory, 'RPHubDB', 'store', edits);
}
businessCursors = 0;
countCursors = true;
const phase3aMark = { requests: requests.length, packs: uploadedPackCount() };
const phase3aStart = Date.now();
const phase3aSlices = await push('phase 3a incremental upload');
countCursors = false;
const phase3aPacks = uploadedPackCount() - phase3aMark.packs;
const phase3aBytes = phase3aSlices.filter(e => e.kind === 'upload-pack').reduce((t, e) => t + e.bodyBytes, 0);
reportRequestTimings(phase3aSlices, 'phase3a');
const phase3aMaxSubrequests = Math.max(...phase3aSlices.map(entry => entry.subrequests));
assert.ok(phase3aMaxSubrequests <= LIMITS.subrequestsPerRequest, 'incremental subrequest budget exceeded');
assert.equal(businessCursors, 0, 'incremental upload must not full-scan business stores');
const manifestV2 = await readManifestDirect();
const packsV2 = readManifestPacksDirect(manifestV2);
{
    const before = new Set(packsV1.map(pack => pack.checksum));
    const after = packsV2.filter(pack => !before.has(pack.checksum));
    assert.equal(after.length, phase3aPacks, 'manifest pack diff must equal uploaded pack count');
    assert.ok(phase3aPacks > 0, 'same-length edits must produce new packs');
    let sawRev2 = false;
    for (const pack of after) {
        const text = await readPackTextDirect(pack.checksum);
        if (text.includes('"rev":2')) sawRev2 = true;
    }
    assert.ok(sawRev2, 'edited records must appear with their new revision among new packs');
    console.log(`  same-length edits: ${phase3aPacks} packs, ${(phase3aBytes / 1024 / 1024).toFixed(1)} MB, ${requests.length - phase3aMark.requests} requests, max wall ${Math.max(...phase3aSlices.map(e=>e.wallMs)).toFixed(2)} ms, ${((Date.now() - phase3aStart) / 1000).toFixed(1)} s`);
}
console.log('phase 3a (same-length incremental): ok');

// ----------------- phase 3b: drift edits + deletes + inserts ----

console.log('phase 3b: 20 drift edits + 10 deletes + 10 inserts ...');
{
    const edits = [];
    for (let i = 0; i < 20; i += 1) {
        const index = (i * 7919 + 5) % RECORD_COUNT;
        const record = makeRecord(index, 3);
        record.payload += '-'.repeat(200);
        edits.push([recordKey(index), record]);
    }
    await idbBulkPut(factory, 'RPHubDB', 'store', edits);
    const deletedKeys = Array.from({ length: 10 }, (_, i) => recordKey(i * 9973 + 2));
    await writeTransaction('RPHubDB', 'store', store => {
        for (const key of deletedKeys) store.delete(key);
    });
    const inserts = [];
    for (let i = 0; i < 10; i += 1) {
        const index = RECORD_COUNT + i;
        inserts.push([recordKey(index), { ...makeRecord(index, 1), tags: ['inserted-scale'] }]);
    }
    await idbBulkPut(factory, 'RPHubDB', 'store', inserts);
    localStorage.setItem('rp_hub_settings', 'v2-scale');
}
businessCursors = 0;
countCursors = true;
const phase3bMark = { requests: requests.length, packs: uploadedPackCount() };
const phase3bStart = Date.now();
const phase3bSlices = await push('phase 3b incremental upload');
countCursors = false;
const phase3bPacks = uploadedPackCount() - phase3bMark.packs;
const phase3bBytes = phase3bSlices.filter(e => e.kind === 'upload-pack').reduce((t, e) => t + e.bodyBytes, 0);
reportRequestTimings(phase3bSlices, 'phase3b');
assert.equal(businessCursors, 0, 'incremental upload must not full-scan business stores');
const manifestV3 = await readManifestDirect();
const packsV3 = readManifestPacksDirect(manifestV3);
{
    const before = new Set(packsV2.map(pack => pack.checksum));
    const fresh = packsV3.filter(pack => !before.has(pack.checksum));
    assert.equal(fresh.length, phase3bPacks, 'manifest pack diff must equal uploaded pack count');
    assert.ok(fresh.length > 0, 'drift phase must produce new packs');
    const deletedKeys = Array.from({ length: 10 }, (_, i) => recordKey(i * 9973 + 2));
    let sawInserted = false;
    for (const pack of fresh) {
        const text = await readPackTextDirect(pack.checksum);
        // Inserted records carry the inserted-scale tag and must appear among
        // new packs; deleted records must not reappear in any new pack (their
        // old packs remain in the 24h GC grace window but are unreferenced).
        if (text.includes('inserted-scale')) sawInserted = true;
        for (const key of deletedKeys) assert.ok(!text.includes(key), `deleted ${key} must not reappear in new packs`);
    }
    assert.ok(sawInserted, 'inserted records must be present among the new packs');
    console.log(`  drift edits + delete + insert: ${phase3bPacks} packs, ${(phase3bBytes / 1024 / 1024).toFixed(1)} MB, ${requests.length - phase3bMark.requests} requests, max wall ${Math.max(...phase3bSlices.map(e=>e.wallMs)).toFixed(2)} ms, ${((Date.now() - phase3bStart) / 1000).toFixed(1)} s`);
}
console.log('phase 3b (drift incremental): ok');

// ------------------------------------------- phase 4: settled no-op push ----

const phase4Mark = { requests: requests.length, packs: uploadedPackCount() };
await push('phase 4 no-change upload');
assert.equal(uploadedPackCount() - phase4Mark.packs, 0, 'post-increment no-op must upload zero packs');
console.log('phase 4 (settled no-op push): ok');

// --------------------------------------------- phase 5: full-scale restore ----

console.log(`phase 5: restore the final ~${SCALE_MB}MB snapshot ...`);
const restoreManifest = await readManifestDirect();
const restorePacks = readManifestPacksDirect(restoreManifest);
restorePrototypes(savedPrototypes);
const deleteDatabase = (factoryToClear, name) => new Promise((resolve, reject) => {
    const request = FDBFactory.prototype.deleteDatabase.call(factoryToClear, name);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error(`database ${name} stayed open during scale restore setup`));
});
for (const name of ['RPHubDB', 'AICharGen', 'RPHubSyncCache', 'RPHubSyncStaging']) {
    await deleteDatabase(factory, name);
}
localStorage.clear();
if (requestGc) requestGc();

const restoreFactory = new FDBFactory();
const RestoreStorage = makeStorageClass();
const restoreStorage = new RestoreStorage();
const restoreDocument = createDocumentStub();
const restoreLocation = {
    pathname: '/sync-restore',
    replaced: null,
    replace(url) { this.replaced = url; },
    assign() { }
};
const restoreLocks = {
    request: (name, options, callback) => Promise.resolve().then(callback),
    query: async () => ({ held: [] })
};
const restoreMetrics = {
    parses: 0,
    stagingReads: [],
    stagingWrites: [],
    cachePackWrites: [],
    pullRequests: 0,
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
    if (snapshotTypes.has(value?.type)) restoreMetrics.parses += 1;
    return value;
};
const measuredTransactions = new WeakMap();
const nativeRestoreTransaction = FDBDatabase.prototype.transaction;
FDBDatabase.prototype.transaction = function (names, mode, ...rest) {
    const tx = nativeRestoreTransaction.call(this, names, mode, ...rest);
    const scope = typeof names === 'string' ? [names] : Array.from(names);
    let target = null;
    if (this.name === 'RPHubSyncStaging' && scope.length === 1 && scope[0] === 'packs') {
        target = mode === 'readonly' ? restoreMetrics.stagingReads : restoreMetrics.stagingWrites;
    } else if (this.name === 'RPHubSyncCache' && mode === 'readwrite'
        && scope.length === 1 && scope[0] === 'packs') {
        target = restoreMetrics.cachePackWrites;
    }
    if (target) {
        const record = { count: 0 };
        target.push(record);
        measuredTransactions.set(tx, record);
    }
    return tx;
};
const nativeRestoreGet = FDBObjectStore.prototype.get;
FDBObjectStore.prototype.get = function (...args) {
    const record = measuredTransactions.get(this.transaction);
    if (record) record.count += 1;
    return nativeRestoreGet.apply(this, args);
};
const nativeRestorePut = FDBObjectStore.prototype.put;
FDBObjectStore.prototype.put = function (...args) {
    const record = measuredTransactions.get(this.transaction);
    if (record) record.count += 1;
    return nativeRestorePut.apply(this, args);
};
const restoreFetch = async (input, init) => {
    const action = new URL(typeof input === 'string' ? input : input.url, 'https://local.test').searchParams.get('action') || kindOf(init);
    const counted = action === 'pull-manifest-page' || action === 'pull-pack';
    if (counted) {
        restoreMetrics.pullRequests += 1;
        restoreMetrics.pullInflight += 1;
        restoreMetrics.maxPullInflight = Math.max(restoreMetrics.maxPullInflight, restoreMetrics.pullInflight);
    }
    try {
        return await fetchShim(input, init);
    } finally {
        if (counted) restoreMetrics.pullInflight -= 1;
    }
};
installBrowserGlobals({
    storageClass: RestoreStorage,
    localStorage: restoreStorage,
    factory: restoreFactory,
    document: restoreDocument,
    location: restoreLocation,
    fetchShim: restoreFetch,
    locks: restoreLocks
});
delete globalThis.RPH_SYNC_UPLOAD_ENGINE;
delete globalThis.RPH_SYNC_PERSISTENCE;
await runScripts(['DB/dirty-tracker.js', 'DB/bootstrap.js']);
const restoreModal = restoreDocument.body.children[0];
const restoreStartedAt = Date.now();
await new Promise((resolve, reject) => {
    const timer = setInterval(() => {
        const status = restoreModal.querySelector('.rp-sync-modal__status').textContent;
        if (restoreModal.classList.contains('is-error')) {
            clearInterval(timer);
            reject(new Error(`scale restore failed: ${status}`));
        } else if (restoreLocation.replaced) {
            clearInterval(timer);
            resolve();
        } else if (Date.now() - restoreStartedAt > 20 * 60_000) {
            clearInterval(timer);
            reject(new Error(`scale restore timed out: ${status}`));
        }
    }, 250);
});
const restoreDurationMs = Date.now() - restoreStartedAt;
const stagingReads = restoreMetrics.stagingReads.filter(batch => batch.count > 0);
const stagingWrites = restoreMetrics.stagingWrites.filter(batch => batch.count > 0);
assert.equal(restoreMetrics.parses, restoreManifest.entryCount * 2,
    'scale restore must parse each snapshot entry exactly twice');
assert.equal(stagingReads.reduce((sum, batch) => sum + batch.count, 0), restoreManifest.packCount,
    'scale restore must read each staged pack once');
assert.equal(stagingReads.length, Math.ceil(restoreManifest.packCount / 4),
    'scale restore staging reads must be batched by four');
assert.equal(stagingWrites.length, Math.ceil(restoreManifest.packCount / 4),
    'scale restore staging writes must be batched by four');
assert.equal(restoreMetrics.cachePackWrites.length, Math.ceil(restoreManifest.packCount / 4),
    'scale restore cache pack writes must be batched by four');
assert.equal(restoreMetrics.pullRequests, restoreManifest.pageCount + restoreManifest.packCount,
    'scale restore must request each manifest page and pack exactly once');
assert.ok(restoreMetrics.maxPullInflight <= 4,
    `scale restore pull concurrency must stay at four, observed ${restoreMetrics.maxPullInflight}`);
assert.ok(restorePacks.length === restoreManifest.packCount);
const restoredSettings = await idbGet(restoreFactory, 'RPHubDB', 'store', 'settings');
const restoredTail = await idbGet(restoreFactory, 'RPHubDB', 'store', recordKey(RECORD_COUNT + 9));
assert.deepEqual(restoredSettings, { theme: 'dark', nested: { a: 1, b: [1, 2, 3] } },
    'scale restore must preserve structured records');
assert.equal(restoredTail?.tags?.[0], 'inserted-scale',
    'scale restore must include the last inserted incremental record');
assert.equal(restoreStorage.getItem('rp_hub_settings'), 'v2-scale',
    'scale restore must apply the final localStorage value');
JSON.parse = nativeJsonParse;
console.log(`  restore: ${(restoreManifest.totalBytes / 1024 ** 3).toFixed(3)} GiB, ${restoreManifest.packCount} packs, ${restoreManifest.entryCount} entries`);
console.log(`  client: ${restoreMetrics.pullRequests} pull requests, max ${restoreMetrics.maxPullInflight} in flight, ${stagingReads.length} staging read transactions, ${(restoreDurationMs / 1000).toFixed(1)} s`);
console.log('phase 5 (full-scale restore): ok');

// ------------------------------------------------- summary report ----

// Diagnostic repeats for constant-size control handlers on the populated heap.
const benchmark = async (label, buildRequest, runs) => {
    const walls = [];
    if (requestGc) requestGc();
    for (let index = 0; index < runs; index += 1) {
        const init = buildRequest();
        const wallStart = process.hrtime.bigint();
        const response = await accountedFetch('/api/rp-sync', init);
        assert.equal(response.status, 200, `${label} benchmark request must succeed`);
        walls.push(Number(process.hrtime.bigint() - wallStart) / 1e6);
    }
    walls.sort((a, b) => a - b);
    const p50 = walls[Math.floor(runs / 2)];
    const p95 = walls[Math.max(0, Math.ceil(runs * 0.95) - 1)];
    const max = walls[walls.length - 1];
    console.log(`  [bench] ${label}: wall p50 ${p50.toFixed(2)} / p95 ${p95.toFixed(2)} / max ${max.toFixed(2)} ms over ${runs} runs (host diagnostic)`);
};
const manifestFinal = await readManifestDirect();
console.log('');
console.log('=== populated-heap handler diagnostics (20 runs each) ===');
const jsonRequest = body => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
});
await benchmark('prepare-upload', () => jsonRequest({
    action: 'prepare-upload', schemaVersion: 13
}), 20);
await benchmark('begin-upload (already committed)', () => jsonRequest({
    action: 'begin-upload',
    schemaVersion: 13,
    snapshotFormat: manifestFinal.snapshotFormat,
    baseVersion: manifestFinal.version,
    baseChecksum: manifestFinal.checksum,
    checksum: manifestFinal.checksum,
    bloomChecksum: manifestFinal.bloomChecksum,
    packCount: manifestFinal.packCount,
    entryCount: manifestFinal.entryCount,
    totalBytes: manifestFinal.totalBytes,
    pageCount: manifestFinal.pageCount,
    pageRoot: manifestFinal.pageRoot
}), 20);
await benchmark('finalize-upload (idempotent)', () => jsonRequest({
    action: 'finalize-upload', uploadId: manifestFinal.checksum
}), 20);
if (manifestFinal.pageCount > 0) {
    await benchmark('pull-manifest-page', () => jsonRequest({
        action: 'pull-manifest-page',
        schemaVersion: 13,
        version: manifestFinal.version,
        pageIndex: 0
    }), 20);
}

const totalRequests = accountings.length;
const totalClassA = accountings.reduce((t, e) => t + e.classA, 0);
const totalClassB = accountings.reduce((t, e) => t + e.classB, 0);
const maxWall = Math.max(...accountings.map(e => e.wallMs));
const maxSubrequests = Math.max(...accountings.map(e => e.subrequests));
const packWalls = accountings.filter(e => e.kind === 'upload-pack').map(e => e.wallMs).sort((a, b) => a - b);
const avgPackWall = packWalls.reduce((t, v) => t + v, 0) / (packWalls.length || 1);
const p95PackWall = packWalls[Math.max(0, Math.ceil(packWalls.length * 0.95) - 1)] ?? 0;
console.log('');
console.log('=== free-plan budget summary ===');
console.log(`requests: ${totalRequests} / 100k per day (${(totalRequests / LIMITS.requestsPerDay * 100).toFixed(3)}%)`);
console.log(`R2 class A ops: ${totalClassA} / 1M per month (${(totalClassA / LIMITS.r2ClassAMonthly * 100).toFixed(3)}%)`);
console.log(`R2 class B ops: ${totalClassB} / 10M per month (${(totalClassB / LIMITS.r2ClassBMonthly * 100).toFixed(4)}%)`);
console.log(`max per-request wall (host diagnostic): ${maxWall.toFixed(2)} ms`);
console.log(`upload-pack wall avg/p95: ${avgPackWall.toFixed(2)} / ${p95PackWall.toFixed(2)} ms`);
console.log(`max per-request subrequests: ${maxSubrequests} / 50`);
console.log(`max client in-flight: ${maxClientInflight} / 6 connections`);
console.log(`max in-flight R2 put bytes: ${(bucket.stats.maxInflightPutBytes / 1024).toFixed(0)} KiB (worker streaming bound)`);
console.log(`max R2 object size: ${(bucket.stats.maxObjectBytes / 1024).toFixed(0)} KiB`);
console.log(`uploaded client->worker bytes: ${(totalUploadedBytes / 1024 ** 3).toFixed(3)} GiB`);
console.log('scale-sim: ok');

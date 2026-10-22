// fake-indexeddb + 浏览器全局的共享测试环境。
import path from 'node:path';
import vm from 'node:vm';

const FDB_CLASS_NAMES = [
    'FDBFactory', 'FDBDatabase', 'FDBObjectStore', 'FDBTransaction', 'FDBIndex',
    'FDBRequest', 'FDBOpenDBRequest', 'FDBVersionChangeEvent', 'FDBKeyRange',
    'FDBCursor', 'FDBCursorWithValue'
];

export async function loadFdbClasses() {
    const fdb = {};
    for (const name of FDB_CLASS_NAMES) {
        const mod = await import(`fake-indexeddb/lib/${name}`);
        fdb[name] = mod.default ?? mod[name];
    }
    return fdb;
}

export function makeStorageClass() {
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

export function createDomElement(tag) {
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
        dispatch(type, event) { for (const handler of listeners[type] || []) handler(event); },
        remove() {
            const parent = element.parentElement;
            if (parent) parent.children = parent.children.filter(child => child !== element);
            element.parentElement = null;
        },
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

export function createDocumentStub() {
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

// 开屏访问门禁的锁页节点可能还挂在 body 上（异步解锁移除前），按类名定位
// 同步面板而不是依赖 children[0] 的顺序。
export function findSyncModal(documentStub) {
    return documentStub.body.children.find(child => String(child.className || '').includes('rp-sync-modal')) || null;
}

export const setGlobal = (name, value) => {
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
};

export function installBrowserGlobals(fdb, { storageClass, localStorage, factory, document, location, fetchShim, locks = null }) {
    const globals = {
        indexedDB: factory,
        // dirty-tracker 把 open/deleteDatabase 补丁打在 IDBFactory.prototype
        // 上（WebKit 会重建 indexedDB 实例，实例级补丁会静默丢失），测试
        // 环境必须提供与 factory 实例同一原型的构造器才等价于浏览器。
        IDBFactory: fdb.FDBFactory,
        IDBKeyRange: fdb.FDBKeyRange,
        IDBDatabase: fdb.FDBDatabase,
        IDBObjectStore: fdb.FDBObjectStore,
        IDBTransaction: fdb.FDBTransaction,
        IDBIndex: fdb.FDBIndex,
        IDBCursor: fdb.FDBCursor,
        IDBCursorWithValue: fdb.FDBCursorWithValue,
        IDBRequest: fdb.FDBRequest,
        IDBOpenDBRequest: fdb.FDBOpenDBRequest,
        IDBVersionChangeEvent: fdb.FDBVersionChangeEvent,
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

export function createPrototypePatcher(members) {
    return {
        snapshot: () => members.map(([proto, name]) => ({
            proto,
            name,
            descriptor: Object.getOwnPropertyDescriptor(proto, name)
        })),
        restore: snapshot => {
            for (const { proto, name, descriptor } of snapshot) {
                if (descriptor) Object.defineProperty(proto, name, descriptor);
                else delete proto[name];
            }
        }
    };
}

export function createScriptRunner({ root, read }) {
    return async names => {
        for (const name of names) {
            vm.runInThisContext(await read(name), { filename: path.join(root, name) });
        }
    };
}

export async function waitFor(getResult, timeoutMs, label) {
    const startedAt = Date.now();
    for (;;) {
        const value = getResult();
        if (value) return value;
        if (Date.now() - startedAt > timeoutMs) throw new Error(`timeout waiting for ${label}`);
        await new Promise(resolve => setTimeout(resolve, 50));
    }
}

export function idbOpen(factory, dbName, version, stores) {
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

export async function idbPut(factory, dbName, storeName, key, value) {
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

export async function idbGetAll(factory, dbName, storeName) {
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

export async function idbBulkPut(factory, dbName, storeName, records) {
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
    } finally {
        db.close();
    }
}

export async function idbGet(factory, dbName, storeName, key) {
    const db = await idbOpen(factory, dbName, undefined, [storeName]);
    try {
        const tx = db.transaction(storeName, 'readonly');
        const request = tx.objectStore(storeName).get(key);
        return await new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve(request.result);
            tx.onerror = () => reject(tx.error);
        });
    } finally {
        db.close();
    }
}

// Incremental-phase writes must go through this entry: after bootstrap.js
// loads, factory.open is the dirty-tracker facade, so these writes land in
// the change journal and get picked up by the next push.
export async function writeTransaction(name, store, action) {
    const db = await idbOpen(globalThis.indexedDB, name, 1, [store]);
    try {
        await new Promise((resolve, reject) => {
            const tx = db.transaction(store, 'readwrite');
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
            action(tx.objectStore(store), tx);
        });
    } finally {
        db.close();
    }
}

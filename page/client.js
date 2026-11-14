// 事务日志与恢复写屏障；先于作者脚本安装。
(function () {
    'use strict';
    if (globalThis.RPClient) return;
    const C = RPCore, K = C.KEYS;
    const restorePage = document.documentElement.hasAttribute('data-rp-sync-restore') || location.pathname === '/sync-restore';
    const native = {
        open: IDBFactory.prototype.open, transaction: IDBDatabase.prototype.transaction,
        put: IDBObjectStore.prototype.put, add: IDBObjectStore.prototype.add, delete: IDBObjectStore.prototype.delete,
        clear: IDBObjectStore.prototype.clear, update: IDBCursor.prototype.update, cursorDelete: IDBCursor.prototype.delete,
        set: Storage.prototype.setItem, remove: Storage.prototype.removeItem, clearStorage: Storage.prototype.clear
    };
    const pending = new Set();
    const initialEpoch = localStorage.getItem(K.restoreEpoch);
    const notify = () => window.dispatchEvent(new CustomEvent('rphub:dirty'));
    const blocked = () => !restorePage && (localStorage.getItem(K.active) || localStorage.getItem(K.restoreEpoch) !== initialEpoch);
    function writable() { if (blocked()) throw new DOMException('云端恢复期间暂停写入。', 'InvalidStateError'); }
    function txDone(tx, value = () => undefined) {
        return new Promise((resolve, reject) => {
            tx.addEventListener('complete', () => { try { resolve(value()); } catch (e) { reject(e); } }, { once: true });
            tx.addEventListener('abort', () => reject(tx.error || new Error('存储事务中止。')), { once: true });
        });
    }
    function open(name, upgrade, version) {
        return new Promise((resolve, reject) => {
            const r = version === undefined ? indexedDB.open(name) : indexedDB.open(name, version);
            r.onupgradeneeded = () => upgrade?.(r.result, r.transaction);
            r.onerror = () => reject(r.error);
            r.onsuccess = () => resolve(r.result);
        });
    }
    IDBFactory.prototype.open = function (name, version) {
        if (!C.STORES[name]) return native.open.apply(this, arguments);
        if (version !== undefined && (!Number.isSafeInteger(version) || version < 1)) return native.open.apply(this, arguments);
        const facade = new EventTarget(), factory = this;
        let current, result, error = null, done = false;
        Object.defineProperties(facade, {
            result: { get: () => result === undefined ? current.result : result }, error: { get: () => error },
            transaction: { get: () => current?.transaction || null }, readyState: { get: () => done ? 'done' : 'pending' }, source: { value: null }
        });
        for (const type of ['success', 'error', 'upgradeneeded', 'blocked']) {
            let fn;
            Object.defineProperty(facade, 'on' + type, { get: () => fn, set(next) { if (fn) facade.removeEventListener(type, fn); fn = typeof next === 'function' ? next : null; if (fn) facade.addEventListener(type, fn); } });
        }
        const emit = (type, source) => {
            const event = new Event(type, { cancelable: type === 'error' });
            if (source && 'oldVersion' in source) Object.defineProperties(event, { oldVersion: { value: source.oldVersion }, newVersion: { value: source.newVersion } });
            facade.dispatchEvent(event);
            if (event.defaultPrevented) source?.preventDefault();
        };
        const connect = requested => {
            current = requested === undefined ? native.open.call(factory, name) : native.open.call(factory, name, requested);
            current.onblocked = e => emit('blocked', e);
            current.onerror = e => { error = current.error; done = true; emit('error', e); };
            current.onupgradeneeded = e => {
                const db = current.result;
                if (!db.objectStoreNames.contains(K.journal)) { const log = db.createObjectStore(K.journal, { autoIncrement: true }); native.put.call(log, crypto.randomUUID(), '__epoch__'); }
                emit('upgradeneeded', e);
            };
            current.onsuccess = e => {
                const db = current.result;
                if (!db.objectStoreNames.contains(K.journal) || version > db.version) { const next = Math.max(db.version + 1, version || 1); db.close(); connect(next); return; }
                db.addEventListener('versionchange', () => db.close());
                result = db; done = true; emit('success', e);
            };
        };
        connect();
        return facade;
    };
    IDBDatabase.prototype.transaction = function (names, mode, options) {
        if (mode !== 'readwrite') return native.transaction.call(this, names, mode, options);
        const scope = typeof names === 'string' ? [names] : Array.from(names);
        const tracked = C.STORES[this.name]?.some(name => scope.includes(name));
        if (tracked) {
            writable();
            if (!this.objectStoreNames.contains(K.journal)) throw new DOMException('变更日志未就绪，请刷新。', 'InvalidStateError');
            if (!scope.includes(K.journal)) scope.push(K.journal);
        }
        const tx = native.transaction.call(this, scope, mode, options);
        if (tracked) {
            const p = txDone(tx).catch(() => {});
            pending.add(p);
            p.then(() => { pending.delete(p); notify(); });
        }
        return tx;
    };
    const tracked = store => !restorePage && C.STORES[store.transaction.db.name]?.includes(store.name);
    const log = (store, data) => {
        if (C.excluded(store.transaction.db.name, store.name, data.key)) return;
        try { native.add.call(store.transaction.objectStore(K.journal), { store: store.name, ...data }); }
        catch (e) { store.transaction.abort(); throw e; }
    };
    for (const name of ['put', 'add', 'delete', 'clear']) IDBObjectStore.prototype[name] = function (...args) {
        if (!tracked(this)) return native[name].apply(this, args);
        writable();
        if (name === 'delete' && args[0] instanceof IDBKeyRange) {
            const keys = this.getAllKeys(args[0]);
            keys.addEventListener('success', () => keys.result.forEach(key => log(this, { key })));
        }
        const r = native[name].apply(this, args);
        if (!(name === 'delete' && args[0] instanceof IDBKeyRange)) r.addEventListener('success', () => log(this, name === 'clear' ? { clear: true } : { key: name === 'delete' ? args[0] : r.result }));
        return r;
    };
    for (const [method, original] of [['update', native.update], ['delete', native.cursorDelete]]) IDBCursor.prototype[method] = function (...args) {
        const store = this.source.objectStore || this.source;
        if (!tracked(store)) return original.apply(this, args);
        writable();
        const key = this.primaryKey, r = original.apply(this, args);
        r.addEventListener('success', () => log(store, { key }));
        return r;
    };
    const commit = IDBTransaction.prototype.commit;
    if (commit) IDBTransaction.prototype.commit = function () {
        if (!restorePage && C.STORES[this.db.name] && this.objectStoreNames.contains(K.journal)) throw new DOMException('受追踪事务使用自动提交。', 'InvalidStateError');
        return commit.call(this);
    };
    function intent(key) { native.set.call(localStorage, K.intent + crypto.randomUUID(), key); }
    Storage.prototype.setItem = function (key, value) {
        key = String(key); value = String(value);
        if (this.getItem(key) === value) return;
        if (this === localStorage && C.appKey(key) && !restorePage) { writable(); intent(key); }
        native.set.call(this, key, value);
        if (this === localStorage && C.appKey(key)) notify();
    };
    Storage.prototype.removeItem = function (key) {
        key = String(key);
        if (this.getItem(key) === null) return;
        if (this === localStorage && C.appKey(key) && !restorePage) { writable(); intent(key); }
        native.remove.call(this, key);
        if (this === localStorage && C.appKey(key)) notify();
    };
    Storage.prototype.clear = function () {
        if (this !== localStorage || restorePage) return native.clearStorage.call(this);
        writable();
        const keys = Object.keys(this);
        for (const key of keys) if (C.appKey(key)) intent(key);
        for (const key of keys) if (!key.startsWith('rp_sync_')) native.remove.call(this, key);
        notify();
    };
    async function names() {
        if (typeof indexedDB.databases !== 'function') return Object.keys(C.STORES);
        const all = await indexedDB.databases();
        return Object.keys(C.STORES).filter(name => all.some(db => db.name === name));
    }
    async function dirty(after = {}, expectedEpochs = {}) {
        const result = { databases: {}, epochs: {}, stores: new Map(), intents: [], local: new Set() };
        for (const key of Object.keys(localStorage)) if (key.startsWith(K.intent)) { result.intents.push(key); result.local.add(localStorage.getItem(key)); }
        for (const name of await names()) {
            const db = await open(name);
            try {
                const tx = db.transaction(K.journal, 'readonly'), store = tx.objectStore(K.journal);
                const epoch = store.get('__epoch__');
                const r = store.openCursor(after[name] === undefined ? IDBKeyRange.upperBound(Infinity) : IDBKeyRange.bound(after[name], Infinity, true));
                r.onsuccess = () => {
                    const cur = r.result;
                    if (!cur) return;
                    result.databases[name] = cur.key;
                    const id = name + '/' + cur.value.store;
                    if (!result.stores.has(id)) result.stores.set(id, { clear: false, keys: new Map() });
                    const item = result.stores.get(id);
                    if (cur.value.clear) { item.clear = true; item.keys.clear(); }
                    else item.keys.set(JSON.stringify(cur.value.key), cur.value.key);
                    cur.continue();
                };
                await txDone(tx, () => { result.epochs[name] = epoch.result; });
            } finally { db.close(); }
        }
        return result;
    }
    async function acknowledge(mark) {
        for (const [name, sequence] of Object.entries(mark.databases || {})) {
            const db = await open(name);
            try { const tx = native.transaction.call(db, K.journal, 'readwrite'); native.delete.call(tx.objectStore(K.journal), IDBKeyRange.upperBound(sequence)); await txDone(tx); }
            finally { db.close(); }
        }
        for (const key of mark.intents || []) native.remove.call(localStorage, key);
    }
    async function flush() { while (pending.size) await Promise.all([...pending]); }
    function pauseOverlay() {
        if (restorePage || !blocked() || !document.body || document.getElementById('rp-restore-pause')) return;
        const el = document.createElement('div'); el.id = 'rp-restore-pause';
        el.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#f8fafcf5;display:grid;place-content:center;text-align:center;font:16px sans-serif';
        const text = document.createElement('p'); text.textContent = '正在恢复云端数据。';
        const link = document.createElement('a'); link.href = '/sync-restore'; link.textContent = '继续恢复';
        el.append(text, link); document.body.append(el);
    }
    function checkRestore() {
        if (restorePage) return;
        if (localStorage.getItem(K.active)) pauseOverlay();
        else if (localStorage.getItem(K.restoreEpoch) !== initialEpoch) location.reload();
    }
    window.addEventListener('storage', checkRestore);
    window.addEventListener('pageshow', checkRestore);
    window.addEventListener('focus', checkRestore);
    document.addEventListener('DOMContentLoaded', checkRestore, { once: true });
    if (!localStorage.getItem(K.epoch)) native.set.call(localStorage, K.epoch, crypto.randomUUID());
    globalThis.RPClient = Object.freeze({ C, native, restorePage, txDone, open, names, dirty, acknowledge, flush, writable });
    globalThis.RPH_SYNC_TRACKER = Object.freeze({ flush, acknowledge });
})();

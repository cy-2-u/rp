(function () {
    if (window.__RPH_SYNC_DIRTY_TRACKING__) return;
    window.__RPH_SYNC_DIRTY_TRACKING__ = true;

    // ---- 跨文件协议常量（人肉双写）----
    // 本块与 DB/bootstrap.js 的同名常量是同一份协议的两份副本（纯静态
    // 文件没有构建注入）。任何一侧改名必须双侧同步，否则脏追踪与同步面板
    // 会静默失去共同语言（journal 对不上、恢复暂停标记失联）；
    // audit-regressions.mjs 的静态断言会抓住两侧不一致。
    const JOURNAL = '__rp_sync_journal_v2';
    const STORAGE_INTENT_PREFIX = 'rp_sync_intent_v2:';
    const TRACKING_EPOCH_KEY = 'rp_sync_tracking_epoch_v2';
    // 恢复页判定与 bootstrap.js 的 RESTORE_PAGE 是同一判定的两份副本，
    // 语义改动须双侧同步。
    const RESTORE_PAGE = Boolean(
        document.documentElement?.hasAttribute?.('data-rp-sync-restore')
        || location.pathname === '/sync-restore'
    );
    const KNOWN_STORES = { RPHubDB: ['store'], AICharGen: ['characters'] };
    const RESTORE_ACTIVE_KEY = 'rp_sync_restore_active';
    const RESTORE_EPOCH_KEY = 'rp_sync_restore_epoch';
    const initialRestoreEpoch = localStorage.getItem(RESTORE_EPOCH_KEY);
    let restorePaused = Boolean(localStorage.getItem(RESTORE_ACTIVE_KEY));
    const isAppKey = key => key.startsWith('rp_hub_') || key.startsWith('ai_chargen_');

    const showRestorePause = () => {
        if (!document.body || document.getElementById('rp-sync-restore-pause')) return;
        const overlay = document.createElement('div');
        overlay.id = 'rp-sync-restore-pause';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:grid;place-content:center;text-align:center;padding:24px;background:#f8fafcf2;color:#334155;font:16px/1.8 sans-serif';
        overlay.textContent = '正在从云端恢复，完成后此页面会自动刷新。';
        document.body.appendChild(overlay);
    };
    const assertWritable = () => {
        if (localStorage.getItem(RESTORE_ACTIVE_KEY)
            || localStorage.getItem(RESTORE_EPOCH_KEY) !== initialRestoreEpoch) restorePaused = true;
        if (!restorePaused) return;
        showRestorePause();
        throw new DOMException('云端恢复期间暂停本页面写入。', 'InvalidStateError');
    };
    const checkRestoreState = () => {
        if (localStorage.getItem(RESTORE_ACTIVE_KEY)) {
            restorePaused = true;
            showRestorePause();
        } else if (restorePaused || localStorage.getItem(RESTORE_EPOCH_KEY) !== initialRestoreEpoch) {
            location.reload();
        }
    };
    const checkInterruptedRestore = async () => {
        checkRestoreState();
        const active = localStorage.getItem(RESTORE_ACTIVE_KEY);
        if (!active || !navigator.locks?.query) return;
        const locks = await navigator.locks.query();
        // 裸字符串比较 bootstrap.js CONFIG.lockName 持有的同一把锁，
        // 改必须与 bootstrap 双侧同步。
        if (localStorage.getItem(RESTORE_ACTIVE_KEY) !== active
            || locks.held.some(lock => lock.name === 'rp-hub-r2-sync-v1')) return;
        showRestorePause();
        const overlay = document.getElementById('rp-sync-restore-pause');
        if (overlay) overlay.innerHTML = '上次恢复已中断，请重新从云端恢复。<a href="/sync-restore" style="color:#2563eb">重新恢复</a>';
    };
    window.addEventListener('storage', event => {
        if (event.key === RESTORE_ACTIVE_KEY || event.key === RESTORE_EPOCH_KEY) checkRestoreState();
    });
    window.addEventListener('pageshow', checkInterruptedRestore);
    window.addEventListener('focus', checkInterruptedRestore);
    document.addEventListener('DOMContentLoaded', checkInterruptedRestore, { once: true });
    // Patch the factory prototype, not one window.indexedDB instance. WebKit
    // can recreate that instance after reconnecting to its database process;
    // an instance-only patch would then disappear while transaction tracking
    // remained installed, leaving new connections without a journal.
    const factoryPrototype = IDBFactory.prototype;
    const nativeOpen = factoryPrototype.open;
    const storageSetItem = Storage.prototype.setItem;
    const storageRemoveItem = Storage.prototype.removeItem;
    const storageClear = Storage.prototype.clear;
    const nativeTransaction = IDBDatabase.prototype.transaction;
    const nativePut = IDBObjectStore.prototype.put;
    const nativeAdd = IDBObjectStore.prototype.add;
    const nativeDelete = IDBObjectStore.prototype.delete;
    const nativeClear = IDBObjectStore.prototype.clear;
    const nativeCursorUpdate = IDBCursor.prototype.update;
    const nativeCursorDelete = IDBCursor.prototype.delete;
    const pendingWrites = new Set();
    let journalFailure = null;
    const trackingEpoch = localStorage.getItem(TRACKING_EPOCH_KEY) || crypto.randomUUID();
    storageSetItem.call(localStorage, TRACKING_EPOCH_KEY, trackingEpoch);

    // Return request events only after the journal store exists. Old explicit
    // author versions remain usable after our internal-only schema upgrade.
    factoryPrototype.open = function (name, version) {
        if (!KNOWN_STORES[name]) return nativeOpen.apply(this, arguments);
        if (version !== undefined && (!Number.isSafeInteger(version) || version < 1)) {
            return nativeOpen.apply(this, arguments);
        }
        const factory = this;
        const facade = new EventTarget();
        let current;
        let result;
        let failure = null;
        let done = false;
        Object.defineProperties(facade, {
            result: { get: () => result === undefined ? current.result : result },
            error: { get: () => failure },
            transaction: { get: () => current?.transaction || null },
            readyState: { get: () => done ? 'done' : 'pending' },
            source: { value: null }
        });
        for (const type of ['success', 'error', 'upgradeneeded', 'blocked']) {
            let handler = null;
            Object.defineProperty(facade, `on${type}`, {
                get: () => handler,
                set(value) {
                    if (handler) facade.removeEventListener(type, handler);
                    handler = typeof value === 'function' ? value : null;
                    if (handler) facade.addEventListener(type, handler);
                }
            });
        }
        const emit = (type, event) => {
            const forwarded = new Event(type, { cancelable: type === 'error' });
            if (event && 'oldVersion' in event) {
                Object.defineProperties(forwarded, {
                    oldVersion: { value: event.oldVersion }, newVersion: { value: event.newVersion }
                });
            }
            facade.dispatchEvent(forwarded);
        };
        const connect = requestedVersion => {
            current = requestedVersion === undefined
                ? nativeOpen.call(factory, name) : nativeOpen.call(factory, name, requestedVersion);
            current.onblocked = event => emit('blocked', event);
            current.onerror = event => {
                failure = current.error;
                done = true;
                emit('error', event);
            };
            current.onupgradeneeded = event => {
                const db = current.result;
                if (!db.objectStoreNames.contains(JOURNAL)) {
                    const journal = db.createObjectStore(JOURNAL, { autoIncrement: true });
                    nativePut.call(journal, crypto.randomUUID(), '__epoch__');
                }
                emit('upgradeneeded', event);
            };
            current.onsuccess = event => {
                const db = current.result;
                if (!db.objectStoreNames.contains(JOURNAL) || (version && version > db.version)) {
                    const next = Math.max(db.version + (db.objectStoreNames.contains(JOURNAL) ? 0 : 1), version || 1);
                    db.close();
                    connect(next);
                    return;
                }
                db.addEventListener('versionchange', () => db.close());
                result = db;
                done = true;
                emit('success', event);
            };
        };
        connect();
        return facade;
    };

    const isTracked = store => KNOWN_STORES[store?.transaction?.db?.name]?.includes(store.name);
    const excluded = (store, key) => store.transaction.db.name === 'RPHubDB'
        && store.name === 'store' && key === 'rp_hub_presets';
    IDBDatabase.prototype.transaction = function (names, mode, options) {
        // 只读事务与写追踪无关：直接透传，省掉 scope 复制与查找。
        if (mode !== 'readwrite') return nativeTransaction.call(this, names, mode, options);
        const scope = typeof names === 'string' ? [names] : Array.from(names);
        if (KNOWN_STORES[this.name]?.some(name => scope.includes(name))) {
            if (!RESTORE_PAGE) assertWritable();
            if (!this.objectStoreNames.contains(JOURNAL)) {
                throw new DOMException('数据库变更日志尚未初始化，请刷新页面。', 'InvalidStateError');
            }
            if (!scope.includes(JOURNAL)) scope.push(JOURNAL);
        }
        const tx = nativeTransaction.call(this, scope, mode, options);
        // mode 恒为 readwrite（只读事务已在函数开头透传返回）；
        // 只有 scope 实际含 journal 时才需要完成/中止守卫。
        if (scope.includes(JOURNAL)) {
            const pending = new Promise(resolve => {
                tx.addEventListener('complete', resolve, { once: true });
                tx.addEventListener('abort', resolve, { once: true });
            });
            pendingWrites.add(pending);
            pending.then(() => pendingWrites.delete(pending));
        }
        return tx;
    };
    // 调用方已确认 store 受追踪且非恢复页；这里只做排除规则与落日志。
    const log = (store, event) => {
        if (excluded(store, event.key)) return;
        try {
            const request = nativeAdd.call(store.transaction.objectStore(JOURNAL), { store: store.name, ...event });
            request.addEventListener('error', () => { journalFailure = request.error; });
        } catch (error) {
            journalFailure = error;
            try { store.transaction.abort(); } catch (_) { }
            throw error;
        }
    };
    for (const [name, native] of [['put', nativePut], ['add', nativeAdd]]) {
        IDBObjectStore.prototype[name] = function (...args) {
            if (RESTORE_PAGE || !isTracked(this)) return native.apply(this, args);
            assertWritable();
            const request = native.apply(this, args);
            request.addEventListener('success', () => log(this, { key: request.result }));
            return request;
        };
    }
    IDBObjectStore.prototype.delete = function (key) {
        if (RESTORE_PAGE || !isTracked(this)) return nativeDelete.call(this, key);
        assertWritable();
        if (key instanceof IDBKeyRange) {
            const request = this.getAllKeys(key);
            request.addEventListener('success', () => {
                for (const candidate of request.result) log(this, { key: candidate });
            });
            return nativeDelete.call(this, key);
        }
        const request = nativeDelete.call(this, key);
        request.addEventListener('success', () => log(this, { key }));
        return request;
    };
    IDBObjectStore.prototype.clear = function () {
        if (RESTORE_PAGE || !isTracked(this)) return nativeClear.call(this);
        assertWritable();
        const request = nativeClear.call(this);
        request.addEventListener('success', () => log(this, { clear: true }));
        return request;
    };
    IDBCursor.prototype.update = function (value) {
        const store = this.source.objectStore || this.source;
        if (RESTORE_PAGE || !isTracked(store)) return nativeCursorUpdate.call(this, value);
        assertWritable();
        const request = nativeCursorUpdate.call(this, value);
        request.addEventListener('success', () => log(store, { key: this.primaryKey }));
        return request;
    };
    IDBCursor.prototype.delete = function () {
        const store = this.source.objectStore || this.source;
        if (RESTORE_PAGE || !isTracked(store)) return nativeCursorDelete.call(this);
        assertWritable();
        const request = nativeCursorDelete.call(this);
        request.addEventListener('success', () => log(store, { key: this.primaryKey }));
        return request;
    };

    const shouldTrackKey = key => isAppKey(key) && !key.startsWith('rp_hub_sync_');
    const storageWrite = (storage, key, operation) => {
        if (storage !== localStorage || !shouldTrackKey(key) || RESTORE_PAGE) return operation();
        assertWritable();
        const intent = `${STORAGE_INTENT_PREFIX}${crypto.randomUUID()}`;
        // Each write owns its intent key; different tabs never overwrite a shared
        // read-modify-write index. An interrupted write is a harmless candidate.
        storageSetItem.call(storage, intent, key);
        return operation();
    };
    Storage.prototype.setItem = function (key, value) {
        key = String(key);
        value = String(value);
        if (this.getItem(key) === value) return;
        return storageWrite(this, key, () => storageSetItem.call(this, key, value));
    };
    Storage.prototype.removeItem = function (key) {
        key = String(key);
        if (this.getItem(key) === null) return;
        return storageWrite(this, key, () => storageRemoveItem.call(this, key));
    };
    Storage.prototype.clear = function () {
        if (this !== localStorage || RESTORE_PAGE) return storageClear.call(this);
        assertWritable();
        const keys = Array.from({ length: this.length }, (_, index) => this.key(index));
        for (const key of keys) if (shouldTrackKey(key)) {
            storageSetItem.call(this, `${STORAGE_INTENT_PREFIX}${crypto.randomUUID()}`, key);
        }
        for (const key of keys) {
            if (!key.startsWith('rp_sync_')) storageRemoveItem.call(this, key);
        }
    };
    const nativeDeleteDatabase = factoryPrototype.deleteDatabase;
    factoryPrototype.deleteDatabase = function (name) {
        if (KNOWN_STORES[name]) throw new DOMException('请使用对象存储 clear 清空业务数据，不能删除同步日志。', 'InvalidStateError');
        return nativeDeleteDatabase.apply(this, arguments);
    };
    const nativeCommit = IDBTransaction.prototype.commit;
    if (nativeCommit) IDBTransaction.prototype.commit = function () {
        if (this.objectStoreNames.contains(JOURNAL) && !RESTORE_PAGE) {
            throw new DOMException('受追踪事务使用自动提交，以便写入实际生成键的日志。', 'InvalidStateError');
        }
        return nativeCommit.call(this);
    };
    window.RPH_SYNC_TRACKER = Object.freeze({
        async flush() {
            while (pendingWrites.size) await Promise.all([...pendingWrites]);
            if (journalFailure) throw new Error(`本地变更日志写入失败：${journalFailure.message || journalFailure}`);
        },
        async acknowledge(watermark) {
            for (const [name, sequence] of Object.entries(watermark.databases || {})) {
                const db = await new Promise((resolve, reject) => {
                    const request = indexedDB.open(name);
                    request.onsuccess = () => resolve(request.result);
                    request.onerror = () => reject(request.error);
                });
                try {
                    await new Promise((resolve, reject) => {
                        const tx = nativeTransaction.call(db, JOURNAL, 'readwrite');
                        nativeDelete.call(tx.objectStore(JOURNAL), IDBKeyRange.upperBound(sequence));
                        tx.oncomplete = resolve;
                        tx.onabort = () => reject(tx.error || new Error('变更日志确认失败。'));
                    });
                } finally { db.close(); }
            }
            for (const intent of watermark.intents || []) storageRemoveItem.call(localStorage, intent);
        }
    });
})();

(function (global) {
    'use strict';

    function toAsyncIterator(source) {
        if (source && typeof source[Symbol.asyncIterator] === 'function') return source[Symbol.asyncIterator]();
        if (source && typeof source[Symbol.iterator] === 'function') {
            const iterator = source[Symbol.iterator]();
            return {
                next: async () => iterator.next(),
                return: async () => typeof iterator.return === 'function' ? iterator.return() : { done: true }
            };
        }
        throw new TypeError('上传数据源必须是可迭代对象。');
    }

    function createBatchReader(source, maxItems, maxBytes) {
        const iterator = toAsyncIterator(source);
        let pending = null;
        let ended = false;

        const readBatch = async function readBatch() {
            if (ended) return null;
            const items = [];
            let totalBytes = 0;
            while (items.length < maxItems) {
                const result = pending || await iterator.next();
                pending = null;
                if (result.done) {
                    ended = true;
                    break;
                }
                const item = result.value;
                const length = Number(item?.length);
                if (!Number.isSafeInteger(length) || length <= 0 || length > maxBytes) {
                    throw new Error('上传分片大小无效。');
                }
                if (items.length > 0 && totalBytes + length > maxBytes) {
                    pending = result;
                    break;
                }
                items.push(item);
                totalBytes += length;
                if (totalBytes === maxBytes) break;
            }
            return items.length ? { items, totalBytes } : null;
        };
        readBatch.close = async () => {
            if (ended) return;
            ended = true;
            pending = null;
            if (typeof iterator.return === 'function') await iterator.return();
        };
        return readBatch;
    }

    async function runBoundedUpload(options = {}) {
        const normalizeLimit = (value, fallback) => {
            const number = Number(value);
            return Number.isFinite(number) && number >= 1 ? Math.floor(number) : fallback;
        };
        const concurrency = normalizeLimit(options.concurrency, 1);
        const maxItems = normalizeLimit(options.maxItems, 1);
        const maxBytes = normalizeLimit(options.maxBytes, 1);
        if (typeof options.read !== 'function' || typeof options.send !== 'function') {
            throw new TypeError('上传引擎缺少 read/send 回调。');
        }

        const readBatch = createBatchReader(options.items, maxItems, maxBytes);
        const active = new Set();
        let stopped = false;
        let failure = null;
        let uploadedBytes = 0;
        let uploadedItems = 0;

        const launch = batch => {
            const task = (async () => {
                const records = [];
                try {
                    for (const item of batch.items) {
                        if (failure) throw failure;
                        const value = await options.read(item);
                        if (!value || !value.bytes || !Number.isSafeInteger(value.bytes.byteLength)
                            || value.bytes.byteLength !== item.length) {
                            throw new Error('本地同步缓存不完整，请重新上传。');
                        }
                        records.push({ ...item, ...value });
                    }
                    await options.send(records);
                    uploadedBytes += batch.totalBytes;
                    uploadedItems += batch.items.length;
                    await options.onBatchSuccess?.({
                        bytes: uploadedBytes,
                        items: uploadedItems,
                        batchBytes: batch.totalBytes,
                        batchItems: batch.items.length
                    });
                } finally {
                    records.forEach(record => { record.bytes = null; });
                }
            })();
            active.add(task);
            task.then(() => active.delete(task), error => {
                active.delete(task);
                failure ||= error;
            });
        };

        try {
            while ((!stopped || active.size) && !failure) {
                while (!stopped && !failure && active.size < concurrency) {
                    const batch = await readBatch();
                    if (!batch) {
                        stopped = true;
                        break;
                    }
                    launch(batch);
                }
                if (active.size) await Promise.race(active);
            }
            if (failure) throw failure;
            return { bytes: uploadedBytes, items: uploadedItems };
        } finally {
            await Promise.allSettled([...active]);
            await readBatch.close?.();
        }
    }

    global.RPH_SYNC_UPLOAD_ENGINE = Object.freeze({
        createBatchReader,
        runBoundedUpload
    });
})(globalThis);
(function () {
    const saves = new Set();
    const debounce = (fn, delay) => {
        const state = { timer: null, args: null, running: Promise.resolve() };
        saves.add(state);
        const run = () => {
            clearTimeout(state.timer);
            state.timer = null;
            const args = state.args;
            if (!args) return state.running;
            state.args = null;
            state.running = state.running.catch(() => undefined).then(() => fn(...args))
                .catch(error => { state.args ||= args; throw error; });
            state.running.catch(() => undefined);
            return state.running;
        };
        state.flush = run;
        return (...args) => {
            state.args = args;
            clearTimeout(state.timer);
            state.timer = setTimeout(run, delay);
        };
    };
    window.RPH_SYNC_PERSISTENCE = {
        debounce,
        async flushDebounced() {
            for (const state of saves) await state.flush();
        },
        async manualSave() {
            if (typeof window.RPHubAuthorSaveData !== 'function') throw new Error('作者保存接口未就绪，请刷新后重试。');
            await window.RPHubAuthorSaveData();
            if (window.RPH_MAGIC_FLUSH_IMAGES) await window.RPH_MAGIC_FLUSH_IMAGES();
            await this.flushDebounced();
            await window.RPH_SYNC_TRACKER.flush();
        }
    };
})();
(function () {
    const SNAPSHOT_FORMAT = 'rp-sync-bounded-jsonl-v3';
    const SNAPSHOT_SCHEMA_VERSION = 12;
    const DOWNLOAD_STAGING_DB = 'RPHubSyncStaging';
    const DOWNLOAD_STAGING_DB_VERSION = 3;
    const DOWNLOAD_STAGING_STORE = 'packs';
    const RESTORE_PAGE = location.pathname === '/sync-restore';
    const PAGE_SCOPE = ['/', '/index.html', '/sync-restore'];
    if (!PAGE_SCOPE.includes(location.pathname)) {
        return;
    }

    // TextEncoder.encode 无内部状态，整个同步模块共享一个实例；
    // 序列化/校验和是每条记录级别的热路径，不再逐次分配编码器。
    const textEncoder = new TextEncoder();

    const CONFIG = {
        apiEndpoint: '/api/rp-sync',
        passwordStorageKey: 'rp_hub_sync_password_v1',
        lockName: 'rp-hub-r2-sync-v1',
        knownDatabases: [
            { name: 'RPHubDB', stores: ['store'] },
            { name: 'AICharGen', stores: ['characters'] }
        ],
        localStoragePrefixes: ['rp_hub_', 'ai_chargen_'],
        maxSnapshotBytes: 1024 * 1024 * 1024,
        // Keep one bounded request in flight by default on the free plan.
        // The server still accepts up to three R2 writes inside that request.
        uploadBatchConcurrency: 1,
        uploadBatchMaxPacks: 8,
        uploadBatchMaxBytes: 4 * 1024 * 1024,
        downloadPackConcurrency: 10,
        requestTimeoutMs: 60_000,
        packTransferTimeoutMs: 120_000,
        commitTimeoutMs: 120_000,
        retryCount: 3,
        retryDelayMs: 600,
        readBatchSize: 256,
        // Full-scan batches: one author record can be an entire conversation,
        // so batches stop before pulling in a record that would exceed either limit.
        scanBatchRecords: 64,
        scanBatchBytes: 8 * 1024 * 1024,
        restoreBatchSize: 64,
        targetPackBytes: 512 * 1024,
        maxPackCount: 8192,
        maxManifestBytes: 2 * 1024 * 1024,
        cacheWriteBytes: 1024 * 1024,
        maxPackEntries: 256,
        yieldIntervalMs: 12
    };

    const LOCAL_CACHE_DB = 'RPHubSyncCache';
    const LOCAL_CACHE_DB_VERSION = 3;
    const LOCAL_CACHE_ENTRY_STORE = 'entries';
    const LOCAL_CACHE_STATE_STORE = 'state';
    const LOCAL_CACHE_PACK_STORE = 'packs';
    const JOURNAL_STORE = '__rp_sync_journal_v2';
    const STORAGE_INTENT_PREFIX = 'rp_sync_intent_v2:';
    const TRACKING_EPOCH_KEY = 'rp_sync_tracking_epoch_v2';
    const BASELINE_KEY = 'rp_sync_baseline_v2';
    const CACHE_STATE_KEY = 'snapshot';
    const CACHE_FORMAT_VERSION = 6;
    const RESTORE_ACTIVE_KEY = 'rp_sync_restore_active';
    const RESTORE_EPOCH_KEY = 'rp_sync_restore_epoch';
    const STABLE_BUCKET_COUNT = 32;
    const ARRAY_BUCKET_ENTRIES = 128;

    const MAX_SUPPORTED_OBJECT_BYTES = 64 * 1024 * 1024;

    const state = {
        syncing: false,
        progress: 0,
        statusText: '请选择同步方向。'
    };

    let modalRoot = null;
    let modalStatus = null;
    let modalProgressBar = null;
    let modalProgressValue = null;
    let pullButton = null;
    let pushButton = null;
    let rebuildButton = null;
    let passwordModalRoot = null;
    let passwordInput = null;
    let passwordStatus = null;
    let passwordSubmitButton = null;
    let checkingPassword = false;

    function wait(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async function readDirtyState() {
        const watermark = { databases: {}, intents: [] };
        const dirty = { localStorage: new Set(), stores: new Map(), watermark, epochs: {} };
        for (let index = 0; index < localStorage.length; index += 1) {
            const intent = localStorage.key(index);
            if (!intent?.startsWith(STORAGE_INTENT_PREFIX)) continue;
            const key = localStorage.getItem(intent);
            if (key !== null) { watermark.intents.push(intent); dirty.localStorage.add(key); }
        }
        for (const name of await listIndexedDbNames()) {
            const db = await openDbByName(name);
            try {
                if (!db.objectStoreNames.contains(JOURNAL_STORE)) throw new Error('本地变更追踪未就绪，请刷新后重试。');
                const tx = db.transaction(JOURNAL_STORE, 'readonly');
                const request = tx.objectStore(JOURNAL_STORE).openCursor();
                request.onsuccess = () => {
                    const cursor = request.result;
                    if (!cursor) return;
                    if (cursor.key === '__epoch__') { dirty.epochs[name] = cursor.value; cursor.continue(); return; }
                    const event = cursor.value;
                    watermark.databases[name] = cursor.key;
                    const identity = `${name}/${event.store}`;
                    const item = dirty.stores.get(identity) || { clear: false, keys: new Map() };
                    if (event.clear) { item.clear = true; item.keys.clear(); }
                    else item.keys.set(stableKeyToken(event.key), event.key);
                    dirty.stores.set(identity, item);
                    cursor.continue();
                };
                await waitForTransaction(tx, '变更日志读取失败。');
            } finally { db.close(); }
        }
        return dirty;
    }

    function requestExplicitRebuild() {
        localStorage.setItem('rp_sync_rebuild_requested', '1');
        return true;
    }

    function readBaseline() {
        const value = localStorage.getItem(BASELINE_KEY);
        if (value === null) return null;
        try {
            const parsed = JSON.parse(value);
            if (!Number.isSafeInteger(parsed.version) || typeof parsed.checksum !== 'string') throw new Error();
            return parsed;
        } catch (_) { throw new Error('同步基线损坏，请先导出本地数据，再重新建立基线。'); }
    }

    function createYieldController() {
        let lastYieldAt = performance.now();
        return async function yieldIfNeeded() {
            if (performance.now() - lastYieldAt < CONFIG.yieldIntervalMs) return;
            await wait(0);
            lastYieldAt = performance.now();
        };
    }

    async function withCrossTabSyncLock(task) {
        if (!navigator.locks?.request) return task();
        return navigator.locks.request(CONFIG.lockName, { mode: 'exclusive' }, task);
    }

    async function withRestoreWriteLock(task) {
        if (!navigator.locks?.request) throw new Error('此浏览器不支持安全恢复，请更新浏览器后重试。');
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        try {
            return await navigator.locks.request('rp-hub-app-writers-v1', {
                mode: 'exclusive', signal: controller.signal
            }, async () => {
                clearTimeout(timeout);
                return task();
            });
        } catch (error) {
            if (error.name === 'AbortError') throw new Error('请关闭其他 RP Hub 页面后重试恢复。');
            throw error;
        } finally {
            clearTimeout(timeout);
        }
    }

    function getStoredSyncPassword() {
        return localStorage.getItem(CONFIG.passwordStorageKey) || '';
    }

    function saveStoredSyncPassword(password) {
        localStorage.setItem(CONFIG.passwordStorageKey, password);
    }

    function clearStoredSyncPassword() {
        localStorage.removeItem(CONFIG.passwordStorageKey);
    }

    function waitForTransaction(tx, message, getValue = () => undefined) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (callback, value) => {
                if (settled) return;
                settled = true;
                callback(value);
            };
            tx.addEventListener('complete', () => {
                try {
                    finish(resolve, getValue());
                } catch (error) {
                    finish(reject, error);
                }
            }, { once: true });
            tx.addEventListener('error', () => {
                finish(reject, tx.error || new Error(message));
            }, { once: true });
            tx.addEventListener('abort', () => {
                finish(reject, tx.error || new Error(`${message} aborted`));
            }, { once: true });
        });
    }

    function openDbByName(dbName, version) {
        return new Promise((resolve, reject) => {
            const request = typeof version === 'number'
                ? indexedDB.open(dbName, version)
                : indexedDB.open(dbName);
            request.onerror = () => reject(request.error || new Error('IndexedDB open failed.'));
            request.onsuccess = () => resolve(request.result);
        });
    }

    function createObjectStoreFromSnapshot(db, storeDef) {
        if (db.objectStoreNames.contains(storeDef.name)) return;

        const options = {};
        if (storeDef.keyPath !== null && typeof storeDef.keyPath !== 'undefined') {
            options.keyPath = storeDef.keyPath;
        }
        if (storeDef.autoIncrement) {
            options.autoIncrement = true;
        }

        db.createObjectStore(storeDef.name, options);
    }

    function openDbForRestore(dbDef) {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(dbDef.name);

            request.onerror = () => reject(request.error || new Error('IndexedDB restore open failed.'));
            request.onupgradeneeded = () => {
                const db = request.result;
                for (const storeDef of dbDef.stores || []) {
                    createObjectStoreFromSnapshot(db, storeDef);
                }
            };
            request.onsuccess = () => {
                const db = request.result;
                const missingStores = (dbDef.stores || [])
                    .filter((storeDef) => !db.objectStoreNames.contains(storeDef.name));

                if (missingStores.length === 0) {
                    resolve(db);
                    return;
                }

                const nextVersion = db.version + 1;
                db.close();

                const upgradeRequest = indexedDB.open(dbDef.name, nextVersion);
                upgradeRequest.onerror = () => reject(upgradeRequest.error || new Error('IndexedDB restore upgrade failed.'));
                upgradeRequest.onupgradeneeded = () => {
                    const upgradedDb = upgradeRequest.result;
                    for (const storeDef of dbDef.stores || []) {
                        createObjectStoreFromSnapshot(upgradedDb, storeDef);
                    }
                };
                upgradeRequest.onsuccess = () => resolve(upgradeRequest.result);
            };
        });
    }

    function isAppLocalStorageKey(key) {
        return key !== CONFIG.passwordStorageKey
            && !key.startsWith('rp_hub_sync_')
            && CONFIG.localStoragePrefixes.some((prefix) => key.startsWith(prefix));
    }

    function isSyncExcludedRecord(database, store, key) {
        return database === 'RPHubDB'
            && store === 'store'
            && key === 'rp_hub_presets';
    }

    function readLocalStorageSnapshot() {
        const entries = [];
        for (let index = 0; index < localStorage.length; index += 1) {
            const key = localStorage.key(index);
            if (key === null || !isAppLocalStorageKey(key)) continue;
            entries.push({
                key,
                value: localStorage.getItem(key)
            });
        }
        entries.sort((a, b) => a.key.localeCompare(b.key));
        return entries;
    }

    async function listIndexedDbNames() {
        const knownNames = CONFIG.knownDatabases.map((dbDef) => dbDef.name);

        if (typeof indexedDB.databases === 'function') {
            try {
                const databases = await indexedDB.databases();
                const existingNames = new Set((databases || [])
                    .map((dbInfo) => dbInfo?.name)
                    .filter((name) => typeof name === 'string' && name));
                return knownNames.filter((name) => existingNames.has(name));
            } catch (error) {
                // Some browsers expose indexedDB.databases but may reject it.
            }
        }

        return knownNames;
    }

    function estimateRecordBytes(value, depth = 0) {
        if (value === null || value === undefined) return 16;
        const type = typeof value;
        if (type === 'string') return value.length * 2 + 24;
        if (type === 'number' || type === 'boolean' || type === 'bigint') return 24;
        if (type !== 'object') return 64;
        if (value instanceof Date) return 24;
        if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value.byteLength + 24;
        if (depth >= 3) return 512;
        let bytes = 64;
        if (Array.isArray(value)) {
            for (const item of value) bytes += estimateRecordBytes(item, depth + 1);
        } else {
            for (const key of Object.keys(value)) {
                bytes += 24 + estimateRecordBytes(value[key], depth + 1);
            }
        }
        return bytes;
    }

    function readObjectStoreRecordBatch(db, storeName, afterKey, hasAfterKey) {
        const tx = db.transaction([storeName], 'readonly');
        const store = tx.objectStore(storeName);
        const range = hasAfterKey ? IDBKeyRange.lowerBound(afterKey, true) : null;
        const records = [];
        let batchBytes = 0;
        const request = store.openCursor(range);
        let result;
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) {
                result = { records, done: true, lastKey: afterKey };
                return;
            }
            // Stop before deserializing the next record into the batch, so a
            // single oversized author record never inflates it. lastKey must be
            // the last key already read: the next batch resumes with an
            // exclusive lower bound, so returning the unread cursor.key here
            // would silently skip that record.
            if (records.length >= CONFIG.scanBatchRecords || batchBytes >= CONFIG.scanBatchBytes) {
                result = { records, done: false, lastKey: records[records.length - 1].key };
                return;
            }
            records.push({ key: cursor.key, value: cursor.value });
            batchBytes += estimateRecordBytes(cursor.value);
            cursor.continue();
        };
        return waitForTransaction(tx, 'IndexedDB cursor read failed.', () => result);
    }

    async function* iterateObjectStoreRecords(db, storeName) {
        let hasAfterKey = false;
        let afterKey;
        const yieldIfNeeded = createYieldController();

        while (true) {
            const batch = await readObjectStoreRecordBatch(db, storeName, afterKey, hasAfterKey);
            for (const record of batch.records) {
                yield record;
            }
            if (batch.done) return;
            hasAfterKey = true;
            afterKey = batch.lastKey;
            await yieldIfNeeded();
        }
    }

    function stableKeyToken(key) {
        return JSON.stringify(key);
    }

    function readObjectStoreKeys(db, storeName) {
        const tx = db.transaction([storeName], 'readonly');
        const store = tx.objectStore(storeName);
        const keys = [];
        const request = store.openKeyCursor();
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) return;
            keys.push(cursor.key);
            cursor.continue();
        };
        return waitForTransaction(tx, 'IndexedDB key read failed.', () => keys);
    }

    function clearObjectStore(db, storeName) {
        if (!db.objectStoreNames.contains(storeName)) return Promise.resolve();
        const tx = db.transaction([storeName], 'readwrite');
        tx.objectStore(storeName).clear();
        return waitForTransaction(tx, 'IndexedDB clear failed.');
    }

    async function deleteObjectStoreKeys(db, storeName, keys) {
        const yieldIfNeeded = createYieldController();
        for (let start = 0; start < keys.length; start += CONFIG.restoreBatchSize) {
            const batch = keys.slice(start, start + CONFIG.restoreBatchSize);
            const tx = db.transaction([storeName], 'readwrite');
            const store = tx.objectStore(storeName);
            batch.forEach((key) => store.delete(key));
            await waitForTransaction(tx, 'IndexedDB cleanup failed.');
            await yieldIfNeeded();
        }
    }

    async function clearKnownIndexedDbStores(dbDef, storeNames) {
        const dbNames = await listIndexedDbNames();
        if (!dbNames.includes(dbDef.name)) return;

        const db = await openDbByName(dbDef.name);
        try {
            for (const storeName of storeNames) {
                if (!db.objectStoreNames.contains(storeName)) continue;
                if (isSyncExcludedRecord(dbDef.name, storeName, 'rp_hub_presets')) {
                    const keys = await readObjectStoreKeys(db, storeName);
                    await deleteObjectStoreKeys(
                        db,
                        storeName,
                        keys.filter((key) => !isSyncExcludedRecord(dbDef.name, storeName, key))
                    );
                } else {
                    await clearObjectStore(db, storeName);
                }
            }
        } finally {
            db.close();
        }
    }

    function writeObjectStoreRecordBatch(db, storeDef, records) {
        if (!Array.isArray(records) || records.length === 0) return Promise.resolve();
        const tx = db.transaction([storeDef.name], 'readwrite');
        const store = tx.objectStore(storeDef.name);

        for (const record of records) {
            if (storeDef.keyPath !== null && typeof storeDef.keyPath !== 'undefined') {
                store.put(record.value);
            } else {
                store.put(record.value, record.key);
            }
        }
        return waitForTransaction(tx, 'IndexedDB restore failed.');
    }

    async function deleteMissingObjectStoreRecords(db, database, storeName, incomingKeyTokens) {
        const existingKeys = await readObjectStoreKeys(db, storeName);
        const keysToDelete = existingKeys.filter((key) => {
            if (isSyncExcludedRecord(database, storeName, key)) return false;
            const token = stableKeyToken(key);
            return !incomingKeyTokens.has(token);
        });
        await deleteObjectStoreKeys(db, storeName, keysToDelete);
    }

    async function waitForIndexedDbWriteBarrier() {
        const dbNames = await listIndexedDbNames();
        for (const dbDef of CONFIG.knownDatabases) {
            if (!dbNames.includes(dbDef.name)) continue;
            const db = await openDbByName(dbDef.name);
            try {
                const storeNames = dbDef.stores.filter(storeName => db.objectStoreNames.contains(storeName));
                for (const storeName of storeNames) {
                    const tx = db.transaction([storeName], 'readwrite');
                    const request = tx.objectStore(storeName).get('__rp_sync_write_barrier__');
                    request.onerror = () => { /* transaction handler below supplies the final error */ };
                    await waitForTransaction(tx, 'IndexedDB write barrier failed.');
                }
            } finally {
                db.close();
            }
        }
    }

    async function sha256(text) {
        return sha256Bytes(textEncoder.encode(text));
    }

    async function sha256Bytes(bytes) {
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
    }

    function serializeSnapshotObject(value) {
        const seen = new Set();
        const canonical = item => {
            if (item === null || typeof item !== 'object') {
                if (item === undefined || (typeof item === 'number' && !Number.isFinite(item))
                    || typeof item === 'bigint' || typeof item === 'function' || typeof item === 'symbol') {
                    throw new Error('数据包含不支持的非 JSON 值，已停止同步以避免丢失。');
                }
                return item;
            }
            if (seen.has(item) || (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)) {
                throw new Error('数据包含循环引用或非 JSON 对象，已停止同步以避免丢失。');
            }
            seen.add(item);
            const value = Array.isArray(item) ? item.map(canonical) : Object.create(null);
            if (!Array.isArray(item)) for (const key of Object.keys(item).sort()) value[key] = canonical(item[key]);
            seen.delete(item);
            return value;
        };
        const json = JSON.stringify(canonical(value));
        if (typeof json !== 'string') throw new Error('本地数据包含无法序列化的内容。');
        return textEncoder.encode(json);
    }

    function openLocalSyncCache() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(LOCAL_CACHE_DB, LOCAL_CACHE_DB_VERSION);
            request.onerror = () => reject(request.error || new Error('本地同步索引打开失败。'));
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(LOCAL_CACHE_ENTRY_STORE)) {
                    const store = db.createObjectStore(LOCAL_CACHE_ENTRY_STORE, { keyPath: 'id' });
                    store.createIndex('bucketKey', 'bucketKey', { unique: false });
                    store.createIndex('sourceKey', 'sourceKey', { unique: false });
                } else {
                    const store = request.transaction.objectStore(LOCAL_CACHE_ENTRY_STORE);
                    if (!store.indexNames.contains('sourceKey')) store.createIndex('sourceKey', 'sourceKey', { unique: false });
                }
                const entries = request.transaction.objectStore(LOCAL_CACHE_ENTRY_STORE);
                if (!entries.indexNames.contains('order')) entries.createIndex('order', ['bucketKey', 'sortKey', 'id']);
                if (!db.objectStoreNames.contains(LOCAL_CACHE_STATE_STORE)) db.createObjectStore(LOCAL_CACHE_STATE_STORE);
                if (!db.objectStoreNames.contains(LOCAL_CACHE_PACK_STORE)) db.createObjectStore(LOCAL_CACHE_PACK_STORE);
            };
            request.onsuccess = () => resolve(request.result);
        });
    }

    function cacheReadState(db) {
        const tx = db.transaction([LOCAL_CACHE_STATE_STORE], 'readonly');
        const request = tx.objectStore(LOCAL_CACHE_STATE_STORE).get(CACHE_STATE_KEY);
        return waitForTransaction(tx, '本地同步索引读取失败。', () => {
            const value = request.result || null;
            // 写入时清单只保存一份（state.packs），读回时回填到
            // state.snapshot.packManifest，避免大库存两份清单。
            if (value && Array.isArray(value.packs) && value.snapshot && !value.snapshot.packManifest) {
                value.snapshot.packManifest = value.packs;
            }
            return value;
        });
    }

    function cacheWriteState(db, value) {
        const persisted = value && Array.isArray(value.packs) && value.snapshot
            ? { ...value, snapshot: { ...value.snapshot, packManifest: undefined } }
            : value;
        const tx = db.transaction([LOCAL_CACHE_STATE_STORE], 'readwrite');
        tx.objectStore(LOCAL_CACHE_STATE_STORE).put(persisted, CACHE_STATE_KEY);
        return waitForTransaction(tx, '本地同步索引写入失败。');
    }

    function cacheReadEntry(db, id) {
        const tx = db.transaction([LOCAL_CACHE_ENTRY_STORE], 'readonly');
        const request = tx.objectStore(LOCAL_CACHE_ENTRY_STORE).get(id);
        return waitForTransaction(tx, '本地同步对象读取失败.', () => request.result);
    }

    // 与 readRecordsByKeys 同样的批量思路：一次只读事务读回多条缓存条目，
    // 避免批量删除或数组分页比较时逐键一个事务。
    async function readCacheEntries(db, ids) {
        const entries = [];
        for (let start = 0; start < ids.length; start += CONFIG.restoreBatchSize) {
            const batch = ids.slice(start, start + CONFIG.restoreBatchSize);
            const tx = db.transaction([LOCAL_CACHE_ENTRY_STORE], 'readonly');
            const requests = batch.map(id => tx.objectStore(LOCAL_CACHE_ENTRY_STORE).get(id));
            const values = await waitForTransaction(tx, '本地同步对象读取失败。', () => requests.map(request => request.result));
            entries.push(...values);
        }
        return entries;
    }

    function cacheSourceKeys(db, sourceKey) {
        const tx = db.transaction([LOCAL_CACHE_ENTRY_STORE], 'readonly');
        const request = tx.objectStore(LOCAL_CACHE_ENTRY_STORE).index('sourceKey').getAllKeys(sourceKey);
        return waitForTransaction(tx, '本地同步对象索引读取失败。', () => request.result || []);
    }

    async function* iterateCachedBucket(db, bucketKey) {
        let after;
        while (true) {
            const tx = db.transaction(LOCAL_CACHE_ENTRY_STORE, 'readonly');
            const index = tx.objectStore(LOCAL_CACHE_ENTRY_STORE).index('order');
            const range = IDBKeyRange.bound(after || [bucketKey], [bucketKey, []], Boolean(after), true);
            const request = index.openCursor(range);
            const entries = [];
            let byteLength = 0;
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) return;
                entries.push(cursor.value);
                byteLength += cursor.value.bytes.byteLength;
                after = cursor.key;
                if (entries.length >= CONFIG.readBatchSize || byteLength >= CONFIG.cacheWriteBytes) return;
                cursor.continue();
            };
            const batch = await waitForTransaction(tx, '本地分片读取失败。', () => ({ entries, done: entries.length === 0 || entries.length < CONFIG.readBatchSize && byteLength < CONFIG.cacheWriteBytes }));
            for (const entry of batch.entries) yield entry;
            if (batch.done) return;
        }
    }

    function cachePack(db, checksum, bytes) {
        const tx = db.transaction(LOCAL_CACHE_PACK_STORE, bytes ? 'readwrite' : 'readonly');
        const store = tx.objectStore(LOCAL_CACHE_PACK_STORE);
        const request = bytes ? store.put(bytes, checksum) : store.get(checksum);
        return waitForTransaction(tx, '本地分片缓存失败。', () => request.result);
    }

    async function pruneCachedPacks(db, manifest) {
        const active = new Set(manifest.map(pack => pack.checksum));
        const keys = await readObjectStoreKeys(db, LOCAL_CACHE_PACK_STORE);
        await deleteObjectStoreKeys(db, LOCAL_CACHE_PACK_STORE, keys.filter(key => !active.has(key)));
    }

    function cacheWriteEntries(db, entries) {
        if (!Array.isArray(entries) || entries.length === 0) return Promise.resolve();
        const tx = db.transaction([LOCAL_CACHE_ENTRY_STORE], 'readwrite');
        const store = tx.objectStore(LOCAL_CACHE_ENTRY_STORE);
        entries.forEach(entry => store.put(entry));
        return waitForTransaction(tx, '本地同步对象写入失败。');
    }

    function cacheClear(db) {
        const tx = db.transaction([LOCAL_CACHE_ENTRY_STORE, LOCAL_CACHE_STATE_STORE, LOCAL_CACHE_PACK_STORE], 'readwrite');
        tx.objectStore(LOCAL_CACHE_ENTRY_STORE).clear();
        tx.objectStore(LOCAL_CACHE_STATE_STORE).clear();
        tx.objectStore(LOCAL_CACHE_PACK_STORE).clear();
        return waitForTransaction(tx, '本地同步索引清理失败。');
    }

    function stableHash(value) {
        let hash = 2166136261;
        const text = String(value || '');
        for (let index = 0; index < text.length; index += 1) {
            hash ^= text.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return hash >>> 0;
    }

    function snapshotEntryId(value) {
        if (value.type === 'localStorage') return `ls:${value.key}`;
        if (value.type === 'database') return `db:${value.name}`;
        if (value.type === 'record') return `record:${value.database}/${value.store}/${stableKeyToken(value.key)}`;
        if (value.type === 'recordArrayStart') return `array:${value.database}/${value.store}/${stableKeyToken(value.key)}:start`;
        if (value.type === 'recordArrayItem') return `array:${value.database}/${value.store}/${stableKeyToken(value.key || '')}:item:${String(value.index).padStart(12, '0')}`;
        if (value.type === 'recordArrayEnd') return `array:${value.database}/${value.store}/${stableKeyToken(value.key || '')}:end`;
        if (value.type === 'storeEnd') return `store-end:${value.database}/${value.store}`;
        if (value.type === 'databaseEnd') return `db-end:${value.name}`;
        throw new Error('未知同步对象类型。');
    }

    function snapshotEntryGroup(value) {
        if (value.type === 'localStorage') return 'localStorage';
        if (value.type === 'database') return `db:${value.name}:header`;
        if (value.type === 'storeEnd') return `store:${value.database}/${value.store}:footer`;
        if (value.type === 'databaseEnd') return `db:${value.name}:footer`;
        return `store:${value.database}/${value.store}:data`;
    }

    function snapshotEntrySource(value) {
        if (value.type === 'localStorage') return `ls:${value.key}`;
        if (value.type === 'database') return `db:${value.name}`;
        if (value.type === 'databaseEnd') return `db-end:${value.name}`;
        if (value.type === 'storeEnd') return `store-end:${value.database}/${value.store}`;
        return `${value.database}/${value.store}/${stableKeyToken(value.key)}`;
    }

    function arraySourceToken(sourceKey) {
        const left = stableHash(`a:${sourceKey}`).toString(16).padStart(8, '0');
        const right = stableHash(`b:${sourceKey}`).toString(16).padStart(8, '0');
        return `${left}${right}-${sourceKey.length}`;
    }

    function snapshotEntryBucket(value, id, sourceKey) {
        const group = snapshotEntryGroup(value);
        if (group.endsWith(':header')) return `${group}|h`;
        if (group.endsWith(':footer')) return `${group}|z`;
        if (value.type === 'recordArrayStart'
            || value.type === 'recordArrayItem'
            || value.type === 'recordArrayEnd') {
            const length = Number(value.length || 0);
            const page = value.type === 'recordArrayItem'
                ? Math.floor(Number(value.index || 0) / ARRAY_BUCKET_ENTRIES)
                : value.type === 'recordArrayEnd'
                    ? Math.floor(length / ARRAY_BUCKET_ENTRIES)
                    : 0;
            return `${group}|a${arraySourceToken(sourceKey)}|p${String(page).padStart(10, '0')}`;
        }
        return `${group}|r${String(stableHash(id) % STABLE_BUCKET_COUNT).padStart(3, '0')}`;
    }

    function buildCacheEntry(value) {
        const id = snapshotEntryId(value);
        const group = snapshotEntryGroup(value);
        const sourceKey = snapshotEntrySource(value);
        const sequence = value.type === 'recordArrayStart'
            ? '0'
            : value.type === 'recordArrayItem'
                ? `1:${String(value.index).padStart(12, '0')}`
                : value.type === 'recordArrayEnd'
                    ? '2'
                    : '1';
        const bytes = serializeSnapshotObject(value);
        if (bytes.byteLength > MAX_SUPPORTED_OBJECT_BYTES) throw new Error('单条本地数据超过 64MiB 同步上限。');
        return { id, group, sourceKey, sortKey: `${sourceKey}|${sequence}`, bucketKey: snapshotEntryBucket(value, id, sourceKey), bytes };
    }

    // 缓存条目的 bytes 本来就是这台序列化器产出的规范字节，判断“未变化”
    // 直接与缓存字节逐位比较即可，省掉先 JSON.parse 再重新序列化一遍。
    function snapshotBytesEqual(value, cachedBytes) {
        const bytes = serializeSnapshotObject(value);
        return bytes.byteLength === cachedBytes.byteLength
            && bytes.every((byte, index) => byte === cachedBytes[index]);
    }

    // 读出缓存 header 里记录的版本号；解析失败或非法时返回 null，调用方回退当前版本。
    function readCachedHeaderVersion(bytes) {
        try {
            const value = JSON.parse(new TextDecoder().decode(bytes));
            return typeof value?.version === 'number' && Number.isFinite(value.version) ? value.version : null;
        } catch (_) {
            return null;
        }
    }

    // Keep requests in one transaction; callers bound each batch by record count.
    // IndexedDB must still clone a whole value for a single business key.
    function readRecordsByKeys(db, storeName, keys) {
        if (!keys.length || !db.objectStoreNames.contains(storeName)) return Promise.resolve(keys.map(() => undefined));
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const requests = keys.map(key => store.get(key));
        return waitForTransaction(tx, '本地同步记录读取失败。', () => requests.map(request => request.result));
    }

    async function buildCachedPacks(db, bucketKey) {
        const packs = [];
        let buffer = new Uint8Array(CONFIG.targetPackBytes);
        let used = 0;
        let entryCount = 0;
        let group;
        const flush = async () => {
            if (used === 0) return;
            const bytes = buffer.slice(0, used);
            const checksum = await sha256Bytes(bytes);
            await cachePack(db, checksum, bytes);
            packs.push({
                bucketKey, group, part: packs.length, checksum, length: bytes.byteLength, entryCount
            });
            used = 0;
            entryCount = 0;
        };
        for await (const entry of iterateCachedBucket(db, bucketKey)) {
            group = entry.group;
            const bytes = entry.bytes instanceof Uint8Array ? entry.bytes : new Uint8Array(entry.bytes);
            for (let offset = 0; offset < bytes.byteLength;) {
                const length = Math.min(buffer.byteLength - used, bytes.byteLength - offset);
                buffer.set(bytes.subarray(offset, offset + length), used);
                used += length;
                offset += length;
                if (used === buffer.byteLength) await flush();
            }
            buffer[used++] = 10;
            entryCount += 1;
            if (used === buffer.byteLength || entryCount === CONFIG.maxPackEntries) await flush();
        }
        await flush();
        return packs;
    }

    function orderPackItems(state, packItems) {
        const order = new Map((state.groups || []).map((group, index) => [group, index]));
        return packItems.slice().sort((a, b) => (
            (order.get(a.group) ?? 999999) - (order.get(b.group) ?? 999999)
            || String(a.bucketKey).localeCompare(String(b.bucketKey))
            || Number(a.part) - Number(b.part)
        ));
    }

    async function finalizeCachedSnapshot(db, state, changedBuckets = null) {
        const targets = changedBuckets
            ? [...changedBuckets]
            : [...new Set((state.packs || []).map(pack => pack.bucketKey))];
        const targetSet = new Set(targets);
        const items = (state.packs || []).filter(pack => !targetSet.has(pack.bucketKey));
        let totalBytes = items.reduce((sum, pack) => sum + pack.length, 0);
        for (const bucketKey of targets) {
            const packs = await buildCachedPacks(db, bucketKey);
            items.push(...packs);
            totalBytes += packs.reduce((sum, pack) => sum + pack.length, 0);
            if (totalBytes > CONFIG.maxSnapshotBytes) throw new Error('本地同步数据超过 1GiB 上限。');
            if (items.length > CONFIG.maxPackCount) throw new Error('本地同步分片超过 8192 个上限。');
        }
        const ordered = orderPackItems(state, items);
        const snapshot = {
            snapshotFormat: SNAPSHOT_FORMAT,
            schemaVersion: SNAPSHOT_SCHEMA_VERSION,
            packCount: ordered.length,
            entryCount: ordered.reduce((sum, pack) => sum + pack.entryCount, 0),
            totalBytes: ordered.reduce((sum, pack) => sum + pack.length, 0),
            packManifest: ordered.map(({ bucketKey, group, part, checksum, length, entryCount }) => ({ bucketKey, group, part, checksum, length, entryCount }))
        };
        if (serializeSnapshotObject(snapshot).byteLength > CONFIG.maxManifestBytes - 1024) {
            throw new Error('本地同步清单超过 2MiB 上限。');
        }
        snapshot.checksum = await sha256(buildPackSnapshotChecksumSource(snapshot));
        state.packs = ordered;
        state.snapshot = snapshot;
        return { state, snapshot };
    }

    async function buildFullCachedSnapshot(cacheDb, progressStart, progressEnd) {
        await cacheClear(cacheDb);
        const buckets = new Map();
        const groups = [];
        let pendingEntries = [];
        let pendingBytes = 0;
        let totalBytes = 0;
        let processed = 0;
        for await (const value of iterateSnapshotObjects()) {
            const entry = buildCacheEntry(value);
            if (!groups.includes(entry.group)) groups.push(entry.group);
            if (!buckets.has(entry.bucketKey)) buckets.set(entry.bucketKey, entry.group);
            pendingEntries.push(entry);
            pendingBytes += entry.bytes.byteLength;
            totalBytes += entry.bytes.byteLength + 1;
            if (totalBytes > CONFIG.maxSnapshotBytes) throw new Error('本地同步数据超过 1GiB 上限。');
            if (pendingEntries.length >= CONFIG.readBatchSize || pendingBytes >= CONFIG.cacheWriteBytes) {
                await cacheWriteEntries(cacheDb, pendingEntries);
                pendingEntries = [];
                pendingBytes = 0;
            }
            processed += 1;
            updateProgress(progressStart + Math.min(progressEnd - progressStart, Math.round(processed / (processed + 256) * (progressEnd - progressStart))), '正在整理…');
        }
        await cacheWriteEntries(cacheDb, pendingEntries);
        const state = { version: CACHE_FORMAT_VERSION, groups, packs: [] };
        for (const [bucketKey, group] of buckets) {
            state.packs.push({ bucketKey, group, part: 0, checksum: '', length: 0, entryCount: 0 });
        }
        return finalizeCachedSnapshot(cacheDb, state, new Set(buckets.keys()));
    }

    async function updateCachedSnapshot(cacheDb, state, dirty) {
        const affectedBuckets = new Set(state.pendingBuckets || []);
        let bucketsDirty = false;
        // 触桶只做内存标记，条目落盘前由 flushPendingBuckets 统一持久化：保住
        // “条目已写入 ⇒ 其所在桶必已在 pendingBuckets”的崩溃安全不变量，
        // 同时把原来每触一个桶就全量写一次 state 合并成每次条目落盘前至多一次。
        const touchBucket = bucket => {
            if (affectedBuckets.has(bucket)) return;
            affectedBuckets.add(bucket);
            state.pendingBuckets = [...affectedBuckets];
            bucketsDirty = true;
        };
        const flushPendingBuckets = async () => {
            if (!bucketsDirty) return;
            bucketsDirty = false;
            await cacheWriteState(cacheDb, state);
        };
        const yieldIfNeeded = createYieldController();
        const removeEntries = async keys => {
            const list = [...keys];
            if (!list.length) return;
            for (const entry of await readCacheEntries(cacheDb, list)) {
                if (entry) touchBucket(entry.bucketKey);
            }
            await flushPendingBuckets();
            await deleteObjectStoreKeys(cacheDb, LOCAL_CACHE_ENTRY_STORE, list);
        };
        const replaceSource = async (sourceKey, value) => {
            const remaining = new Set(await cacheSourceKeys(cacheDb, sourceKey));
            if (value) {
                const id = snapshotEntryId(value);
                const previous = await cacheReadEntry(cacheDb, id);
                remaining.delete(id);
                if (!previous || !snapshotBytesEqual(value, previous.bytes)) {
                    const entry = buildCacheEntry(value);
                    if (previous) touchBucket(previous.bucketKey);
                    touchBucket(entry.bucketKey);
                    await flushPendingBuckets();
                    await cacheWriteEntries(cacheDb, [entry]);
                }
            }
            await removeEntries(remaining);
        };
        const replaceArraySource = async (database, store, key, value, sourceKey) => {
            const remaining = new Set(await cacheSourceKeys(cacheDb, sourceKey));
            for (let page = 0; page <= Math.floor(value.length / ARRAY_BUCKET_ENTRIES); page += 1) {
                const start = page * ARRAY_BUCKET_ENTRIES;
                const values = new Map();
                const add = item => values.set(snapshotEntryId(item), item);
                if (page === 0) add({ type: 'recordArrayStart', database, store, key });
                for (let index = start; index < Math.min(value.length, start + ARRAY_BUCKET_ENTRIES); index += 1) {
                    add({ type: 'recordArrayItem', database, store, key, index, value: value[index] === undefined ? null : value[index] });
                }
                if (start + ARRAY_BUCKET_ENTRIES > value.length) add({ type: 'recordArrayEnd', database, store, key, length: value.length });
                const first = values.values().next().value;
                const bucketKey = snapshotEntryBucket(first, snapshotEntryId(first), sourceKey);
                for await (const previous of iterateCachedBucket(cacheDb, bucketKey)) {
                    const item = values.get(previous.id);
                    if (item && snapshotBytesEqual(item, previous.bytes)) {
                        values.delete(previous.id);
                        remaining.delete(previous.id);
                    }
                }
                const previousEntries = new Map();
                for (const entry of await readCacheEntries(cacheDb, [...values.keys()])) {
                    if (entry) previousEntries.set(entry.id, entry);
                }
                let writes = [];
                let bytes = 0;
                for (const [id, item] of values) {
                    remaining.delete(id);
                    const previous = previousEntries.get(id);
                    if (previous) touchBucket(previous.bucketKey);
                    const entry = buildCacheEntry(item);
                    touchBucket(entry.bucketKey);
                    writes.push(entry);
                    bytes += entry.bytes.byteLength;
                    if (bytes >= CONFIG.cacheWriteBytes || writes.length >= CONFIG.readBatchSize) {
                        await flushPendingBuckets();
                        await cacheWriteEntries(cacheDb, writes);
                        writes = [];
                        bytes = 0;
                    }
                }
                await flushPendingBuckets();
                await cacheWriteEntries(cacheDb, writes);
                await yieldIfNeeded();
            }
            await removeEntries(remaining);
        };
        for (const key of dirty.localStorage) {
            if (!isAppLocalStorageKey(key)) continue;
            const value = localStorage.getItem(key);
            if (value !== null && !state.groups.includes('localStorage')) state.groups.unshift('localStorage');
            await replaceSource(`ls:${key}`, value === null ? null : { type: 'localStorage', key, value });
        }
        for (const [storeName, item] of dirty.stores) {
            const slash = storeName.indexOf('/');
            if (slash <= 0) throw new Error('变更日志对象存储无效。');
            const database = storeName.slice(0, slash);
            const store = storeName.slice(slash + 1);
            const knownDb = CONFIG.knownDatabases.find(dbDef => dbDef.name === database);
            if (!knownDb || !knownDb.stores.includes(store)) continue;
            const db = await openDbByName(database);
            try {
                const stores = readStoreDefinitions(db, knownDb.stores.filter(name => db.objectStoreNames.contains(name)));
                let headerValue = { type: 'database', name: database, version: db.version, stores };
                const previousHeader = await cacheReadEntry(cacheDb, snapshotEntryId(headerValue));
                if (previousHeader && !snapshotBytesEqual(headerValue, previousHeader.bytes)) {
                    // 仅内置版本号变化（store 定义等价）时改用缓存 header 的版本号，
                    // 让随后的字节比较判等，不再制造无效的 header 分片；
                    // 真实 schema 变化仍以当前版本号写入。
                    const stabilized = { ...headerValue, version: readCachedHeaderVersion(previousHeader.bytes) };
                    if (stabilized.version !== null && snapshotBytesEqual(stabilized, previousHeader.bytes)) {
                        headerValue = stabilized;
                    }
                }
                await replaceSource(`db:${database}`, headerValue);
                await replaceSource(`db-end:${database}`, { type: 'databaseEnd', name: database });
                for (const definition of stores) {
                    await replaceSource(`store-end:${database}/${definition.name}`, { type: 'storeEnd', database, store: definition.name });
                }
                const dbGroups = stores.flatMap(def => [`store:${database}/${def.name}:data`, `store:${database}/${def.name}:footer`]);
                const otherGroups = state.groups.filter(group => !group.startsWith(`db:${database}:`) && !dbGroups.includes(group));
                const localGroup = otherGroups.includes('localStorage') ? ['localStorage'] : [];
                state.groups = [...localGroup, ...otherGroups.filter(group => group !== 'localStorage'), `db:${database}:header`, ...dbGroups, `db:${database}:footer`];
                if (item.clear) {
                    // clear 按最终键集合做差分：只删除真正消失的键；clear 后原样
                    // 回填的数据继续交给键循环字节比较去重，不再整店重写缓存。
                    const finalSources = new Set();
                    for (const key of item.keys.values()) {
                        if (!isSyncExcludedRecord(database, store, key)) {
                            finalSources.add(`${database}/${store}/${stableKeyToken(key)}`);
                        }
                    }
                    const prefix = `${database}/${store}/`;
                    const tx = cacheDb.transaction(LOCAL_CACHE_ENTRY_STORE, 'readonly');
                    const request = tx.objectStore(LOCAL_CACHE_ENTRY_STORE)
                        .index('sourceKey').openCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
                    const keys = [];
                    request.onsuccess = () => {
                        const cursor = request.result;
                        if (!cursor) return;
                        if (!finalSources.has(cursor.key)) keys.push(cursor.primaryKey);
                        cursor.continue();
                    };
                    const staleKeys = await waitForTransaction(tx, '本地同步索引读取失败。', () => keys);
                    await removeEntries(staleKeys);
                }
                const dirtyKeys = [...item.keys.values()].filter(key => !isSyncExcludedRecord(database, store, key));
                // 单连接 + 批量只读事务读取变化键：原来每键重开一次数据库、
                // 每键一个事务，收敛为每库一次打开、每 64 键一个只读事务，
                // 只读连接不会阻塞业务写入。
                for (let start = 0; start < dirtyKeys.length; start += CONFIG.restoreBatchSize) {
                    const batch = dirtyKeys.slice(start, start + CONFIG.restoreBatchSize);
                    const values = await readRecordsByKeys(db, store, batch);
                    for (let index = 0; index < batch.length; index += 1) {
                        const key = batch[index];
                        const value = values[index];
                        const sourceKey = `${database}/${store}/${stableKeyToken(key)}`;
                        if (Array.isArray(value)) await replaceArraySource(database, store, key, value, sourceKey);
                        else await replaceSource(sourceKey, value === undefined ? null : { type: 'record', database, store, key, value });
                    }
                    await yieldIfNeeded();
                }
            } finally { db.close(); }
        }
        const groupOrder = ['localStorage'];
        for (const definition of CONFIG.knownDatabases) {
            groupOrder.push(`db:${definition.name}:header`);
            for (const name of definition.stores) groupOrder.push(`store:${definition.name}/${name}:data`, `store:${definition.name}/${name}:footer`);
            groupOrder.push(`db:${definition.name}:footer`);
        }
        state.groups.sort((left, right) => groupOrder.indexOf(left) - groupOrder.indexOf(right));
        if (affectedBuckets.size === 0) return { state, snapshot: state.snapshot };
        const result = await finalizeCachedSnapshot(cacheDb, state, affectedBuckets);
        result.state.pendingBuckets = [];
        return result;
    }

    function readStoreDefinitions(db, storeNames) {
        return storeNames.map((storeName) => {
            const tx = db.transaction([storeName], 'readonly');
            const store = tx.objectStore(storeName);
            return {
                name: storeName,
                keyPath: store.keyPath,
                autoIncrement: Boolean(store.autoIncrement)
            };
        });
    }

    async function* iterateSnapshotObjects() {
        for (const entry of readLocalStorageSnapshot()) {
            yield { type: 'localStorage', key: entry.key, value: entry.value };
        }

        const dbNames = await listIndexedDbNames();
        for (const dbName of dbNames) {
            const knownDb = CONFIG.knownDatabases.find((dbDef) => dbDef.name === dbName);
            if (!knownDb) continue;

            const db = await openDbByName(dbName);
            try {
                const storeNames = knownDb.stores.filter((name) => db.objectStoreNames.contains(name));
                if (storeNames.length === 0) continue;
                const stores = readStoreDefinitions(db, storeNames);
                yield { type: 'database', name: dbName, version: db.version, stores };

                for (const storeDef of stores) {
                    for await (const record of iterateObjectStoreRecords(db, storeDef.name)) {
                        if (isSyncExcludedRecord(dbName, storeDef.name, record.key)) continue;
                        if (Array.isArray(record.value)) {
                            yield {
                                type: 'recordArrayStart',
                                database: dbName,
                                store: storeDef.name,
                                key: record.key
                            };
                            for (let index = 0; index < record.value.length; index += 1) {
                                const value = Object.prototype.hasOwnProperty.call(record.value, index)
                                    ? record.value[index]
                                    : null;
                                yield {
                                    type: 'recordArrayItem',
                                    database: dbName,
                                    store: storeDef.name,
                                    key: record.key,
                                    index,
                                    value: value === undefined ? null : value
                                };
                            }
                            yield {
                                type: 'recordArrayEnd',
                                database: dbName,
                                store: storeDef.name,
                                key: record.key,
                                length: record.value.length
                            };
                        } else {
                            yield {
                                type: 'record',
                                database: dbName,
                                store: storeDef.name,
                                key: record.key,
                                value: record.value
                            };
                        }
                    }
                    yield { type: 'storeEnd', database: dbName, store: storeDef.name };
                }
                yield { type: 'databaseEnd', name: dbName };
            } finally {
                db.close();
            }
        }
    }

    function openDownloadStagingDb() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DOWNLOAD_STAGING_DB, DOWNLOAD_STAGING_DB_VERSION);
            request.onerror = () => reject(request.error || new Error('同步临时数据库打开失败。'));
            request.onupgradeneeded = () => {
                const stagingDb = request.result;
                if (stagingDb.objectStoreNames.contains('chunks')) {
                    stagingDb.deleteObjectStore('chunks');
                }
                if (stagingDb.objectStoreNames.contains('objects')) {
                    stagingDb.deleteObjectStore('objects');
                }
                if (!stagingDb.objectStoreNames.contains(DOWNLOAD_STAGING_STORE)) {
                    stagingDb.createObjectStore(DOWNLOAD_STAGING_STORE);
                }
            };
            request.onsuccess = () => resolve(request.result);
        });
    }

    function clearDownloadStagingStore(stagingDb) {
        const tx = stagingDb.transaction([DOWNLOAD_STAGING_STORE], 'readwrite');
        tx.objectStore(DOWNLOAD_STAGING_STORE).clear();
        return waitForTransaction(tx, '同步临时数据清理失败。');
    }

    function writeDownloadStagingObjects(stagingDb, objects) {
        if (!Array.isArray(objects) || objects.length === 0) return Promise.resolve();
        const tx = stagingDb.transaction([DOWNLOAD_STAGING_STORE], 'readwrite');
        const store = tx.objectStore(DOWNLOAD_STAGING_STORE);
        objects.forEach(object => store.put(object.bytes, object.index));
        return waitForTransaction(tx, '同步临时数据写入失败。');
    }

    function readDownloadStagingObject(stagingDb, index) {
        const tx = stagingDb.transaction([DOWNLOAD_STAGING_STORE], 'readonly');
        const request = tx.objectStore(DOWNLOAD_STAGING_STORE).get(index);
        return waitForTransaction(tx, '同步临时数据读取失败。', () => {
            const value = request.result;
            if (value instanceof Uint8Array) return value;
            if (value instanceof ArrayBuffer) return new Uint8Array(value);
            throw new Error(`同步临时对象 ${index + 1} 不存在。`);
        });
    }

    async function downloadPacksToStaging(remote, packManifest, stagingDb) {
        await clearDownloadStagingStore(stagingDb);
        let completed = 0;
        for (let start = 0; start < packManifest.length; start += CONFIG.downloadPackConcurrency) {
            const batch = packManifest.slice(start, start + CONFIG.downloadPackConcurrency);
            const downloaded = await Promise.all(batch.map(async (pack, batchIndex) => {
                const index = start + batchIndex;
                const bytes = await postSyncBinary({
                    action: 'pull-pack',
                    version: remote.version,
                    checksum: pack.checksum
                }, { timeoutMs: CONFIG.packTransferTimeoutMs });
                if (bytes.byteLength !== pack.length) {
                    throw new Error(`服务器数据包 ${index + 1} 大小校验失败。`);
                }
                if (await sha256Bytes(bytes) !== pack.checksum) {
                    throw new Error(`服务器数据包 ${index + 1} 校验失败。`);
                }
                completed += 1;
                const percent = 8 + Math.round((completed / packManifest.length) * 57);
                updateProgress(percent, '正在下载…');
                return { index, bytes };
            }));
            await writeDownloadStagingObjects(stagingDb, downloaded);
        }
    }

    async function* iterateStagedSnapshotPacks(stagingDb, packManifest) {
        for (let index = 0; index < packManifest.length; index += 1) {
            const bytes = await readDownloadStagingObject(stagingDb, index);
            if (bytes.byteLength !== packManifest[index].length) {
                throw new Error(`同步临时数据包 ${index + 1} 校验失败。`);
            }
            yield { ...packManifest[index], bytes };
        }
    }

    class ObjectSnapshotRestorer {
        constructor(expectedEntryCount, { validateOnly = false } = {}) {
            this.expectedEntryCount = Number(expectedEntryCount || 0);
            this.validateOnly = validateOnly;
            this.entryCount = 0;
            this.finished = false;
            this.localStorageEnded = false;
            this.localStorageKeys = new Set();
            this.seenDatabases = new Set();
            this.currentDatabase = null;
            this.yieldIfNeeded = createYieldController();
        }

        async consume(value) {
            const object = value;
            if (!object || typeof object !== 'object' || Array.isArray(object)) {
                throw new Error('服务器同步对象格式不正确。');
            }

            switch (object.type) {
                case 'localStorage':
                    this.restoreLocalStorageEntry(object);
                    break;
                case 'database':
                    await this.startDatabase(object);
                    break;
                case 'record':
                    await this.restoreRecord(object);
                    break;
                case 'recordArrayStart':
                    this.startArrayRecord(object);
                    break;
                case 'recordArrayItem':
                    this.restoreArrayRecordItem(object);
                    break;
                case 'recordArrayEnd':
                    await this.finishArrayRecord(object);
                    break;
                case 'storeEnd':
                    await this.finishStore(object);
                    break;
                case 'databaseEnd':
                    await this.finishDatabase(object);
                    break;
                default:
                    throw new Error('服务器同步包含未知对象。');
            }
            this.entryCount += 1;
        }

        restoreLocalStorageEntry(line) {
            if (this.localStorageEnded || this.currentDatabase || typeof line.key !== 'string') {
                throw new Error('服务器本地设置记录顺序不正确。');
            }
            if (!isAppLocalStorageKey(line.key)) throw new Error('服务器包含无效的本地设置。');
            if (!this.validateOnly) localStorage.setItem(line.key, String(line.value ?? ''));
            this.localStorageKeys.add(line.key);
        }

        finishLocalStorage() {
            if (this.currentDatabase) {
                throw new Error('服务器本地设置结束标记不正确。');
            }
            if (this.localStorageEnded) return;
            if (!this.validateOnly) {
                for (const entry of readLocalStorageSnapshot()) {
                    if (!this.localStorageKeys.has(entry.key)) localStorage.removeItem(entry.key);
                }
            }
            this.localStorageEnded = true;
        }

        async startDatabase(line) {
            this.finishLocalStorage();
            if (this.currentDatabase || this.seenDatabases.has(line.name) || typeof line.name !== 'string') {
                throw new Error('服务器数据库记录顺序不正确。');
            }

            const knownDb = CONFIG.knownDatabases.find((dbDef) => dbDef.name === line.name);
            if (!knownDb) {
                this.currentDatabase = { name: line.name, ignored: true };
                return;
            }

            const seenStoreNames = new Set();
            const stores = (Array.isArray(line.stores) ? line.stores : []).filter((storeDef) => {
                if (!storeDef || !knownDb.stores.includes(storeDef.name) || seenStoreNames.has(storeDef.name)) return false;
                seenStoreNames.add(storeDef.name);
                return true;
            }).map((storeDef) => ({
                name: storeDef.name,
                keyPath: storeDef.keyPath,
                autoIncrement: Boolean(storeDef.autoIncrement)
            }));

            const db = !this.validateOnly && stores.length > 0
                ? await openDbForRestore({ name: line.name, stores })
                : null;
            this.currentDatabase = {
                name: line.name,
                db,
                knownDb,
                stores: new Map(stores.map((storeDef) => [storeDef.name, {
                    definition: storeDef,
                    incomingKeys: new Set(),
                    batch: [],
                    arrayRecord: null,
                    finished: false
                }]))
            };
            this.seenDatabases.add(line.name);
        }

        getStoreState(line) {
            const current = this.currentDatabase;
            if (!current || line.database !== current.name || typeof line.store !== 'string') {
                throw new Error('服务器数据库记录归属不正确。');
            }
            if (current.ignored) return null;

            const storeState = current.stores.get(line.store);
            if (!storeState || storeState.finished) throw new Error('服务器对象存储记录顺序不正确。');
            return storeState;
        }

        async queueStoreRecord(storeState, record) {
            storeState.incomingKeys.add(stableKeyToken(record.key));
            storeState.batch.push(record);
            if (storeState.batch.length >= CONFIG.restoreBatchSize) {
                await this.flushStore(storeState);
            }
        }

        async restoreRecord(line) {
            const storeState = this.getStoreState(line);
            if (!storeState) return;
            if (storeState.arrayRecord) throw new Error('服务器数组记录尚未结束。');
            if (isSyncExcludedRecord(this.currentDatabase.name, line.store, line.key)) {
                return;
            }
            const record = {
                key: line.key,
                value: Object.prototype.hasOwnProperty.call(line, 'value') ? line.value : undefined
            };
            await this.queueStoreRecord(storeState, record);
        }

        startArrayRecord(line) {
            const storeState = this.getStoreState(line);
            if (!storeState) return;
            if (storeState.arrayRecord) {
                throw new Error('服务器数组记录头信息不正确。');
            }
            storeState.arrayRecord = {
                key: line.key,
                value: [],
                nextIndex: 0,
                excluded: isSyncExcludedRecord(this.currentDatabase.name, line.store, line.key)
            };
        }

        restoreArrayRecordItem(line) {
            const storeState = this.getStoreState(line);
            if (!storeState) return;
            const arrayRecord = storeState.arrayRecord;
            if (!arrayRecord || stableKeyToken(line.key) !== stableKeyToken(arrayRecord.key)
                || Number(line.index) !== arrayRecord.nextIndex) {
                throw new Error('服务器数组记录顺序不正确。');
            }
            if (!arrayRecord.excluded && !this.validateOnly) {
                arrayRecord.value.push(Object.prototype.hasOwnProperty.call(line, 'value') ? line.value : null);
            }
            arrayRecord.nextIndex += 1;
        }

        async finishArrayRecord(line) {
            const storeState = this.getStoreState(line);
            if (!storeState) return;
            const arrayRecord = storeState.arrayRecord;
            if (!arrayRecord || stableKeyToken(line.key) !== stableKeyToken(arrayRecord.key)
                || Number(line.length) !== arrayRecord.nextIndex) {
                throw new Error('服务器数组记录数据不完整。');
            }
            storeState.arrayRecord = null;
            if (arrayRecord.excluded) {
                return;
            }
            await this.queueStoreRecord(storeState, { key: arrayRecord.key, value: arrayRecord.value });
            await this.flushStore(storeState);
        }

        async flushStore(storeState) {
            if (storeState.batch.length === 0) return;
            const batch = storeState.batch;
            storeState.batch = [];
            if (!this.validateOnly) {
                await writeObjectStoreRecordBatch(this.currentDatabase.db, storeState.definition, batch);
                await this.yieldIfNeeded();
            }
        }

        async finishStore(line) {
            const current = this.currentDatabase;
            if (!current || line.database !== current.name || typeof line.store !== 'string') {
                throw new Error('服务器对象存储结束标记不正确。');
            }
            if (current.ignored) return;

            const storeState = current.stores.get(line.store);
            if (!storeState || storeState.finished) throw new Error('服务器对象存储结束顺序不正确。');
            if (storeState.arrayRecord) throw new Error('服务器数组记录尚未结束。');
            await this.flushStore(storeState);
            if (!this.validateOnly) {
                await deleteMissingObjectStoreRecords(current.db, current.name, line.store, storeState.incomingKeys);
            }
            storeState.incomingKeys.clear();
            storeState.finished = true;
        }

        async finishDatabase(line) {
            const current = this.currentDatabase;
            if (!current || line.name !== current.name) throw new Error('服务器数据库结束标记不正确。');
            if (!current.ignored) {
                if ([...current.stores.values()].some((storeState) => !storeState.finished)) {
                    throw new Error('服务器对象存储数据不完整。');
                }
                if (current.db) current.db.close();
                const missingStores = current.knownDb.stores.filter((storeName) => !current.stores.has(storeName));
                if (!this.validateOnly && missingStores.length > 0) {
                    await clearKnownIndexedDbStores(current.knownDb, missingStores);
                }
            }
            this.currentDatabase = null;
        }

        async finish() {
            if (this.finished) throw new Error('服务器同步恢复已结束。');
            if (this.currentDatabase) throw new Error('服务器数据库数据不完整。');
            this.finishLocalStorage();
            if (this.entryCount !== this.expectedEntryCount) {
                throw new Error('服务器同步对象数量校验失败。');
            }
            if (!this.validateOnly) {
                for (const knownDb of CONFIG.knownDatabases) {
                    if (!this.seenDatabases.has(knownDb.name)) {
                        await clearKnownIndexedDbStores(knownDb, knownDb.stores);
                    }
                }
            }
            this.finished = true;
        }

        abort() {
            if (this.currentDatabase?.db) this.currentDatabase.db.close();
            this.currentDatabase = null;
        }
    }

    async function parseStagedPackSnapshot(stagingDb, packManifest, consumer, options = {}) {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        let completed = 0;
        let fragments = [];
        let fragmentBytes = 0;
        let previousBucket = null;
        for await (const pack of iterateStagedSnapshotPacks(stagingDb, packManifest)) {
            if (previousBucket !== pack.bucketKey && fragmentBytes) {
                throw new Error('服务器同步分片记录不完整。');
            }
            previousBucket = pack.bucketKey;
            let count = 0;
            let offset = 0;
            while (offset < pack.bytes.byteLength) {
                const end = pack.bytes.indexOf(10, offset);
                const piece = pack.bytes.subarray(offset, end === -1 ? pack.bytes.byteLength : end);
                fragmentBytes += piece.byteLength;
                if (fragmentBytes > MAX_SUPPORTED_OBJECT_BYTES) throw new Error('服务器单条数据超过 64MiB 上限。');
                fragments.push(piece);
                if (end === -1) break;
                let bytes = fragments[0];
                if (fragments.length > 1) {
                    bytes = new Uint8Array(fragmentBytes);
                    let position = 0;
                    for (const fragment of fragments) { bytes.set(fragment, position); position += fragment.byteLength; }
                }
                let value;
                try { value = JSON.parse(decoder.decode(bytes)); }
                catch (_) { throw new Error('服务器同步数据包 JSON 不正确。'); }
                fragments = [];
                fragmentBytes = 0;
                await consumer.consume(value, pack);
                count += 1;
                offset = end + 1;
            }
            if (count !== pack.entryCount) throw new Error('服务器同步数据包记录数量不一致。');
            completed += 1;
            if (typeof options.onProgress === 'function') {
                options.onProgress(completed, packManifest.length);
            }
        }
        if (fragmentBytes || fragments.length) throw new Error('服务器同步记录尚未结束。');
        await consumer.finish();
    }

    function buildPackSnapshotChecksumSource(snapshot) {
        return JSON.stringify([
            SNAPSHOT_FORMAT,
            SNAPSHOT_SCHEMA_VERSION,
            Number(snapshot.totalBytes || 0),
            Number(snapshot.packCount || 0),
            Number(snapshot.entryCount || 0),
            (snapshot.packManifest || []).map((pack) => [
                String(pack.bucketKey),
                String(pack.group),
                Number(pack.part),
                String(pack.checksum).toLowerCase(),
                Number(pack.length),
                Number(pack.entryCount)
            ])
        ]);
    }

    async function validateRemotePackManifest(remote) {
        if (remote?.snapshotFormat !== SNAPSHOT_FORMAT
            || Number(remote?.schemaVersion) !== SNAPSHOT_SCHEMA_VERSION) {
            throw new Error('服务器同步格式不受支持。');
        }

        const packCount = Number(remote.packCount);
        const entryCount = Number(remote.entryCount);
        const totalBytes = Number(remote.totalBytes);
        const sourceManifest = Array.isArray(remote.packManifest) ? remote.packManifest : [];
        const emptySnapshot = packCount === 0 && entryCount === 0 && totalBytes === 0 && sourceManifest.length === 0;
        if (!Number.isInteger(packCount) || packCount < 0 || packCount > CONFIG.maxPackCount) {
            throw new Error('服务器同步数据包数量异常。');
        }
        if (!Number.isInteger(entryCount) || entryCount < 0 || entryCount > 10_000_000) {
            throw new Error('服务器同步记录数量异常。');
        }
        if (!Number.isInteger(totalBytes) || totalBytes < 0 || totalBytes > CONFIG.maxSnapshotBytes) {
            throw new Error(`服务器数据太大：${totalBytes}/${CONFIG.maxSnapshotBytes}。`);
        }
        if (!emptySnapshot && (packCount === 0 || entryCount === 0 || totalBytes === 0)) {
            throw new Error('服务器空快照字段必须同时为零。');
        }
        if (sourceManifest.length !== packCount) {
            throw new Error('服务器同步数据包清单数量不一致。');
        }

        let manifestBytes = 0;
        let manifestEntries = 0;
        const bucketParts = new Map();
        const packManifest = sourceManifest.map((pack) => {
            const bucketKey = String(pack?.bucketKey || '');
            const group = String(pack?.group || '');
            const part = Number(pack?.part);
            const checksum = String(pack?.checksum || '').toLowerCase();
            const length = Number(pack?.length);
            const entries = Number(pack?.entryCount);
            if (!bucketKey || bucketKey.length > 4000 || !group || group.length > 1000
                || !Number.isInteger(part) || part < 0) {
                throw new Error('服务器同步数据包索引异常。');
            }
            if (!/^[a-f0-9]{64}$/.test(checksum)) throw new Error('服务器同步数据包校验码异常。');
            if (!Number.isInteger(length) || length <= 0 || length > CONFIG.targetPackBytes) {
                throw new Error('服务器同步数据包大小异常。');
            }
            if (!Number.isInteger(entries) || entries < 0 || entries > CONFIG.maxPackEntries) {
                throw new Error('服务器同步数据包记录数量异常。');
            }
            const bucketState = bucketParts.get(bucketKey) || { group, nextPart: 0 };
            if (bucketState.group !== group || part !== bucketState.nextPart) {
                throw new Error('服务器同步数据包顺序异常。');
            }
            bucketState.nextPart += 1;
            bucketParts.set(bucketKey, bucketState);
            manifestBytes += length;
            manifestEntries += entries;
            return { bucketKey, group, part, checksum, length, entryCount: entries };
        });
        if (manifestBytes !== totalBytes) {
            throw new Error('服务器同步数据包大小合计不一致。');
        }
        if (manifestEntries !== entryCount) {
            throw new Error('服务器同步记录数量不一致。');
        }

        const expectedChecksum = await sha256(buildPackSnapshotChecksumSource({
            totalBytes,
            packCount,
            entryCount,
            packManifest
        }));
        if (String(remote.checksum || '').toLowerCase() !== expectedChecksum) {
            throw new Error('服务器同步清单校验失败。');
        }
        return packManifest;
    }

    async function rebuildLocalSyncCacheFromStaging(stagingDb, packManifest, remote) {
        const cacheDb = await openLocalSyncCache();
        try {
            await cacheClear(cacheDb);
            let pending = [];
            let pendingBytes = 0;
            let entryCount = 0;
            await parseStagedPackSnapshot(stagingDb, packManifest, {
                async consume(value, pack) {
                    const entry = buildCacheEntry(value);
                    if (entry.bucketKey !== pack.bucketKey || entry.group !== pack.group) {
                        throw new Error('服务器同步缓存索引不一致。');
                    }
                    pending.push(entry);
                    pendingBytes += entry.bytes.byteLength;
                    entryCount += 1;
                    if (pendingBytes >= CONFIG.cacheWriteBytes || pending.length >= CONFIG.readBatchSize) {
                        await cacheWriteEntries(cacheDb, pending);
                        pending = [];
                        pendingBytes = 0;
                    }
                },
                async finish() { await cacheWriteEntries(cacheDb, pending); }
            });
            for (let index = 0; index < packManifest.length; index += 1) {
                const pack = packManifest[index];
                const bytes = await readDownloadStagingObject(stagingDb, index);
                await cachePack(cacheDb, pack.checksum, bytes);
            }
            if (entryCount !== Number(remote.entryCount)) {
                throw new Error('服务器同步缓存记录数量不一致。');
            }
            const snapshot = {
                snapshotFormat: SNAPSHOT_FORMAT,
                schemaVersion: SNAPSHOT_SCHEMA_VERSION,
                packCount: Number(remote.packCount),
                entryCount: Number(remote.entryCount),
                totalBytes: Number(remote.totalBytes),
                packManifest: packManifest.map(pack => ({ ...pack })),
                checksum: String(remote.checksum).toLowerCase()
            };
            await cacheWriteState(cacheDb, {
                version: CACHE_FORMAT_VERSION,
                groups: [...new Set(packManifest.map(pack => pack.group))],
                packs: packManifest.map(pack => ({ ...pack })),
                epoch: localStorage.getItem(TRACKING_EPOCH_KEY),
                epochs: (await readDirtyState()).epochs,
                snapshot
            });
            localStorage.setItem(BASELINE_KEY, JSON.stringify({ version: remote.version, checksum: remote.checksum }));
            await window.RPH_SYNC_TRACKER.acknowledge(remote.restoreWatermark);
        } catch (error) {
            await cacheClear(cacheDb);
            throw error;
        } finally {
            cacheDb.close();
        }
    }

    async function restorePackSnapshot(remote) {
        const packManifest = await validateRemotePackManifest(remote);
        const stagingDb = await openDownloadStagingDb();

        try {
            await downloadPacksToStaging(remote, packManifest, stagingDb);
            updateProgress(72, '正在校验…');
            await parseStagedPackSnapshot(
                stagingDb,
                packManifest,
                new ObjectSnapshotRestorer(remote.entryCount, { validateOnly: true })
            );
            updateProgress(82, '正在应用…');
            const restoreEpoch = crypto.randomUUID();
            const restorer = new ObjectSnapshotRestorer(remote.entryCount);
            try {
                localStorage.setItem(RESTORE_ACTIVE_KEY, restoreEpoch);
                localStorage.setItem(RESTORE_EPOCH_KEY, restoreEpoch);
                await withRestoreWriteLock(async () => {
                    await waitForIndexedDbWriteBarrier();
                    const restoreWatermark = (await readDirtyState()).watermark;
                    await parseStagedPackSnapshot(stagingDb, packManifest, restorer, {
                        onProgress: (completed, total) => {
                            const percent = Math.round((completed / total) * 100);
                            updateProgress(82 + Math.round(percent * 0.16), '正在应用…');
                        }
                    });
                    await rebuildLocalSyncCacheFromStaging(stagingDb, packManifest, { ...remote, restoreWatermark });
                    if (localStorage.getItem(RESTORE_ACTIVE_KEY) === restoreEpoch) localStorage.removeItem(RESTORE_ACTIVE_KEY);
                });
            } catch (error) {
                restorer.abort();
                throw error;
            }
        } finally {
            try { await clearDownloadStagingStore(stagingDb); } catch (_) { }
            stagingDb.close();
        }
    }

    function buildSyncHeaders(options = {}, withContentType = true) {
        const headers = withContentType ? { 'content-type': 'application/json' } : {};
        const password = typeof options.password === 'string' ? options.password : getStoredSyncPassword();
        if (password) {
            headers['x-rp-sync-password'] = password;
        }
        return headers;
    }

    function shouldRetrySyncError(error) {
        const status = Number(error?.status || 0);
        return !status || status === 408 || status === 429 || status >= 500;
    }

    async function withSyncRetry(options, send) {
        const retryCount = Number.isInteger(options.retryCount) ? options.retryCount : CONFIG.retryCount;
        const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : CONFIG.requestTimeoutMs;
        const abortMessage = options.abortMessage || '同步请求超时，请检查网络后重试。';
        let lastError = null;

        for (let attempt = 0; attempt <= retryCount; attempt += 1) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
            try {
                return await send(controller.signal);
            } catch (error) {
                const isAbort = error?.name === 'AbortError';
                const status = isAbort ? 0 : error?.status;
                const normalizedError = isAbort
                    ? new Error(abortMessage)
                    : (error instanceof Error ? error : new Error(String(error)));
                lastError = Object.assign(normalizedError, { status });
                if (attempt >= retryCount || !shouldRetrySyncError(lastError)) {
                    throw lastError;
                }
                await wait(CONFIG.retryDelayMs * (attempt + 1));
            } finally {
                clearTimeout(timeoutId);
            }
        }

        throw lastError || new Error('同步请求失败。');
    }

    function throwSyncHttpError(response, data, keepPasswordOnAuthError) {
        if (response.status === 401 && !keepPasswordOnAuthError) {
            clearStoredSyncPassword();
        }
        throw Object.assign(
            new Error(data?.error || `HTTP ${response.status}`),
            { response: data, status: response.status }
        );
    }

    async function postSync(payload, options = {}) {
        return withSyncRetry(options, async signal => {
            const response = await fetch(CONFIG.apiEndpoint, {
                method: 'POST',
                headers: buildSyncHeaders(options),
                body: JSON.stringify(payload),
                credentials: 'same-origin',
                signal
            });

            const data = await response.json().catch(() => ({}));
            if (!response.ok || !data.ok) throwSyncHttpError(response, data, options.keepPasswordOnAuthError);
            return data;
        });
    }

    async function postSyncBinary(payload, options = {}) {
        return withSyncRetry(options, async signal => {
            const response = await fetch(CONFIG.apiEndpoint, {
                method: 'POST',
                headers: buildSyncHeaders(options),
                body: JSON.stringify(payload),
                credentials: 'same-origin',
                signal
            });

            if (!response.ok) {
                throwSyncHttpError(response, await response.json().catch(() => ({})), options.keepPasswordOnAuthError);
            }
            return new Uint8Array(await response.arrayBuffer());
        });
    }

    function buildUploadBatchBody(records) {
        const manifest = textEncoder.encode(JSON.stringify(records.map(record => ({
            checksum: record.checksum,
            length: record.length
        }))));
        const prefix = new Uint8Array(4);
        new DataView(prefix.buffer).setUint32(0, manifest.byteLength);
        return new Blob([prefix, manifest, ...records.map(record => record.bytes)], { type: 'application/octet-stream' });
    }

    async function postUploadPackBatch(records) {
        const body = buildUploadBatchBody(records);
        // Blob owns this bounded batch; retries reuse it without cloning the source packs again.
        records.forEach(record => { record.bytes = null; });
        const params = new URLSearchParams({ action: 'upload-pack-batch' });

        return withSyncRetry({
            timeoutMs: CONFIG.packTransferTimeoutMs,
            abortMessage: '上传超时，请检查网络后重试。'
        }, async signal => {
            const response = await fetch(`${CONFIG.apiEndpoint}?${params.toString()}`, {
                method: 'POST',
                headers: buildSyncHeaders({}, false),
                body,
                credentials: 'same-origin',
                signal
            });
            if (!response.ok) {
                throwSyncHttpError(response, await response.json().catch(() => ({})));
            }
        });
    }


    async function prepareLocalSnapshot(progressStart, progressEnd) {
        const cacheDb = await openLocalSyncCache();
        try {
            const dirty = await readDirtyState();
            const baseline = readBaseline();
            let state = await cacheReadState(cacheDb);
            const rebuild = localStorage.getItem('rp_sync_rebuild_requested') === '1';
            const epoch = localStorage.getItem(TRACKING_EPOCH_KEY);
            const journalReset = state?.epochs && Object.entries(state.epochs).some(([name, value]) => dirty.epochs[name] !== value);
            if (!rebuild && (baseline || state) && (state?.version !== CACHE_FORMAT_VERSION || !state.snapshot || state.epoch !== epoch || journalReset)) {
                const error = new Error('本地同步索引缺失、过期或追踪已重置，需要完整重建索引后才能继续上传（只读本地数据，不会覆盖云端）。');
                error.indexInvalid = true;
                throw error;
            }
            let result;
            if (rebuild || !state) {
                result = await buildFullCachedSnapshot(cacheDb, progressStart, progressEnd);
            } else {
                result = await updateCachedSnapshot(cacheDb, state, dirty);
            }
            state = result.state;
            state.epoch = epoch;
            state.epochs = dirty.epochs;
            await cacheWriteState(cacheDb, state);
            localStorage.removeItem('rp_sync_rebuild_requested');
            await pruneCachedPacks(cacheDb, state.snapshot.packManifest);
            return { snapshot: state.snapshot, watermark: dirty.watermark };
        } finally {
            cacheDb.close();
        }
    }

    async function* iterateMissingUploadPacks(snapshot, remotePackManifest) {
        // 直接用基线远端快照的分片清单作种子：已提交到远端的分片必然已在 R2 中，
        // 不再每次上传都列举全部历史分片（原来是每次 O(历史分片数/1000) 个请求）。
        // 中断上传等异常由提交时服务器的 409 missingPacks 定向补传兜底。
        const available = new Set((Array.isArray(remotePackManifest) ? remotePackManifest : [])
            .map(pack => `${pack.checksum}:${pack.length}`));
        const yielded = new Set();
        for (const pack of snapshot.packManifest) {
            const key = `${pack.checksum}:${pack.length}`;
            if (available.has(key) || yielded.has(pack.checksum)) continue;
            yielded.add(pack.checksum);
            yield pack;
        }
    }

    async function uploadCachedSnapshot(packSource, totalBytes, progressStart, progressEnd) {
        const cacheDb = await openLocalSyncCache();
        try {
            const engine = window.RPH_SYNC_UPLOAD_ENGINE;
            if (!engine?.runBoundedUpload) throw new Error('上传引擎未就绪，请刷新页面后重试。');
            await engine.runBoundedUpload({
                items: packSource,
                concurrency: CONFIG.uploadBatchConcurrency,
                maxItems: CONFIG.uploadBatchMaxPacks,
                maxBytes: CONFIG.uploadBatchMaxBytes,
                read: async pack => {
                    const bytes = await cachePack(cacheDb, pack.checksum);
                    if (!bytes || bytes.byteLength !== pack.length) {
                        await cacheWriteState(cacheDb, null);
                        throw new Error('本地同步缓存不完整，请重新上传。');
                    }
                    return { bytes };
                },
                send: postUploadPackBatch,
                onBatchSuccess: ({ bytes }) => {
                    const ratio = totalBytes > 0 ? Math.min(1, bytes / totalBytes) : 1;
                    updateProgress(progressStart + Math.round(ratio * (progressEnd - progressStart)), '正在按分片上传…');
                }
            });
        } finally {
            cacheDb.close();
        }
    }

    function updateProgress(progress, text) {
        state.progress = Math.max(0, Math.min(100, progress));
        state.statusText = text || state.statusText;
        modalRoot?.classList.remove('is-error');
        if (modalProgressBar) {
            modalProgressBar.style.width = `${state.progress}%`;
        }
        if (modalProgressValue) {
            modalProgressValue.textContent = `${Math.round(state.progress)}%`;
        }
        if (modalStatus) {
            modalStatus.textContent = state.statusText;
        }
    }

    function showSyncError(error) {
        state.statusText = error?.message || '同步失败，请重试。';
        if (modalStatus) modalStatus.textContent = state.statusText;
        modalRoot?.classList.add('is-error');
    }

    function setActionButtonsDisabled(disabled) {
        if (pullButton) pullButton.disabled = disabled;
        if (pushButton) pushButton.disabled = disabled;
    }

    function getAppPersistenceProxy() {
        const proxy = window.RPH_SYNC_PERSISTENCE;
        if (!proxy || typeof proxy.manualSave !== 'function') {
            throw new Error('应用保存接口尚未就绪，请刷新页面后重试。');
        }
        return proxy;
    }

    async function flushAppState() {
        const proxy = getAppPersistenceProxy();
        await proxy.manualSave();
    }

    async function getAuthStatus(password = getStoredSyncPassword()) {
        return postSync({ action: 'auth-status' }, {
            password,
            keepPasswordOnAuthError: true
        });
    }

    function ensurePasswordModal() {
        if (passwordModalRoot) return;

        passwordModalRoot = document.createElement('div');
        passwordModalRoot.className = 'rp-sync-modal rp-sync-password-modal';
        passwordModalRoot.innerHTML = `
            <div class="rp-sync-modal__backdrop"></div>
            <form class="rp-sync-modal__panel rp-sync-password-panel">
                <div class="rp-sync-modal__header">
                    <div>
                        <div class="rp-sync-modal__eyebrow">云端访问</div>
                        <h3 class="rp-sync-modal__title">同步密码</h3>
                    </div>
                    <button type="button" class="rp-sync-modal__close" aria-label="关闭">×</button>
                </div>
                <p class="rp-sync-modal__intro">请输入访问密码。</p>
                <label class="rp-sync-password-field">
                    <span>密码</span>
                    <input type="password" autocomplete="current-password" placeholder="请输入同步密码">
                </label>
                <p class="rp-sync-password-status">请输入同步密码。</p>
                <div class="rp-sync-modal__actions">
                    <button type="button" class="rp-sync-modal__button" data-action="cancel-password">取消</button>
                    <button type="submit" class="rp-sync-modal__button is-primary" data-action="submit-password">继续同步</button>
                </div>
            </form>
        `;

        document.body.appendChild(passwordModalRoot);
        passwordInput = passwordModalRoot.querySelector('input');
        passwordStatus = passwordModalRoot.querySelector('.rp-sync-password-status');
        passwordSubmitButton = passwordModalRoot.querySelector('[data-action="submit-password"]');

        const closePasswordModal = () => {
            if (checkingPassword) return;
            passwordModalRoot.classList.remove('is-open');
        };

        passwordModalRoot.querySelector('.rp-sync-modal__close').addEventListener('click', closePasswordModal);
        passwordModalRoot.querySelector('[data-action="cancel-password"]').addEventListener('click', closePasswordModal);
        passwordModalRoot.querySelector('.rp-sync-modal__backdrop').addEventListener('click', closePasswordModal);
        passwordModalRoot.querySelector('form').addEventListener('submit', (event) => {
            event.preventDefault();
            submitSyncPassword().catch(() => { });
        });
    }

    function openPasswordModal(message = '请输入同步密码。') {
        ensurePasswordModal();
        passwordStatus.textContent = message;
        passwordInput.value = '';
        passwordSubmitButton.disabled = false;
        passwordModalRoot.classList.add('is-open');
        setTimeout(() => passwordInput.focus(), 0);
    }

    function openSyncPanel() {
        state.statusText = '请选择同步方向。';
        state.progress = 0;
        openModal();
    }

    async function submitSyncPassword() {
        if (checkingPassword) return;

        const password = passwordInput.value;
        if (!password) {
            passwordStatus.textContent = '请输入同步密码。';
            passwordInput.focus();
            return;
        }

        checkingPassword = true;
        passwordSubmitButton.disabled = true;
        passwordStatus.textContent = '验证中…';

        try {
            const auth = await getAuthStatus(password);
            if (auth.authRequired && !auth.authenticated) {
                clearStoredSyncPassword();
                passwordStatus.textContent = '密码不正确，请重新输入。';
                passwordInput.select();
                return;
            }

            if (auth.authRequired) {
                saveStoredSyncPassword(password);
            } else {
                clearStoredSyncPassword();
            }
            passwordModalRoot.classList.remove('is-open');
            if (RESTORE_PAGE) pullFromServer().catch(showSyncError);
            else openSyncPanel();
        } catch (error) {
            passwordStatus.textContent = error.message || '密码验证失败，请稍后再试。';
        } finally {
            checkingPassword = false;
            passwordSubmitButton.disabled = false;
        }
    }

    async function handleSyncButtonClick() {
        if (state.syncing || checkingPassword) return;
        openModal();
        setActionButtonsDisabled(true);
        updateProgress(0, '正在连接…');
        checkingPassword = true;
        try {
            const auth = await getAuthStatus();
            if (!auth.authRequired || auth.authenticated) {
                updateProgress(0, '选择同步方向');
                setActionButtonsDisabled(false);
                return;
            }

            clearStoredSyncPassword();
            closeModal();
            openPasswordModal('请输入同步密码后继续。');
        } catch (error) {
            if (error.status === 401) {
                clearStoredSyncPassword();
                closeModal();
                openPasswordModal('请输入同步密码后继续。');
                return;
            }

            showSyncError(error);
        } finally {
            checkingPassword = false;
        }
    }

    function ensureModal() {
        if (modalRoot) return;

        modalRoot = document.createElement('div');
        modalRoot.className = 'rp-sync-modal';
        modalRoot.innerHTML = `
            <div class="rp-sync-modal__backdrop"></div>
            <div class="rp-sync-modal__panel">
                <div class="rp-sync-modal__header">
                    <h3 class="rp-sync-modal__title">
                        <span class="rp-sync-modal__title-main">云同步</span>
                    </h3>
                    <button type="button" class="rp-sync-modal__close" aria-label="关闭">×</button>
                </div>
                <div class="rp-sync-main-actions">
                    <button type="button" class="rp-sync-action-button is-primary" data-action="push">上传到云端</button>
                    <button type="button" class="rp-sync-action-button" data-action="pull">从云端恢复</button>
                    <button type="button" class="rp-sync-action-button" data-action="rebuild">重建本地索引</button>
                </div>
                <p class="rp-sync-modal__status">选择同步</p>
                <div class="rp-sync-progress">
                    <div class="rp-sync-progress__bar"></div>
                </div>
                <div class="rp-sync-progress__value">0%</div>
            </div>
        `;

        document.body.appendChild(modalRoot);
        modalStatus = modalRoot.querySelector('.rp-sync-modal__status');
        modalProgressBar = modalRoot.querySelector('.rp-sync-progress__bar');
        modalProgressValue = modalRoot.querySelector('.rp-sync-progress__value');
        pullButton = modalRoot.querySelector('[data-action="pull"]');
        pushButton = modalRoot.querySelector('[data-action="push"]');
        rebuildButton = modalRoot.querySelector('[data-action="rebuild"]');
        // 重建是恢复手段不是常规操作：默认隐藏。推送遇索引错误时经确认
        // 自动重建并继续；拒绝时才显示按钮走手动路径。
        rebuildButton.style.display = 'none';

        const closeButton = modalRoot.querySelector('.rp-sync-modal__close');
        if (RESTORE_PAGE) {
            modalRoot.classList.add('rp-sync-modal--restore');
            pullButton.textContent = '重新恢复';
            pushButton.style.display = 'none';
            closeButton.textContent = '返回';
            closeButton.setAttribute('aria-label', '返回');
        }
        closeButton.addEventListener('click', () => {
            if (RESTORE_PAGE && !state.syncing) {
                location.replace('/');
                return;
            }
            closeModal();
        });
        modalRoot.querySelector('.rp-sync-modal__backdrop').addEventListener('click', () => {
            if (!state.syncing) closeModal();
        });
        if (pullButton) pullButton.addEventListener('click', () => {
            if (RESTORE_PAGE) { pullFromServer().catch(showSyncError); return; }
            if (confirm('从云端恢复将替换此浏览器的本地数据，其他已打开的页面会刷新。继续吗？')) location.assign('/sync-restore');
        });
        modalRoot.querySelector('[data-action="rebuild"]').addEventListener('click', async () => {
            if (state.syncing || !confirm('这会完整读取本地数据重建索引，但不会上传或覆盖云端。请先导出本地数据备份。继续吗？')) return;
            await withCrossTabSyncLock(async () => {
                state.syncing = true;
                try {
                    setActionButtonsDisabled(true);
                    await flushAppState();
                    requestExplicitRebuild();
                    await prepareLocalSnapshot(5, 95);
                    updateProgress(100, '本地索引已重建，云端未修改。');
                } catch (error) { showSyncError(error); }
                finally { state.syncing = false; setActionButtonsDisabled(false); }
            });
        });
        pushButton.addEventListener('click', () => pushToServer().catch(() => { }));
    }

    function openModal() {
        ensureModal();
        modalRoot.classList.add('is-open');
        updateProgress(state.progress, state.statusText || '选择同步');
        setActionButtonsDisabled(state.syncing);
    }

    function closeModal() {
        if (state.syncing || !modalRoot) return;
        modalRoot.classList.remove('is-open');
    }

    async function commitObjectSnapshot(progress) {
        updateProgress(progress.check, '准备中…');
        const statusResponse = await postSync({ action: 'prepare-upload', schemaVersion: SNAPSHOT_SCHEMA_VERSION }, {
            timeoutMs: CONFIG.commitTimeoutMs
        });
        const baseline = readBaseline();
        let baseRemote = statusResponse.remote || null;
        let baseVersion = Number(baseline?.version || 0);
        let baseChecksum = baseline?.checksum || '';
        let incremental;
        try {
            incremental = await prepareLocalSnapshot(progress.check, progress.uploadStart);
        } catch (err) {
            if (!err?.indexInvalid) throw err;
            // 索引过期不再要求用户离开当前流程：一次确认后自动重建并继续
            // 上传。重建只读本地数据；云端若被别端更新过，后续提交仍会被
            // 基线比对拦下，这里不会造成静默覆盖。
            if (!confirm('本地同步索引缺失、过期或追踪已重置，需要完整扫描本地数据重建索引后才能继续上传。\n\n重建只读取本地数据，不会覆盖云端；云端若被别端更新过，上传仍会被基线比对拦下。大库可能需要几分钟。继续吗？')) {
                if (rebuildButton) rebuildButton.style.display = '';
                throw err;
            }
            updateProgress(progress.check, '正在完整重建本地索引…');
            requestExplicitRebuild();
            incremental = await prepareLocalSnapshot(progress.check, progress.uploadStart);
        }
        const snapshot = incremental.snapshot;
        if (statusResponse.resetRequired) {
            updateProgress(progress.check, '正在一次性清理旧云端同步数据…');
            let cursor;
            do {
                const migration = await postSync({ action: 'reset-upload', schemaVersion: SNAPSHOT_SCHEMA_VERSION, cursor });
                cursor = migration.cursor || null;
            } while (cursor);
            // One-time schema 12 cleanup wiped the remote dataset; the old
            // acknowledged baseline no longer refers to any cloud version.
            localStorage.removeItem(BASELINE_KEY);
            baseRemote = null;
            baseVersion = 0;
            baseChecksum = '';
        }
        if (baseRemote?.checksum === snapshot.checksum) {
            localStorage.setItem(BASELINE_KEY, JSON.stringify({ version: baseRemote.version, checksum: snapshot.checksum }));
            await window.RPH_SYNC_TRACKER.acknowledge(incremental.watermark);
            return true;
        }
        if (Number(baseRemote?.version || 0) !== baseVersion || (baseRemote && baseRemote.checksum !== baseline?.checksum)) {
            throw new Error('云端与此浏览器的已确认基线不同，已停止上传以防覆盖。请先导出本地数据，再恢复云端并合并本地修改。');
        }

        updateProgress(progress.uploadStart, '正在上传…');
        await uploadCachedSnapshot(
            iterateMissingUploadPacks(snapshot, baseRemote?.packManifest),
            snapshot.totalBytes,
            progress.uploadStart,
            progress.uploadEnd
        );

        updateProgress(progress.commit, '即将完成…');
        const payload = {
            action: 'upload-complete',
            baseVersion,
            baseChecksum,
            checksum: snapshot.checksum,
            snapshotFormat: snapshot.snapshotFormat,
            schemaVersion: snapshot.schemaVersion,
            packCount: snapshot.packCount,
            entryCount: snapshot.entryCount,
            totalBytes: snapshot.totalBytes,
            packManifest: snapshot.packManifest
        };
        const submit = () => postSync(payload, { retryCount: 1, timeoutMs: CONFIG.commitTimeoutMs });
        let commitResponse;
        try {
            commitResponse = await submit();
        } catch (error) {
            if (error.status !== 409 || !Array.isArray(error.response?.missingPacks)) throw error;
            const missing = new Set(error.response.missingPacks);
            const packs = snapshot.packManifest.filter(pack => missing.has(pack.checksum));
            await uploadCachedSnapshot(
                (async function* () {
                    const unique = new Set();
                    for (const pack of packs) {
                        if (unique.has(pack.checksum)) continue;
                        unique.add(pack.checksum);
                        yield pack;
                    }
                })(),
                snapshot.totalBytes,
                progress.uploadEnd,
                progress.commit
            );
            commitResponse = await submit();
        }
        if (commitResponse.checksum !== snapshot.checksum) {
            throw new Error('服务器没有确认新快照。');
        }
        localStorage.setItem(BASELINE_KEY, JSON.stringify({ version: commitResponse.version, checksum: snapshot.checksum }));
        await window.RPH_SYNC_TRACKER.acknowledge(incremental.watermark);
        return baseRemote?.checksum === snapshot.checksum;
    }

    async function pullFromServerUnlocked() {
        if (state.syncing) return;

        state.syncing = true;

        try {
            openModal();
            setActionButtonsDisabled(true);
            await waitForIndexedDbWriteBarrier();
            updateProgress(4, '正在连接…');
            const manifestResponse = await postSync({ action: 'pull-manifest', schemaVersion: SNAPSHOT_SCHEMA_VERSION });
            if (manifestResponse.resetRequired) {
                throw new Error('云端同步存储尚未完成升级清理。请先在主页面执行一次“上传到云端”，再回到此页恢复。');
            }
            const remote = manifestResponse.remote;

            if (!remote) {
                updateProgress(100, '暂无云端数据');
                setActionButtonsDisabled(false);
                if (RESTORE_PAGE) setTimeout(() => location.replace('/'), 700);
                return;
            }
            if (Number(remote.totalBytes || 0) > CONFIG.maxSnapshotBytes) {
                throw new Error(`服务器数据太大：${remote.totalBytes}/${CONFIG.maxSnapshotBytes}。`);
            }

            if (remote.snapshotFormat !== SNAPSHOT_FORMAT) {
                throw new Error('服务器快照格式不受支持。');
            }
            updateProgress(8, '正在下载…');
            await restorePackSnapshot(remote);

            updateProgress(100, '已完成，正在刷新…');
            setTimeout(() => {
                if (RESTORE_PAGE) location.replace('/');
                else location.reload();
            }, 700);
        } catch (error) {
            showSyncError(error);
            if (error.status === 401) openPasswordModal('请输入同步密码后恢复。');
            setActionButtonsDisabled(false);
        } finally {
            state.syncing = false;
        }
    }

    async function pushToServerUnlocked() {
        if (state.syncing) return;

        state.syncing = true;

        try {
            openModal();
            setActionButtonsDisabled(true);
            updateProgress(8, '准备中…');
            await flushAppState();
            await waitForIndexedDbWriteBarrier();

            const alreadyUpToDate = await commitObjectSnapshot({
                check: 30,
                uploadStart: 36,
                uploadEnd: 88,
                commit: 92
            });
            if (alreadyUpToDate) {
                updateProgress(100, '已是最新');
                setActionButtonsDisabled(false);
                return;
            }

            updateProgress(100, '已完成');
            setActionButtonsDisabled(false);
        } catch (error) {
            showSyncError(error);
            setActionButtonsDisabled(false);
        } finally {
            state.syncing = false;
        }
    }

    const pullFromServer = () => withCrossTabSyncLock(pullFromServerUnlocked);
    const pushToServer = () => withCrossTabSyncLock(pushToServerUnlocked);

    window.RPH_R2_OPEN_SYNC = () => {
        handleSyncButtonClick().catch(() => { });
    };

    if (RESTORE_PAGE) {
        const beginRestore = () => {
            ensureModal();
            openModal();
            pullFromServer().catch(() => { });
        };
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', beginRestore, { once: true });
        } else {
            beginRestore();
        }
    } else if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            ensureModal();
        }, { once: true });
    } else {
        ensureModal();
    }
})();

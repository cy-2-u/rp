(function () {
    if (window.__RPH_SYNC_DIRTY_TRACKING__) return;
    window.__RPH_SYNC_DIRTY_TRACKING__ = true;

    const DIRTY_STATE_KEY = 'rp_sync_dirty_v1';
    const EXCLUDED_DATABASES = new Set(['RPHubSyncCache', 'RPHubSyncStaging']);
    const RESTORE_ACTIVE_KEY = 'rp_sync_restore_active';
    const RESTORE_EPOCH_KEY = 'rp_sync_restore_epoch';
    const initialRestoreEpoch = localStorage.getItem(RESTORE_EPOCH_KEY);
    let restorePaused = Boolean(localStorage.getItem(RESTORE_ACTIVE_KEY));
    let releaseWriterLease = null;
    const acquireWriterLease = () => {
        if (!navigator.locks?.request || restorePaused) return;
        navigator.locks.request('rp-hub-app-writers-v1', { mode: 'shared' }, () => {
            if (restorePaused || localStorage.getItem(RESTORE_ACTIVE_KEY)) return;
            return new Promise(resolve => { releaseWriterLease = resolve; });
        });
    };
    const isAppKey = key => String(key).startsWith('rp_hub_') || String(key).startsWith('ai_chargen_');

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
            releaseWriterLease?.();
            releaseWriterLease = null;
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
        if (localStorage.getItem(RESTORE_ACTIVE_KEY) !== active
            || locks.held.some(lock => lock.name === 'rp-hub-r2-sync-v1')) return;
        showRestorePause();
        const overlay = document.getElementById('rp-sync-restore-pause');
        if (overlay) overlay.innerHTML = '上次恢复已中断，请重新从云端恢复。<a href="/sync-restore" style="color:#2563eb">重新恢复</a>';
    };
    window.addEventListener('storage', event => {
        if (event.key === RESTORE_ACTIVE_KEY || event.key === RESTORE_EPOCH_KEY) checkRestoreState();
    });
    window.addEventListener('pageshow', event => {
        checkInterruptedRestore();
        if (event.persisted && !restorePaused) acquireWriterLease();
    });
    window.addEventListener('focus', checkInterruptedRestore);
    window.addEventListener('pagehide', () => {
        releaseWriterLease?.();
        releaseWriterLease = null;
    });
    document.addEventListener('DOMContentLoaded', checkInterruptedRestore, { once: true });
    acquireWriterLease();
    const assertStoreWritable = store => {
        if (['RPHubDB', 'AICharGen'].includes(store?.transaction?.db?.name)) assertWritable();
    };

    const readState = () => {
        try {
            const value = JSON.parse(localStorage.getItem(DIRTY_STATE_KEY) || '{}');
            return {
                revision: Number.isSafeInteger(value?.revision) && value.revision >= 0 ? value.revision : 0,
                all: value?.all === true,
                localStorage: new Set(Array.isArray(value?.localStorage) ? value.localStorage : []),
                stores: new Map(Object.entries(value?.stores || {}).map(([name, item]) => [name, {
                    all: item?.all === true,
                    keys: new Set(Array.isArray(item?.keys) ? item.keys : [])
                }]))
            };
        } catch (_) {
            return { revision: 0, all: true, localStorage: new Set(), stores: new Map() };
        }
    };

    const writeState = state => {
        const stores = {};
        for (const [name, item] of state.stores) {
            stores[name] = { all: item.all === true, keys: [...item.keys].slice(0, 5000) };
        }
        localStorage.setItem(DIRTY_STATE_KEY, JSON.stringify({
            revision: state.revision,
            all: state.all === true,
            localStorage: [...state.localStorage].slice(0, 5000),
            stores
        }));
    };

    const markLocalStorage = (key, all = false) => {
        const name = String(key);
        if (!all && (name.startsWith('rp_hub_sync_')
            || (!name.startsWith('rp_hub_') && !name.startsWith('ai_chargen_')))) return;
        const state = readState();
        if (all) state.all = true;
        else if (!state.all) state.localStorage.add(name);
        if (state.localStorage.size > 5000) state.all = true;
        state.revision += 1;
        writeState(state);
    };

    const markStore = (store, key, all = false) => {
        const database = store?.transaction?.db?.name;
        if (!database || !store.name || EXCLUDED_DATABASES.has(database)) return;
        if (database === 'RPHubDB' && store.name === 'store' && key === 'rp_hub_presets') return;
        const state = readState();
        const name = `${database}/${store.name}`;
        const item = state.stores.get(name) || { all: false, keys: new Set() };
        if (all || key === undefined) item.all = true;
        else if (!state.all && !item.all) item.keys.add(JSON.stringify(key));
        if (item.keys.size > 5000) item.all = true;
        state.stores.set(name, item);
        state.revision += 1;
        writeState(state);
    };

    const storageSetItem = Storage.prototype.setItem;
    const storageRemoveItem = Storage.prototype.removeItem;
    const storageClear = Storage.prototype.clear;
    Storage.prototype.setItem = function (key, value) {
        if (this === localStorage && isAppKey(key)) assertWritable();
        const result = storageSetItem.call(this, key, value);
        if (this === localStorage && key !== DIRTY_STATE_KEY) {
            try { markLocalStorage(key); } catch (_) { }
        }
        return result;
    };
    Storage.prototype.removeItem = function (key) {
        if (this === localStorage && isAppKey(key)) assertWritable();
        const result = storageRemoveItem.call(this, key);
        if (this === localStorage && key !== DIRTY_STATE_KEY) {
            try { markLocalStorage(key); } catch (_) { }
        }
        return result;
    };
    Storage.prototype.clear = function () {
        if (this === localStorage) assertWritable();
        const result = storageClear.call(this);
        if (this === localStorage) {
            try { markLocalStorage('', true); } catch (_) { }
        }
        return result;
    };

    const keyFromValue = (store, value, explicitKey) => {
        if (explicitKey !== undefined) return explicitKey;
        if (typeof store.keyPath === 'string' && value && typeof value === 'object') return value[store.keyPath];
        return undefined;
    };
    const objectStorePut = IDBObjectStore.prototype.put;
    const objectStoreAdd = IDBObjectStore.prototype.add;
    const objectStoreDelete = IDBObjectStore.prototype.delete;
    const objectStoreClear = IDBObjectStore.prototype.clear;
    IDBObjectStore.prototype.put = function (value, key) {
        assertStoreWritable(this);
        try { markStore(this, keyFromValue(this, value, key)); } catch (_) { }
        return arguments.length > 1 ? objectStorePut.call(this, value, key) : objectStorePut.call(this, value);
    };
    IDBObjectStore.prototype.add = function (value, key) {
        assertStoreWritable(this);
        try { markStore(this, keyFromValue(this, value, key)); } catch (_) { }
        return arguments.length > 1 ? objectStoreAdd.call(this, value, key) : objectStoreAdd.call(this, value);
    };
    IDBObjectStore.prototype.delete = function (key) {
        assertStoreWritable(this);
        try { markStore(this, key); } catch (_) { }
        return objectStoreDelete.call(this, key);
    };
    IDBObjectStore.prototype.clear = function () {
        assertStoreWritable(this);
        try { markStore(this, undefined, true); } catch (_) { }
        return objectStoreClear.call(this);
    };
})();

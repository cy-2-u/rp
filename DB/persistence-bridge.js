(function () {
    const saves = new Set();
    const pendingWrites = new Set();
    const writeErrors = new Set();
    const transactionErrors = new WeakMap();
    const nativeTransaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) {
        const transaction = nativeTransaction.apply(this, args);
        if (args[1] === 'readwrite' && ['RPHubDB', 'AICharGen'].includes(this.name)) {
            const pending = new Promise(resolve => {
                transaction.addEventListener('complete', resolve, { once: true });
                transaction.addEventListener('abort', () => {
                    writeErrors.add(transactionErrors.get(transaction) || `${this.name}:*`);
                    resolve();
                }, { once: true });
            });
            pendingWrites.add(pending);
            pending.finally(() => pendingWrites.delete(pending));
        }
        return transaction;
    };
    const nativePut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
        const result = arguments.length > 1 ? nativePut.call(this, value, key) : nativePut.call(this, value);
        if (['RPHubDB', 'AICharGen'].includes(this.transaction.db.name)) {
            const identity = `${this.transaction.db.name}/${this.name}/${JSON.stringify(key)}`;
            transactionErrors.set(this.transaction, identity);
            this.transaction.addEventListener('complete', () => writeErrors.delete(identity), { once: true });
        }
        return result;
    };
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
            await Promise.all(pendingWrites);
            if (writeErrors.size) throw new Error('部分本地数据未保存，请先重试保存，暂不能上传。');
        }
    };
})();

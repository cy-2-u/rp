(function (global) {
    'use strict';

    function toAsyncIterator(source) {
        if (source && typeof source[Symbol.asyncIterator] === 'function') return source[Symbol.asyncIterator]();
        if (source && typeof source[Symbol.iterator] === 'function') {
            const iterator = source[Symbol.iterator]();
            return {
                next: async () => iterator.next()
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

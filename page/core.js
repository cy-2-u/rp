// 浏览器与模拟器共享的协议工具；不依赖作者应用。
(function (root) {
    'use strict';
    const encoder = new TextEncoder();
    const FORMAT = 'rp-sync-manifest-v2';
    const LIMIT = Object.freeze({ snapshot: 1024 ** 3, pack: 6 * 1024 ** 2, raw: 4 * 1024 ** 2, packs: 4096, entries: 512, object: 64 * 1024 ** 2 });
    const STORES = Object.freeze({ RPHubDB: ['store'], AICharGen: ['characters'] });
    const KEYS = Object.freeze({ journal: '__rp_sync_journal_v2', intent: 'rp_sync_intent_v2:', epoch: 'rp_sync_tracking_epoch_v2', active: 'rp_sync_restore_active', restoreEpoch: 'rp_sync_restore_epoch', password: 'rp_hub_sync_password_v1' });
    const appKey = key => typeof key === 'string' && !key.startsWith('rp_hub_sync_') && (key.startsWith('rp_hub_') || key.startsWith('ai_chargen_'));
    const excluded = (db, store, key) => db === 'RPHubDB' && store === 'store' && key === 'rp_hub_presets';
    const fail = (message, status = 400, details = {}) => Object.assign(new Error(message), { status, ...details });
    const hash = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', typeof bytes === 'string' ? encoder.encode(bytes) : bytes)), b => b.toString(16).padStart(2, '0')).join('');
    const checksumSource = m => JSON.stringify([FORMAT, m.compression, m.totalBytes, m.entryCount, m.packs.map(p => [p.bucket, p.checksum, p.length, p.entries])]);
    function canonical(value) {
        const seen = new Set();
        const visit = item => {
            if (item === null || typeof item !== 'object') {
                if (item === undefined || typeof item === 'bigint' || typeof item === 'function' || typeof item === 'symbol' || typeof item === 'number' && !Number.isFinite(item)) throw fail('数据包含非 JSON 值，同步已停止。');
                return item;
            }
            if (Object.prototype.toString.call(item) === '[object Date]') {
                if (!Number.isFinite(item.getTime())) throw fail('数据包含无效日期。');
                return item.toISOString();
            }
            const proto = Object.getPrototypeOf(item);
            if (seen.has(item) || !Array.isArray(item) && proto !== null && Object.getPrototypeOf(proto) !== null) throw fail('数据包含循环引用或非 JSON 对象。');
            seen.add(item);
            const result = Array.isArray(item) ? Array.from(item, x => visit(x === undefined ? null : x)) : Object.create(null);
            if (!Array.isArray(item)) for (const key of Object.keys(item).sort()) result[key] = visit(item[key]);
            seen.delete(item);
            return result;
        };
        return JSON.stringify(visit(value));
    }
    function normalizeManifest(m) {
        if (!m || m.format !== FORMAT || m.compression !== 'gzip' || !Number.isSafeInteger(m.version) || m.version < 1 || !Number.isFinite(m.updatedAt) || m.updatedAt <= 0 || !Array.isArray(m.packs) || m.packs.length > LIMIT.packs) throw fail('同步清单格式无效。', 409);
        let bytes = 0, entries = 0;
        const seen = new Set();
        const packs = m.packs.map(p => {
            if (typeof p.bucket !== 'string' || !p.bucket || p.bucket.length > 4000 || !/^[a-f0-9]{64}$/.test(p.checksum) || seen.has(p.checksum) || !Number.isSafeInteger(p.length) || p.length < 1 || p.length > LIMIT.pack || !Number.isSafeInteger(p.entries) || p.entries < 0 || p.entries > LIMIT.entries) throw fail('同步分片清单无效。', 409);
            seen.add(p.checksum); bytes += p.length; entries += p.entries;
            return { bucket: p.bucket, checksum: p.checksum, length: p.length, entries: p.entries };
        });
        if (bytes !== m.totalBytes || entries !== m.entryCount || bytes > LIMIT.snapshot || entries > 10000000 || !/^[a-f0-9]{64}$/.test(m.checksum)) throw fail('同步清单合计无效。', 409);
        return { format: FORMAT, compression: 'gzip', version: m.version, updatedAt: m.updatedAt, totalBytes: bytes, entryCount: entries, packs, checksum: m.checksum };
    }
    async function validateManifest(m) {
        const normalized = normalizeManifest(m);
        if (await hash(checksumSource(normalized)) !== normalized.checksum) throw fail('同步清单校验失败。', 409);
        return normalized;
    }
    async function bounded(message, limit, signal) {
        const reader = message.body?.getReader();
        if (!reader) return new Uint8Array();
        let size = 0;
        const chunks = [];
        const cancel = () => { void reader.cancel().catch(() => {}); };
        signal?.addEventListener('abort', cancel, { once: true });
        try {
            if (Number(message.headers?.get('content-length')) > limit) throw fail('正文超过大小上限。', 413);
            for (;;) {
                signal?.throwIfAborted();
                const { done, value } = await reader.read();
                signal?.throwIfAborted();
                if (done) break;
                size += value.byteLength;
                if (size > limit) throw fail('正文超过大小上限。', 413);
                chunks.push(value);
            }
            if (chunks.length === 1) return chunks[0];
            const out = new Uint8Array(size);
            let offset = 0;
            for (const part of chunks) { out.set(part, offset); offset += part.byteLength; }
            return out;
        } catch (error) { cancel(); throw error; }
        finally { signal?.removeEventListener('abort', cancel); reader.releaseLock(); }
    }
    async function jsonBody(message, limit = 1024 ** 2, signal) {
        const bytes = await bounded(message, limit, signal);
        try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
        catch { throw fail('JSON 正文无效。', 400); }
    }
    async function pool(items, count, fn) {
        const results = new Array(items.length);
        let next = 0, error;
        await Promise.all(Array.from({ length: Math.min(count, items.length) }, async () => {
            while (!error && next < items.length) {
                const i = next++;
                try { results[i] = await fn(items[i], i); } catch (e) { error ||= e; }
            }
        }));
        if (error) throw error;
        return results;
    }
    async function compress(bytes, decode = false) {
        const body = new Blob([bytes]).stream().pipeThrough(decode ? new DecompressionStream('gzip') : new CompressionStream('gzip'));
        return bounded({ body }, decode ? LIMIT.raw : LIMIT.pack);
    }
    root.RPCore = Object.freeze({ FORMAT, LIMIT, STORES, KEYS, appKey, excluded, fail, hash, checksumSource, canonical, normalizeManifest, validateManifest, bounded, jsonBody, pool, compress, encoder });
})(globalThis);

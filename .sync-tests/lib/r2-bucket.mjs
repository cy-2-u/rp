// 内存 R2 bucket：与生产 R2 的 head/get/put/delete/list 形状一致。
// ETag 全局递增：isolate 级 manifest/迁移标记缓存按 etag 索引，真实 R2
// 的 etag 是内容摘要，不会因换 bucket 而重置；mock 若每个 bucket 从
// "etag-1" 重新计数，同一 isolate 内多个测试 bucket 会互相污染缓存。
import { sha256Bytes } from './protocol.mjs';

export function createR2Mock() {
    const objects = new Map();
    const hooks = {};
    let etagSequence = globalThis.__r2MockEtagCounter = (globalThis.__r2MockEtagCounter || 0);
    const asBytes = async value => {
        if (value instanceof Uint8Array) return new Uint8Array(value);
        if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
        return new Uint8Array(await new Response(value).arrayBuffer());
    };
    const metadata = object => object ? {
        key: object.key,
        etag: object.etag,
        size: object.size,
        uploaded: object.uploaded,
        httpMetadata: object.httpMetadata,
        customMetadata: object.customMetadata
    } : null;
    const bucket = {
        objects,
        hooks,
        async head(key) {
            await hooks.beforeHead?.(key);
            return metadata(objects.get(key));
        },
        async get(key) {
            await hooks.beforeGet?.(key);
            const object = objects.get(key);
            if (!object) return null;
            return {
                ...metadata(object),
                body: new Uint8Array(object.bytes),
                text: async () => Buffer.from(object.bytes).toString('utf8')
            };
        },
        async put(key, value, options = {}) {
            const bytes = await asBytes(value);
            await hooks.beforePut?.({ key, bytes, options, bucket });
            const current = objects.get(key);
            const etag = current?.etag ?? null;
            if (options.onlyIf?.etagMatches !== undefined && etag !== options.onlyIf.etagMatches) return null;
            if (options.onlyIf?.etagDoesNotMatch === '*' && etag !== null) return null;
            if (options.sha256) {
                const expected = options.sha256 instanceof ArrayBuffer
                    ? Buffer.from(options.sha256).toString('hex')
                    : String(options.sha256).toLowerCase();
                if (await sha256Bytes(bytes) !== expected) throw new Error('BadDigest: SHA-256 mismatch');
            }
            etagSequence = globalThis.__r2MockEtagCounter = globalThis.__r2MockEtagCounter + 1;
            const nextEtag = `"etag-${etagSequence}"`;
            objects.set(key, {
                key,
                bytes,
                size: bytes.byteLength,
                etag: nextEtag,
                uploaded: hooks.uploadedAt ? new Date(hooks.uploadedAt) : new Date(),
                httpMetadata: options.httpMetadata,
                customMetadata: options.customMetadata
            });
            return { key, etag: nextEtag };
        },
        async delete(keys) {
            await hooks.beforeDelete?.(keys);
            const list = Array.isArray(keys) ? keys : [keys];
            for (const key of list) objects.delete(key);
        },
        async list({ prefix = '', cursor, limit = 1000 } = {}) {
            await hooks.beforeList?.({ prefix, cursor, limit });
            const keys = [...objects.keys()].filter(key => key.startsWith(prefix)).sort();
            const start = cursor ? keys.findIndex(key => key > cursor) : 0;
            const normalizedStart = start < 0 ? keys.length : start;
            const selected = keys.slice(normalizedStart, normalizedStart + limit);
            const truncated = normalizedStart + limit < keys.length;
            return {
                objects: selected.map(key => metadata(objects.get(key))),
                truncated,
                cursor: truncated ? selected[selected.length - 1] : undefined
            };
        }
    };
    return bucket;
}

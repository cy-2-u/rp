// 测试用最小 R2 兼容桶：内存 Map 实现，覆盖 Worker 用到的全部操作与语义
// （条件写、sha256 校验、customMetadata、list 游标、批量删除）。
import { createHash } from 'node:crypto';

export class R2Error extends Error { }

function etagOf(bytes, salt) {
    return createHash('md5').update(salt).update(bytes).digest('hex');
}

async function toBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (typeof value === 'string') return new TextEncoder().encode(value);
    if (value instanceof ReadableStream) {
        const chunks = [];
        const reader = value.getReader();
        while (true) {
            const { done, value: chunk } = await reader.read();
            if (done) break;
            chunks.push(chunk);
        }
        const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        return bytes;
    }
    throw new R2Error(`unsupported body type: ${value?.constructor?.name}`);
}

function bodyLike(bytes) {
    return new Response(bytes).body;
}

function publicMeta(entry) {
    return {
        key: entry.key,
        size: entry.bytes.byteLength,
        etag: entry.etag,
        uploaded: new Date(entry.uploaded),
        httpMetadata: entry.httpMetadata || {},
        customMetadata: entry.customMetadata || {}
    };
}

export function createR2Bucket() {
    const objects = new Map();
    let saltCounter = 0;
    const bucket = {
        // 测试辅助：直接改写对象时间（sweep 宽限期判定用）。
        _age(key, ms) {
            const entry = objects.get(key);
            if (entry) entry.uploaded = new Date(Date.now() - ms);
        },
        _has(key) { return objects.has(key); },
        async put(key, value, options = {}) {
            const bytes = await toBytes(value);
            if (options.sha256) {
                const expected = Buffer.from(options.sha256).toString('hex');
                const actual = createHash('sha256').update(bytes).digest('hex');
                if (expected !== actual) {
                    throw new R2Error('SHA-256 checksum did not match provided digest.');
                }
            }
            const existing = objects.get(key);
            if (options.onlyIf) {
                if (options.onlyIf.etagDoesNotMatch === '*' && existing) return null;
                if (options.onlyIf.etagMatches && (!existing || existing.etag !== options.onlyIf.etagMatches)) return null;
            }
            saltCounter += 1;
            const entry = {
                key,
                bytes,
                etag: etagOf(bytes, Buffer.from(String(saltCounter))),
                uploaded: new Date(),
                httpMetadata: options.httpMetadata,
                customMetadata: options.customMetadata
            };
            objects.set(key, entry);
            return { etag: entry.etag, uploaded: new Date(entry.uploaded) };
        },
        async get(key) {
            const entry = objects.get(key);
            if (!entry) return null;
            const meta = publicMeta(entry);
            return {
                ...meta,
                body: bodyLike(entry.bytes),
                arrayBuffer: async () => entry.bytes.slice().buffer,
                text: async () => new TextDecoder().decode(entry.bytes),
                bodyUsed: false,
                cancel: async () => { }
            };
        },
        async head(key) {
            const entry = objects.get(key);
            return entry ? publicMeta(entry) : null;
        },
        async delete(keys) {
            const list = Array.isArray(keys) ? keys : [keys];
            let deleted = 0;
            for (const key of list) {
                if (objects.delete(key)) deleted += 1;
            }
            return deleted;
        },
        async list({ prefix = '', cursor = undefined, limit = 1000 } = {}) {
            const all = [...objects.values()]
                .filter(entry => entry.key.startsWith(prefix))
                .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
            let start = 0;
            if (cursor) {
                start = all.findIndex(entry => entry.key > cursor);
                if (start < 0) start = all.length;
            }
            const page = all.slice(start, start + limit);
            const truncated = start + page.length < all.length;
            return {
                objects: page.map(publicMeta),
                truncated,
                cursor: truncated ? page[page.length - 1]?.key : undefined
            };
        }
    };
    return bucket;
}

// 便捷工具：按协议生成一个 gzip 分片对象（客户端与服务端测试共用）。
export async function makePackBytes(rawText) {
    const raw = new TextEncoder().encode(rawText);
    const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function sha256Hex(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
}

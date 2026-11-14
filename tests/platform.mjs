import { createHash } from 'node:crypto';

const lengths = new WeakMap();
export class FixedLengthStream {
    constructor(length) {
        let count = 0;
        const stream = new TransformStream({
            transform(chunk, controller) {
                count += chunk.byteLength;
                if (count > length) throw new Error('length exceeds expected size');
                controller.enqueue(chunk);
            },
            flush() { if (count !== length) throw new Error('length did not match expected size'); }
        });
        this.readable = stream.readable;
        this.writable = stream.writable;
        lengths.set(this.readable, length);
    }
}
const digest = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');
export class Bucket {
    objects = new Map();
    calls = { get: 0, head: 0, put: 0, delete: 0, list: 0 };
    faults = new Map();
    check(method, key) {
        this.calls[method]++;
        const fail = this.faults.get(method + ':' + key);
        if (fail) throw fail;
    }
    meta(entry) {
        return { key: entry.key, size: entry.bytes.length, etag: entry.etag, httpEtag: '"' + entry.etag + '"', uploaded: entry.uploaded, customMetadata: entry.customMetadata, httpMetadata: entry.httpMetadata };
    }
    async put(key, value, options = {}) {
        this.check('put', key);
        const old = this.objects.get(key), condition = options.onlyIf;
        // R2 可在读取请求正文前拒绝条件写。
        if (condition?.etagDoesNotMatch === '*' && old || condition?.etagMatches && condition.etagMatches !== old?.etag) return null;
        let bytes;
        if (value instanceof ReadableStream) {
            if (!lengths.has(value)) throw new TypeError('R2 requires a known-length stream');
            bytes = new Uint8Array(await new Response(value).arrayBuffer());
            if (bytes.length !== lengths.get(value)) throw new Error('length did not match expected size');
        } else if (typeof value === 'string') bytes = new TextEncoder().encode(value);
        else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
        else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        else throw new TypeError('unsupported R2 body');
        if (options.sha256 && digest(bytes) !== Buffer.from(options.sha256).toString('hex')) throw new Error('SHA-256 checksum did not match');
        const entry = { key, bytes: bytes.slice(), etag: digest(bytes, 'md5'), uploaded: new Date(), customMetadata: options.customMetadata || {}, httpMetadata: options.httpMetadata || {} };
        this.objects.set(key, entry);
        return this.meta(entry);
    }
    async head(key) { this.check('head', key); const entry = this.objects.get(key); return entry ? this.meta(entry) : null; }
    async get(key, options = {}) {
        this.check('get', key);
        const entry = this.objects.get(key);
        if (!entry) return null;
        const meta = this.meta(entry), condition = options.onlyIf;
        if (condition instanceof Headers) {
            const none = condition.get('if-none-match'), match = condition.get('if-match');
            if (none && (none === '*' || none.split(',').map(s => s.trim()).includes(meta.httpEtag)) || match && match !== '*' && match !== meta.httpEtag) return meta;
        }
        return { ...meta, body: new Response(entry.bytes).body };
    }
    async delete(keys) {
        this.check('delete', String(keys));
        keys = Array.isArray(keys) ? keys : [keys];
        if (keys.length > 1000) throw new Error('R2 delete limit');
        for (const key of keys) this.objects.delete(key);
    }
    async list({ prefix = '', cursor, limit = 1000 } = {}) {
        this.check('list', prefix);
        if (limit < 1 || limit > 1000) throw new Error('R2 list limit');
        const rows = [...this.objects.values()].filter(e => e.key.startsWith(prefix) && (!cursor || e.key > cursor)).sort((a, b) => a.key < b.key ? -1 : 1);
        const selected = rows.slice(0, limit), truncated = rows.length > limit;
        return { objects: selected.map(e => this.meta(e)), truncated, cursor: truncated ? selected.at(-1).key : undefined };
    }
}

// 只模拟本项目使用的 head 注入；不是通用 HTML 解析器或流式性能模型。
export class HTMLRewriter {
    handlers = [];
    on(selector, handler) { this.handlers.push([selector, handler]); return this; }
    async transform(response) {
        let text = await response.text();
        for (const [selector, handler] of this.handlers) {
            if (selector !== 'head') throw new Error('unsupported selector');
            handler.element({
                prepend(html) { text = text.replace(/(<head\b[^>]*>)/i, match => match + html); },
                append(html) { text = text.replace(/<\/head\s*>/i, () => html + '</head>'); }
            });
        }
        return new Response(text, response);
    }
}
export class Cache {
    values = new Map();
    async match(request) {
        const entry = this.values.get(request.url);
        if (!entry || entry.until <= Date.now()) return undefined;
        return entry.response.clone();
    }
    async put(request, response) {
        const seconds = Number(/max-age=(\d+)/.exec(response.headers.get('cache-control'))?.[1] || 0);
        // 消费正文后才算缓存落盘。
        const bytes = await response.arrayBuffer();
        this.values.set(request.url, { until: Date.now() + seconds * 1000, response: new Response(bytes, response) });
    }
}
export function context() {
    const pending = new Set();
    return {
        waitUntil(value) { const p = Promise.resolve(value); pending.add(p); p.finally(() => pending.delete(p)).catch(() => {}); },
        async drain() { while (pending.size) await Promise.allSettled([...pending]); }
    };
}

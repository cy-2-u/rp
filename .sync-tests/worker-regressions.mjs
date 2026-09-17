import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { test } from 'node:test';

// All fetches and R2 operations are local mocks; never contact an upstream.
const source = await readFile(new URL('../_worker.js', import.meta.url), 'utf8');
function load(overrides = {}) {
    const timers = new Map();
    let nextTimer = 0;
    const context = vm.createContext({
        URL, Headers, Request, Response, ReadableStream, Uint8Array, ArrayBuffer,
        TextEncoder, TextDecoder, AbortController, DOMException, crypto: webcrypto,
        fetch: () => { throw new Error('Unexpected network access'); },
        setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; },
        clearTimeout(id) { timers.delete(id); },
        ...overrides
    });
    vm.runInContext(source.replace('export default {', 'globalThis.worker = {'), context);
    return { context, timers };
}
const key = `rp-images/characters/A..B/${'a'.repeat(64)}`;
function bucket() {
    const writes = [], deletes = [], reads = [];
    return {
        writes, deletes, reads,
        async get(k) { reads.push(k); return { body: new Uint8Array([1]), size: 1 }; },
        async list({ prefix }) { return { objects: key.startsWith(prefix) ? [{ key, size: 1 }] : [], truncated: false }; },
        async put(...args) { writes.push(args); },
        async delete(keys) { deletes.push(...keys); }
    };
}
function admin(context, store, endpoint, method = 'GET', body) {
    const url = new URL(`https://offline.invalid/image/api/${endpoint}`);
    url.searchParams.set('key', key);
    const request = new Request(url, { method, body, headers: body ? { 'content-type': 'image/webp' } : {} });
    return context.handleImageAdmin(request, { RP_SYNC_R2: store }, url);
}
for (const endpoint of ['image', 'thumb']) {
    test(`A..B ${endpoint} GET and HEAD remain accessible`, async () => {
        const { context } = load();
        for (const method of ['GET', 'HEAD']) assert.equal((await admin(context, bucket(), endpoint, method)).status, 200);
    });
}
test('A..B thumbnail upload works', async () => {
    const { context } = load();
    const store = bucket();
    assert.equal((await admin(context, store, 'thumb', 'PUT', new Uint8Array([1]))).status, 200);
    assert.equal(store.writes.length, 1);
});
test('A..B selected deletion writes tombstone and deletes files', async () => {
    const { context } = load();
    const store = bucket();
    const result = await admin(context, store, 'delete', 'POST', JSON.stringify({ keys: [key] }));
    assert.equal((await result.json()).deletedCount, 1);
    assert.equal(store.writes.length, 1);
    assert.ok(store.deletes.includes(key));
});
test('malformed image keys are rejected before bucket access', async () => {
    const { context } = load();
    for (const bad of [key.replace('A..B', '..'), key.replace('A..B', '.'), key + '/extra', key.replace('A..B', 'A\\B'), key.replace('/characters/', '/thumbs/')]) {
        const store = bucket();
        const url = new URL('https://offline.invalid/image/api/image');
        url.searchParams.set('key', bad);
        assert.equal((await context.handleImageAdmin(new Request(url), { RP_SYNC_R2: store }, url)).status, 400);
        assert.equal(store.reads.length, 0);
    }
});
function streamFixture(limit) {
    let pulled = 0, cancelled = false;
    const chunk = new Uint8Array(1024 * 1024);
    const body = new ReadableStream({
        pull(controller) {
            pulled++;
            if (pulled <= limit + 4) controller.enqueue(chunk);
            else controller.close();
        },
        cancel() { cancelled = true; }
    }, { highWaterMark: 0 });
    return { body, get pulled() { return pulled; }, get cancelled() { return cancelled; } };
}
for (const length of [null, '1']) {
    test(`thumbnail stops at 2 MiB with content-length ${length}`, async () => {
        const { context } = load();
        const stream = streamFixture(2);
        const headers = { 'content-type': 'image/webp' };
        if (length !== null) headers['content-length'] = length;
        const request = new Request('https://offline.invalid/', { method: 'PUT', body: stream.body, duplex: 'half', headers });
        await assert.rejects(context.readThumbnailBytes(request));
        assert.ok(stream.pulled <= 3, `read ${stream.pulled} chunks`);
        assert.equal(stream.cancelled, true);
    });
    test(`image stops at 64 MiB with content-length ${length}`, async () => {
        const stream = streamFixture(64);
        const headers = { 'content-type': 'image/png' };
        if (length !== null) headers['content-length'] = length;
        const { context, timers } = load({ fetch: async () => new Response(stream.body, { headers }) });
        const store = bucket(); store.get = async () => null;
        const result = await context.handleImageRender(new Request('https://offline.invalid/api/rp-image?token=fake&tag=test', { method: 'POST' }), { RP_SYNC_R2: store });
        assert.equal(result.status, 413);
        assert.ok(stream.pulled <= 65, `read ${stream.pulled} chunks`);
        assert.equal(stream.cancelled, true);
        assert.equal(store.writes.length, 0);
        assert.equal(timers.size, 0);
    });
}
test('image timeout remains active after headers and aborts stalled body', async () => {
    let signal, cancelled = false;
    const { context, timers } = load({ fetch: async (_url, options) => {
        signal = options.signal;
        return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'image/png' } });
    } });
    const store = bucket(); store.get = async () => null;
    const pending = context.handleImageRender(new Request('https://offline.invalid/api/rp-image?token=fake&tag=test', { method: 'POST' }), { RP_SYNC_R2: store });
    const settled = pending.then(() => 'resolved', () => 'rejected');
    for (let i = 0; i < 30 && !signal; i++) await new Promise(resolve => setTimeout(resolve, 5));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(timers.size, 1, 'deadline was cleared at headers');
    [...timers.values()][0]();
    assert.equal(await Promise.race([settled, new Promise(resolve => setTimeout(() => resolve('hung'), 200))]), 'rejected');
    assert.equal(signal.aborted, true);
    assert.equal(cancelled, true);
    assert.equal(timers.size, 0);
    assert.equal(store.writes.length, 0);
});
test('thumbnail accepts exactly 2 MiB and rejects empty bodies', async () => {
    const { context } = load();
    const make = size => new Request('https://offline.invalid/', { method: 'PUT', headers: { 'content-type': 'image/webp' }, body: new Uint8Array(size) });
    assert.equal((await context.readThumbnailBytes(make(2 * 1024 * 1024))).byteLength, 2 * 1024 * 1024);
    await assert.rejects(context.readThumbnailBytes(make(0)));
});
test('image accepts exactly 64 MiB, stores once and clears deadline', async () => {
    const { context, timers } = load({ fetch: async () => new Response(new Uint8Array(64 * 1024 * 1024), { headers: { 'content-type': 'image/png' } }) });
    const store = bucket(); store.get = async () => null;
    const result = await context.handleImageRender(new Request('https://offline.invalid/api/rp-image?token=fake&tag=test', { method: 'POST' }), { RP_SYNC_R2: store });
    assert.equal(result.status, 200);
    assert.equal(store.writes.length, 1);
    assert.equal(store.writes[0][1].byteLength, 64 * 1024 * 1024);
    assert.equal(timers.size, 0);
});
for (const scenario of [
    { status: 503, type: 'image/png', expected: 503 },
    { status: 200, type: 'text/plain', expected: 502 },
    { status: 200, type: 'image/png', length: String(64 * 1024 * 1024 + 1), expected: 413 }
]) {
    test(`upstream rejection ${scenario.expected} cancels unread body and clears deadline`, async () => {
        const stream = streamFixture(64);
        const headers = { 'content-type': scenario.type };
        if (scenario.length) headers['content-length'] = scenario.length;
        const { context, timers } = load({ fetch: async () => new Response(stream.body, { status: scenario.status, headers }) });
        const store = bucket(); store.get = async () => null;
        const result = await context.handleImageRender(new Request('https://offline.invalid/api/rp-image?token=fake&tag=test', { method: 'POST' }), { RP_SYNC_R2: store });
        assert.equal(result.status, scenario.expected);
        assert.equal(stream.pulled, 0);
        assert.equal(stream.cancelled, true);
        assert.equal(timers.size, 0);
        assert.equal(store.writes.length, 0);
    });
}
test('thumbnail oversized declared length is rejected without reading', async () => {
    const { context } = load();
    const stream = streamFixture(2);
    const request = new Request('https://offline.invalid/', { method: 'PUT', body: stream.body, duplex: 'half', headers: { 'content-type': 'image/webp', 'content-length': String(2 * 1024 * 1024 + 1) } });
    await assert.rejects(context.readThumbnailBytes(request));
    assert.equal(stream.pulled, 0);
    assert.equal(stream.cancelled, true);
});
test('fetch rejection clears deadline', async () => {
    const { context, timers } = load({ fetch: async () => { throw new Error('offline failure'); } });
    await assert.rejects(context.fetchImageWithTimeout('https://offline.invalid/', {}, () => {}), /offline failure/);
    assert.equal(timers.size, 0);
});
test('author proxy strips local credentials and retains ordinary headers', async () => {
    let forwarded;
    const { context } = load({ fetch: async (_url, options) => { forwarded = options.headers; return new Response('body', { headers: { 'content-type': 'text/css' } }); } });
    await context.serveAuthor(new Request('https://offline.invalid/assets/style.css', { headers: {
        Cookie: 'session=local', Authorization: 'Bearer local', 'x-rp-sync-password': 'local', 'accept': 'text/css', 'if-none-match': 'test-etag'
    } }), {});
    for (const name of ['cookie', 'authorization', 'x-rp-sync-password']) assert.equal(forwarded.get(name), null, name);
    assert.equal(forwarded.get('accept'), 'text/css');
    assert.equal(forwarded.get('if-none-match'), 'test-etag');
});

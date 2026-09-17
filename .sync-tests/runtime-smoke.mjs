import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = relative => fs.readFile(path.join(root, relative), 'utf8');
const defaultAdapterUrl = pathToFileURL(path.join(root, 'adapter', 'rp-hub-2026-09-16.json')).href;
const configuredAdapterUrl = process.env.RPHUB_ADAPTER_URL?.trim() || defaultAdapterUrl;
const upstreamRoot = process.env.RPHUB_UPSTREAM_DIR?.trim() || 'C:\\Users\\my\\Downloads\\RP-Hub-main';

function localAdapterPath() {
    const url = new URL(configuredAdapterUrl);
    if (url.protocol !== 'file:') throw new Error('runtime-smoke requires a file:// adapter URL');
    return fileURLToPath(url);
}

async function loadWorker(fetchImpl = globalThis.fetch) {
    const source = await read('_worker.js');
    const transformed = source.replace('export default {', 'return {');
    return new Function('fetch', transformed)(fetchImpl);
}

async function loadWorkerInternals(fetchImpl = globalThis.fetch) {
    const source = await read('_worker.js');
    const transformed = source.replace('export default {', 'const workerExport = {')
        + '\nreturn { worker: workerExport, handleUploadPackBatch };';
    return new Function('fetch', transformed)(fetchImpl);
}

async function testAdapterFromFileUrl() {
    const workerSource = await read('_worker.js');
    const start = workerSource.indexOf('function authorSourcePattern');
    const end = workerSource.indexOf('const DATASET_ID');
    const api = new Function(`${workerSource.slice(start, end)}; return { validateAdapter, rewriteAuthorScript };`)();
    const adapter = JSON.parse(await fs.readFile(localAdapterPath(), 'utf8'));
    const author = await readFromUpstream('assets/js/app.js');
    api.validateAdapter(adapter);
    const rewritten = api.rewriteAuthorScript(author, adapter);
    assert.notEqual(rewritten, author, 'adapter should rewrite the current author bundle');
    assert.match(rewritten, /image_renders/);
    assert.doesNotThrow(() => new Function(rewritten), 'rewritten author bundle must remain valid JavaScript');
    assert.throws(() => api.validateAdapter({
        ...adapter,
        author: { ...adapter.author, sourceChecks: {} }
    }), /源码检查无效/);
    assert.throws(() => api.validateAdapter({
        ...adapter,
        author: {
            ...adapter.author,
            script: { ...adapter.author.script, replacements: [{ name: 'empty', find: ' ', replace: '' }] }
        }
    }), /替换规则无效/);
}

async function readFromUpstream(relative) {
    return fs.readFile(path.join(upstreamRoot, relative), 'utf8');
}

async function testManifestEtagCache() {
    const sha256Hex = async text => {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
        return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
    };
    const packChecksum = 'a'.repeat(64);
    const manifestKey = 'rp-sync/main/manifest.json';
    const packKey = `rp-sync/main/packs/${packChecksum}.bin`;
    const buildManifest = async version => {
        const core = {
            version,
            updatedAt: 1700000000000 + version,
            totalBytes: 4,
            packCount: 1,
            entryCount: 1,
            packManifest: [{
                bucketKey: 'bucket-1',
                group: 'group-1',
                part: 0,
                checksum: packChecksum,
                length: 4,
                entryCount: 1
            }],
            snapshotFormat: 'rp-sync-bounded-jsonl-v3',
            schemaVersion: 11
        };
        core.checksum = await sha256Hex(JSON.stringify([
            'rp-sync-bounded-jsonl-v3',
            11,
            core.totalBytes,
            core.packCount,
            core.entryCount,
            core.packManifest.map(pack => [pack.bucketKey, pack.group, pack.part, pack.checksum, pack.length, pack.entryCount])
        ]));
        return core;
    };
    const objects = new Map();
    const counters = { manifestGet: 0 };
    let etagCounter = 0;
    const bucket = {
        head: async key => {
            const object = objects.get(key);
            return object ? { key, etag: object.etag, size: object.size } : null;
        },
        get: async key => {
            if (key === manifestKey) counters.manifestGet += 1;
            const object = objects.get(key);
            if (!object) return null;
            return {
                key,
                etag: object.etag,
                size: object.size,
                text: async () => Buffer.from(object.bytes).toString('utf8'),
                body: new Uint8Array(object.bytes)
            };
        },
        put: async (key, value) => {
            const bytes = value instanceof Uint8Array ? value : new Uint8Array(await new Response(value).arrayBuffer());
            etagCounter += 1;
            const etag = `etag-${etagCounter}`;
            objects.set(key, { bytes, etag, size: bytes.byteLength });
            return { key, etag };
        }
    };
    const worker = await loadWorker();
    const env = { RP_SYNC_R2: bucket };
    const post = payload => worker.fetch(new Request('https://local.test/api/rp-sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
    }), env, {});

    await bucket.put(manifestKey, new TextEncoder().encode(JSON.stringify(await buildManifest(1))));
    await bucket.put(packKey, new TextEncoder().encode('one\n'));

    const first = await post({ action: 'pull-manifest' });
    assert.equal(first.status, 200);
    assert.equal((await first.json()).remote.version, 1);
    assert.equal(counters.manifestGet, 1);

    const second = await post({ action: 'pull-manifest' });
    assert.equal((await second.json()).remote.version, 1);
    assert.equal(counters.manifestGet, 1, 'second manifest read must come from the etag cache');

    const packPull = await post({ action: 'pull-pack', version: 1, checksum: packChecksum });
    assert.equal(packPull.status, 200);
    assert.equal(new Uint8Array(await packPull.arrayBuffer()).byteLength, 4);
    assert.equal(counters.manifestGet, 1, 'pack pulls must reuse the cached manifest');

    await bucket.put(manifestKey, new TextEncoder().encode(JSON.stringify(await buildManifest(2))));
    const third = await post({ action: 'pull-manifest' });
    assert.equal((await third.json()).remote.version, 2);
    assert.equal(counters.manifestGet, 2, 'a changed manifest etag must invalidate the cache');
}

async function loadUploadEngine() {
    const source = await read('DB/upload-engine.js');
    const context = { console, setTimeout, clearTimeout, Promise, Set, TypeError, Error };
    context.globalThis = context;
    vm.runInNewContext(source, context, { filename: 'upload-engine.js' });
    return context.RPH_SYNC_UPLOAD_ENGINE;
}

async function testBoundedUploadEngine() {
    const engine = await loadUploadEngine();
    const total = 1000;
    let produced = 0;
    let liveBytes = 0;
    let maxLiveBytes = 0;
    let sendCount = 0;
    let maxBatchItems = 0;
    let maxBatchBytes = 0;
    let firstSendProduced = null;
    async function* source() {
        for (let index = 0; index < total; index += 1) {
            produced += 1;
            yield { checksum: String(index).padStart(64, '0'), length: 4096 };
        }
    }
    const result = await engine.runBoundedUpload({
        items: source(),
        concurrency: 1,
        maxItems: 8,
        maxBytes: 4 * 1024 * 1024,
        read: async item => {
            liveBytes += item.length;
            maxLiveBytes = Math.max(maxLiveBytes, liveBytes);
            return { bytes: new Uint8Array(item.length) };
        },
        send: async records => {
            sendCount += 1;
            if (firstSendProduced === null) firstSendProduced = produced;
            maxBatchItems = Math.max(maxBatchItems, records.length);
            maxBatchBytes = Math.max(maxBatchBytes, records.reduce((sum, item) => sum + item.bytes.byteLength, 0));
            liveBytes = 0;
        }
    });
    assert.equal(result.items, total);
    assert.equal(sendCount, 125);
    assert.ok(maxBatchItems <= 8);
    assert.ok(maxBatchBytes <= 4 * 1024 * 1024);
    assert.ok(maxLiveBytes <= 8 * 4096);
    assert.equal(firstSendProduced, 8, 'the producer must not be drained before the first upload');
    assert.equal(produced, total);
}

async function testUploadEngineCleanup() {
    const engine = await loadUploadEngine();
    let closed = false;
    async function* source() {
        try {
            yield { checksum: 'c'.repeat(64), length: 1 };
            yield { checksum: 'd'.repeat(64), length: 1 };
        } finally {
            closed = true;
        }
    }
    await assert.rejects(() => engine.runBoundedUpload({
        items: source(),
        concurrency: Infinity,
        maxItems: Infinity,
        maxBytes: Infinity,
        read: async item => item.checksum.startsWith('d')
            ? (() => { throw new Error('synthetic read failure'); })()
            : { bytes: new Uint8Array(item.length) },
        send: async () => { }
    }), /synthetic read failure/);
    assert.equal(closed, true, 'failed uploads must close the source iterator');
}

async function testAppJsRewriteCache() {
    const appJsSource = await readFromUpstream('assets/js/app.js');
    const etag = { value: '"app-v1"' };
    let upstreamFetches = 0;
    let upstreamBodyDownloads = 0;
    const fetchMock = async (input, init) => {
        const url = new URL(String(input));
        if (url.protocol === 'file:') {
            const body = await fs.readFile(fileURLToPath(url));
            return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url.pathname.endsWith('/assets/js/app.js')) {
            upstreamFetches += 1;
            const ifNoneMatch = new Headers(init?.headers || {}).get('if-none-match');
            if (ifNoneMatch && ifNoneMatch === etag.value) return new Response(null, { status: 304 });
            upstreamBodyDownloads += 1;
            return new Response(appJsSource, {
                status: 200,
                headers: { etag: etag.value, 'content-type': 'application/javascript' }
            });
        }
        return new Response('missing', { status: 404 });
    };
    const worker = await loadWorker(fetchMock);
    const env = { RPHUB_ADAPTER_URL: configuredAdapterUrl };
    const appUrl = 'https://local.test/assets/js/app.js';

    const first = await worker.fetch(new Request(appUrl), env, {});
    assert.equal(first.status, 200);
    const firstBody = await first.text();
    assert.match(firstBody, /image_renders/);
    assert.equal(upstreamFetches, 1);

    const second = await worker.fetch(new Request(appUrl), env, {});
    assert.equal(second.status, 200);
    const secondBody = await second.text();
    assert.equal(secondBody, firstBody, 'second request must reuse the cached rewrite');
    assert.match(secondBody, /image_renders/);
    assert.equal(upstreamFetches, 2, 'freshness must be revalidated with a conditional request');
    assert.equal(upstreamBodyDownloads, 1, 'unchanged upstream must not be downloaded again');

    etag.value = '"app-v2"';
    const third = await worker.fetch(new Request(appUrl), env, {});
    assert.equal(third.status, 200);
    assert.match(await third.text(), /image_renders/);
    assert.equal(upstreamBodyDownloads, 2, 'changed upstream must be fetched and rewritten again');
}

async function testUploadBatchEndpoint() {
    const objects = new Map();
    const bucket = {
        head: async key => key.endsWith('migration-v11.done') ? { key } : objects.get(key) || null,
        put: async (key, value, options) => {
            const bytes = value instanceof ArrayBuffer
                ? new Uint8Array(value)
                : value instanceof Uint8Array
                    ? new Uint8Array(value)
                    : new Uint8Array(await new Response(value).arrayBuffer());
            objects.set(key, { key, bytes, size: bytes.byteLength, options });
            return { key };
        }
    };
    const { worker } = await loadWorkerInternals();
    const definitions = [
        { checksum: 'a'.repeat(64), length: 4 },
        { checksum: 'b'.repeat(64), length: 3 }
    ];
    const header = new TextEncoder().encode(JSON.stringify(definitions));
    const body = new Uint8Array(4 + header.byteLength + 7);
    new DataView(body.buffer).setUint32(0, header.byteLength);
    body.set(header, 4);
    body.set(new TextEncoder().encode('one\n'), 4 + header.byteLength);
    body.set(new TextEncoder().encode('two'), 4 + header.byteLength + 4);
    const response = await worker.fetch(new Request('https://local.test/api/rp-sync?action=upload-pack-batch', {
        method: 'POST',
        headers: {
            'content-type': 'application/octet-stream',
            'content-length': String(body.byteLength)
        },
        body
    }), { RP_SYNC_R2: bucket }, {});
    assert.equal(response.status, 204);
    assert.equal(objects.get(`rp-sync/main/packs/${'a'.repeat(64)}.bin`).size, 4);
    assert.equal(objects.get(`rp-sync/main/packs/${'b'.repeat(64)}.bin`).size, 3);
}

async function testBootstrapUsesBoundedEngine() {
    const bootstrap = await read('DB/bootstrap.js');
    assert.match(bootstrap, /window\.RPH_SYNC_UPLOAD_ENGINE/);
    assert.match(bootstrap, /async function\* iterateMissingUploadPacks/);
    assert.doesNotMatch(bootstrap, /const batches = \[\]/);
}

async function testAdapterConfigEndpoint() {
    const workerSource = await read('_worker.js');
    const fetchMock = async input => {
        const url = new URL(String(input));
        if (url.protocol === 'file:') {
            const body = await fs.readFile(fileURLToPath(url));
            return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
        }
        const relative = url.pathname.replace(/^\/RP-Hub\//, '');
        try {
            const body = await fs.readFile(path.join(upstreamRoot, relative));
            return new Response(body, { status: 200 });
        } catch (_) {
            return new Response('missing', { status: 404 });
        }
    };
    const worker = await loadWorker(fetchMock);
    const adapter = JSON.parse(await fs.readFile(localAdapterPath(), 'utf8'));
    const env = { RPHUB_ADAPTER_URL: configuredAdapterUrl };
    const ok = await worker.fetch(new Request('https://local.test/__rphub/adapter.json'), env, {});
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { schema: adapter.schema, id: adapter.id, ui: adapter.ui });
    const head = await worker.fetch(new Request('https://local.test/__rphub/adapter.json', { method: 'HEAD' }), env, {});
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');

    const failingWorker = await loadWorker(async input => {
        const url = new URL(String(input));
        if (url.protocol === 'file:') return new Response('not found', { status: 404 });
        return fetchMock(input);
    });
    const failed = await failingWorker.fetch(new Request('https://local.test/__rphub/adapter.json'), env, {});
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), { ok: false });
}

await testAdapterFromFileUrl();
await testManifestEtagCache();
await testAdapterConfigEndpoint();
await testAppJsRewriteCache();
await testBoundedUploadEngine();
await testUploadEngineCleanup();
await testUploadBatchEndpoint();
await testBootstrapUsesBoundedEngine();
console.log('runtime-smoke: ok');

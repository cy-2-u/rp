import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const FORMAT = 'rp-sync-paged-jsonl-v4';
const SCHEMA = 13;
const PAGE_FORMAT = 'rp-sync-manifest-page-v1';
const PAGE_PACKS = 32;
const CHAIN_SEED = '0'.repeat(64);
const BLOOM_BYTES = 32 * 1024;
const PREFIX = 'rp-sync/main';
const MANIFEST_KEY = `${PREFIX}/manifest.json`;
const MIGRATION_KEY = `${PREFIX}/migration-v13.done`;
const LOCK_KEY = `${PREFIX}/maintenance/mutation-lock.json`;
const encoder = new TextEncoder();

async function sha256Bytes(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Buffer.from(digest).toString('hex');
}

const sha256Text = text => sha256Bytes(encoder.encode(text));
const packKey = checksum => `${PREFIX}/packs/${checksum}.bin`;
const pageKey = (checksum, pageIndex) => `${PREFIX}/manifests/${checksum}/${String(pageIndex).padStart(4, '0')}.json`;
const bloomKey = checksum => `${PREFIX}/blooms/${checksum}.bin`;
const sessionKey = uploadId => `${PREFIX}/uploads/${uploadId}.json`;
const tuple = pack => [pack.bucketKey, pack.group, pack.part, pack.checksum, pack.length, pack.entryCount];
const pageSource = (pageIndex, previousPageHash, packs) => JSON.stringify([
    PAGE_FORMAT, pageIndex, previousPageHash, packs.map(tuple)
]);
const rootSource = snapshot => JSON.stringify([
    FORMAT, SCHEMA, snapshot.totalBytes, snapshot.packCount, snapshot.entryCount,
    snapshot.pageCount, snapshot.pageRoot, snapshot.bloomChecksum
]);

function bloomIndexes(checksum) {
    const bitCount = BLOOM_BYTES * 8;
    return [0, 8, 16, 24].map(offset => parseInt(checksum.slice(offset, offset + 8), 16) % bitCount);
}

function bloomHas(bloom, checksum) {
    return bloomIndexes(checksum).every(bit => (bloom[bit >>> 3] & (1 << (bit & 7))) !== 0);
}

function makeBloom(packs) {
    const bloom = new Uint8Array(BLOOM_BYTES);
    for (const pack of packs) {
        for (const bit of bloomIndexes(pack.checksum)) bloom[bit >>> 3] |= 1 << (bit & 7);
    }
    return bloom;
}

async function buildSnapshot(count, { prefix = 'snapshot', mutatePacks, bloom } = {}) {
    const packs = [];
    for (let index = 0; index < count; index += 1) {
        const bytes = encoder.encode(`${prefix}-${index}\n`);
        packs.push({
            bucketKey: `${prefix}-bucket`,
            group: `${prefix}-group`,
            part: index,
            checksum: await sha256Bytes(bytes),
            length: bytes.byteLength,
            entryCount: 1,
            bytes
        });
    }
    if (mutatePacks) mutatePacks(packs);
    let previousPageHash = CHAIN_SEED;
    const pages = [];
    const pageCount = Math.ceil(packs.length / PAGE_PACKS);
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
        const pagePacks = packs.slice(pageIndex * PAGE_PACKS, (pageIndex + 1) * PAGE_PACKS)
            .map(({ bytes, ...pack }) => pack);
        const pageHash = await sha256Text(pageSource(pageIndex, previousPageHash, pagePacks));
        pages.push({ pageIndex, previousPageHash, pageHash, packs: pagePacks });
        previousPageHash = pageHash;
    }
    const bloomBytes = bloom || makeBloom(packs);
    const snapshot = {
        snapshotFormat: FORMAT,
        schemaVersion: SCHEMA,
        totalBytes: packs.reduce((sum, pack) => sum + pack.length, 0),
        packCount: packs.length,
        entryCount: packs.reduce((sum, pack) => sum + pack.entryCount, 0),
        pageCount,
        pageRoot: previousPageHash,
        bloomChecksum: await sha256Bytes(bloomBytes),
        packs,
        pages,
        bloom: bloomBytes
    };
    snapshot.checksum = await sha256Text(rootSource(snapshot));
    return snapshot;
}

function createBarrier(parties) {
    let arrived = 0;
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    return async () => {
        arrived += 1;
        if (arrived >= parties) release();
        await promise;
    };
}

function createR2Mock() {
    const objects = new Map();
    const hooks = {};
    let etagSequence = 0;
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
            etagSequence += 1;
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

class FakeHTMLRewriter {
    on() { return this; }
    transform(response) { return response; }
}

async function loadWorker() {
    const source = await fs.readFile(path.join(root, '_worker.js'), 'utf8');
    return new Function('fetch', 'HTMLRewriter', source.replace('export default {', 'return {'))(
        globalThis.fetch,
        FakeHTMLRewriter
    );
}

function makeApi(worker, bucket, password = '') {
    const auth = password ? { 'x-rp-sync-password': password } : {};
    return {
        async post(payload) {
            return worker.fetch(new Request('https://local.test/api/rp-sync', {
                method: 'POST',
                headers: { 'content-type': 'application/json', ...auth },
                body: JSON.stringify(payload)
            }), { RP_SYNC_R2: bucket, ...(password ? { RP_SYNC_PASSWORD: password } : {}) }, {});
        },
        async json(payload) {
            const response = await this.post(payload);
            const body = await response.json().catch(() => ({}));
            return { response, body };
        },
        async binary(action, params, bytes) {
            const url = new URL('https://local.test/api/rp-sync');
            url.searchParams.set('action', action);
            for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value));
            return worker.fetch(new Request(url, {
                method: 'POST',
                headers: { 'content-type': 'application/octet-stream', ...auth },
                body: bytes
            }), { RP_SYNC_R2: bucket, ...(password ? { RP_SYNC_PASSWORD: password } : {}) }, {});
        }
    };
}

async function initialize(api) {
    const { response } = await api.json({ action: 'initialize-storage', schemaVersion: SCHEMA });
    assert.equal(response.status, 200);
}

async function begin(api, snapshot, baseVersion = 0, baseChecksum = '') {
    return api.json({
        action: 'begin-upload',
        baseVersion,
        baseChecksum,
        checksum: snapshot.checksum,
        bloomChecksum: snapshot.bloomChecksum,
        snapshotFormat: FORMAT,
        schemaVersion: SCHEMA,
        totalBytes: snapshot.totalBytes,
        packCount: snapshot.packCount,
        entryCount: snapshot.entryCount,
        pageCount: snapshot.pageCount,
        pageRoot: snapshot.pageRoot
    });
}

async function uploadBloom(api, snapshot) {
    return api.binary('upload-bloom', { uploadId: snapshot.checksum }, snapshot.bloom);
}

async function uploadPack(api, uploadId, pack) {
    return api.binary('upload-pack', {
        uploadId,
        checksum: pack.checksum,
        length: pack.length,
        entryCount: pack.entryCount
    }, pack.bytes);
}

async function submitPage(api, snapshot, pageIndex) {
    return api.json({
        action: 'upload-manifest-page',
        uploadId: snapshot.checksum,
        pageIndex,
        packs: snapshot.pages[pageIndex].packs
    });
}

async function seedPack(bucket, pack, uploaded = new Date()) {
    const result = await bucket.put(packKey(pack.checksum), pack.bytes, {
        customMetadata: { entryCount: String(pack.entryCount) },
        httpMetadata: { contentType: 'application/octet-stream' }
    });
    bucket.objects.get(packKey(pack.checksum)).uploaded = uploaded;
    return result;
}

async function finishPages(api, snapshot) {
    for (let pageIndex = 0; pageIndex < snapshot.pageCount; pageIndex += 1) {
        let { response, body } = await submitPage(api, snapshot, pageIndex);
        assert.equal(response.status, 200);
        for (const checksum of body.missingPacks || []) {
            const pack = snapshot.packs.find(item => item.checksum === checksum);
            assert.ok(pack);
            assert.equal((await uploadPack(api, snapshot.checksum, pack)).status, 204);
        }
        ({ response, body } = await submitPage(api, snapshot, pageIndex));
        assert.equal(response.status, 200);
        assert.deepEqual(body.missingPacks, []);
    }
}

async function prepareSnapshot(api, snapshot, baseVersion = 0, baseChecksum = '') {
    const started = await begin(api, snapshot, baseVersion, baseChecksum);
    assert.equal(started.response.status, 200);
    assert.equal(started.body.committed, false);
    assert.equal((await uploadBloom(api, snapshot)).status, 204);
    await finishPages(api, snapshot);
    return started.body;
}

async function testLegacyInitializationAndEmptyCommit(worker) {
    const bucket = createR2Mock();
    const api = makeApi(worker, bucket);
    const legacy = encoder.encode('{"schemaVersion":12,"large":"preserve"}');
    const legacyPut = await bucket.put(MANIFEST_KEY, legacy);

    const before = await api.json({ action: 'prepare-upload', schemaVersion: SCHEMA });
    assert.equal(before.body.resetRequired, true);
    await initialize(api);
    assert.deepEqual(bucket.objects.get(MANIFEST_KEY).bytes, legacy, 'initialization must preserve the legacy root');
    const marker = JSON.parse(Buffer.from(bucket.objects.get(MIGRATION_KEY).bytes).toString('utf8'));
    assert.equal(marker.legacyEtag, legacyPut.etag);

    const empty = await buildSnapshot(0, { prefix: 'empty' });
    const started = await begin(api, empty);
    assert.equal(started.response.status, 200);
    assert.equal((await uploadBloom(api, empty)).status, 204);
    const finalized = await api.json({ action: 'finalize-upload', uploadId: empty.checksum });
    assert.equal(finalized.response.status, 200);
    assert.equal(finalized.body.remote.version, 1);
    assert.equal(finalized.body.remote.checksum, empty.checksum);
    assert.notDeepEqual(bucket.objects.get(MANIFEST_KEY).bytes, legacy);

    const repeated = await begin(api, empty, 1, empty.checksum);
    assert.equal(repeated.response.status, 200);
    assert.equal(repeated.body.committed, true, 'repeating a committed empty snapshot must be idempotent');
}

async function testResumablePagedUploadAndPull(worker) {
    const bucket = createR2Mock();
    const api = makeApi(worker, bucket);
    await initialize(api);
    const snapshot = await buildSnapshot(33, { prefix: 'resume' });
    const started = await begin(api, snapshot);
    assert.equal(started.body.nextPage, 0);
    assert.equal((await uploadBloom(api, snapshot)).status, 204);

    let page = await submitPage(api, snapshot, 0);
    assert.equal(page.response.status, 200);
    assert.equal(page.body.missingPacks.length, 32);
    for (const pack of snapshot.packs.slice(0, 32)) {
        assert.equal((await uploadPack(api, snapshot.checksum, pack)).status, 204);
        const stored = bucket.objects.get(packKey(pack.checksum));
        assert.equal(stored.customMetadata.entryCount, '1');
        assert.deepEqual(stored.bytes, pack.bytes);
    }

    const sessionGate = createBarrier(2);
    bucket.hooks.beforePut = async ({ key, options }) => {
        if (key === sessionKey(snapshot.checksum) && options.onlyIf?.etagMatches) await sessionGate();
    };
    const raced = await Promise.all([submitPage(api, snapshot, 0), submitPage(api, snapshot, 0)]);
    bucket.hooks.beforePut = null;
    assert.deepEqual(raced.map(item => item.response.status).sort(), [200, 409], 'only one concurrent page CAS may advance');

    const resumed = await begin(api, snapshot);
    assert.equal(resumed.response.status, 200);
    assert.equal(resumed.body.nextPage, 1, 'begin-upload must resume from persisted server progress');
    page = await submitPage(api, snapshot, 1);
    assert.deepEqual(page.body.missingPacks, [snapshot.packs[32].checksum]);
    await uploadPack(api, snapshot.checksum, snapshot.packs[32]);
    page = await submitPage(api, snapshot, 1);
    assert.equal(page.body.complete, true);

    let releaseManifest;
    let manifestPutEntered;
    const entered = new Promise(resolve => { manifestPutEntered = resolve; });
    const held = new Promise(resolve => { releaseManifest = resolve; });
    bucket.hooks.beforePut = async ({ key }) => {
        if (key === MANIFEST_KEY) {
            manifestPutEntered();
            await held;
        }
    };
    const finalizing = api.json({ action: 'finalize-upload', uploadId: snapshot.checksum });
    await entered;
    const blockedGc = await api.json({ action: 'gc-step' });
    assert.equal(blockedGc.response.status, 409, 'GC must not run while finalize owns the mutation lock');
    releaseManifest();
    const finalized = await finalizing;
    bucket.hooks.beforePut = null;
    assert.equal(finalized.response.status, 200);

    const pulledPage = await api.json({
        action: 'pull-manifest-page', schemaVersion: SCHEMA, version: 1, pageIndex: 1
    });
    assert.equal(pulledPage.response.status, 200);
    assert.equal(pulledPage.body.pageHash, snapshot.pages[1].pageHash);

    const pack = snapshot.packs[32];
    const pulledPack = await api.post({
        action: 'pull-pack',
        version: 1,
        pageIndex: 1,
        packIndex: 0,
        checksum: pack.checksum,
        length: pack.length,
        entryCount: pack.entryCount
    });
    assert.equal(pulledPack.status, 200);
    assert.deepEqual(new Uint8Array(await pulledPack.arrayBuffer()), pack.bytes);

    const uncommitted = await api.post({
        action: 'pull-pack',
        version: 1,
        pageIndex: 1,
        packIndex: 0,
        checksum: 'f'.repeat(64),
        length: pack.length,
        entryCount: pack.entryCount
    });
    assert.equal(uncommitted.status, 409, 'pack reads must be bound to the committed page entry');

    const storedPage = bucket.objects.get(pageKey(snapshot.checksum, 1));
    const originalPage = new Uint8Array(storedPage.bytes);
    const damaged = JSON.parse(Buffer.from(storedPage.bytes).toString('utf8'));
    damaged.pageHash = '0'.repeat(64);
    storedPage.bytes = encoder.encode(JSON.stringify(damaged));
    storedPage.size = storedPage.bytes.byteLength;
    const damagedPull = await api.post({ action: 'pull-manifest-page', version: 1, pageIndex: 1 });
    assert.equal(damagedPull.status, 409, 'damaged manifest pages must be rejected');
    storedPage.bytes = originalPage;
    storedPage.size = originalPage.byteLength;

    return { bucket, api, snapshot };
}

async function testMetadataBloomAndOrderingRejections(worker) {
    {
        const bucket = createR2Mock();
        const api = makeApi(worker, bucket);
        await initialize(api);
        const zeroBloom = new Uint8Array(BLOOM_BYTES);
        const snapshot = await buildSnapshot(1, { prefix: 'missing-bloom', bloom: zeroBloom });
        await begin(api, snapshot);
        await uploadBloom(api, snapshot);
        await uploadPack(api, snapshot.checksum, snapshot.packs[0]);
        const page = await submitPage(api, snapshot, 0);
        assert.equal(page.response.status, 409);
        assert.match(page.body.error, /过滤器缺少/);
    }

    {
        const bucket = createR2Mock();
        const api = makeApi(worker, bucket);
        await initialize(api);
        const snapshot = await buildSnapshot(1, { prefix: 'metadata' });
        await begin(api, snapshot);
        await uploadBloom(api, snapshot);
        await bucket.put(packKey(snapshot.packs[0].checksum), snapshot.packs[0].bytes, {
            customMetadata: { entryCount: '2' }
        });
        const page = await submitPage(api, snapshot, 0);
        assert.deepEqual(page.body.missingPacks, [snapshot.packs[0].checksum], 'wrong custom metadata must count as missing');
        await uploadPack(api, snapshot.checksum, snapshot.packs[0]);
        assert.equal((await submitPage(api, snapshot, 0)).response.status, 200);
        const bloomObject = bucket.objects.get(bloomKey(snapshot.bloomChecksum));
        bloomObject.bytes[0] ^= 1;
        const final = await api.post({ action: 'finalize-upload', uploadId: snapshot.checksum });
        assert.equal(final.status, 409, 'finalize must re-hash the Bloom object');
    }

    {
        const bucket = createR2Mock();
        const api = makeApi(worker, bucket);
        await initialize(api);
        const snapshot = await buildSnapshot(33, {
            prefix: 'ordering',
            mutatePacks: packs => { packs[32].part = 33; }
        });
        await begin(api, snapshot);
        await uploadBloom(api, snapshot);
        for (const pack of snapshot.packs.slice(0, 32)) await seedPack(bucket, pack);
        assert.equal((await submitPage(api, snapshot, 0)).response.status, 200);
        const second = await submitPage(api, snapshot, 1);
        assert.equal(second.response.status, 409, 'part ordering must continue across page boundaries');
    }
}

async function testConcurrentFinalizeAndRootCas(worker) {
    {
        const bucket = createR2Mock();
        const api = makeApi(worker, bucket);
        await initialize(api);
        const snapshot = await buildSnapshot(0, { prefix: 'finalize-race' });
        await begin(api, snapshot);
        await uploadBloom(api, snapshot);
        const lockGate = createBarrier(2);
        bucket.hooks.beforePut = async ({ key, options }) => {
            if (key === LOCK_KEY && options.onlyIf) await lockGate();
        };
        const results = await Promise.all([
            api.json({ action: 'finalize-upload', uploadId: snapshot.checksum }),
            api.json({ action: 'finalize-upload', uploadId: snapshot.checksum })
        ]);
        bucket.hooks.beforePut = null;
        assert.deepEqual(results.map(item => item.response.status).sort(), [200, 409]);
        const retry = await api.json({ action: 'finalize-upload', uploadId: snapshot.checksum });
        assert.equal(retry.response.status, 200, 'a lost successful finalize response must be retryable');
    }

    {
        const bucket = createR2Mock();
        const api = makeApi(worker, bucket);
        await initialize(api);
        const left = await buildSnapshot(1, { prefix: 'left' });
        const right = await buildSnapshot(1, { prefix: 'right' });
        await prepareSnapshot(api, left);
        await prepareSnapshot(api, right);
        assert.equal((await api.post({ action: 'finalize-upload', uploadId: left.checksum })).status, 200);
        const stale = await api.post({ action: 'finalize-upload', uploadId: right.checksum });
        assert.equal(stale.status, 409, 'a second session from the same base must lose the root CAS');
        const rootObject = JSON.parse(Buffer.from(bucket.objects.get(MANIFEST_KEY).bytes).toString('utf8'));
        assert.equal(rootObject.checksum, left.checksum);
    }
}

async function testGcCursor(worker, committed) {
    const { bucket, api, snapshot } = committed;
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const orphanKeys = [];
    for (let index = 0; orphanKeys.length < 300; index += 1) {
        const checksum = index.toString(16).padStart(64, '0');
        if (snapshot.packs.some(pack => pack.checksum === checksum) || bloomHas(snapshot.bloom, checksum)) continue;
        const key = packKey(checksum);
        await bucket.put(key, new Uint8Array([index & 255]), { customMetadata: { entryCount: '1' } });
        bucket.objects.get(key).uploaded = old;
        orphanKeys.push(key);
    }
    let steps = 0;
    let done = false;
    while (!done && steps < 10) {
        const result = await api.json({ action: 'gc-step' });
        assert.equal(result.response.status, 200);
        done = result.body.done;
        steps += 1;
    }
    assert.equal(done, true);
    assert.ok(steps >= 2, 'the test must exercise more than one R2 list page');
    assert.equal(orphanKeys.filter(key => bucket.objects.has(key)).length, 0,
        'opaque cursor pagination must not permanently spare a page-boundary object');
    for (const pack of snapshot.packs) assert.ok(bucket.objects.has(packKey(pack.checksum)));
}

async function testPasswordAndBinaryEndpoint(worker) {
    const bucket = createR2Mock();
    const api = makeApi(worker, bucket, 'secret');
    const denied = makeApi(worker, bucket);
    const anonymousResponse = await worker.fetch(new Request('https://local.test/api/rp-sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'auth-status' })
    }), { RP_SYNC_R2: bucket, RP_SYNC_PASSWORD: 'secret' }, {});
    const anonymous = await anonymousResponse.json();
    assert.equal(anonymous.authRequired, true);
    assert.equal(anonymous.authenticated, false);
    const authenticated = await api.json({ action: 'auth-status' });
    assert.equal(authenticated.body.authenticated, true);
    const deniedPost = payload => worker.fetch(new Request('https://local.test/api/rp-sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
    }), { RP_SYNC_R2: bucket, RP_SYNC_PASSWORD: 'secret' }, {});
    assert.equal((await deniedPost({ action: 'prepare-upload', schemaVersion: SCHEMA })).status, 401);
    assert.equal((await api.post({ action: 'prepare-upload', schemaVersion: SCHEMA })).status, 200);
    const deniedUrl = new URL('https://local.test/api/rp-sync');
    deniedUrl.searchParams.set('action', 'upload-pack');
    deniedUrl.searchParams.set('uploadId', 'a'.repeat(64));
    deniedUrl.searchParams.set('checksum', 'b'.repeat(64));
    deniedUrl.searchParams.set('length', '1');
    deniedUrl.searchParams.set('entryCount', '1');
    const binaryDenied = await worker.fetch(new Request(deniedUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: new Uint8Array([1])
    }), { RP_SYNC_R2: bucket, RP_SYNC_PASSWORD: 'secret' }, {});
    assert.equal(binaryDenied.status, 401);
}

const worker = await loadWorker();
await testLegacyInitializationAndEmptyCommit(worker);
const committed = await testResumablePagedUploadAndPull(worker);
await testMetadataBloomAndOrderingRejections(worker);
await testConcurrentFinalizeAndRootCas(worker);
await testGcCursor(worker, committed);
await testPasswordAndBinaryEndpoint(worker);
console.log('sync-v13-smoke: ok');

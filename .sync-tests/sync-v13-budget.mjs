// Isolated request-budget proxy for schema 13 Worker handlers.
// R2 I/O resolves without network delay and pack streams are staged outside
// the measured window. This keeps wall time focused on Worker-side work.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PREFIX = 'rp-sync/main';
const FORMAT = 'rp-sync-paged-jsonl-v4';
const PAGE_FORMAT = 'rp-sync-manifest-page-v1';
const ROOT_FORMAT = 'rp-sync-manifest-root-v1';
const SESSION_FORMAT = 'rp-sync-upload-session-v1';
const SCHEMA = 13;
const PAGE_PACKS = 32;
const BLOOM_BYTES = 32 * 1024;
const CHAIN_SEED = '0'.repeat(64);
const RUNS = 40;
const WARMUPS = 5;
const CPU_PROXY_MS = 10;
const HARD_WALL_MS = 20;
const encoder = new TextEncoder();

const keys = {
    manifest: `${PREFIX}/manifest.json`,
    migration: `${PREFIX}/migration-v13.done`,
    lock: `${PREFIX}/maintenance/mutation-lock.json`,
    gc: `${PREFIX}/maintenance/gc-v1.json`,
    pack: checksum => `${PREFIX}/packs/${checksum}.bin`,
    page: (checksum, index) => `${PREFIX}/manifests/${checksum}/${String(index).padStart(4, '0')}.json`,
    bloom: checksum => `${PREFIX}/blooms/${checksum}.bin`,
    session: checksum => `${PREFIX}/uploads/${checksum}.json`
};

async function sha256(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Buffer.from(digest).toString('hex');
}

const sha256Text = text => sha256(encoder.encode(text));
const tuple = pack => [pack.bucketKey, pack.group, pack.part, pack.checksum, pack.length, pack.entryCount];
const pageSource = (index, previous, packs) => JSON.stringify([PAGE_FORMAT, index, previous, packs.map(tuple)]);
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

async function buildFixture() {
    const packs = [];
    for (let index = 0; index < PAGE_PACKS; index += 1) {
        const bytes = index === 0
            ? new Uint8Array(1024 * 1024).fill(97)
            : encoder.encode(`pack-${index}\n`);
        packs.push({
            bucketKey: 'idb:RPHubDB:store',
            group: 'records',
            part: index,
            checksum: await sha256(bytes),
            length: bytes.byteLength,
            entryCount: 1,
            bytes
        });
    }
    const pagePacks = packs.map(({ bytes, ...pack }) => pack);
    const pageHash = await sha256Text(pageSource(0, CHAIN_SEED, pagePacks));
    const bloom = makeBloom(packs);
    const snapshot = {
        totalBytes: packs.reduce((sum, pack) => sum + pack.length, 0),
        packCount: packs.length,
        entryCount: packs.length,
        pageCount: 1,
        pageRoot: pageHash,
        bloomChecksum: await sha256(bloom)
    };
    snapshot.checksum = await sha256Text(rootSource(snapshot));
    const now = Date.now();
    const session = {
        format: SESSION_FORMAT,
        uploadId: snapshot.checksum,
        checksum: snapshot.checksum,
        bloomChecksum: snapshot.bloomChecksum,
        baseVersion: 0,
        baseChecksum: '',
        baseEtag: null,
        totalBytes: snapshot.totalBytes,
        packCount: snapshot.packCount,
        entryCount: snapshot.entryCount,
        pageCount: snapshot.pageCount,
        pageRoot: snapshot.pageRoot,
        nextPage: 0,
        previousPageHash: CHAIN_SEED,
        verifiedBytes: 0,
        verifiedPacks: 0,
        verifiedEntries: 0,
        lastBucketKey: null,
        lastGroup: null,
        nextPart: 0,
        createdAt: now,
        updatedAt: now
    };
    const page = {
        format: PAGE_FORMAT,
        checksum: snapshot.checksum,
        pageIndex: 0,
        previousPageHash: CHAIN_SEED,
        pageHash,
        packs: pagePacks
    };
    const manifest = {
        format: ROOT_FORMAT,
        version: 1,
        checksum: snapshot.checksum,
        updatedAt: now,
        ...snapshot,
        snapshotFormat: FORMAT,
        schemaVersion: SCHEMA
    };
    const completedSession = {
        ...session,
        nextPage: 1,
        previousPageHash: pageHash,
        verifiedBytes: snapshot.totalBytes,
        verifiedPacks: snapshot.packCount,
        verifiedEntries: snapshot.entryCount,
        lastBucketKey: pagePacks.at(-1).bucketKey,
        lastGroup: pagePacks.at(-1).group,
        nextPart: PAGE_PACKS,
        updatedAt: now + 1
    };
    const orphans = [];
    for (let index = 0; orphans.length < 256; index += 1) {
        const checksum = await sha256Text(`orphan-${index}`);
        if (!bloomHas(bloom, checksum)) orphans.push(checksum);
    }
    return { packs, pagePacks, page, manifest, session, completedSession, snapshot, bloom, orphans };
}

function createBucket() {
    const objects = new Map();
    const stagedPacks = new Map();
    let current = null;
    let etagSequence = 0;
    let listResult = null;
    const metadata = object => object ? {
        key: object.key,
        etag: object.etag,
        size: object.size,
        uploaded: object.uploaded,
        httpMetadata: object.httpMetadata,
        customMetadata: object.customMetadata
    } : null;
    const bytesOf = async value => {
        if (typeof value === 'string') return encoder.encode(value);
        if (value instanceof Uint8Array) return value;
        if (value instanceof ArrayBuffer) return new Uint8Array(value);
        return new Uint8Array(await new Response(value).arrayBuffer());
    };
    const charge = () => {
        assert.ok(current, 'R2 operation outside request accounting');
        current.subrequests += 1;
        return current;
    };
    const settle = async (accounting, value) => {
        accounting.inflight += 1;
        accounting.maxInflight = Math.max(accounting.maxInflight, accounting.inflight);
        await Promise.resolve();
        accounting.inflight -= 1;
        return value;
    };
    const bucket = {
        reset() {
            assert.equal(current, null);
            objects.clear();
            stagedPacks.clear();
            listResult = null;
            etagSequence = 0;
        },
        seed(key, bytes, options = {}) {
            const value = typeof bytes === 'string' ? encoder.encode(bytes) : bytes;
            etagSequence += 1;
            objects.set(key, {
                key,
                bytes: value,
                size: value.byteLength,
                etag: `seed-${etagSequence}`,
                uploaded: options.uploaded || new Date(),
                httpMetadata: options.httpMetadata,
                customMetadata: options.customMetadata
            });
        },
        stagePack(checksum, bytes) { stagedPacks.set(checksum, bytes); },
        setListResult(value) { listResult = value; },
        beginRequest() {
            assert.equal(current, null);
            current = { subrequests: 0, inflight: 0, maxInflight: 0 };
        },
        endRequest() {
            const result = current;
            current = null;
            return result;
        },
        async head(key) {
            const accounting = charge();
            return settle(accounting, metadata(objects.get(key)));
        },
        async get(key) {
            const accounting = charge();
            const object = objects.get(key);
            const result = object ? {
                ...metadata(object),
                body: new ReadableStream({
                    start(controller) {
                        controller.enqueue(object.bytes);
                        controller.close();
                    }
                }),
                text: async () => Buffer.from(object.bytes).toString('utf8')
            } : null;
            return settle(accounting, result);
        },
        async put(key, value, options = {}) {
            const accounting = charge();
            const match = key.match(/^rp-sync\/main\/packs\/([a-f0-9]{64})\.bin$/);
            const staged = match ? stagedPacks.get(match[1]) : null;
            const bytes = staged || await bytesOf(value);
            const existing = objects.get(key);
            const etag = existing?.etag ?? null;
            if (options.onlyIf?.etagMatches !== undefined && etag !== options.onlyIf.etagMatches) {
                return settle(accounting, null);
            }
            if (options.onlyIf?.etagDoesNotMatch === '*' && etag !== null) {
                return settle(accounting, null);
            }
            if (options.sha256) {
                const expected = options.sha256 instanceof ArrayBuffer
                    ? Buffer.from(options.sha256).toString('hex')
                    : String(options.sha256).toLowerCase();
                if (match) assert.equal(expected, match[1]);
                else assert.equal(await sha256(bytes), expected);
            }
            if (match) stagedPacks.delete(match[1]);
            etagSequence += 1;
            const next = {
                key,
                bytes,
                size: bytes.byteLength,
                etag: `put-${etagSequence}`,
                uploaded: new Date(),
                httpMetadata: options.httpMetadata,
                customMetadata: options.customMetadata
            };
            objects.set(key, next);
            return settle(accounting, { key, etag: next.etag });
        },
        async delete() {
            const accounting = charge();
            return settle(accounting, undefined);
        },
        async list() {
            const accounting = charge();
            assert.ok(listResult, 'budget fixture must precompute R2 list results');
            return settle(accounting, listResult);
        }
    };
    return bucket;
}

const workerSource = await fs.readFile(path.join(root, '_worker.js'), 'utf8');
const worker = new Function('fetch', workerSource.replace('export default {', 'return {'))(globalThis.fetch);
const fixture = await buildFixture();
const migration = JSON.stringify({ format: 'rp-sync-migration-v13', legacyEtag: null, createdAt: Date.now() });
const jsonRequest = body => new Request('https://local.test/api/rp-sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
});
const seedPack = (bucket, pack) => bucket.seed(keys.pack(pack.checksum), pack.bytes, {
    httpMetadata: { contentType: 'application/octet-stream' },
    customMetadata: { entryCount: String(pack.entryCount) }
});
const seedCommitted = bucket => {
    bucket.seed(keys.migration, migration);
    bucket.seed(keys.manifest, JSON.stringify(fixture.manifest));
    bucket.seed(keys.page(fixture.snapshot.checksum, 0), JSON.stringify(fixture.page));
    bucket.seed(keys.bloom(fixture.snapshot.bloomChecksum), fixture.bloom);
};

async function invoke(bucket, request) {
    const waitUntil = [];
    bucket.beginRequest();
    const started = process.hrtime.bigint();
    let response;
    let wallMs;
    let accounting;
    try {
        response = await worker.fetch(request, { RP_SYNC_R2: bucket }, {
            waitUntil: promise => waitUntil.push(Promise.resolve(promise))
        });
        while (waitUntil.length) await waitUntil.shift();
        wallMs = Number(process.hrtime.bigint() - started) / 1e6;
    } finally {
        accounting = bucket.endRequest();
    }
    return { response, wallMs, ...accounting };
}

async function benchmark({ name, setup, status, minSubrequests = 1 }) {
    const bucket = createBucket();
    const execute = async record => {
        const request = setup(bucket);
        const result = await invoke(bucket, request);
        assert.equal(result.response.status, status, `${name} returned ${result.response.status}`);
        assert.ok(result.subrequests >= minSubrequests, `${name} skipped expected R2 work`);
        assert.ok(result.subrequests <= 50, `${name} used ${result.subrequests} subrequests`);
        assert.ok(result.maxInflight <= 6, `${name} used ${result.maxInflight} concurrent R2 operations`);
        await result.response.body?.cancel();
        if (record) return result;
        return null;
    };
    if (typeof globalThis.gc === 'function') globalThis.gc();
    for (let index = 0; index < WARMUPS; index += 1) await execute(false);
    if (typeof globalThis.gc === 'function') globalThis.gc();
    const samples = [];
    for (let index = 0; index < RUNS; index += 1) samples.push(await execute(true));
    const walls = samples.map(sample => sample.wallMs).sort((a, b) => a - b);
    const p50 = walls[Math.floor(walls.length / 2)];
    const p95 = walls[Math.ceil(walls.length * 0.95) - 1];
    const max = walls.at(-1);
    const maxSubrequests = Math.max(...samples.map(sample => sample.subrequests));
    const maxInflight = Math.max(...samples.map(sample => sample.maxInflight));
    console.log(`${name}: wall p50=${p50.toFixed(2)} p95=${p95.toFixed(2)} max=${max.toFixed(2)} ms, subrequests=${maxSubrequests}, R2 concurrency=${maxInflight}`);
    assert.ok(p95 <= CPU_PROXY_MS, `${name} p95 ${p95.toFixed(2)}ms exceeds ${CPU_PROXY_MS}ms proxy budget`);
    assert.ok(max <= HARD_WALL_MS, `${name} max ${max.toFixed(2)}ms exceeds ${HARD_WALL_MS}ms ceiling`);
}

await benchmark({
    name: 'upload-pack (1MiB direct stream)',
    status: 204,
    minSubrequests: 3,
    setup(bucket) {
        bucket.reset();
        bucket.seed(keys.session(fixture.snapshot.checksum), JSON.stringify(fixture.session));
        const pack = fixture.packs[0];
        bucket.stagePack(pack.checksum, pack.bytes);
        const url = new URL('https://local.test/api/rp-sync');
        url.searchParams.set('action', 'upload-pack');
        url.searchParams.set('uploadId', fixture.snapshot.checksum);
        url.searchParams.set('checksum', pack.checksum);
        url.searchParams.set('length', String(pack.length));
        url.searchParams.set('entryCount', String(pack.entryCount));
        return new Request(url, {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body: pack.bytes
        });
    }
});

await benchmark({
    name: 'upload-manifest-page (32 packs)',
    status: 200,
    minSubrequests: 36,
    setup(bucket) {
        bucket.reset();
        bucket.seed(keys.session(fixture.snapshot.checksum), JSON.stringify(fixture.session));
        bucket.seed(keys.bloom(fixture.snapshot.bloomChecksum), fixture.bloom);
        for (const pack of fixture.packs) seedPack(bucket, pack);
        return jsonRequest({
            action: 'upload-manifest-page',
            uploadId: fixture.snapshot.checksum,
            pageIndex: 0,
            packs: fixture.pagePacks
        });
    }
});

await benchmark({
    name: 'finalize-upload (verified root)',
    status: 200,
    minSubrequests: 10,
    setup(bucket) {
        bucket.reset();
        bucket.seed(keys.migration, migration);
        bucket.seed(keys.session(fixture.snapshot.checksum), JSON.stringify(fixture.completedSession));
        bucket.seed(keys.bloom(fixture.snapshot.bloomChecksum), fixture.bloom);
        return jsonRequest({ action: 'finalize-upload', uploadId: fixture.snapshot.checksum });
    }
});

await benchmark({
    name: 'pull-manifest-page (32 packs)',
    status: 200,
    minSubrequests: 4,
    setup(bucket) {
        bucket.reset();
        seedCommitted(bucket);
        return jsonRequest({ action: 'pull-manifest-page', version: 1, pageIndex: 0 });
    }
});

await benchmark({
    name: 'pull-pack (1MiB direct stream)',
    status: 200,
    minSubrequests: 5,
    setup(bucket) {
        bucket.reset();
        seedCommitted(bucket);
        const pack = fixture.packs[0];
        seedPack(bucket, pack);
        return jsonRequest({
            action: 'pull-pack',
            version: 1,
            pageIndex: 0,
            packIndex: 0,
            checksum: pack.checksum,
            length: pack.length,
            entryCount: pack.entryCount
        });
    }
});

await benchmark({
    name: 'gc-step (256 listed packs)',
    status: 200,
    minSubrequests: 11,
    setup(bucket) {
        bucket.reset();
        seedCommitted(bucket);
        const uploaded = new Date(Date.now() - 48 * 60 * 60 * 1000);
        const listed = [];
        for (const checksum of fixture.orphans) {
            const key = keys.pack(checksum);
            bucket.seed(key, new Uint8Array([1]), { uploaded });
            listed.push({ key, size: 1, uploaded });
        }
        bucket.setListResult({ objects: listed, truncated: false, cursor: undefined });
        return jsonRequest({ action: 'gc-step' });
    }
});

console.log('sync-v13-budget: ok');

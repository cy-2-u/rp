import assert from 'node:assert/strict';
import {
    BLOOM_BYTES, MANIFEST_KEY, MIGRATION_KEY, SCHEMA,
    bloomHas, bloomKey, buildSnapshot, pageKey, packKey, sessionKey
} from './lib/protocol.mjs';
import { createR2Mock } from './lib/r2-bucket.mjs';
import { loadWorker } from './lib/worker-loader.mjs';
import {
    begin, createBarrier, finishPages, initialize, makeApi, prepareSnapshot,
    seedPack, submitPage, uploadBloom, uploadPack
} from './lib/sync-api.mjs';

const encoder = new TextEncoder();

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
    assert.deepEqual(raced.map(item => item.response.status).sort(), [200, 200], 'concurrent same-page retries are idempotent');

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
    assert.equal(blockedGc.response.status, 200, 'GC may run while finalize is in progress');
    assert.equal(blockedGc.body.deletedCount, 0, 'pending finalize packs must remain protected');
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
    // 清单页在 isolate 内有内容寻址缓存（页对象按协议不可变）；本用例改写
    // R2 属于隔离体外损坏，需用全新 isolate 验证读取路径仍会校验并拒绝。
    const damagedWorker = await loadWorker();
    const damagedApi = makeApi(damagedWorker, bucket);
    const damagedPull = await damagedApi.post({ action: 'pull-manifest-page', version: 1, pageIndex: 1 });
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
        assert.equal((await uploadPack(api, snapshot.checksum, snapshot.packs[0])).status, 409, 'undeclared upload is rejected');
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
        assert.equal((await uploadPack(api, snapshot.checksum, snapshot.packs[0])).status, 409);
        assert.equal(bucket.objects.get(packKey(snapshot.packs[0].checksum)).customMetadata.entryCount, '2', 'existing metadata is immutable');
        assert.deepEqual((await submitPage(api, snapshot, 0)).body.missingPacks, [snapshot.packs[0].checksum]);
    }

    {
        const bucket = createR2Mock();
        const api = makeApi(worker, bucket);
        await initialize(api);
        const snapshot = await buildSnapshot(1, { prefix: 'damaged-bloom' });
        await prepareSnapshot(api, snapshot);
        assert.equal(JSON.parse(Buffer.from(bucket.objects.get(sessionKey(snapshot.checksum)).bytes)).nextPage, 1);
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
        await prepareSnapshot(api, snapshot);
        const rootGate = createBarrier(2);
        bucket.hooks.beforePut = async ({ key, options }) => {
            if (key === MANIFEST_KEY && options.onlyIf) await rootGate();
        };
        const results = await Promise.all([
            api.json({ action: 'finalize-upload', uploadId: snapshot.checksum }),
            api.json({ action: 'finalize-upload', uploadId: snapshot.checksum })
        ]);
        bucket.hooks.beforePut = null;
        assert.deepEqual(results.map(item => item.response.status).sort(), [200, 200],
            'same snapshot finalize is idempotent under a root CAS race');
        const root = JSON.parse(Buffer.from(bucket.objects.get(MANIFEST_KEY).bytes).toString('utf8'));
        assert.equal(root.checksum, snapshot.checksum);
        const retry = await api.json({ action: 'finalize-upload', uploadId: snapshot.checksum });
        assert.equal(retry.response.status, 200, 'a repeated finalize must be idempotent');
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
        const replaced = await api.json({ action: 'finalize-upload', uploadId: right.checksum });
        assert.equal(replaced.response.status, 200, 'a later complete snapshot must replace the old root');
        assert.equal(replaced.body.remote.checksum, right.checksum);
        const rootObject = JSON.parse(Buffer.from(bucket.objects.get(MANIFEST_KEY).bytes).toString('utf8'));
        assert.equal(rootObject.checksum, right.checksum);
        assert.equal(rootObject.version, 2, 'last-wins commit increments the observed root version');
    }
}

async function testConsistencyRecoveryAndImmutablePacks(worker) {
    {
        const bucket = createR2Mock();
        const api = makeApi(worker, bucket);
        await initialize(api);
        const committed = await buildSnapshot(1, { prefix: 'committed' });
        await prepareSnapshot(api, committed);
        assert.equal((await api.post({ action: 'finalize-upload', uploadId: committed.checksum })).status, 200);

        const other = await buildSnapshot(1, { prefix: 'other' });
        await begin(api, other, 1, committed.checksum);
        await uploadBloom(api, other);
        const page = await submitPage(api, other, 0);
        assert.equal(page.body.nextPage, 0);
        assert.ok(bucket.objects.has(pageKey(other.checksum, 0)), 'page declaration is durable before binary upload');

        const old = bucket.objects.get(packKey(committed.packs[0].checksum));
        assert.equal((await uploadPack(api, other.checksum, { ...committed.packs[0], entryCount: 2 })).status, 409);
        assert.equal(bucket.objects.get(old.key), old, 'cross-session write cannot replace an existing pack');
        assert.equal((await api.post({ action: 'pull-pack', version: 1, pageIndex: 0, packIndex: 0, ...committed.pages[0].packs[0] })).status, 200);

        const outcomes = await Promise.all([
            uploadPack(api, other.checksum, other.packs[0]),
            uploadPack(api, other.checksum, other.packs[0])
        ]);
        assert.deepEqual(outcomes.map(item => item.status), [204, 204]);
        assert.equal((await uploadPack(api, other.checksum, { ...other.packs[0], entryCount: 2 })).status, 409);
        await submitPage(api, other, 0);
        assert.equal((await uploadPack(api, other.checksum, other.packs[0])).status, 204, 'completed-page retry is idempotent');
    }

    {
        const bucket = createR2Mock();
        const api = makeApi(worker, bucket);
        await initialize(api);
        const snapshot = await buildSnapshot(0, { prefix: 'lost-root-response' });
        await prepareSnapshot(api, snapshot);
        const put = bucket.put.bind(bucket);
        bucket.put = async (key, bytes, options) => {
            const result = await put(key, bytes, options);
            if (key === MANIFEST_KEY) throw new Error('R2 response lost after root write');
            return result;
        };
        const finalized = await api.json({ action: 'finalize-upload', uploadId: snapshot.checksum });
        assert.equal(finalized.response.status, 200, 'finalize verifies a root after an unknown write response');
        assert.equal(finalized.body.remote.checksum, snapshot.checksum);
    }

    {
        const bucket = createR2Mock();
        const api = makeApi(worker, bucket);
        await initialize(api);
        const snapshot = await buildSnapshot(1, { prefix: 'lost-session-response' });
        const put = bucket.put.bind(bucket);
        bucket.put = async (key, bytes, options) => {
            const result = await put(key, bytes, options);
            if (key === sessionKey(snapshot.checksum)) throw new Error('R2 response lost after session write');
            return result;
        };
        assert.equal((await begin(api, snapshot)).response.status, 503);
        bucket.put = put;
        const resumed = await begin(api, snapshot);
        assert.equal(resumed.response.status, 200, 'a session write with a lost response remains resumable');
    }

    console.log('PASS consistency recovery, immutable packs and page/session binding');
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

async function runGcToDone(api, maxSteps = 12) {
    let steps = 0;
    let done = false;
    let deletedCount = 0;
    while (!done && steps < maxSteps) {
        const result = await api.json({ action: 'gc-step' });
        assert.equal(result.response.status, 200);
        done = result.body.done;
        deletedCount += result.body.deletedCount || 0;
        steps += 1;
    }
    assert.equal(done, true, `GC must reach done within ${maxSteps} steps`);
    return deletedCount;
}

async function testGcControlObjectLifecycle(worker) {
    const bucket = createR2Mock();
    const api = makeApi(worker, bucket);
    await initialize(api);

    // 第一代快照：随后整体替换，其 page/Bloom/session 都成为可回收垃圾。
    const old = await buildSnapshot(1, { prefix: 'gc-old' });
    await prepareSnapshot(api, old);
    assert.equal((await api.post({ action: 'finalize-upload', uploadId: old.checksum })).status, 200);
    assert.ok(bucket.objects.has(pageKey(old.checksum, 0)));
    assert.ok(bucket.objects.has(bloomKey(old.bloomChecksum)));

    // 新根提交后旧 page/Bloom 不再被引用，但仍在 24 小时控制对象宽限期内。
    const fresh = await buildSnapshot(1, { prefix: 'gc-new' });
    await prepareSnapshot(api, fresh);
    const freshFinal = await api.json({ action: 'finalize-upload', uploadId: fresh.checksum });
    assert.equal(freshFinal.response.status, 200);

    const firstPass = await api.json({ action: 'gc-step' });
    assert.equal(firstPass.response.status, 200);
    assert.ok(bucket.objects.has(pageKey(old.checksum, 0)), 'fresh control objects stay within the grace window');
    assert.ok(bucket.objects.has(bloomKey(old.bloomChecksum)));

    // 时钟越过宽限期后，旧 page/Bloom 被回收，当前根的对象保留。
    bucket.objects.get(pageKey(old.checksum, 0)).uploaded = new Date(Date.now() - 48 * 60 * 60 * 1000);
    bucket.objects.get(bloomKey(old.bloomChecksum)).uploaded = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await runGcToDone(api);
    assert.ok(!bucket.objects.has(pageKey(old.checksum, 0)), 'orphaned manifest pages must be collected');
    assert.ok(!bucket.objects.has(bloomKey(old.bloomChecksum)), 'orphaned blooms must be collected');
    assert.ok(bucket.objects.has(pageKey(fresh.checksum, 0)), 'the current root page must survive GC');
    assert.ok(bucket.objects.has(bloomKey(fresh.bloomChecksum)), 'the current root bloom must survive GC');
    for (const pack of fresh.packs) assert.ok(bucket.objects.has(packKey(pack.checksum)));

    // 过期 upload session：根切换触发新一轮完整扫描（与真实上传后客户端
    // drain 的路径一致），过期会话被删除后 begin-upload 能建立新会话。
    const expired = await buildSnapshot(1, { prefix: 'gc-expired' });
    await begin(api, expired, freshFinal.body.remote.version, fresh.checksum);
    const sessionObject = bucket.objects.get(sessionKey(expired.checksum));
    assert.ok(sessionObject);
    const staleTime = Date.now() - 8 * 24 * 60 * 60 * 1000;
    sessionObject.uploaded = new Date(staleTime);
    const storedSession = JSON.parse(Buffer.from(sessionObject.bytes).toString('utf8'));
    storedSession.createdAt = staleTime;
    storedSession.updatedAt = staleTime;
    sessionObject.bytes = encoder.encode(JSON.stringify(storedSession));
    sessionObject.size = sessionObject.bytes.byteLength;

    const next = await buildSnapshot(1, { prefix: 'gc-next' });
    await prepareSnapshot(api, next);
    assert.equal((await api.post({ action: 'finalize-upload', uploadId: next.checksum })).status, 200);
    await runGcToDone(api);
    assert.ok(!bucket.objects.has(sessionKey(expired.checksum)), 'expired upload sessions must be collected');

    const reborn = await begin(api, expired, 3, next.checksum);
    assert.equal(reborn.response.status, 200, 'begin-upload after session expiry must create a new session');
    assert.equal(reborn.body.nextPage, 0);
    assert.equal((await uploadBloom(api, expired)).status, 204, 'the bloom can be re-uploaded into the new session');
    await finishPages(api, expired);
    assert.equal((await api.post({ action: 'finalize-upload', uploadId: expired.checksum })).status, 200);
    assert.equal(JSON.parse(Buffer.from(bucket.objects.get(MANIFEST_KEY).bytes).toString('utf8')).checksum, expired.checksum);
}

async function testGcProtectsFreshSession(worker) {
    const bucket = createR2Mock();
    const api = makeApi(worker, bucket);
    await initialize(api);
    const committed = await buildSnapshot(1, { prefix: 'protect-base' });
    await prepareSnapshot(api, committed);
    assert.equal((await api.post({ action: 'finalize-upload', uploadId: committed.checksum })).status, 200);

    // 新鲜（未过期）pending session：其 page/Bloom/session/pack 全部保留。
    const pending = await buildSnapshot(1, { prefix: 'protect-pending' });
    await seedPack(bucket, pending.packs[0], new Date(Date.now() - 48 * 60 * 60 * 1000));
    await begin(api, pending, 1, committed.checksum);
    await uploadBloom(api, pending);
    await submitPage(api, pending, 0);

    const replaced = await buildSnapshot(1, { prefix: 'protect-new' });
    await prepareSnapshot(api, replaced);
    assert.equal((await api.post({ action: 'finalize-upload', uploadId: replaced.checksum })).status, 200);

    bucket.objects.get(pageKey(committed.checksum, 0)).uploaded = new Date(Date.now() - 48 * 60 * 60 * 1000);
    bucket.objects.get(bloomKey(committed.bloomChecksum)).uploaded = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await runGcToDone(api);

    assert.ok(!bucket.objects.has(pageKey(committed.checksum, 0)), 'replaced root pages are collectable');
    assert.ok(bucket.objects.has(sessionKey(pending.checksum)), 'a fresh pending session must survive GC');
    assert.ok(bucket.objects.has(pageKey(pending.checksum, 0)), 'a fresh session page must survive GC');
    assert.ok(bucket.objects.has(bloomKey(pending.bloomChecksum)), 'a fresh session bloom must survive GC');
    assert.ok(bucket.objects.has(packKey(pending.packs[0].checksum)), 'packs protected by a fresh session must survive GC');

    const resumed = await begin(api, pending, 1, committed.checksum);
    assert.equal(resumed.response.status, 200, 'a fresh session remains resumable after GC');
    assert.equal(resumed.body.nextPage, 1);
    assert.equal((await api.post({ action: 'finalize-upload', uploadId: pending.checksum })).status, 200);
}

async function testGcStageDrainCoversAllObjects(worker) {
    const bucket = createR2Mock();
    const api = makeApi(worker, bucket);
    await initialize(api);
    const root = await buildSnapshot(1, { prefix: 'drain-root' });
    await prepareSnapshot(api, root);
    assert.equal((await api.post({ action: 'finalize-upload', uploadId: root.checksum })).status, 200);

    // 四类垃圾各造一个：旧 pack、旧 page、旧 Bloom、过期 session。
    const stale = Date.now() - 48 * 60 * 60 * 1000;
    const seedStale = async (key, bytes) => {
        await bucket.put(key, bytes);
        bucket.objects.get(key).uploaded = new Date(stale);
    };
    const orphanPack = 'e'.repeat(64);
    assert.ok(!bloomHas(root.bloom, orphanPack));
    await seedStale(packKey(orphanPack), new Uint8Array([9]));
    const garbageSnapshot = await buildSnapshot(1, { prefix: 'drain-garbage' });
    await seedStale(pageKey(garbageSnapshot.checksum, 0), encoder.encode('{}'));
    await seedStale(bloomKey(garbageSnapshot.bloomChecksum), new Uint8Array(BLOOM_BYTES));
    await begin(api, garbageSnapshot, 1, root.checksum);
    const staleTime = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const garbageSession = bucket.objects.get(sessionKey(garbageSnapshot.checksum));
    garbageSession.uploaded = new Date(staleTime);
    const garbageStored = JSON.parse(Buffer.from(garbageSession.bytes).toString('utf8'));
    garbageStored.createdAt = staleTime;
    garbageStored.updatedAt = staleTime;
    garbageSession.bytes = encoder.encode(JSON.stringify(garbageStored));
    garbageSession.size = garbageSession.bytes.byteLength;

    let stageSequence = [];
    let steps = 0;
    let done = false;
    while (!done && steps < 12) {
        const result = await api.json({ action: 'gc-step' });
        assert.equal(result.response.status, 200);
        done = result.body.done;
        if (result.body.stage) stageSequence.push(result.body.stage);
        steps += 1;
    }
    assert.equal(done, true);
    assert.ok(stageSequence.includes('packs') && stageSequence.includes('manifest-pages')
        && stageSequence.includes('blooms') && stageSequence.includes('uploads'),
        `all four GC stages must run, saw ${stageSequence.join(',')}`);
    assert.ok(!bucket.objects.has(packKey(orphanPack)), 'orphan packs must be collected');
    assert.ok(!bucket.objects.has(pageKey(garbageSnapshot.checksum, 0)), 'garbage pages must be collected');
    assert.ok(!bucket.objects.has(bloomKey(garbageSnapshot.bloomChecksum)), 'garbage blooms must be collected');
    assert.ok(!bucket.objects.has(sessionKey(garbageSnapshot.checksum)), 'expired sessions must be collected');
    assert.ok(bucket.objects.has(pageKey(root.checksum, 0)));
    assert.ok(bucket.objects.has(bloomKey(root.bloomChecksum)));
    for (const pack of root.packs) assert.ok(bucket.objects.has(packKey(pack.checksum)));

    // 全部阶段完成后重复 gc-step 是幂等的空操作。
    const idle = await api.json({ action: 'gc-step' });
    assert.equal(idle.response.status, 200);
    assert.equal(idle.body.done, true);
}

async function testPasswordAndBinaryEndpoint(worker) {
    const bucket = createR2Mock();
    const api = makeApi(worker, bucket, 'secret');
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

async function testFinalizeChecksReusedPacks(worker) {
    const bucket = createR2Mock();
    const api = makeApi(worker, bucket);
    await initialize(api);

    const seed = await buildSnapshot(1, { prefix: 'finalize-seed' });
    await prepareSnapshot(api, seed);
    assert.equal((await api.json({ action: 'finalize-upload', uploadId: seed.checksum })).response.status, 200);

    // The new snapshot reuses the old pack instead of uploading it again.
    const snapshot = await buildSnapshot(2, {
        prefix: 'finalize-reused',
        mutatePacks(packs) {
            packs[0] = seed.packs[0];
            packs[1] = {
                ...packs[1],
                bucketKey: seed.packs[0].bucketKey,
                group: seed.packs[0].group,
                part: 1
            };
        }
    });
    await prepareSnapshot(api, snapshot);

    // Advance the root to a snapshot that does not reference the reused pack,
    // then simulate a GC race deleting it before this session finalizes.
    const other = await buildSnapshot(1, { prefix: 'finalize-other' });
    await prepareSnapshot(api, other);
    assert.equal((await api.json({ action: 'finalize-upload', uploadId: other.checksum })).response.status, 200);
    bucket.objects.delete(packKey(seed.packs[0].checksum));

    const finalized = await api.json({
        action: 'finalize-upload',
        uploadId: snapshot.checksum,
        reusedPacks: [seed.packs[0].checksum]
    });
    assert.equal(finalized.response.status, 409, 'missing reused packs must block finalize');
    assert.deepEqual(finalized.body.missingPacks, [seed.packs[0].checksum]);
    assert.equal(bucket.objects.has(sessionKey(snapshot.checksum)), false,
        'failed reused-pack verification clears the session so a retry can re-upload');
}

const worker = await loadWorker();
await testLegacyInitializationAndEmptyCommit(worker);
const committed = await testResumablePagedUploadAndPull(worker);
await testMetadataBloomAndOrderingRejections(worker);
await testConcurrentFinalizeAndRootCas(worker);
await testConsistencyRecoveryAndImmutablePacks(worker);
await testGcCursor(worker, committed);
await testGcControlObjectLifecycle(worker);
await testGcProtectsFreshSession(worker);
await testGcStageDrainCoversAllObjects(worker);
await testFinalizeChecksReusedPacks(worker);
await testPasswordAndBinaryEndpoint(worker);
console.log('sync-v13-smoke: ok');

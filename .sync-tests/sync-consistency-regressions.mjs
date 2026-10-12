import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const original = await fs.readFile(new URL('./sync-v13-smoke.mjs', import.meta.url), 'utf8');
const prefix = original.slice(0, original.indexOf('const worker = await loadWorker();'))
    .replace("const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));", `const root = ${JSON.stringify(fileURLToPath(new URL('..', import.meta.url)))};`);
const helpersUrl = 'data:text/javascript;base64,' + Buffer.from(prefix + '\nexport { loadWorker, createR2Mock, makeApi, initialize, buildSnapshot, prepareSnapshot, begin, uploadBloom, submitPage, uploadPack, finishPages, packKey, pageKey, sessionKey, seedPack, MANIFEST_KEY };').toString('base64');
const h = await import(helpersUrl);
const worker = await h.loadWorker();

const setup = async () => {
    const bucket = h.createR2Mock();
    const api = h.makeApi(worker, bucket);
    await h.initialize(api);
    return { bucket, api };
};

const readJson = (bucket, key) => JSON.parse(Buffer.from(bucket.objects.get(key).bytes).toString('utf8'));

{
    const { bucket, api } = await setup();
    const committed = await h.buildSnapshot(1, { prefix: 'committed' });
    await h.prepareSnapshot(api, committed);
    assert.equal((await api.post({ action: 'finalize-upload', uploadId: committed.checksum })).status, 200);

    const other = await h.buildSnapshot(1, { prefix: 'other' });
    await h.begin(api, other, 1, committed.checksum);
    await h.uploadBloom(api, other);
    const page = await h.submitPage(api, other, 0);
    assert.equal(page.body.nextPage, 0);
    assert.ok(bucket.objects.has(h.pageKey(other.checksum, 0)), 'page declaration is durable before binary upload');

    const old = bucket.objects.get(h.packKey(committed.packs[0].checksum));
    assert.equal((await h.uploadPack(api, other.checksum, { ...committed.packs[0], entryCount: 2 })).status, 409);
    assert.equal(bucket.objects.get(old.key), old, 'cross-session write cannot replace an existing pack');
    assert.equal((await api.post({ action: 'pull-pack', version: 1, pageIndex: 0, packIndex: 0, ...committed.pages[0].packs[0] })).status, 200);

    const outcomes = await Promise.all([
        h.uploadPack(api, other.checksum, other.packs[0]),
        h.uploadPack(api, other.checksum, other.packs[0])
    ]);
    assert.deepEqual(outcomes.map(item => item.status), [204, 204]);
    assert.equal((await h.uploadPack(api, other.checksum, { ...other.packs[0], entryCount: 2 })).status, 409);
    await h.submitPage(api, other, 0);
    assert.equal((await h.uploadPack(api, other.checksum, other.packs[0])).status, 204, 'completed-page retry is idempotent');
}

{
    const { bucket, api } = await setup();
    const committed = await h.buildSnapshot(0, { prefix: 'base' });
    await h.prepareSnapshot(api, committed);
    assert.equal((await api.post({ action: 'finalize-upload', uploadId: committed.checksum })).status, 200);

    const pending = await h.buildSnapshot(1, { prefix: 'pending-finalize' });
    await h.seedPack(bucket, pending.packs[0], new Date(Date.now() - 48 * 60 * 60 * 1000));
    await h.prepareSnapshot(api, pending, 1, committed.checksum);

    let release;
    let entered;
    const gate = new Promise(resolve => { release = resolve; });
    const ready = new Promise(resolve => { entered = resolve; });
    bucket.hooks.beforePut = async ({ key }) => {
        if (key === h.MANIFEST_KEY) {
            entered();
            await gate;
        }
    };
    const finalizing = api.post({ action: 'finalize-upload', uploadId: pending.checksum });
    await ready;
    const gc = await api.json({ action: 'gc-step' });
    assert.equal(gc.response.status, 200, 'GC and finalize do not use a user-visible maintenance lock');
    assert.equal(gc.body.deletedCount, 0, 'GC protects the active upload session');
    release();
    bucket.hooks.beforePut = null;
    assert.equal((await finalizing).status, 200);
    assert.ok(bucket.objects.has(h.packKey(pending.packs[0].checksum)));
}

{
    const { bucket, api } = await setup();
    const left = await h.buildSnapshot(1, { prefix: 'left' });
    const right = await h.buildSnapshot(1, { prefix: 'right' });
    await h.prepareSnapshot(api, left);
    await h.prepareSnapshot(api, right);
    assert.equal((await api.post({ action: 'finalize-upload', uploadId: left.checksum })).status, 200);
    const replaced = await api.json({ action: 'finalize-upload', uploadId: right.checksum });
    assert.equal(replaced.response.status, 200, 'a later complete snapshot replaces the old root');
    assert.equal(replaced.body.remote.checksum, right.checksum);
    assert.equal(readJson(bucket, h.MANIFEST_KEY).checksum, right.checksum);
}

{
    const { bucket, api } = await setup();
    const snapshot = await h.buildSnapshot(0, { prefix: 'same-finalize' });
    await h.prepareSnapshot(api, snapshot);
    let arrived;
    let release;
    const entered = new Promise(resolve => { arrived = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    bucket.hooks.beforePut = async ({ key, options }) => {
        if (key === h.MANIFEST_KEY && options.onlyIf) {
            arrived();
            await gate;
        }
    };
    const results = [
        api.json({ action: 'finalize-upload', uploadId: snapshot.checksum }),
        api.json({ action: 'finalize-upload', uploadId: snapshot.checksum })
    ];
    await entered;
    release();
    const settled = await Promise.all(results);
    bucket.hooks.beforePut = null;
    assert.deepEqual(settled.map(item => item.response.status).sort(), [200, 200],
        'same snapshot finalize converges after root CAS competition');
    assert.equal(readJson(bucket, h.MANIFEST_KEY).checksum, snapshot.checksum);
}

{
    const { bucket, api } = await setup();
    const snapshot = await h.buildSnapshot(0, { prefix: 'lost-root-response' });
    await h.prepareSnapshot(api, snapshot);
    const put = bucket.put.bind(bucket);
    bucket.put = async (key, bytes, options) => {
        const result = await put(key, bytes, options);
        if (key === h.MANIFEST_KEY) throw new Error('R2 response lost after root write');
        return result;
    };
    const finalized = await api.json({ action: 'finalize-upload', uploadId: snapshot.checksum });
    assert.equal(finalized.response.status, 200, 'finalize verifies a root after an unknown write response');
    assert.equal(finalized.body.remote.checksum, snapshot.checksum);
}

{
    const { bucket, api } = await setup();
    const snapshot = await h.buildSnapshot(1, { prefix: 'lost-session-response' });
    const put = bucket.put.bind(bucket);
    bucket.put = async (key, bytes, options) => {
        const result = await put(key, bytes, options);
        if (key === h.sessionKey(snapshot.checksum)) throw new Error('R2 response lost after session write');
        return result;
    };
    assert.equal((await h.begin(api, snapshot)).response.status, 503);
    bucket.put = put;
    const resumed = await h.begin(api, snapshot);
    assert.equal(resumed.response.status, 200, 'a session write with a lost response remains resumable');
}

console.log('sync-consistency-regressions: last-wins, idempotent CAS, pending-upload GC protection and unknown-write recovery passed');

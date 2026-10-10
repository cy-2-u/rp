import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const original = await fs.readFile(new URL('./sync-v13-smoke.mjs', import.meta.url), 'utf8');
const prefix = original.slice(0, original.indexOf('const worker = await loadWorker();'))
    .replace("const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));", `const root = ${JSON.stringify(fileURLToPath(new URL('..', import.meta.url)))};`);
const helpersUrl = 'data:text/javascript;base64,' + Buffer.from(prefix + '\nexport { loadWorker, createR2Mock, makeApi, initialize, buildSnapshot, prepareSnapshot, begin, uploadBloom, submitPage, uploadPack, finishPages, packKey, pageKey, sessionKey, seedPack, LOCK_KEY, MANIFEST_KEY };').toString('base64');
const h = await import(helpersUrl);
const workerSource = await fs.readFile(new URL('../_worker.js', import.meta.url), 'utf8');
let clock = Date.now();
class Clock extends Date { static now() { return clock; } }
const apiHelpers = new Function('Date', workerSource.replace('export default {', 'const worker = {') + ';return { worker, acquireMutationLock, promoteMutationLock, releaseMutationLock };')(Clock);
const worker = apiHelpers.worker;
const setup = async () => {
    const bucket = h.createR2Mock();
    const api = h.makeApi(worker, bucket);
    await h.initialize(api);
    return { bucket, api };
};
const readJson = (bucket, key) => JSON.parse(Buffer.from(bucket.objects.get(key).bytes));
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
    assert.ok(bucket.objects.has(h.pageKey(other.checksum, 0)), 'missing page is declared before binary upload');
    const old = bucket.objects.get(h.packKey(committed.packs[0].checksum));
    assert.equal((await h.uploadPack(api, other.checksum, { ...committed.packs[0], entryCount: 2 })).status, 409);
    assert.equal(bucket.objects.get(old.key), old, 'cross-session write cannot replace an existing pack');
    const response = await api.post({ action: 'pull-pack', version: 1, pageIndex: 0, packIndex: 0, ...committed.pages[0].packs[0] });
    assert.equal(response.status, 200);
    const outcomes = await Promise.all([h.uploadPack(api, other.checksum, other.packs[0]), h.uploadPack(api, other.checksum, other.packs[0])]);
    assert.deepEqual(outcomes.map(item => item.status), [204, 204]);
    assert.equal((await h.uploadPack(api, other.checksum, { ...other.packs[0], entryCount: 2 })).status, 409);
    await h.submitPage(api, other, 0);
    assert.equal((await h.uploadPack(api, other.checksum, other.packs[0])).status, 204, 'completed-page retry is idempotent');
}
{
    const { bucket, api } = await setup();
    const root = await h.buildSnapshot(0);
    await h.prepareSnapshot(api, root);
    await api.post({ action: 'finalize-upload', uploadId: root.checksum });
    const next = await h.buildSnapshot(1, { prefix: 'long-finalize' });
    await h.seedPack(bucket, next.packs[0], new Date(clock - 48 * 3600000));
    await h.prepareSnapshot(api, next, 1, root.checksum);
    let release, arrived;
    const gate = new Promise(resolve => { release = resolve; });
    const ready = new Promise(resolve => { arrived = resolve; });
    bucket.hooks.beforePut = async ({ key }) => { if (key === h.MANIFEST_KEY) { arrived(); await gate; } };
    const final = api.post({ action: 'finalize-upload', uploadId: next.checksum });
    await ready;
    clock += 60000;
    assert.equal(readJson(bucket, h.LOCK_KEY).phase, 'mutating');
    assert.equal((await api.post({ action: 'gc-step' })).status, 409);
    release();
    assert.equal((await final).status, 200);
    assert.ok(bucket.objects.has(h.packKey(next.packs[0].checksum)));
}
{
    const { bucket } = await setup();
    const old = await apiHelpers.acquireMutationLock(bucket);
    clock += 31000;
    const next = await apiHelpers.acquireMutationLock(bucket);
    assert.ok(next);
    assert.equal(await apiHelpers.promoteMutationLock(bucket, old), false);
    await apiHelpers.releaseMutationLock(bucket, old);
    assert.equal(readJson(bucket, h.LOCK_KEY).owner, next.owner);
    assert.equal(await apiHelpers.promoteMutationLock(bucket, next), true);
    clock += 60000;
    assert.equal(await apiHelpers.acquireMutationLock(bucket), null);
    await apiHelpers.releaseMutationLock(bucket, next);
    assert.equal(readJson(bucket, h.LOCK_KEY).phase, 'released');
}
for (const failure of ['promotion', 'root']) {
    const { bucket, api } = await setup();
    const snapshot = await h.buildSnapshot(0);
    await h.prepareSnapshot(api, snapshot);
    const put = bucket.put.bind(bucket);
    bucket.put = async (key, bytes, options) => {
        const result = await put(key, bytes, options);
        if ((failure === 'root' && key === h.MANIFEST_KEY)
            || (failure === 'promotion' && key === h.LOCK_KEY && JSON.parse(bytes).phase === 'mutating')) throw new Error('R2 response lost after write');
        return result;
    };
    assert.equal((await api.post({ action: 'finalize-upload', uploadId: snapshot.checksum })).status, 503);
    assert.equal(readJson(bucket, h.LOCK_KEY).phase, 'mutating');
    clock += 60000;
    assert.equal((await api.post({ action: 'gc-step' })).status, 409, `${failure} unknown result retains lock`);
}
{
    const { bucket } = await setup();
    const put = bucket.put.bind(bucket);
    bucket.put = async (...args) => { const result = await put(...args); return result && { key: result.key }; };
    assert.equal(await apiHelpers.acquireMutationLock(bucket), null, 'never adopt an etag from a later head');
}
const gcStateKey = 'rp-sync/main/maintenance/gc-v1.json';
for (const failure of ['generation', 'delete', 'cursor']) {
    const { bucket, api } = await setup();
    const committed = await h.buildSnapshot(0);
    await h.prepareSnapshot(api, committed);
    assert.equal((await api.post({ action: 'finalize-upload', uploadId: committed.checksum })).status, 200);
    const orphan = await h.buildSnapshot(1, { prefix: `gc-${failure}` });
    await h.seedPack(bucket, orphan.packs[0], new Date(clock - 48 * 3600000));
    const put = bucket.put.bind(bucket);
    const remove = bucket.delete.bind(bucket);
    let stateWrites = 0;
    bucket.put = async (key, bytes, options) => {
        const result = await put(key, bytes, options);
        if (key === gcStateKey && ++stateWrites === (failure === 'generation' ? 1 : 2) && failure !== 'delete') {
            throw new Error('GC state response lost after write');
        }
        return result;
    };
    bucket.delete = async keys => {
        await remove(keys);
        if (failure === 'delete') throw new Error('GC delete response lost');
    };
    assert.equal((await api.post({ action: 'gc-step' })).status, 503);
    assert.equal(readJson(bucket, h.LOCK_KEY).phase, 'mutating');
    clock += 60000;
    assert.equal((await api.post({ action: 'gc-step' })).status, 409, `${failure} unknown result retains lock`);
    assert.equal(await apiHelpers.acquireMutationLock(bucket), null);
}
{
    const { bucket, api } = await setup();
    const snapshot = await h.buildSnapshot(0);
    await h.prepareSnapshot(api, snapshot);
    await api.post({ action: 'finalize-upload', uploadId: snapshot.checksum });
    let arrived, release;
    const entered = new Promise(resolve => { arrived = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    bucket.hooks.beforeList = async () => { arrived(); await gate; };
    const collecting = api.post({ action: 'gc-step' });
    await entered;
    clock += 31000;
    const successor = await apiHelpers.acquireMutationLock(bucket);
    assert.ok(successor);
    release();
    assert.equal((await collecting).status, 409, 'expired empty GC cannot write its cursor');
    assert.equal(bucket.objects.has(gcStateKey), false);
    assert.equal(readJson(bucket, h.LOCK_KEY).owner, successor.owner);
    await apiHelpers.releaseMutationLock(bucket, successor);
}
for (const action of ['begin', 'finalize']) {
    const { bucket, api } = await setup();
    const snapshot = await h.buildSnapshot(1, { prefix: `expired-${action}` });
    if (action === 'finalize') await h.prepareSnapshot(api, snapshot);
    let arrived, release;
    const entered = new Promise(resolve => { arrived = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    bucket.hooks.beforeGet = async key => {
        if (key === gcStateKey) { arrived(); await gate; }
    };
    const request = action === 'begin' ? h.begin(api, snapshot)
        : api.json({ action: 'finalize-upload', uploadId: snapshot.checksum });
    await entered;
    clock += 31000;
    const successor = await apiHelpers.acquireMutationLock(bucket);
    assert.ok(successor);
    release();
    assert.equal((await request).response.status, 409, `expired ${action} cannot mutate after takeover`);
    assert.equal(bucket.objects.has(h.MANIFEST_KEY), false);
    if (action === 'begin') assert.equal(bucket.objects.has(h.sessionKey(snapshot.checksum)), false);
    assert.equal(readJson(bucket, h.LOCK_KEY).owner, successor.owner);
    await apiHelpers.releaseMutationLock(bucket, successor);
}
{
    const { bucket, api } = await setup();
    const snapshot = await h.buildSnapshot(1, { prefix: 'unknown-session' });
    const put = bucket.put.bind(bucket);
    bucket.put = async (key, bytes, options) => {
        const result = await put(key, bytes, options);
        if (key === h.sessionKey(snapshot.checksum)) throw new Error('Session response lost after write');
        return result;
    };
    assert.equal((await h.begin(api, snapshot)).response.status, 503);
    assert.equal(readJson(bucket, h.LOCK_KEY).phase, 'mutating');
    clock += 60000;
    assert.equal(await apiHelpers.acquireMutationLock(bucket), null);
}
console.log('sync-consistency-regressions: immutable membership, retries, expired begin/finalize/GC owners and unknown mutation results passed');

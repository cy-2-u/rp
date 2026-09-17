import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';

const source = await readFile(new URL('../magic-extension.js', import.meta.url), 'utf8');

function harness(fixed = false) {
    const requests = [];
    const window = {};
    const context = vm.createContext({
        window, URL, crypto: { randomUUID },
        indexedDB: new IDBFactory(), // Isolated in-memory DB; never accesses browser data.
        location: { pathname: '/', origin: 'https://offline.invalid', href: 'https://offline.invalid/' },
        localStorage: { getItem: key => key === 'rp_hub_magic_fixed_image' ? (fixed ? '1' : '0') : '1' },
        document: { readyState: 'loading', addEventListener() {} },
        MutationObserver: class { disconnect() {} observe() {} },
        fetch(url, options) {
            assert.equal(new URL(url).origin, 'https://offline.invalid');
            assert.equal(new URL(url).pathname, '/api/rp-image');
            assert.equal(options.method, 'POST');
            return new Promise((resolve, reject) => requests.push({
                url, reject,
                succeed: () => resolve({ ok: true, body: { cancel: async () => {} } }),
                fail: () => resolve({ ok: false, status: 503, json: async () => ({ error: 'offline failure' }) })
            }));
        }
    });
    // Expose only cache state in this VM to force cache eviction and inspect ownership.
    const marker = '    window.RPH_MAGIC_IMAGE_TASK = options => {';
    assert.equal(source.split(marker).length, 2);
    vm.runInContext(source.replace(marker,
        '    window.testState = { imageStores, imageSlotTasks };\n' + marker), context);
    function start({ prompt = 'test prompt', fresh = false } = {}) {
        const card = { closest: () => row };
        const row = { dataset: { chatIndex: '0' }, querySelectorAll: () => [card] };
        return window.RPH_MAGIC_IMAGE_TASK({
            card, requestUrl: '/api/rp-image?tag=' + encodeURIComponent(prompt), fresh,
            message: { id: 'message-1', content: 'test message' },
            characterId: 'offline-character', characterName: 'Offline', render() {}
        });
    }
    async function waitForRequests(count) {
        for (let i = 0; i < 100 && requests.length < count; i++) {
            await new Promise(resolve => setImmediate(resolve));
        }
        assert.equal(requests.length, count, 'expected a real mocked POST, not a cached done task');
    }
    const state = () => window.testState.imageStores.get('offline-character');
    const evict = () => window.testState.imageSlotTasks.clear();
    return { start, requests, waitForRequests, state, evict };
}

for (const fixed of [false, true]) {
    test(`failed first request retries via POST (fixed=${fixed})`, async () => {
        const h = harness(fixed);
        const first = h.start();
        await h.waitForRequests(1);
        h.requests[0].fail();
        assert.equal((await first.promise).status, 'failed');
        const second = h.start();
        await h.waitForRequests(2);
        h.requests[1].succeed();
        assert.equal((await second.promise).status, 'done');
        assert.equal(h.state().records.length, fixed ? 1 : 0);
    });
}

test('successful transient survives slot cache eviction without regenerating', async () => {
    const h = harness();
    const first = h.start();
    await h.waitForRequests(1);
    h.requests[0].succeed();
    assert.equal((await first.promise).status, 'done');
    assert.equal(h.state().records.length, 0);
    assert.equal(h.state().transientRecords.size, 1);
    h.evict();
    assert.equal((await h.start().promise).status, 'done');
    assert.equal(h.requests.length, 1);
    assert.equal(h.state().transientRecords.size, 1);
});

test('old failure cannot delete newer successful reroll at the identical record key', async () => {
    const h = harness();
    const old = h.start();
    await h.waitForRequests(1);
    const newer = h.start({ fresh: true });
    await h.waitForRequests(2);
    h.requests[1].succeed();
    assert.equal((await newer.promise).status, 'done');
    const record = [...h.state().transientRecords.values()][0];
    assert.ok(record.paramsSnapshot.rerollNonce);
    h.requests[0].reject(new Error('late network failure'));
    assert.equal((await old.promise).status, 'failed');
    assert.equal(h.state().transientRecords.get(record.key), record);
    h.evict();
    assert.equal((await h.start().promise).status, 'done');
    assert.equal(h.requests.length, 2);
});

test('superseded failure removes only its own record while newer slot task is pending', async () => {
    const h = harness();
    const old = h.start();
    await h.waitForRequests(1);
    const oldRecord = [...h.state().transientRecords.values()][0];
    const newer = h.start({ prompt: 'changed prompt' });
    await h.waitForRequests(2);
    const newerRecord = [...h.state().transientRecords.values()].find(record => record !== oldRecord);
    assert.ok(newerRecord);
    h.requests[0].fail();
    assert.equal((await old.promise).status, 'failed');
    assert.equal(h.state().transientRecords.has(oldRecord.key), false);
    assert.equal(h.state().transientRecords.get(newerRecord.key), newerRecord);
    h.requests[1].succeed();
    assert.equal((await newer.promise).status, 'done');
});

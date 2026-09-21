import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';

const source = await readFile(new URL('../magic-extension.js', import.meta.url), 'utf8');

const hashText = value => {
    let hash = 2166136261;
    const text = String(value || '');
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
};

function harness(
    fixed = false,
    adapterResponse = { ok: false, status: 503, json: async () => ({ ok: false }) },
    database = new IDBFactory()
) {
    const requests = [];
    let fixedEnabled = fixed;
    const window = {};
    const context = vm.createContext({
        window, URL, crypto: { randomUUID },
        indexedDB: database, // Isolated in-memory DB; never accesses browser data.
        location: { pathname: '/', origin: 'https://offline.invalid', href: 'https://offline.invalid/' },
        localStorage: { getItem: key => key === 'rp_hub_magic_fixed_image' ? (fixedEnabled ? '1' : '0') : '1' },
        document: { readyState: 'loading', addEventListener() {} },
        MutationObserver: class { disconnect() {} observe() {} },
        fetch(url, options) {
            const parsed = new URL(url, 'https://offline.invalid');
            if (parsed.pathname === '/__rphub/adapter.json') {
                return Promise.resolve(adapterResponse);
            }
            assert.equal(parsed.origin, 'https://offline.invalid');
            assert.equal(parsed.pathname, '/api/rp-image');
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
    function start({
        prompt = 'test prompt',
        fresh = false,
        storyScopeId = 'main',
        messageId = 'message-1',
        messageContent = 'test message',
        characterId = 'offline-character',
        autoImageGen = true
    } = {}) {
        const testClasses = new Set();
        const card = {
            closest: () => row,
            dataset: {},
            isConnected: true,
            classList: {
                add: name => testClasses.add(name),
                remove: name => testClasses.delete(name),
                toggle: (name, force) => (force === false ? testClasses.delete(name) : testClasses.add(name))
            }
        };
        card.testClasses = testClasses;
        const row = { dataset: { chatIndex: '0' }, querySelectorAll: () => [card] };
        const options = {
            card, requestUrl: '/api/rp-image?tag=' + encodeURIComponent(prompt), fresh,
            message: { id: messageId, content: messageContent },
            storyScopeId,
            characterId, characterName: 'Offline', render() {}
        };
        // 'legacy' 模拟旧适配清单：不传 autoImageGen 字段。
        if (autoImageGen !== 'legacy') options.autoImageGen = autoImageGen;
        const task = window.RPH_MAGIC_IMAGE_TASK(options);
        task.cards.add(card);
        task.testCard = card;
        return task;
    }
    async function waitForRequests(count) {
        for (let i = 0; i < 100 && requests.length < count; i++) {
            await new Promise(resolve => setImmediate(resolve));
        }
        assert.equal(requests.length, count, 'expected a real mocked POST, not a cached done task');
    }
    const state = () => window.testState.imageStores.get('offline-character');
    const evict = () => window.testState.imageSlotTasks.clear();
    const setFixed = value => { fixedEnabled = value; };
    return { start, requests, waitForRequests, state, evict, setFixed, window };
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

test('fixed-off reroll keeps the existing persistent record', async () => {
    const h = harness(true);
    const first = h.start();
    await h.waitForRequests(1);
    h.requests[0].succeed();
    assert.equal((await first.promise).status, 'done');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.state().records.length, 1);
    const storedKey = h.state().records[0].key;

    h.setFixed(false);
    h.evict();
    const reroll = h.start({ fresh: true });
    await h.waitForRequests(2);
    h.requests[1].succeed();
    assert.equal((await reroll.promise).status, 'done');
    assert.equal(h.state().records.length, 1);
    assert.equal(h.state().records[0].key, storedKey);
    assert.equal(h.state().transientRecords.size, 1);
});

test('story scopes do not reuse the same slot record', async () => {
    const h = harness(true);
    const main = h.start({ storyScopeId: 'main' });
    await h.waitForRequests(1);
    h.requests[0].succeed();
    assert.equal((await main.promise).status, 'done');
    h.evict();
    const branch = h.start({ storyScopeId: 'branch-1' });
    await h.waitForRequests(2);
    assert.equal(h.requests.length, 2);
    h.requests[1].succeed();
    assert.equal((await branch.promise).status, 'done');
    assert.equal(h.state().records.length, 2);
    assert.deepEqual(new Set(h.state().records.map(record => record.storyScopeId)), new Set(['main', 'branch-1']));
});

test('two independent tabs merge persistent records', async () => {
    const database = new IDBFactory();
    const first = harness(true, undefined, database);
    const second = harness(true, undefined, database);
    const firstTask = first.start({ prompt: 'first prompt', messageId: 'message-a' });
    const secondTask = second.start({ prompt: 'second prompt', messageId: 'message-b' });
    await first.waitForRequests(1);
    await second.waitForRequests(1);
    first.requests[0].succeed();
    second.requests[0].succeed();
    assert.equal((await firstTask.promise).status, 'done');
    assert.equal((await secondTask.promise).status, 'done');
    await Promise.all([first.window.RPH_MAGIC_FLUSH_IMAGES(), second.window.RPH_MAGIC_FLUSH_IMAGES()]);
    const verifier = harness(true, undefined, database);
    await verifier.start({ prompt: 'first prompt', messageId: 'message-a' }).promise;
    assert.equal(verifier.state().records.length, 2);
});

test('loading trims persistent history to the configured limit', async () => {
    const database = new IDBFactory();
    const seed = harness(true, undefined, database);
    const task = seed.start({ prompt: 'seed', messageId: 'seed-message' });
    await seed.waitForRequests(1);
    seed.requests[0].succeed();
    await task.promise;
    await seed.window.RPH_MAGIC_FLUSH_IMAGES();
    const db = await new Promise((resolve, reject) => {
        const request = database.open('RPHubDB');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
    });
    const records = Array.from({ length: 300 }, (_, index) => {
        const prompt = `prompt-${index}`;
        return {
            storyScopeId: 'main',
            messageId: `old-${index}`, messageIndex: index, contentHash: hashText(`message-${index}`),
            occurrenceIndex: 0, prompt, promptHash: hashText(prompt),
            paramsSnapshot: { characterName: 'Offline' }
        };
    });
    await new Promise((resolve, reject) => {
        const transaction = db.transaction(['store'], 'readwrite');
        transaction.objectStore('store').put(records, 'rp_hub_image_renders_offline-character');
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
    });
    db.close();
    const loaded = harness(true, undefined, database);
    await loaded.start({ prompt: 'prompt-299', messageId: 'old-299' }).promise;
    assert.equal(loaded.state().records.length, 256);
});

test('author-switch-off message without a record generates nothing and hides the card', async () => {
    const h = harness(false);
    const task = h.start({ autoImageGen: false });
    const job = await task.promise;
    assert.equal(job.status, 'done');
    assert.equal(job.imageUrl, '');
    assert.equal(h.requests.length, 0);
    assert.equal(h.state().records.length, 0);
    assert.ok(task.testCard.testClasses.has('magic-image-suppressed'));
});

test('re-enabling the author switch regenerates the previously hidden message', async () => {
    const h = harness(true);
    const hidden = h.start({ autoImageGen: false });
    assert.equal((await hidden.promise).status, 'done');
    assert.ok(hidden.testCard.testClasses.has('magic-image-suppressed'));
    assert.equal(h.requests.length, 0);

    h.evict();
    const reopened = h.start({ autoImageGen: true });
    await h.waitForRequests(1);
    h.requests[0].succeed();
    assert.equal((await reopened.promise).status, 'done');
    assert.equal(reopened.testCard.testClasses.has('magic-image-suppressed'), false);
    assert.equal(h.state().records.length, 1);
});

test('author-switch-off still shows previously saved images', async () => {
    const h = harness(true);
    const first = h.start();
    await h.waitForRequests(1);
    h.requests[0].succeed();
    const firstJob = await first.promise;
    assert.equal(firstJob.status, 'done');

    h.evict();
    const task = h.start({ autoImageGen: false });
    const job = await task.promise;
    assert.equal(job.status, 'done');
    assert.equal(job.imageUrl, firstJob.imageUrl);
    assert.equal(task.testCard.testClasses.has('magic-image-suppressed'), false);
    assert.equal(h.requests.length, 1);
});

test('author-switch-off reroll keeps the existing image without generating', async () => {
    const h = harness(true);
    const first = h.start();
    await h.waitForRequests(1);
    h.requests[0].succeed();
    assert.equal((await first.promise).status, 'done');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.state().records.length, 1);
    const storedKey = h.state().records[0].key;

    h.evict();
    const reroll = h.start({ fresh: true, autoImageGen: false });
    assert.equal((await reroll.promise).status, 'done');
    assert.equal(reroll.testCard.testClasses.has('magic-image-suppressed'), false);
    assert.equal(h.requests.length, 1);
    assert.equal(h.state().records.length, 1);
    assert.equal(h.state().records[0].key, storedKey);
    assert.equal(h.state().transientRecords.size, 0);
});

test('author-switch-off reroll on a record-less slot hides the card too', async () => {
    const h = harness(false);
    const task = h.start({ fresh: true, autoImageGen: false });
    assert.equal((await task.promise).status, 'done');
    assert.ok(task.testCard.testClasses.has('magic-image-suppressed'));
    assert.equal(h.requests.length, 0);
});

test('legacy adapter without autoImageGen still generates', async () => {
    const h = harness(false);
    const task = h.start({ autoImageGen: 'legacy' });
    await h.waitForRequests(1);
    h.requests[0].succeed();
    assert.equal((await task.promise).status, 'done');
    assert.equal(h.state().transientRecords.size, 1);
});

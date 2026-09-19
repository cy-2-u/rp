import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../DB/bootstrap.js', import.meta.url), 'utf8');
const start = source.indexOf('    async function prepareLocalSnapshot(');
const end = source.indexOf('    async function* iterateMissingUploadPacks(', start);
assert.ok(start >= 0 && end > start, 'prepareLocalSnapshot source boundaries');

for (const stage of ['dirty', 'baseline', 'state']) {
    let closes = 0;
    const failure = new Error(`injected ${stage} failure`);
    const db = { close() { closes += 1; } };
    const context = vm.createContext({
        openLocalSyncCache: async () => db,
        readDirtyState: async () => { if (stage === 'dirty') throw failure; return {}; },
        readBaseline: () => { if (stage === 'baseline') throw failure; return null; },
        cacheReadState: async () => { if (stage === 'state') throw failure; return null; }
    });
    vm.runInContext(source.slice(start, end), context);
    await assert.rejects(context.prepareLocalSnapshot(0, 100), error => error === failure);
    assert.equal(closes, 1, `${stage} failure must close the opened cache connection exactly once`);
    console.log(`PASS cache connection closes after ${stage} failure`);
}

// Crash-safety invariant of the incremental update: every durable cache-entry
// mutation inside updateCachedSnapshot must be preceded by a pendingBuckets
// flush, so a crash can never leave a written entry whose bucket is missing
// from the persisted pending set (the bucket would never be rebuilt).
{
    const updateStart = source.indexOf('    async function updateCachedSnapshot(');
    const updateEnd = source.indexOf('    function readStoreDefinitions(', updateStart);
    assert.ok(updateStart >= 0 && updateEnd > updateStart, 'updateCachedSnapshot source boundaries');
    const updateSource = source.slice(updateStart, updateEnd);
    const positions = needle => {
        const found = [];
        for (let index = 0; ; index = found[found.length - 1] + 1) {
            const pos = updateSource.indexOf(needle, index);
            if (pos < 0) break;
            found.push(pos);
        }
        return found;
    };
    const flushes = positions('await flushPendingBuckets();');
    const mutations = [
        ...positions('await cacheWriteEntries(cacheDb'),
        ...positions('await deleteObjectStoreKeys(cacheDb, LOCAL_CACHE_ENTRY_STORE')
    ];
    assert.equal(flushes.length, 4, 'expected one flush per durable mutation site');
    assert.equal(mutations.length, 4, 'expected four durable cache mutation sites');
    for (const pos of mutations) {
        assert.ok(flushes.some(flush => flush < pos),
            'every durable cache mutation must be preceded by a pendingBuckets flush');
    }
}

// IndexedDB transaction helpers must reject on abort instead of leaving callers
// pending forever. Use a tiny EventTarget-like transaction so this stays a
// deterministic unit regression rather than depending on browser timing.
{
    const helperStart = source.indexOf('    function waitForTransaction(');
    const helperEnd = source.indexOf('    function openDbByName(', helperStart);
    assert.ok(helperStart >= 0 && helperEnd > helperStart, 'waitForTransaction source boundaries');
    const context = vm.createContext({});
    vm.runInContext(source.slice(helperStart, helperEnd), context);
    const listeners = new Map();
    const failure = new Error('QuotaExceededError');
    const tx = {
        error: failure,
        addEventListener(type, handler) { listeners.set(type, handler); }
    };
    const pending = context.waitForTransaction(tx, 'restore write failed');
    listeners.get('abort')();
    await assert.rejects(
        Promise.race([
            pending,
            new Promise((_, reject) => setTimeout(() => reject(new Error('abort promise remained pending')), 100))
        ]),
        error => error === failure
    );
    console.log('PASS transaction abort rejects instead of remaining pending');
}

// Schema migration cleanup must not run until the local snapshot has been
// fully prepared. A serialization/cache failure therefore leaves R2 intact.
{
    const commitStart = source.indexOf('    async function commitObjectSnapshot(');
    const commitEnd = source.indexOf('    async function pullFromServerUnlocked(', commitStart);
    assert.ok(commitStart >= 0 && commitEnd > commitStart, 'commitObjectSnapshot source boundaries');
    const calls = [];
    const failure = new Error('unsupported local data');
    const storage = {
        removeItem() { calls.push('remove baseline'); },
        setItem() { },
        getItem() { return null; }
    };
    const context = vm.createContext({
        CONFIG: { commitTimeoutMs: 1 },
        SNAPSHOT_SCHEMA_VERSION: 12,
        postSync: async payload => {
            calls.push(payload.action);
            if (payload.action === 'prepare-upload') return { resetRequired: true, remote: null };
            throw new Error(`unexpected ${payload.action}`);
        },
        readBaseline: () => null,
        prepareLocalSnapshot: async () => { calls.push('validate local snapshot'); throw failure; },
        updateProgress() { },
        localStorage: storage,
        window: { RPH_SYNC_TRACKER: { acknowledge: async () => { } } }
    });
    vm.runInContext(source.slice(commitStart, commitEnd), context);
    await assert.rejects(context.commitObjectSnapshot({ check: 1, uploadStart: 2, uploadEnd: 3, commit: 4 }), error => error === failure);
    assert.deepEqual(calls, ['prepare-upload', 'validate local snapshot'],
        'remote migration must wait for successful local snapshot preparation');
    console.log('PASS local snapshot failure preserves remote migration state');
}

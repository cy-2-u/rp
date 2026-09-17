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
    console.log('PASS updateCachedSnapshot flushes pendingBuckets before every durable mutation');
}

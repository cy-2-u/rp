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

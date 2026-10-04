import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../DB/bootstrap.js', import.meta.url), 'utf8');
const start = source.indexOf('    async function prepareLocalSnapshot(');
const end = source.indexOf('    async function runGcMaintenance(', start);
assert.ok(start >= 0 && end > start, 'prepareLocalSnapshot source boundaries');

for (const stage of ['dirty', 'state']) {
    let closes = 0;
    const failure = new Error(`injected ${stage} failure`);
    const db = { close() { closes += 1; } };
    const context = vm.createContext({
        openLocalSyncCache: async () => db,
        readDirtyState: async () => { if (stage === 'dirty') throw failure; return {}; },
        cacheReadState: async () => { if (stage === 'state') throw failure; return null; },
        localStorage: { getItem: () => null }
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

// 跨文件协议常量互为副本（纯静态文件没有构建注入，bootstrap 与
// dirty-tracker 头部各自持有一份字面量）。这里逐字比较两侧声明，
// 任一侧单方面改名立即在此失败，而不是等到运行时静默失效。

// Restore batches must flush on estimated bytes even when the record count is
// below the ordinary batch count, bounding transient IndexedDB write payloads.
{
    const start = source.indexOf('    class ObjectSnapshotRestorer {');
    const end = source.indexOf('    async function parsePackSnapshot(', start);
    assert.ok(start >= 0 && end > start, 'ObjectSnapshotRestorer source boundaries');
    const restorerSource = source.slice(start, end) + '\nthis.__Restorer = ObjectSnapshotRestorer;';
    const context = vm.createContext({
        CONFIG: {
            knownDatabases: [{ name: 'RPHubDB', stores: ['store'] }],
            restoreBatchSize: 64,
            scanBatchBytes: 10
        },
        createYieldController: () => async () => { },
        isAppLocalStorageKey: () => true,
        readLocalStorageSnapshot: () => [],
        stableKeyToken: value => JSON.stringify(value),
        isSyncExcludedRecord: () => false,
        estimateRecordBytes: value => String(value).length,
        localStorage: { setItem() { }, removeItem() { } },
        openDbForRestore: async () => null,
        writeObjectStoreRecordBatch: async () => { },
        deleteMissingObjectStoreRecords: async () => { },
        clearKnownIndexedDbStores: async () => { }
    });
    vm.runInContext(restorerSource, context);
    const Restorer = context.__Restorer;
    const restorer = new Restorer(2, { validateOnly: true });
    await restorer.consume({
        type: 'database', name: 'RPHubDB',
        stores: [{ name: 'store', keyPath: null, autoIncrement: false }]
    });
    const flushed = [];
    restorer.flushStore = async storeState => {
        flushed.push({ count: storeState.batch.length, bytes: storeState.batchBytes });
        storeState.batch = [];
        storeState.batchBytes = 0;
    };
    await restorer.consume({ type: 'record', database: 'RPHubDB', store: 'store', key: 'large', value: '12345678901' });
    assert.deepEqual(flushed, [{ count: 1, bytes: 11 }], 'byte threshold must flush a small-count large record');
    console.log('PASS restore record batches honor the byte threshold');
}

// GC recheck retries must refresh the remote base before rebuilding the same
// local snapshot. Ordinary CAS conflicts remain one-shot errors.
{
    const start = source.indexOf('    async function resumePagedUpload(');
    const end = source.indexOf('    async function uploadPagedSnapshotAttempt(', start);
    assert.ok(start >= 0 && end > start, 'resumePagedUpload source boundaries');
    const resumeSource = source.slice(start, end);
    const attempts = [];
    let prepareCalls = 0;
    const context = vm.createContext({
        CONFIG: { commitTimeoutMs: 10 },
        SNAPSHOT_SCHEMA_VERSION: 13,
        updateProgress() { },
        postSync: async payload => {
            assert.equal(payload.action, 'prepare-upload');
            prepareCalls += 1;
            return { remote: { version: 9, checksum: 'fresh-base' } };
        },
        uploadPagedSnapshotAttempt: async (_snapshot, version, checksum) => {
            attempts.push([version, checksum]);
            if (attempts.length === 1) {
                throw Object.assign(new Error('GC changed'), {
                    response: { recheckRequired: true }, status: 409
                });
            }
            return { checksum: 'snapshot' };
        }
    });
    vm.runInContext(resumeSource, context);
    const result = await context.resumePagedUpload({ checksum: 'snapshot' }, 3, 'old-base', { uploadStart: 1 });
    assert.equal(result.checksum, 'snapshot');
    assert.deepEqual(attempts, [[3, 'old-base'], [9, 'fresh-base']]);
    assert.equal(prepareCalls, 1);

    const ordinaryAttempts = [];
    const ordinary = vm.createContext({
        CONFIG: { commitTimeoutMs: 10 },
        SNAPSHOT_SCHEMA_VERSION: 13,
        updateProgress() { },
        postSync: async () => { throw new Error('unexpected prepare'); },
        uploadPagedSnapshotAttempt: async () => {
            ordinaryAttempts.push(true);
            throw Object.assign(new Error('root CAS conflict'), {
                response: { error: 'version changed' }, status: 409
            });
        }
    });
    vm.runInContext(resumeSource, ordinary);
    await assert.rejects(
        ordinary.resumePagedUpload({ checksum: 'snapshot' }, 3, 'old-base', { uploadStart: 1 }),
        /root CAS conflict/
    );
    assert.equal(ordinaryAttempts.length, 1, 'ordinary CAS conflicts must not auto-merge or retry');
    console.log('PASS client GC recheck refreshes the base, while ordinary CAS remains one-shot');
}

// Autosave scheduler is a foreground-only one-shot timer. Keep this test
// independent from the browser DOM so hidden-page and sleep edge cases stay
// deterministic and never wait for real minutes.
{
    const schedulerStart = source.indexOf('function createAutoSaveScheduler(');
    const schedulerEnd = source.indexOf('\n(function () {', schedulerStart);
    assert.ok(schedulerStart >= 0 && schedulerEnd > schedulerStart, 'autosave scheduler source boundaries');
    const schedulerSource = source.slice(schedulerStart, schedulerEnd);
    const timers = new Map();
    let nextTimerId = 0;
    let now = 0;
    let wall = 100000;
    let visible = true;
    const due = [];
    const context = vm.createContext({
        performance: { now: () => now },
        Date,
        setTimeout(callback, delay) {
            const id = ++nextTimerId;
            timers.set(id, { callback, delay });
            return id;
        },
        clearTimeout(id) { timers.delete(id); },
        Promise,
        set: undefined
    });
    vm.runInContext(`${schedulerSource}\nthis.__createAutoSaveScheduler = createAutoSaveScheduler;`, context);
    const flushTimer = () => {
        const entry = [...timers.entries()][0];
        assert.ok(entry, 'expected a scheduled autosave timer');
        timers.delete(entry[0]);
        now += entry[1].delay;
        wall += entry[1].delay;
        entry[1].callback();
    };
    const scheduler = context.__createAutoSaveScheduler({
        tickMs: 1000,
        lateToleranceMs: 100,
        now: () => now,
        wallNow: () => wall,
        isActive: () => visible,
        setTimeout: context.setTimeout,
        clearTimeout: context.clearTimeout,
        onDue: () => { due.push(now); }
    });
    scheduler.start(3000);
    assert.equal(timers.size, 1, 'enabled scheduler must use one timer');
    flushTimer();
    assert.equal(due.length, 0, 'scheduler must not fire before interval');
    visible = false;
    scheduler.pause();
    const paused = scheduler.getState().remainingMs;
    now += 10000;
    wall += 10000;
    visible = true;
    scheduler.resume();
    assert.equal(scheduler.getState().remainingMs, paused, 'hidden time must not be counted');
    while (!due.length) flushTimer();
    assert.equal(due.length, 1, 'interval must trigger exactly once');
    assert.equal(timers.size, 0, 'due callback must not create a second timer by itself');
    scheduler.start(3000);
    visible = true;
    const beforeSleep = scheduler.getState().remainingMs;
    now += 10000;
    wall += 10000;
    flushTimer();
    assert.equal(due.length, 1, 'uncertain delayed callback must not upload immediately');
    assert.equal(scheduler.getState().remainingMs, beforeSleep, 'uncertain elapsed time must be preserved');
    scheduler.stop();
    assert.equal(timers.size, 0, 'disabled scheduler must clear its timer');
    console.log('PASS autosave scheduler pauses in background and rejects uncertain wakeups');
}

// Lifecycle resume must not restart a cycle while any sync operation still
// owns the operation gate; the outer runner restarts it after cleanup.
{
    const resumeStart = source.indexOf('    function resumeAutoSave() {');
    const resumeEnd = source.indexOf('    function persistAutoSaveMinutes(', resumeStart);
    assert.ok(resumeStart >= 0 && resumeEnd > resumeStart, 'resumeAutoSave source boundaries');
    const resumeSource = source.slice(resumeStart, resumeEnd);
    assert.match(resumeSource, /state\.operationPending\s*\|\|\s*state\.syncing/,
        'resumeAutoSave must respect the sync operation gate');
    const lifecycleSource = source.slice(
        source.indexOf("document.addEventListener('visibilitychange'"),
        source.indexOf('if (isAutoSaveEnabled()) restartAutoSaveCycle();', source.indexOf("document.addEventListener('visibilitychange'"))
    );
    assert.match(lifecycleSource, /document\.addEventListener\('freeze'/,
        'freeze must be listened for on document');
    assert.match(lifecycleSource, /document\.addEventListener\('resume'/,
        'resume must be listened for on document');
    console.log('PASS autosave lifecycle resume stays paused during sync');
}

{
    const trackerSource = fs.readFileSync(new URL('../DB/dirty-tracker.js', import.meta.url), 'utf8');
    const sharedLiterals = [
        '__rp_sync_journal_v2',
        'rp_sync_intent_v2:',
        'rp_sync_tracking_epoch_v2',
        'rp_sync_restore_active',
        'rp_sync_restore_epoch',
        'rp-hub-r2-sync-v1'
    ];
    const declares = (text, literal) => text.includes(`'${literal}'`) || text.includes(`"${literal}"`);
    for (const literal of sharedLiterals) {
        assert.ok(declares(source, literal), `bootstrap.js must declare ${literal}`);
        assert.ok(declares(trackerSource, literal), `dirty-tracker.js must declare ${literal}`);
    }
    // 结构性共享名（RESTORE_PAGE 判定、排除规则、已知库/前缀、journal 哨兵键）：
    // 两侧语义必须一致，任一侧单方面改名立即在此失败。
    const sharedNames = [
        '/sync-restore',
        '__epoch__',
        'rp_hub_presets',
        'RPHubDB',
        'AICharGen',
        'rp_hub_',
        'ai_chargen_'
    ];
    for (const name of sharedNames) {
        assert.ok(source.includes(name), `bootstrap.js must reference ${name}`);
        assert.ok(trackerSource.includes(name), `dirty-tracker.js must reference ${name}`);
    }
    console.log('PASS cross-file protocol constants stay in lockstep');
}

// bootstrap 与 _worker.js 之间的同步协议常量同样是人肉双写（worker 是协议
// 服务端、bootstrap 是浏览器端引擎，纯静态文件没有构建注入，改动必须双侧
// 同步）。除字面量外，根清单校验和与清单页校验和的**字段序**也必须锁步：
// 任一侧单方面增删字段或调整顺序，两端校验和立即失配，服务器会以
// “校验失败，已停止读写以保护数据”拒绝服务。
{
    const workerSource = fs.readFileSync(new URL('../_worker.js', import.meta.url), 'utf8');
    const declares = (text, literal) => text.includes(`'${literal}'`) || text.includes(`"${literal}"`);
    for (const literal of ['rp-sync-paged-jsonl-v4', 'rp-sync-manifest-page-v1', 'rp_hub_sync_password_v1']) {
        assert.ok(declares(source, literal), `bootstrap.js must declare ${literal}`);
        assert.ok(declares(workerSource, literal), `_worker.js must declare ${literal}`);
    }
    const declaresExpr = (text, name, expected) => {
        const matched = text.match(new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*([^;\\n]+);`));
        assert.ok(matched, `expected a ${name} declaration`);
        assert.equal(matched[1].trim(), expected, `${name} must stay ${expected} on both sides`);
    };
    for (const text of [source, workerSource]) {
        declaresExpr(text, 'MANIFEST_PAGE_PACKS', '32');
        declaresExpr(text, 'MANIFEST_CHAIN_SEED', "'0'.repeat(64)");
        declaresExpr(text, 'GC_BLOOM_BYTES', '32 * 1024');
    }
    declaresExpr(source, 'SNAPSHOT_SCHEMA_VERSION', '13');
    declaresExpr(workerSource, 'STREAM_SNAPSHOT_SCHEMA_VERSION', '13');

    // 提取校验和源数组里的字段名序列：剥掉包装（Number/String/snapshot.）与
    // 两侧常量名差异（SNAPSHOT_* vs STREAM_SNAPSHOT_*、空快照回退种子）后，
    // 两侧剩余字段序列必须完全一致。
    const checksumFieldOrder = (text, funcName, ignored) => {
        const start = text.indexOf(`function ${funcName}(`);
        assert.ok(start >= 0, `expected function ${funcName}`);
        const open = text.indexOf('JSON.stringify([', start);
        const close = text.indexOf(']);', open);
        assert.ok(open >= 0 && close > open, `expected checksum array in ${funcName}`);
        return text.slice(open + 'JSON.stringify(['.length, close)
            .match(/[A-Za-z_$][\w$]*/g)
            .filter(token => !ignored.has(token));
    };
    const rootIgnored = new Set([
        'Number', 'String', 'snapshot',
        'SNAPSHOT_FORMAT', 'STREAM_SNAPSHOT_FORMAT',
        'SNAPSHOT_SCHEMA_VERSION', 'STREAM_SNAPSHOT_SCHEMA_VERSION',
        'MANIFEST_CHAIN_SEED'
    ]);
    assert.deepEqual(
        checksumFieldOrder(workerSource, 'buildManifestRootChecksumSource', rootIgnored),
        checksumFieldOrder(source, 'buildPackSnapshotChecksumSource', rootIgnored),
        'root manifest checksum field order must stay in lockstep between _worker.js and bootstrap.js'
    );
    const pageIgnored = new Set(['MANIFEST_PAGE_FORMAT']);
    assert.deepEqual(
        checksumFieldOrder(workerSource, 'buildManifestPageChecksumSource', pageIgnored),
        checksumFieldOrder(source, 'buildManifestPageChecksumSource', pageIgnored),
        'manifest page checksum field order must stay in lockstep between _worker.js and bootstrap.js'
    );
    console.log('PASS worker/bootstrap sync protocol constants and checksum field order stay in lockstep');
}

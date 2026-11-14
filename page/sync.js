// 云同步：源记录为增量单位，分片缓存与消费水位同事务提交。
(function () {
    'use strict';
    const P = RPClient, C = RPCore, K = C.KEYS;
    const DB = 'RPHubSyncNext', VERSION = 1;
    let running = null, preparing = null, prepareTimer, autoTimer, activated = false, lastActive = performance.now(), remaining = 0;
    const ui = { busy: false, automatic: false, progress: 0, text: '请选择同步方向。' };
    const pause = () => new Promise(resolve => setTimeout(resolve, 0));
    // 后台准备以约 43% 占空比运行（工作 6ms → 让出 8ms），上传路径不节流。
    let lowDuty = false, dutyUntil = 0;
    const breathe = async () => {
        if (!lowDuty) return;
        const now = performance.now();
        if (now >= dutyUntil) { await new Promise(resolve => setTimeout(resolve, 8)); dutyUntil = performance.now() + 6; }
    };
    const exclusive = work => navigator.locks?.request ? navigator.locks.request('rp-sync-v2', work) : work();
    const appEntries = () => Object.keys(localStorage).filter(C.appKey).sort().map(key => [key, localStorage.getItem(key)]);
    const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
    const cache = () => P.open(DB, db => { db.createObjectStore('sources'); db.createObjectStore('packs'); db.createObjectStore('state'); }, VERSION);
    async function readCache(db, store, key) { const tx = db.transaction(store, 'readonly'), r = tx.objectStore(store).get(key); return P.txDone(tx, () => r.result); }
    async function allCache(db, store) { const tx = db.transaction(store, 'readonly'), s = tx.objectStore(store), keys = s.getAllKeys(), values = s.getAll(); return P.txDone(tx, () => keys.result.map((k, i) => [k, values.result[i]])); }
    function progress(value, text) {
        ui.progress = value; ui.text = text;
        if (modalStatus) modalStatus.textContent = text;
        if (modalProgressBar) modalProgressBar.style.width = value + '%';
        if (modalProgressValue) modalProgressValue.textContent = Math.round(value) + '%';
    }
    async function request(path, options = {}, acceptConflict = false) {
        for (let attempt = 0; ; attempt++) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 120000);
            try {
                const response = await fetch(path, { ...options, signal: controller.signal, headers: { 'x-rp-sync-password': localStorage.getItem(K.password) || '', ...options.headers } });
                if (response.ok) return response;
                const body = await response.json().catch(() => ({}));
                if (acceptConflict && response.status === 409) return { conflict: body };
                throw C.fail(body.error || 'HTTP ' + response.status, response.status);
            } catch (e) {
                if (attempt >= 2 || e.status && e.status !== 408 && e.status !== 429 && e.status < 500) throw e;
                await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
            } finally { clearTimeout(timer); }
        }
    }
    const post = async (body, conflicts = false) => {
        const response = await request('/api/rp-sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, conflicts);
        return response.conflict ? { ok: false, ...response.conflict } : response.json();
    };
    async function record(dbName, storeName, key) {
        const db = await P.open(dbName);
        try { const tx = db.transaction(storeName, 'readonly'), r = tx.objectStore(storeName).get(key); return await P.txDone(tx, () => r.result); }
        finally { db.close(); }
    }
    function bucketFor(key) {
        let hash = 2166136261;
        for (const ch of C.canonical(key)) { hash ^= ch.charCodeAt(0); hash = Math.imul(hash, 16777619); }
        return (hash >>> 0) % 64;
    }
    async function* bucketRows(dbName, store, keys) {
        for (const key of keys) {
            const value = await record(dbName, store, key);
            if (value !== undefined) yield* rowsFor(dbName, store, key, value);
        }
    }
    function* rowsFor(db, store, key, value) {
        if (Array.isArray(value)) {
            yield { type: 'recordArrayStart', database: db, store, key };
            for (let index = 0; index < value.length; index++) yield { type: 'recordArrayItem', database: db, store, key, index, value: value[index] ?? null };
            yield { type: 'recordArrayEnd', database: db, store, key, length: value.length };
        } else yield { type: 'record', database: db, store, key, value };
    }
    async function encodeSource(id, rows, storePack, previous) {
        const packs = [], rawHashes = [];
        const bucket = 'source:' + await C.hash(id);
        const buffer = new Uint8Array(C.LIMIT.raw);
        let used = 0, entries = 0;
        const flush = async () => {
            if (!used) return;
            const rawHash = await C.hash(buffer.subarray(0, used)), index = packs.length;
            rawHashes.push(rawHash);
            if (previous?.rawHashes?.[index] === rawHash && previous.packs[index]?.entries === entries) packs.push(previous.packs[index]);
            else {
                const bytes = await C.compress(buffer.subarray(0, used)), checksum = await C.hash(bytes);
                packs.push({ bucket, checksum, length: bytes.length, entries });
                await storePack(checksum, bytes);
            }
            used = 0; entries = 0;
        };
        for await (const row of rows) {
            const bytes = C.encoder.encode(C.canonical(row));
            await breathe();
            if (bytes.length > C.LIMIT.object) throw C.fail('单条数据超过 64MiB。');
            for (let offset = 0; offset < bytes.length;) {
                const n = Math.min(bytes.length - offset, buffer.length - used);
                buffer.set(bytes.subarray(offset, offset + n), used); used += n; offset += n;
                if (used === buffer.length) await flush();
            }
            buffer[used++] = 10; entries++;
            if (used === buffer.length || entries === C.LIMIT.entries) await flush();
        }
        await flush();
        return { packs, rawHashes };
    }
    async function prepare(full = false) {
        if (preparing) { await preparing; if (!full) return prepare(false); }
        preparing = exclusive(() => { lowDuty = true; dutyUntil = 0; return buildSnapshot(full).finally(() => { lowDuty = false; }); });
        try { return await preparing; } finally { preparing = null; }
    }
    async function buildSnapshot(full = false) {
        await P.flush();
        const db = await cache();
        try {
            const old = await readCache(db, 'state', 'snapshot');
            const dirty = await P.dirty(old?.watermark?.databases || {});
            const epoch = localStorage.getItem(K.epoch);
            full ||= !old || old.layout !== 2 || old.epoch !== epoch || C.canonical(old.epochs || {}) !== C.canonical(dirty.epochs);
            const sources = new Map(full ? [] : await allCache(db, 'sources'));
            const changes = new Map();
            const storePack = async (checksum, bytes) => {
                const tx = db.transaction('packs', 'readwrite');
                tx.objectStore('packs').put(bytes, checksum);
                await P.txDone(tx);
            };
            const replace = async (id, rows, order) => {
                const encoded = await encodeSource(id, rows, storePack, sources.get(id));
                const value = { ...encoded, order };
                sources.set(id, value); changes.set(id, value);
            };
            await replace('localStorage', appEntries().map(([key, value]) => ({ type: 'localStorage', key, value })), '0');
            const existing = await P.names();
            for (const [dbIndex, dbName] of Object.keys(C.STORES).entries()) {
                const prefix = '1:' + dbIndex;
                if (!existing.includes(dbName)) continue;
                const app = await P.open(dbName);
                try {
                    const definitions = C.STORES[dbName].filter(s => app.objectStoreNames.contains(s)).map(name => {
                        const store = app.transaction(name, 'readonly').objectStore(name);
                        return { name, keyPath: store.keyPath, autoIncrement: store.autoIncrement };
                    });
                    await replace('header:' + dbName, [{ type: 'database', name: dbName, version: 1, stores: definitions }], prefix + ':0');
                    for (const [storeIndex, def] of definitions.entries()) {
                        const order = prefix + ':1:' + storeIndex;
                        const item = dirty.stores.get(dbName + '/' + def.name);
                        if (full || item) {
                            const keyTx = app.transaction(def.name, 'readonly'), keyRequest = keyTx.objectStore(def.name).getAllKeys();
                            const keys = await P.txDone(keyTx, () => keyRequest.result.filter(key => !C.excluded(dbName, def.name, key)));
                            const affected = full || item.clear ? new Set(Array.from({ length: 64 }, (_, i) => i)) : new Set([...item.keys.values()].map(bucketFor));
                            for (const bucket of affected) {
                                const id = 'bucket:' + dbName + '/' + def.name + '/' + bucket;
                                const selected = keys.filter(key => bucketFor(key) === bucket);
                                if (selected.length) await replace(id, bucketRows(dbName, def.name, selected), order + ':1:' + String(bucket).padStart(2, '0'));
                                else { sources.delete(id); changes.set(id, null); }
                            }
                        }
                        await replace('footer:' + dbName + '/' + def.name, [{ type: 'storeEnd', database: dbName, store: def.name }], order + ':2');
                    }
                    await replace('end:' + dbName, [{ type: 'databaseEnd', name: dbName }], prefix + ':2');
                } finally { app.close(); }
            }
            const packs = [...sources.values()].sort((a, b) => compare(a.order, b.order)).flatMap(s => s.packs);
            const totalBytes = packs.reduce((n, p) => n + p.length, 0), entryCount = packs.reduce((n, p) => n + p.entries, 0);
            if (packs.length > C.LIMIT.packs || totalBytes > C.LIMIT.snapshot) throw C.fail('同步快照超过上限。');
            const watermark = { databases: { ...(full ? {} : old?.watermark?.databases), ...dirty.databases }, intents: [...new Set([...(full ? [] : old?.watermark?.intents || []), ...dirty.intents])] };
            const next = { layout: 2, epoch, epochs: dirty.epochs, watermark, packs, totalBytes, entryCount, verifiedAt: old?.verifiedAt || 0, committed: old?.committed || '', sweptAt: old?.sweptAt || 0 };
            const tx = db.transaction(['sources', 'state'], 'readwrite');
            if (full) tx.objectStore('sources').clear();
            for (const [id, value] of changes) value ? tx.objectStore('sources').put(value, id) : tx.objectStore('sources').delete(id);
            tx.objectStore('state').put(next, 'snapshot');
            await P.txDone(tx);
            return next;
        } finally { db.close(); }
    }
    async function rootFor(snapshot, version) {
        const m = { format: C.FORMAT, compression: 'gzip', version: version + 1, updatedAt: Date.now(), packs: snapshot.packs, totalBytes: snapshot.totalBytes, entryCount: snapshot.entryCount };
        m.checksum = await C.hash(C.checksumSource(m)); return m;
    }
    async function sweepAll() {
        let cursor, deleted = 0;
        do {
            const reply = await post({ action: 'sweep', ...(cursor ? { cursor } : {}) });
            deleted += reply.deleted || 0; cursor = reply.cursor;
        } while (cursor);
        return deleted;
    }
    async function upload(automatic) {
        if (!window.RPHubExternal || RPHubExternal.version !== 2) throw C.fail('作者适配接口未就绪。');
        const flushed = await RPHubExternal.flush();
        if (flushed?.ok !== true) throw C.fail(flushed?.reason || '作者数据未确认保存。');
        await window.RPH_MAGIC_FLUSH_IMAGES?.(); await P.flush();
        const snapshot = await buildSnapshot();
        const db = await cache();
        try {
            const localRoot = await rootFor(snapshot, 0);
            if (automatic && snapshot.committed === localRoot.checksum && Date.now() - snapshot.verifiedAt < 3600000) { await P.acknowledge(snapshot.watermark); return '本地无变化，已保存'; }
            const reply = await post({ action: 'status' });
            const remote = reply.manifest ? await C.validateManifest(reply.manifest) : null;
            let reclaimed = 0;
            if (remote?.checksum !== localRoot.checksum) {
                const known = new Set((remote?.packs || []).map(p => p.checksum));
                const pending = snapshot.packs.filter(p => !known.has(p.checksum));
                const send = async packs => {
                    let done = 0;
                    await C.pool(packs, 6, async p => {
                        const bytes = await readCache(db, 'packs', p.checksum);
                        if (!bytes || bytes.length !== p.length || await C.hash(bytes) !== p.checksum) throw C.fail('本地分片缓存损坏，请重建索引。');
                        const query = new URLSearchParams({ checksum: p.checksum, length: String(p.length), entries: String(p.entries) });
                        await request('/api/rp-sync/pack?' + query, { method: 'PUT', headers: { 'content-type': 'application/gzip' }, body: bytes });
                        progress(40 + Math.round(++done / Math.max(1, packs.length) * 40), '正在上传分片…');
                    });
                };
                progress(40, '正在上传分片…');
                await send(pending);
                let result;
                const root = await rootFor(snapshot, remote?.version || 0);
                for (let round = 0; round < 3; round++) {
                    progress(90, '正在确认云端快照…');
                    result = await post({ action: 'commit', manifest: root }, true);
                    if (result.ok) break;
                    if (!Array.isArray(result.missing) || !result.missing.length) throw C.fail(result.error || '云端状态变化，请重试。', 409);
                    const missing = new Set(result.missing);
                    await send(snapshot.packs.filter(p => missing.has(p.checksum)));
                }
                if (!result.ok) throw C.fail('云端仍缺少分片。');
                reclaimed = result.reclaimed || 0;
            }
            snapshot.committed = localRoot.checksum; snapshot.verifiedAt = Date.now();
            // 提交回收失败（reclaimed>0）或距上次清扫满一天时兜底清扫：清掉
            // 中断上传留下的孤儿分片（宽限 1 小时，正在进行的上传不受影响）。
            if (reclaimed > 0 || Date.now() - snapshot.sweptAt >= 86400000) {
                progress(95, '正在清理孤儿分片…');
                snapshot.sweptAt = Date.now();
                await sweepAll();
            }
            const tx = db.transaction('state', 'readwrite'); tx.objectStore('state').put(snapshot, 'snapshot'); await P.txDone(tx);
            await P.acknowledge(snapshot.watermark);
            const active = new Set(snapshot.packs.map(p => p.checksum));
            const keysTx = db.transaction('packs', 'readonly'), keysRequest = keysTx.objectStore('packs').getAllKeys();
            const obsolete = (await P.txDone(keysTx, () => keysRequest.result)).filter(key => !active.has(key));
            if (obsolete.length) { const cleanup = db.transaction('packs', 'readwrite'); for (const key of obsolete) cleanup.objectStore('packs').delete(key); await P.txDone(cleanup); }
            return remote?.checksum === localRoot.checksum ? '已是最新' : '上传完成';
        } finally { db.close(); }
    }
    class Restore {
        constructor(validate) { this.validate = validate; this.database = null; this.seen = new Set(); this.local = new Set(); this.count = 0; }
        async consume(row) {
            this.count++;
            const d = this.database;
            if (row.type === 'localStorage') {
                if (this.seen.size || d || !C.appKey(row.key) || typeof row.value !== 'string' || this.local.has(row.key)) throw C.fail('本地设置记录无效。');
                this.local.add(row.key); if (!this.validate) localStorage.setItem(row.key, row.value); return;
            }
            if (row.type === 'database') {
                if (d || this.seen.has(row.name) || !C.STORES[row.name] || !Array.isArray(row.stores)) throw C.fail('数据库头无效。');
                this.seen.add(row.name);
                const defs = row.stores;
                if (new Set(defs.map(s => s.name)).size !== defs.length || defs.some(s => !C.STORES[row.name].includes(s.name) || s.keyPath != null && typeof s.keyPath !== 'string' && (!Array.isArray(s.keyPath) || !s.keyPath.length || s.keyPath.some(key => typeof key !== 'string')))) throw C.fail('对象存储定义无效。');
                const validPath = path => path === '' || path.split('.').every(part => /^[$_\p{ID_Start}][$_\u200c\u200d\p{ID_Continue}]*$/u.test(part));
                if (defs.some(s => s.keyPath != null && (Array.isArray(s.keyPath) ? s.keyPath.some(path => !validPath(path)) || s.autoIncrement : !validPath(s.keyPath) || s.keyPath === '' && s.autoIncrement))) throw C.fail('对象存储键路径无效。');
                let db;
                if (this.validate) {
                    if ((await P.names()).includes(row.name)) {
                        db = await P.open(row.name);
                        try { for (const def of defs) if (db.objectStoreNames.contains(def.name)) { const store = db.transaction(def.name, 'readonly').objectStore(def.name); if (JSON.stringify(store.keyPath) !== JSON.stringify(def.keyPath ?? null) || store.autoIncrement !== Boolean(def.autoIncrement)) throw C.fail('本地数据库结构不兼容。'); } }
                        finally { db.close(); }
                    }
                    db = null;
                } else {
                    db = await P.open(row.name, target => { for (const def of defs) if (!target.objectStoreNames.contains(def.name)) target.createObjectStore(def.name, { ...(def.keyPath != null ? { keyPath: def.keyPath } : {}), autoIncrement: Boolean(def.autoIncrement) }); });
                    if (defs.some(def => !db.objectStoreNames.contains(def.name))) {
                        const version = db.version + 1; db.close();
                        db = await P.open(row.name, target => { for (const def of defs) if (!target.objectStoreNames.contains(def.name)) target.createObjectStore(def.name, { ...(def.keyPath != null ? { keyPath: def.keyPath } : {}), autoIncrement: Boolean(def.autoIncrement) }); }, version);
                    }
                }
                this.database = { name: row.name, db, stores: new Map(defs.map(def => [def.name, { def, keys: new Set(), finished: false, array: null }])) }; return;
            }
            if (row.type === 'databaseEnd') {
                if (!d || d.name !== row.name || [...d.stores.values()].some(s => !s.finished)) throw C.fail('数据库未完整结束。');
                d.db?.close(); this.database = null; return;
            }
            if (!d || row.database !== d.name || !d.stores.has(row.store)) throw C.fail('数据记录归属无效。');
            const s = d.stores.get(row.store);
            if (s.finished) throw C.fail('对象存储已结束。');
            if (row.type === 'recordArrayStart') { if (s.array) throw C.fail('数组头重复。'); s.array = { key: row.key, next: 0, values: [] }; return; }
            if (row.type === 'recordArrayItem') {
                if (!s.array || C.canonical(s.array.key) !== C.canonical(row.key) || row.index !== s.array.next++) throw C.fail('数组记录顺序无效。');
                if (!this.validate) s.array.values.push(row.value); return;
            }
            if (row.type === 'recordArrayEnd') {
                if (!s.array || row.length !== s.array.next || C.canonical(s.array.key) !== C.canonical(row.key)) throw C.fail('数组记录不完整。');
                const array = s.array; s.array = null; await this.write(s, array.key, array.values); return;
            }
            if (row.type === 'record') { if (s.array) throw C.fail('数组记录未结束。'); await this.write(s, row.key, row.value); return; }
            if (row.type !== 'storeEnd' || s.array) throw C.fail('对象存储结束标记无效。');
            if (!this.validate) {
                const tx = d.db.transaction(row.store, 'readwrite'), store = tx.objectStore(row.store), r = store.openKeyCursor();
                r.onsuccess = () => { const cur = r.result; if (!cur) return; if (!C.excluded(d.name, row.store, cur.key) && !s.keys.has(C.canonical(cur.key))) store.delete(cur.key); cur.continue(); };
                await P.txDone(tx);
            }
            s.finished = true;
        }
        async write(s, key, value) {
            const token = C.canonical(key);
            try { IDBKeyRange.only(key); } catch { throw C.fail('快照包含无效数据库键。'); }
            if (s.def.keyPath != null) {
                const extract = path => path === '' ? value : path.split('.').reduce((item, part) => item?.[part], value);
                const inline = Array.isArray(s.def.keyPath) ? s.def.keyPath.map(extract) : extract(s.def.keyPath);
                if (inline === undefined || C.canonical(inline) !== token) throw C.fail('记录内联键与快照键不一致。');
            }
            if (s.keys.has(token)) throw C.fail('快照包含重复键。');
            s.keys.add(token);
            if (C.excluded(this.database.name, s.def.name, key) || this.validate) return;
            const tx = this.database.db.transaction(s.def.name, 'readwrite'), store = tx.objectStore(s.def.name);
            if (s.def.keyPath != null) store.put(value); else store.put(value, key);
            await P.txDone(tx);
        }
        async finish(expected) {
            if (this.database || this.count !== expected) throw C.fail('快照不完整。');
            if (!this.validate) {
                for (const [key] of appEntries()) if (!this.local.has(key)) localStorage.removeItem(key);
                for (const name of await P.names()) if (!this.seen.has(name)) {
                    const db = await P.open(name);
                    try { for (const store of C.STORES[name]) if (db.objectStoreNames.contains(store)) { const tx = db.transaction(store, 'readwrite'), s = tx.objectStore(store), r = s.openKeyCursor(); r.onsuccess = () => { const cur = r.result; if (!cur) return; if (!C.excluded(name, store, cur.key)) s.delete(cur.key); cur.continue(); }; await P.txDone(tx); } }
                    finally { db.close(); }
                }
            }
        }
        abort() { this.database?.db?.close(); }
    }
    async function parse(packs, get, consumer, expected) {
        let fragments = [], size = 0, lastBucket;
        const decoder = new TextDecoder('utf-8', { fatal: true });
        try {
            for (const p of packs) {
                if (lastBucket !== p.bucket && size) throw C.fail('跨桶记录未结束。');
                lastBucket = p.bucket;
                const raw = await get(p);
                let count = 0;
                for (let offset = 0; offset < raw.length;) {
                    const end = raw.indexOf(10, offset), piece = raw.subarray(offset, end < 0 ? raw.length : end);
                    size += piece.length; fragments.push(piece);
                    if (size > C.LIMIT.object) throw C.fail('单条恢复数据过大。');
                    if (end < 0) break;
                    const bytes = new Uint8Array(size); let pos = 0;
                    for (const part of fragments) { bytes.set(part, pos); pos += part.length; }
                    const row = JSON.parse(decoder.decode(bytes));
                    await consumer.consume(row);
                    fragments = []; size = 0; count++; offset = end + 1;
                }
                if (count !== p.entries) throw C.fail('分片记录数不符。');
                await pause();
            }
            if (size || fragments.length) throw C.fail('恢复记录未完整结束。');
            await consumer.finish(expected);
        } catch (e) { consumer.abort(); throw e; }
    }
    async function download() {
        const reply = await post({ action: 'status' });
        if (!reply.manifest) return '云端没有数据';
        const root = await C.validateManifest(reply.manifest), db = await cache();
        try {
            let completed = 0;
            await C.pool(root.packs, 4, async p => {
                let bytes = await readCache(db, 'packs', p.checksum);
                if (!bytes || bytes.length !== p.length || await C.hash(bytes) !== p.checksum) {
                    bytes = await C.bounded(await request('/api/rp-sync/pack?c=' + p.checksum), C.LIMIT.pack);
                    if (bytes.length !== p.length || await C.hash(bytes) !== p.checksum) throw C.fail('下载分片校验失败。');
                    const tx = db.transaction('packs', 'readwrite'); tx.objectStore('packs').put(bytes, p.checksum); await P.txDone(tx);
                }
                progress(10 + ++completed / root.packs.length * 50, '正在下载并校验…');
            });
            const get = async p => C.compress(await readCache(db, 'packs', p.checksum), true);
            await parse(root.packs, get, new Restore(true), root.entryCount);
            const epoch = crypto.randomUUID();
            localStorage.setItem(K.active, epoch); localStorage.setItem(K.restoreEpoch, epoch);
            await P.flush();
            for (const name of await P.names()) {
                const app = await P.open(name);
                try { const stores = C.STORES[name].filter(s => app.objectStoreNames.contains(s)); if (stores.length) { const tx = app.transaction(stores, 'readwrite'); tx.objectStore(stores[0]).get('__barrier__'); await P.txDone(tx); } }
                finally { app.close(); }
            }
            const mark = await P.dirty();
            progress(75, '正在应用云端数据…');
            await parse(root.packs, get, new Restore(false), root.entryCount);
            await P.acknowledge(mark);
            // 恢复后本地与云端一致：预写 committed 记忆，首轮自动保存零请求。
            const tx = db.transaction(['sources', 'state'], 'readwrite');
            tx.objectStore('sources').clear();
            tx.objectStore('state').put({ layout: 2, epoch: localStorage.getItem(K.epoch), epochs: {}, watermark: { databases: {}, intents: [] }, packs: [], totalBytes: 0, entryCount: 0, verifiedAt: Date.now(), committed: root.checksum, sweptAt: 0 }, 'snapshot');
            await P.txDone(tx);
            localStorage.removeItem(K.active);
            return '恢复完成';
        } finally { db.close(); }
    }
    function lastResult(ok) {
        localStorage.setItem('rp_hub_sync_last_result_v1', JSON.stringify({ at: Date.now(), ok }));
        renderLastSync();
    }
    async function operate(kind, automatic = false) {
        if (running) return running;
        ui.busy = true; ui.automatic = automatic;
        setActionsDisabled(true);
        progress(5, automatic ? '正在自动上传…' : '准备中…');
        if (modalRoot) modalRoot.classList.remove('is-error');
        running = (async () => {
            try {
                if (preparing) await preparing;
                const result = await exclusive(async () => kind === 'pull' ? download() : kind === 'rebuild' ? (await buildSnapshot(true), '本地索引已重建') : upload(automatic));
                if (automatic) lastAutoSaveError = '';
                progress(100, result); lastResult(true);
                if (kind === 'pull') location.replace('/');
            } catch (e) {
                if (automatic) lastAutoSaveError = e.message;
                progress(ui.progress, e.message); lastResult(false);
                if (modalRoot) modalRoot.classList.add('is-error');
                // 缓存损坏类错误亮出"重建本地索引"作为恢复入口。
                if (rebuildButton && /重建/.test(e.message)) rebuildButton.style.display = '';
                if (e.status === 401) { if (P.restorePage) openAccessGate('恢复需要访问密码。'); else openPasswordModal(); }
                throw e;
            } finally {
                running = null; ui.busy = false; setActionsDisabled(false);
                progress(ui.progress, ui.text); remaining = minutes() * 60000;
                syncAutoSaveUi();
            }
        })();
        return running;
    }

    /* ================= UI 层：v2 视觉体系（rp-sync-modal BEM + 全屏锁页） ================= */

    const enabled = () => localStorage.getItem('rp_hub_sync_auto_save_enabled_v1') === '1';
    const minutes = () => Math.max(1, Math.min(1440, Number(localStorage.getItem('rp_hub_sync_auto_save_minutes_v1')) || 5));
    let lastAutoSaveError = '';

    function schedulePrepare(delay = 8000) {
        clearTimeout(prepareTimer);
        if (P.restorePage) return;
        prepareTimer = setTimeout(() => { if (!running && document.visibilityState !== 'hidden') prepare().catch(e => progress(0, '后台准备：' + e.message)); }, delay);
    }
    function autoTick() {
        clearTimeout(autoTimer);
        const now = performance.now(), elapsed = now - lastActive;
        if (document.visibilityState !== 'hidden' && elapsed >= 0 && elapsed < 35000 && !running) remaining -= elapsed;
        lastActive = now;
        if (enabled() && remaining <= 0 && document.visibilityState !== 'hidden' && !running) operate('push', true).catch(() => {});
        syncAutoSaveUi();
        autoTimer = setTimeout(autoTick, 30000);
    }

    const SYNC_STYLE_TEXT = `
.rp-sync-modal *, .rp-sync-modal *::before, .rp-sync-modal *::after {
    box-sizing: border-box;
}

.rp-sync-modal {
    position: fixed;
    inset: 0;
    z-index: 9999;
    display: none;
    color: #111827;
}

.rp-sync-modal.is-open {
    display: block;
}

.rp-sync-modal__backdrop {
    position: absolute;
    inset: 0;
    background: rgba(17, 24, 39, 0.32);
    backdrop-filter: blur(5px);
}

.rp-sync-modal__panel {
    position: absolute;
    left: 50%;
    top: 50%;
    width: min(92vw, 420px);
    max-height: min(86vh, 640px);
    overflow-y: auto;
    transform: translate(-50%, -50%);
    border: 1px solid rgba(229, 231, 235, 0.95);
    border-radius: 18px;
    background: rgba(255, 255, 255, 0.98);
    box-shadow: 0 24px 70px -34px rgba(15, 23, 42, 0.55);
    padding: 18px;
}

.rp-sync-modal__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 14px;
}

.rp-sync-modal__eyebrow {
    color: #2563eb;
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
}

.rp-sync-modal__title {
    margin: 0;
    color: #111827;
    font-size: 20px;
    line-height: 1.2;
    font-weight: 800;
}

.rp-sync-modal__title-main {
    display: block;
    color: #111827;
    font-size: 18px;
    line-height: 1.1;
    font-weight: 800;
    letter-spacing: 0;
}

.rp-sync-modal__close {
    flex: 0 0 auto;
    width: 32px;
    height: 32px;
    border: 1px solid rgba(229, 231, 235, 0.95);
    border-radius: 999px;
    background: #fff;
    color: #6b7280;
    font-size: 20px;
    line-height: 1;
    cursor: pointer;
}

.rp-sync-modal__close:hover {
    color: #111827;
    border-color: rgba(156, 163, 175, 0.9);
}

.rp-sync-modal--restore .rp-sync-modal__panel {
    width: min(88vw, 360px);
    max-height: none;
    overflow: visible;
    border-radius: 8px;
    padding: 20px;
}

.rp-sync-modal--notice .rp-sync-modal__panel {
    width: min(86vw, 320px);
    text-align: center;
}

.rp-sync-modal--notice .rp-sync-modal__actions {
    justify-content: center;
}

.rp-sync-modal--restore .rp-sync-modal__title-main,
.rp-sync-modal--restore .rp-sync-modal__status {
    text-align: center;
}

.rp-sync-restore-actions {
    display: none;
    justify-content: center;
    gap: 8px;
    margin-top: 16px;
}

.rp-sync-modal--restore.is-error .rp-sync-restore-actions {
    display: flex;
}

.rp-sync-modal.is-error .rp-sync-modal__status,
.rp-sync-modal.is-error .rp-sync-progress__value {
    color: #b91c1c;
}

.rp-sync-modal.is-error .rp-sync-progress__bar {
    background: #dc2626;
}

.rp-sync-main-actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
}

.rp-sync-auto-save {
    margin-top: 14px;
    padding: 12px;
    border: 1px solid rgba(229, 231, 235, 0.95);
    border-radius: 12px;
    background: #f8fafc;
}

.rp-sync-auto-save__row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
}

.rp-sync-auto-save__toggle,
.rp-sync-auto-save__interval {
    display: flex;
    align-items: center;
    gap: 8px;
    color: #374151;
    font-size: 13px;
    font-weight: 800;
}

.rp-sync-auto-save__toggle input {
    width: 16px;
    height: 16px;
    margin: 0;
    accent-color: #2563eb;
}

.rp-sync-auto-save__interval input {
    width: 76px;
    border: 1px solid rgba(209, 213, 219, 0.95);
    border-radius: 8px;
    background: #fff;
    color: #111827;
    font: inherit;
    padding: 7px 8px;
}

.rp-sync-auto-save__interval input:focus {
    border-color: rgba(37, 99, 235, 0.52);
    outline: 3px solid rgba(37, 99, 235, 0.11);
}

.rp-sync-auto-save__interval input[aria-invalid="true"] {
    border-color: #dc2626;
    outline-color: rgba(220, 38, 38, 0.12);
}

.rp-sync-auto-save__status {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 18px;
    margin: 8px 0 0;
    color: #64748b;
    font-size: 12px;
    line-height: 1.5;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.rp-sync-auto-save__footer {
    display: flex;
    align-items: baseline;
    gap: 12px;
}

.rp-sync-last-sync {
    flex: 0 0 auto;
    margin: 8px 0 0;
    padding-left: 12px;
    color: #64748b;
    font-size: 12px;
    font-weight: 700;
    line-height: 1.5;
    white-space: nowrap;
}

.rp-sync-last-sync.is-ok {
    color: #15803d;
}

.rp-sync-last-sync.is-fail {
    color: #b91c1c;
}

.rp-sync-action-button {
    min-width: 0;
    height: 42px;
    border: 1px solid rgba(229, 231, 235, 0.95);
    border-radius: 12px;
    background: #fff;
    color: #374151;
    font-size: 15px;
    font-weight: 800;
    cursor: pointer;
    transition: border-color 0.16s ease, background 0.16s ease, color 0.16s ease;
}

.rp-sync-action-button:hover {
    border-color: rgba(59, 130, 246, 0.35);
    background: #f8fafc;
    color: #1d4ed8;
}

.rp-sync-action-button.is-primary {
    border-color: rgba(37, 99, 235, 0.25);
    background: #eff6ff;
    color: #1d4ed8;
}

.rp-sync-action-button:disabled,
.rp-sync-modal__button:disabled {
    opacity: 0.62;
    cursor: wait;
}

.rp-sync-modal__status {
    min-height: 22px;
    margin: 14px 0 10px;
    color: #4b5563;
    font-size: 13px;
    line-height: 1.55;
}

.rp-sync-progress {
    width: 100%;
    height: 8px;
    overflow: hidden;
    border-radius: 999px;
    background: #e5e7eb;
}

.rp-sync-progress__bar {
    width: 0;
    height: 100%;
    border-radius: inherit;
    background: #2563eb;
    transition: width 0.28s ease;
}

.rp-sync-progress__value {
    margin-top: 6px;
    text-align: right;
    color: #2563eb;
    font-size: 12px;
    font-weight: 800;
}

.rp-sync-modal__intro {
    margin: 0 0 10px;
    color: #64748b;
    font-size: 13px;
    line-height: 1.55;
}

.rp-sync-password-field {
    display: grid;
    gap: 7px;
    margin-top: 14px;
    color: #475569;
    font-size: 13px;
    font-weight: 800;
}

.rp-sync-modal__actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 16px;
}

.rp-sync-modal__button {
    min-width: 78px;
    border: 1px solid rgba(209, 213, 219, 0.95);
    border-radius: 999px;
    background: #fff;
    color: #374151;
    font-size: 13px;
    font-weight: 800;
    padding: 8px 12px;
    cursor: pointer;
}

.rp-sync-modal__button:hover {
    border-color: rgba(59, 130, 246, 0.35);
    color: #1d4ed8;
}

.rp-sync-modal__button.is-primary {
    border-color: rgba(37, 99, 235, 0.25);
    background: #eff6ff;
    color: #1d4ed8;
}

.rp-sync-password-field input {
    width: 100%;
    border: 1px solid rgba(209, 213, 219, 0.95);
    border-radius: 12px;
    background: #fff;
    color: #111827;
    font-size: 15px;
    line-height: 1.4;
    padding: 11px 12px;
    outline: none;
    transition: border-color 0.16s ease, box-shadow 0.16s ease;
}

.rp-sync-password-field input:focus {
    border-color: rgba(37, 99, 235, 0.52);
    box-shadow: 0 0 0 4px rgba(37, 99, 235, 0.11);
}

.rp-sync-password-status {
    min-height: 20px;
    margin: 10px 0 0;
    color: #475569;
    font-size: 13px;
    line-height: 1.5;
}

@media (max-width: 640px) {
    .rp-sync-modal__backdrop {
        background: rgba(17, 24, 39, 0.36);
    }

    .rp-sync-modal__panel {
        left: 0;
        right: 0;
        bottom: 0;
        top: auto;
        width: 100%;
        max-height: min(82vh, 620px);
        transform: none;
        border-right: 0;
        border-bottom: 0;
        border-left: 0;
        border-radius: 20px 20px 0 0;
        padding: 16px 16px max(16px, env(safe-area-inset-bottom));
    }

    .rp-sync-modal__header {
        margin-bottom: 12px;
    }

    .rp-sync-modal__title {
        font-size: 18px;
    }

    .rp-sync-modal__title-main {
        font-size: 17px;
    }

    .rp-sync-main-actions {
        gap: 8px;
    }

    .rp-sync-auto-save__row {
        flex-wrap: wrap;
        row-gap: 10px;
    }

    .rp-sync-auto-save__interval {
        margin-left: auto;
    }

    .rp-sync-auto-save__footer {
        flex-wrap: wrap;
        row-gap: 2px;
    }

    .rp-sync-action-button {
        height: 42px;
        font-size: 14px;
        border-radius: 12px;
    }

    .rp-sync-modal--restore .rp-sync-modal__panel {
        left: 50%;
        right: auto;
        bottom: auto;
        top: 50%;
        width: min(88vw, 360px);
        transform: translate(-50%, -50%);
        border: 1px solid rgba(229, 231, 235, 0.95);
        border-radius: 8px;
        padding: 20px;
    }
}
`;
    const LOCK_STYLE_TEXT = `
.rp-sync-lock{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px;overflow:hidden;background:linear-gradient(180deg,#f8fafc 0%,#eef2ff 52%,#faf5ff 100%);opacity:1;transition:opacity .24s ease}
.rp-sync-lock::before,.rp-sync-lock::after{content:"";position:absolute;inset:-24%;pointer-events:none}
.rp-sync-lock::before{background:radial-gradient(36% 44% at 24% 30%,rgba(96,165,250,.5),transparent 70%),radial-gradient(32% 40% at 78% 20%,rgba(167,139,250,.42),transparent 70%),radial-gradient(38% 46% at 80% 76%,rgba(103,232,249,.4),transparent 70%);animation:rp-lock-drift-a 26s ease-in-out infinite alternate}
.rp-sync-lock::after{background:radial-gradient(34% 44% at 72% 72%,rgba(244,114,182,.32),transparent 70%),radial-gradient(36% 46% at 16% 78%,rgba(129,140,248,.38),transparent 70%);animation:rp-lock-drift-b 32s ease-in-out infinite alternate}
@keyframes rp-lock-drift-a{from{transform:translate3d(-2.5%,-2%,0) scale(1)}to{transform:translate3d(2.5%,2.5%,0) scale(1.07)}}
@keyframes rp-lock-drift-b{from{transform:translate3d(2%,2.5%,0) scale(1.05)}to{transform:translate3d(-2.5%,-2%,0) scale(1)}}
.rp-sync-lock.is-leaving{opacity:0;pointer-events:none}
.rp-sync-lock__card{position:relative;z-index:1;width:min(100%,380px);border:1px solid rgba(255,255,255,.85);border-radius:22px;background:rgba(255,255,255,.82);backdrop-filter:blur(16px) saturate(1.5);-webkit-backdrop-filter:blur(16px) saturate(1.5);box-shadow:0 24px 70px -30px rgba(79,70,229,.38),0 4px 16px rgba(15,23,42,.07);padding:28px 26px 24px;color:#0f172a;animation:rp-sync-lock-in .34s cubic-bezier(.2,.8,.3,1)}
.rp-sync-lock.is-leaving .rp-sync-lock__card{transform:translateY(6px) scale(.985);transition:transform .24s ease}
@keyframes rp-sync-lock-in{from{opacity:0;transform:translateY(10px) scale(.97)}to{opacity:1;transform:translateY(0) scale(1)}}
.rp-sync-lock.is-error .rp-sync-lock__card{animation:rp-sync-lock-shake .36s ease}
@keyframes rp-sync-lock-shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-7px)}40%{transform:translateX(6px)}60%{transform:translateX(-4px)}80%{transform:translateX(3px)}}
.rp-sync-lock__card,.rp-sync-lock__card *{box-sizing:border-box}
.rp-sync-lock__badge{width:44px;height:44px;margin:0 auto 14px;display:flex;align-items:center;justify-content:center;border-radius:14px;background:linear-gradient(135deg,#60a5fa,#4f46e5);box-shadow:0 12px 26px -10px rgba(79,70,229,.55)}
.rp-sync-lock__badge svg{width:22px;height:22px;display:block}
.rp-sync-lock__title{margin:0 0 8px;text-align:center;color:#0f172a;font-size:21px;line-height:1.2;font-weight:800}
.rp-sync-lock__intro{margin:0 0 18px;text-align:center;color:#64748b;font-size:13px;line-height:1.6}
.rp-sync-lock__field{position:relative;display:block}
.rp-sync-lock__field input{width:100%;border:1px solid rgba(203,213,225,.9);border-radius:14px;background:rgba(255,255,255,.92);color:#0f172a;font-size:15px;line-height:1.4;padding:13px 46px 13px 14px;outline:none;transition:border-color .16s ease,box-shadow .16s ease,background .16s ease}
.rp-sync-lock__field input:focus{border-color:rgba(99,102,241,.55);background:#fff;box-shadow:0 0 0 4px rgba(99,102,241,.13)}
.rp-sync-lock__field input::placeholder{color:#94a3b8}
.rp-sync-lock__toggle{position:absolute;top:50%;right:8px;transform:translateY(-50%);width:32px;height:32px;display:flex;align-items:center;justify-content:center;border:0;border-radius:10px;background:transparent;color:#94a3b8;cursor:pointer;transition:color .16s ease,background .16s ease}
.rp-sync-lock__toggle:hover{color:#4f46e5;background:rgba(99,102,241,.09)}
.rp-sync-lock__toggle:focus-visible{outline:2px solid rgba(99,102,241,.55);outline-offset:1px}
.rp-sync-lock__toggle svg{width:18px;height:18px}
.rp-sync-lock__error{min-height:18px;margin:8px 2px 0;color:#b91c1c;font-size:12.5px;line-height:1.5}
.rp-sync-lock__submit{width:100%;margin-top:12px;display:flex;align-items:center;justify-content:center;gap:8px;border:0;border-radius:14px;background:linear-gradient(135deg,#6366f1,#4f46e5);color:#fff;font-size:15px;font-weight:800;padding:12px 16px;cursor:pointer;box-shadow:0 14px 30px -14px rgba(79,70,229,.6);transition:filter .16s ease,transform .16s ease,box-shadow .16s ease}
.rp-sync-lock__submit:hover{filter:brightness(1.07)}
.rp-sync-lock__submit:active{transform:translateY(1px)}
.rp-sync-lock__submit:focus-visible{outline:2px solid rgba(67,56,202,.7);outline-offset:2px}
.rp-sync-lock__submit:disabled{opacity:.72;cursor:wait;box-shadow:none;transform:none}
.rp-sync-lock__spinner{width:16px;height:16px;border:2px solid rgba(255,255,255,.45);border-top-color:#fff;border-radius:50%;animation:rp-sync-lock-spin .7s linear infinite;display:none}
.rp-sync-lock__submit.is-busy .rp-sync-lock__spinner{display:block}
@keyframes rp-sync-lock-spin{to{transform:rotate(360deg)}}
@media (max-width:480px){.rp-sync-lock__card{padding:24px 20px 20px;border-radius:18px}}
@media (prefers-reduced-motion:reduce){.rp-sync-lock{transition:none}.rp-sync-lock::before,.rp-sync-lock::after{animation:none}.rp-sync-lock__card{animation:none}.rp-sync-lock.is-leaving .rp-sync-lock__card{transition:none}.rp-sync-lock__spinner{animation-duration:1.2s}}
`;
    const LOCK_EYE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
    const LOCK_EYE_OFF_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
    const LOCK_BADGE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';

    function ensureStyle(id, css) {
        if (document.getElementById(id)) return;
        const style = document.createElement('style');
        style.id = id;
        style.textContent = css;
        (document.head || document.documentElement).append(style);
    }

    let modalRoot = null, modalStatus = null, modalProgressBar = null, modalProgressValue = null;
    let pushButton = null, pullButton = null, rebuildButton = null;
    let autoSaveToggle = null, autoSaveMinutesInput = null, autoSaveStatus = null, lastSyncBadge = null;
    let passwordModalRoot = null, passwordInput = null, passwordStatus = null, passwordSubmitButton = null;
    let lockOverlay = null, lockIntro = null, lockFormInput = null, lockFormError = null, lockFormSubmit = null;
    let lockBody = null, lockBodyOverflow = '';
    let noticeModalRoot = null;
    let checkingPassword = false;
    let accessGateDone = Promise.resolve();

    function renderLastSync() {
        if (!lastSyncBadge) return;
        let record = null;
        try { record = JSON.parse(localStorage.getItem('rp_hub_sync_last_result_v1') || 'null'); } catch { /* 视为无记录 */ }
        if (!record || typeof record.at !== 'number') { lastSyncBadge.textContent = ''; lastSyncBadge.className = 'rp-sync-last-sync'; return; }
        const time = new Date(record.at);
        const clock = String(time.getHours()).padStart(2, '0') + ':' + String(time.getMinutes()).padStart(2, '0');
        const now = new Date();
        const sameDay = time.getFullYear() === now.getFullYear() && time.getMonth() === now.getMonth() && time.getDate() === now.getDate();
        lastSyncBadge.textContent = (sameDay ? clock : (time.getMonth() + 1) + '/' + time.getDate() + ' ' + clock) + ' ' + (record.ok ? '同步成功' : '同步失败');
        lastSyncBadge.className = 'rp-sync-last-sync ' + (record.ok ? 'is-ok' : 'is-fail');
    }
    function setActionsDisabled(disabled) {
        for (const button of [pushButton, pullButton, rebuildButton]) if (button) button.disabled = disabled;
    }
    function syncAutoSaveUi() {
        if (!autoSaveToggle) return;
        autoSaveToggle.checked = enabled();
        if (autoSaveMinutesInput.value === '' || document.activeElement !== autoSaveMinutesInput) autoSaveMinutesInput.value = minutes();
        autoSaveStatus.textContent = running && ui.automatic ? '正在自动上传…' : enabled() ? ((remaining <= 0 ? '即将自动保存' : '约 ' + Math.max(1, Math.ceil(remaining / 60000)) + ' 分钟后自动保存') + (lastAutoSaveError ? '；上次失败：' + lastAutoSaveError : '')) : '自动保存已关闭';
    }
    function ensureModal() {
        if (modalRoot) return;
        ensureStyle('rp-sync-style', SYNC_STYLE_TEXT);
        modalRoot = document.createElement('div');
        modalRoot.className = P.restorePage ? 'rp-sync-modal rp-sync-modal--restore' : 'rp-sync-modal';
        modalRoot.innerHTML = P.restorePage ? `
            <div class="rp-sync-modal__backdrop"></div>
            <main class="rp-sync-modal__panel" aria-live="polite">
                <h1 class="rp-sync-modal__title-main">恢复数据</h1>
                <p class="rp-sync-modal__status">正在恢复…</p>
                <div class="rp-sync-progress"><div class="rp-sync-progress__bar"></div></div>
                <div class="rp-sync-progress__value">0%</div>
                <div class="rp-sync-restore-actions">
                    <button type="button" class="rp-sync-modal__button is-primary" data-action="pull">重试</button>
                    <button type="button" class="rp-sync-modal__button" data-action="return">返回</button>
                </div>
            </main>
        ` : `
            <div class="rp-sync-modal__backdrop"></div>
            <div class="rp-sync-modal__panel">
                <div class="rp-sync-modal__header">
                    <h3 class="rp-sync-modal__title"><span class="rp-sync-modal__title-main">云同步</span></h3>
                    <button type="button" class="rp-sync-modal__close" aria-label="关闭">×</button>
                </div>
                <div class="rp-sync-main-actions">
                    <button type="button" class="rp-sync-action-button is-primary" data-action="push">上传到云端</button>
                    <button type="button" class="rp-sync-action-button" data-action="pull">从云端恢复</button>
                    <button type="button" class="rp-sync-action-button" data-action="rebuild">重建本地索引</button>
                </div>
                <section class="rp-sync-auto-save" aria-label="自动保存">
                    <div class="rp-sync-auto-save__row">
                        <label class="rp-sync-auto-save__toggle"><input type="checkbox" data-action="auto-save-toggle"><span>自动保存</span></label>
                        <label class="rp-sync-auto-save__interval"><span>间隔（分钟）</span><input type="number" data-action="auto-save-minutes" inputmode="numeric"></label>
                    </div>
                    <div class="rp-sync-auto-save__footer">
                        <p class="rp-sync-auto-save__status" aria-live="polite"></p>
                        <span class="rp-sync-last-sync" aria-live="polite"></span>
                    </div>
                </section>
                <p class="rp-sync-modal__status">请选择同步方向。</p>
                <div class="rp-sync-progress"><div class="rp-sync-progress__bar"></div></div>
                <div class="rp-sync-progress__value">0%</div>
            </div>
        `;
        document.body.append(modalRoot);
        modalStatus = modalRoot.querySelector('.rp-sync-modal__status');
        modalProgressBar = modalRoot.querySelector('.rp-sync-progress__bar');
        modalProgressValue = modalRoot.querySelector('.rp-sync-progress__value');
        pullButton = modalRoot.querySelector('[data-action="pull"]');
        if (P.restorePage) {
            pullButton.addEventListener('click', () => { modalRoot.classList.remove('is-error'); operate('pull').catch(() => {}); });
            modalRoot.querySelector('[data-action="return"]').addEventListener('click', () => location.replace('/'));
            modalRoot.classList.add('is-open');
            return;
        }
        pushButton = modalRoot.querySelector('[data-action="push"]');
        rebuildButton = modalRoot.querySelector('[data-action="rebuild"]');
        autoSaveToggle = modalRoot.querySelector('[data-action="auto-save-toggle"]');
        autoSaveMinutesInput = modalRoot.querySelector('[data-action="auto-save-minutes"]');
        autoSaveStatus = modalRoot.querySelector('.rp-sync-auto-save__status');
        lastSyncBadge = modalRoot.querySelector('.rp-sync-last-sync');
        // 重建默认隐藏：缓存损坏类错误出现时才作为恢复入口亮出。
        rebuildButton.style.display = 'none';
        autoSaveToggle.checked = enabled();
        autoSaveMinutesInput.value = minutes();
        autoSaveToggle.addEventListener('change', () => { localStorage.setItem('rp_hub_sync_auto_save_enabled_v1', autoSaveToggle.checked ? '1' : '0'); remaining = minutes() * 60000; syncAutoSaveUi(); });
        autoSaveMinutesInput.addEventListener('change', () => {
            const value = Number(autoSaveMinutesInput.value);
            if (!Number.isInteger(value) || value < 1 || value > 1440) { autoSaveMinutesInput.setAttribute('aria-invalid', 'true'); autoSaveMinutesInput.value = minutes(); return; }
            autoSaveMinutesInput.removeAttribute('aria-invalid');
            localStorage.setItem('rp_hub_sync_auto_save_minutes_v1', String(value));
            remaining = value * 60000;
            syncAutoSaveUi();
        });
        modalRoot.querySelector('.rp-sync-modal__close').addEventListener('click', () => modalRoot.classList.remove('is-open'));
        modalRoot.querySelector('.rp-sync-modal__backdrop').addEventListener('click', () => modalRoot.classList.remove('is-open'));
        pushButton.addEventListener('click', () => operate('push').catch(() => {}));
        pullButton.addEventListener('click', async () => {
            if (running && ui.automatic) { showSyncNotice('正在自动上传，请稍后。'); return; }
            if (running) return;
            let local = '';
            try { const dirty = await P.dirty(); if (dirty.stores.size || dirty.intents.length) local = '（本地有未上传的修改，恢复后会丢弃）'; }
            catch { /* 状态探测失败不阻塞恢复入口 */ }
            if (confirm('从云端恢复会替换本地数据' + local + '，继续吗？')) location.replace('/sync-restore');
        });
        rebuildButton.addEventListener('click', () => { if (!running && confirm('重建会完整读取本地数据重建索引，不会上传或覆盖云端。继续吗？')) operate('rebuild').catch(() => {}); });
        renderLastSync();
        syncAutoSaveUi();
    }
    function openSyncPanel() {
        ensureModal();
        if (!running) { progress(0, '请选择同步方向。'); modalRoot.classList.remove('is-error'); }
        renderLastSync();
        syncAutoSaveUi();
        modalRoot.classList.add('is-open');
    }
    function showSyncNotice(text) {
        ensureStyle('rp-sync-style', SYNC_STYLE_TEXT);
        if (!noticeModalRoot) {
            noticeModalRoot = document.createElement('div');
            noticeModalRoot.className = 'rp-sync-modal rp-sync-modal--notice';
            noticeModalRoot.innerHTML = `
                <div class="rp-sync-modal__backdrop"></div>
                <div class="rp-sync-modal__panel">
                    <h3 class="rp-sync-modal__title"><span class="rp-sync-modal__title-main">请稍后</span></h3>
                    <p class="rp-sync-modal__intro"></p>
                    <div class="rp-sync-modal__actions"><button type="button" class="rp-sync-modal__button is-primary" data-action="notice-ok">知道了</button></div>
                </div>
            `;
            document.body.append(noticeModalRoot);
            const close = () => noticeModalRoot.classList.remove('is-open');
            noticeModalRoot.querySelector('[data-action="notice-ok"]').addEventListener('click', close);
            noticeModalRoot.querySelector('.rp-sync-modal__backdrop').addEventListener('click', close);
        }
        noticeModalRoot.querySelector('.rp-sync-modal__intro').textContent = text;
        noticeModalRoot.classList.add('is-open');
    }
    function openPasswordModal() {
        ensureStyle('rp-sync-style', SYNC_STYLE_TEXT);
        if (!passwordModalRoot) {
            passwordModalRoot = document.createElement('div');
            passwordModalRoot.className = 'rp-sync-modal';
            passwordModalRoot.innerHTML = `
                <div class="rp-sync-modal__backdrop"></div>
                <form class="rp-sync-modal__panel rp-sync-password-panel">
                    <div class="rp-sync-modal__header">
                        <div><div class="rp-sync-modal__eyebrow">云端访问</div><h3 class="rp-sync-modal__title">同步密码</h3></div>
                        <button type="button" class="rp-sync-modal__close" aria-label="关闭">×</button>
                    </div>
                    <p class="rp-sync-modal__intro">请输入访问密码。</p>
                    <label class="rp-sync-password-field"><span>密码</span><input type="password" autocomplete="current-password" placeholder="请输入同步密码"></label>
                    <p class="rp-sync-password-status" aria-live="polite"></p>
                    <div class="rp-sync-modal__actions"><button type="submit" class="rp-sync-modal__button is-primary">继续</button></div>
                </form>
            `;
            document.body.append(passwordModalRoot);
            passwordInput = passwordModalRoot.querySelector('input');
            passwordStatus = passwordModalRoot.querySelector('.rp-sync-password-status');
            passwordSubmitButton = passwordModalRoot.querySelector('[type="submit"]');
            passwordModalRoot.querySelector('.rp-sync-modal__close').addEventListener('click', () => passwordModalRoot.classList.remove('is-open'));
            passwordModalRoot.addEventListener('submit', async event => {
                event.preventDefault();
                if (checkingPassword) return;
                const value = passwordInput.value;
                if (!value) { passwordStatus.textContent = '请输入同步密码。'; passwordInput.focus(); return; }
                checkingPassword = true;
                passwordSubmitButton.disabled = true;
                passwordStatus.textContent = '验证中…';
                const old = localStorage.getItem(K.password);
                localStorage.setItem(K.password, value);
                try {
                    const auth = await post({ action: 'auth-status' });
                    if (!auth.authenticated) throw C.fail('密码不正确。');
                    passwordStatus.textContent = '';
                    passwordModalRoot.classList.remove('is-open');
                    activate();
                } catch (error) {
                    if (old !== null) localStorage.setItem(K.password, old); else localStorage.removeItem(K.password);
                    passwordStatus.textContent = error.message;
                } finally { checkingPassword = false; passwordSubmitButton.disabled = false; }
            });
        }
        passwordModalRoot.classList.add('is-open');
        passwordInput.focus();
    }
    function submitLockPassword() {
        if (checkingPassword) return;
        const value = lockFormInput.value;
        if (!value) { lockFormError.textContent = '请输入访问密码。'; lockFormInput.focus(); return; }
        checkingPassword = true;
        lockFormSubmit.disabled = true;
        lockFormSubmit.classList.add('is-busy');
        lockFormError.textContent = '';
        const old = localStorage.getItem(K.password);
        localStorage.setItem(K.password, value);
        post({ action: 'auth-status' }).then(auth => {
            if (!auth.authenticated) throw C.fail('密码不正确。');
            lockOverlay.classList.add('is-leaving');
            const leaving = lockOverlay;
            lockOverlay = null;
            setTimeout(() => { leaving.remove(); if (lockBody) lockBody.style.overflow = lockBodyOverflow; }, 240);
            if (submitGateResolve) { submitGateResolve(); submitGateResolve = null; }
            activate();
        }).catch(error => {
            if (old !== null) localStorage.setItem(K.password, old); else localStorage.removeItem(K.password);
            lockFormError.textContent = error.message;
            lockOverlay.classList.remove('is-error');
            void lockOverlay.offsetWidth;
            lockOverlay.classList.add('is-error');
        }).finally(() => { checkingPassword = false; lockFormSubmit.disabled = false; lockFormSubmit.classList.remove('is-busy'); lockFormInput.focus(); });
    }
    let submitGateResolve = null;
    function openAccessGate(introText) {
        if (lockOverlay) { if (lockIntro) lockIntro.textContent = introText; return; }
        ensureStyle('rp-sync-lock-style', LOCK_STYLE_TEXT);
        const overlay = document.createElement('div');
        overlay.className = 'rp-sync-lock';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-label', '访问验证');
        overlay.innerHTML = `
            <div class="rp-sync-lock__card">
                <div class="rp-sync-lock__badge">${LOCK_BADGE_SVG}</div>
                <h1 class="rp-sync-lock__title">访问验证</h1>
                <p class="rp-sync-lock__intro"></p>
                <form class="rp-sync-lock__form">
                    <label class="rp-sync-lock__field">
                        <input type="password" autocomplete="current-password" aria-label="访问密码" placeholder="请输入访问密码">
                        <button type="button" class="rp-sync-lock__toggle" aria-label="显示密码"></button>
                    </label>
                    <p class="rp-sync-lock__error" aria-live="polite"></p>
                    <button type="submit" class="rp-sync-lock__submit"><span class="rp-sync-lock__spinner"></span><span>解锁</span></button>
                </form>
            </div>
        `;
        lockIntro = overlay.querySelector('.rp-sync-lock__intro');
        lockFormInput = overlay.querySelector('input');
        lockFormError = overlay.querySelector('.rp-sync-lock__error');
        lockFormSubmit = overlay.querySelector('.rp-sync-lock__submit');
        const toggle = overlay.querySelector('.rp-sync-lock__toggle');
        toggle.innerHTML = LOCK_EYE_SVG;
        toggle.addEventListener('click', () => {
            const reveal = lockFormInput.type === 'password';
            lockFormInput.type = reveal ? 'text' : 'password';
            toggle.innerHTML = reveal ? LOCK_EYE_OFF_SVG : LOCK_EYE_SVG;
            toggle.setAttribute('aria-label', reveal ? '隐藏密码' : '显示密码');
            lockFormInput.focus();
        });
        overlay.querySelector('form').addEventListener('submit', event => { event.preventDefault(); submitLockPassword(); });
        document.body.append(overlay);
        lockOverlay = overlay;
        lockBody = document.body;
        lockBodyOverflow = lockBody.style.overflow || '';
        lockBody.style.overflow = 'hidden';
        setTimeout(() => { try { lockFormInput.focus(); } catch { /* 焦点失败不致命 */ } }, 50);
        accessGateDone = new Promise(resolve => { submitGateResolve = resolve; });
    }
        async function handleSyncButtonClick() {
        await accessGateDone;
        if (checkingPassword) return;
        openSyncPanel();
    }
    async function start() {
        ensureModal();
        try {
            const auth = await post({ action: 'auth-status' });
            if (auth.authRequired && !auth.authenticated) { openAccessGate('此站点已开启访问密码。'); return; }
        } catch {
            if (P.restorePage) { modalRoot.classList.add('is-open', 'is-error'); progress(0, '网络不可用，请刷新重试。'); return; }
        }
        activate();
    }
    function activate() {
        if (P.restorePage) { if (!running) operate('pull').catch(() => {}); return; }
        if (activated) return;
        activated = true;
        remaining = minutes() * 60000; autoTick(); schedulePrepare(3000);
        window.addEventListener('rphub:dirty', () => schedulePrepare());
        document.addEventListener('visibilitychange', () => { lastActive = performance.now(); if (document.visibilityState !== 'hidden') schedulePrepare(1000); });
    }
    // 确定性模拟直接使用正式入口，无源码改写或测试专用替身。
    globalThis.RPSync = Object.freeze({ prepare, operate, getState: () => ({ ...ui }) });
    window.RPH_R2_OPEN_SYNC = handleSyncButtonClick;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { start().catch(e => progress(0, e.message)); }, { once: true });
    else start().catch(e => progress(0, e.message));
})();

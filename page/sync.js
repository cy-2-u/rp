// 云同步：源记录为增量单位，分片缓存与消费水位同事务提交。
(function () {
    'use strict';
    const P = RPClient, C = RPCore, K = C.KEYS;
    const DB = 'RPHubSyncNext', VERSION = 1;
    let running = null, preparing = null, prepareTimer, autoTimer, activated = false, lastActive = performance.now(), remaining = 0;
    let panel, status, bar, badge, autoInput, minutesInput, passwordForm;
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
        if (status) status.textContent = text;
        if (bar) bar.value = value;
        if (P.restorePage && panel) { const retry = panel.querySelector('[data-action="retry"]'); if (retry) retry.disabled = ui.busy; }
        if (panel) panel.querySelectorAll('[data-action="push"],[data-action="rebuild"]').forEach(el => { el.disabled = ui.busy; });
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
                const send = async packs => C.pool(packs, 6, async p => {
                    const bytes = await readCache(db, 'packs', p.checksum);
                    if (!bytes || bytes.length !== p.length || await C.hash(bytes) !== p.checksum) throw C.fail('本地分片缓存损坏，请重建索引。');
                    const query = new URLSearchParams({ checksum: p.checksum, length: String(p.length), entries: String(p.entries) });
                    await request('/api/rp-sync/pack?' + query, { method: 'PUT', headers: { 'content-type': 'application/gzip' }, body: bytes });
                });
                progress(40, '正在上传分片…');
                await send(snapshot.packs.filter(p => !known.has(p.checksum)));
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
            const tx = db.transaction(['sources', 'state'], 'readwrite'); tx.objectStore('sources').clear(); tx.objectStore('state').clear(); await P.txDone(tx);
            localStorage.removeItem(K.active);
            return '恢复完成';
        } finally { db.close(); }
    }
    function lastResult(ok) {
        const value = { at: Date.now(), ok };
        localStorage.setItem('rp_hub_sync_last_result_v1', JSON.stringify(value));
        if (badge) badge.textContent = new Date(value.at).toLocaleString('zh-CN') + (ok ? ' 同步成功' : ' 同步失败');
    }
    async function operate(kind, automatic = false) {
        if (running) return running;
        ui.busy = true; ui.automatic = automatic;
        progress(5, automatic ? '正在自动上传…' : '准备中…');
        running = (async () => {
            try {
                if (preparing) await preparing;
                const result = await exclusive(async () => kind === 'pull' ? download() : kind === 'rebuild' ? (await buildSnapshot(true), '本地索引已重建') : upload(automatic));
                progress(100, result); lastResult(true);
                if (kind === 'pull') location.replace('/');
            } catch (e) { progress(ui.progress, e.message); lastResult(false); if (e.status === 401) showPassword(); throw e; }
            finally { running = null; ui.busy = false; progress(ui.progress, ui.text); remaining = minutes() * 60000; }
        })();
        return running;
    }
    function schedulePrepare(delay = 8000) {
        clearTimeout(prepareTimer);
        if (P.restorePage) return;
        prepareTimer = setTimeout(() => { if (!running && document.visibilityState !== 'hidden') prepare().catch(e => progress(0, '后台准备：' + e.message)); }, delay);
    }
    const enabled = () => localStorage.getItem('rp_hub_sync_auto_save_enabled_v1') === '1';
    const minutes = () => Math.max(1, Math.min(1440, Number(localStorage.getItem('rp_hub_sync_auto_save_minutes_v1')) || 5));
    function autoTick() {
        clearTimeout(autoTimer);
        const now = performance.now(), elapsed = now - lastActive;
        if (document.visibilityState !== 'hidden' && elapsed >= 0 && elapsed < 35000 && !running) remaining -= elapsed;
        lastActive = now;
        if (enabled() && remaining <= 0 && document.visibilityState !== 'hidden' && !running) operate('push', true).catch(() => {});
        autoTimer = setTimeout(autoTick, 30000);
    }
    function showPassword() {
        if (!passwordForm) {
            passwordForm = document.createElement('dialog'); passwordForm.className = 'rp-dialog';
            passwordForm.innerHTML = '<form><h2>访问验证</h2><p>请输入同步密码。</p><input type="password" autocomplete="current-password" aria-label="同步密码" required><p role="status"></p><button>继续</button></form>';
            document.body.append(passwordForm);
            passwordForm.querySelector('form').onsubmit = async e => {
                e.preventDefault();
                const input = passwordForm.querySelector('input'), old = localStorage.getItem(K.password);
                localStorage.setItem(K.password, input.value);
                try { const auth = await post({ action: 'auth-status' }); if (!auth.authenticated) throw C.fail('密码不正确。'); passwordForm.close(); activate(); }
                catch (error) { if (old !== null) localStorage.setItem(K.password, old); else localStorage.removeItem(K.password); passwordForm.querySelector('[role="status"]').textContent = error.message; }
            };
        }
        passwordForm.showModal();
    }
    function installUi() {
        const style = document.createElement('style');
        style.textContent = '.rp-dialog{border:1px solid #e2e8f0;border-radius:16px;padding:22px;width:min(90vw,410px);color:#334155;background:#fff;font:14px/1.6 system-ui;box-sizing:border-box}.rp-dialog::backdrop{background:#0f172a66;backdrop-filter:blur(4px)}.rp-dialog h2{font-size:19px;margin:0 0 16px}.rp-dialog button{border:1px solid #cbd5e1;border-radius:9px;padding:9px 12px;background:#f8fafc;color:#1d4ed8;cursor:pointer}.rp-dialog button:disabled{opacity:.5;cursor:wait}.rp-dialog nav{display:flex;gap:8px;flex-wrap:wrap}.rp-dialog progress{width:100%;height:12px}.rp-dialog input{max-width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:7px}.rp-dialog input[type=number]{width:60px}.rp-dialog small{display:block;color:#64748b}.rp-dialog .rp-auto{margin:16px 0;background:#f8fafc;padding:10px;border-radius:9px}';
        document.head.append(style);
        panel = document.createElement('dialog'); panel.className = 'rp-dialog';
        panel.innerHTML = '<h2>云同步</h2><nav><button data-action="push">上传到云端</button><button data-action="pull">从云端恢复</button><button data-action="close">关闭</button></nav><div class="rp-auto"><label><input type="checkbox" data-action="auto"> 自动保存</label>　<label>间隔 <input type="number" min="1" max="1440" data-action="minutes"> 分钟</label></div><p role="status" aria-live="polite"></p><progress max="100" value="0"></progress><small></small><details><summary>维护</summary><button data-action="rebuild">重建本地索引</button></details>';
        document.body.append(panel);
        status = panel.querySelector('[role="status"]'); bar = panel.querySelector('progress'); badge = panel.querySelector('small');
        autoInput = panel.querySelector('[data-action="auto"]'); minutesInput = panel.querySelector('[data-action="minutes"]');
        autoInput.checked = enabled(); minutesInput.value = minutes();
        autoInput.onchange = () => { localStorage.setItem('rp_hub_sync_auto_save_enabled_v1', autoInput.checked ? '1' : '0'); remaining = minutes() * 60000; };
        minutesInput.onchange = () => { const value = Number(minutesInput.value); if (!Number.isInteger(value) || value < 1 || value > 1440) { minutesInput.value = minutes(); return; } localStorage.setItem('rp_hub_sync_auto_save_minutes_v1', String(value)); remaining = value * 60000; };
        panel.onclick = async e => {
            const action = e.target.closest('[data-action]')?.dataset.action;
            if (action === 'close') { if (!ui.busy || ui.automatic) panel.close(); }
            if (action === 'retry' && !running) operate('pull').catch(() => {});
            if (action === 'push' || action === 'rebuild') operate(action).catch(() => {});
            if (action === 'pull') {
                if (ui.automatic && running) { const notice = document.createElement('dialog'); notice.className = 'rp-dialog'; notice.innerHTML = '<h2>请稍后</h2><p>正在自动上传，请稍后。</p><form method="dialog"><button>知道了</button></form>'; document.body.append(notice); notice.addEventListener('close', () => notice.remove(), { once: true }); notice.showModal(); }
                else if (!running) {
                    let local = '';
                    try { const dirty = await P.dirty(); if (dirty.stores.size || dirty.intents.length) local = '（本地有未上传的修改，恢复后会丢弃）'; }
                    catch { /* 状态探测失败不阻塞恢复入口 */ }
                    if (confirm('从云端恢复会替换本地数据' + local + '，继续吗？')) location.replace('/sync-restore');
                }
            }
        };
        panel.oncancel = e => { if (ui.busy && !ui.automatic) e.preventDefault(); };
        window.RPH_R2_OPEN_SYNC = () => { if (!panel.open) panel.showModal(); progress(ui.progress, ui.text); };
        progress(0, ui.text);
        if (P.restorePage) {
            panel.showModal(); panel.querySelector('nav').innerHTML = '<button data-action="retry">重试恢复</button>';
            panel.querySelector('.rp-auto').hidden = true; panel.querySelector('details').hidden = true;
        }
    }
    async function start() {
        installUi();
        try { const auth = await post({ action: 'auth-status' }); if (!auth.authenticated) { showPassword(); return; } }
        catch { if (P.restorePage) { progress(0, '网络不可用，请刷新重试。'); return; } }
        activate();
    }
    function activate() {
        if (P.restorePage) { operate('pull').catch(() => {}); return; }
        if (activated) return;
        activated = true;
        remaining = minutes() * 60000; autoTick(); schedulePrepare(3000);
        window.addEventListener('rphub:dirty', () => schedulePrepare());
        document.addEventListener('visibilitychange', () => { lastActive = performance.now(); if (document.visibilityState !== 'hidden') schedulePrepare(1000); });
    }
    // 确定性模拟直接使用正式入口，无源码改写或测试专用替身。
    globalThis.RPSync = Object.freeze({ prepare, operate, getState: () => ({ ...ui }) });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { start().catch(e => progress(0, e.message)); }, { once: true });
    else start().catch(e => progress(0, e.message));
})();

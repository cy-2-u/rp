// 图片任务与固定记录；聊天使用原图，图库独立维护缩略图。
(function () {
    'use strict';
    const E = window.RPHubExternal, P = window.RPClient;
    if (!E || E.version !== 2 || !P) return;
    const prefix = 'rp_hub_image_renders_', tasks = new Map(), writes = new Set(), retired = new Set(), failures = new Map();
    const params = ['tag', 'model', 'artist', 'size', 'steps', 'scale', 'cfg', 'sampler', 'negative', 'nocache', 'noise_schedule'];
    function hash(text) {
        let value = 2166136261;
        for (const ch of String(text || '').split('')) { value ^= ch.charCodeAt(0); value = Math.imul(value, 16777619); }
        return (value >>> 0).toString(16);
    }
    const recordKey = r => [encodeURIComponent(r.storyScopeId || 'main'), r.messageId || (r.messageIndex != null ? 'index:' + r.messageIndex : r.contentHash || 'message'), r.occurrenceIndex || 0, r.promptHash || hash(r.prompt)].join(':');
    const open = () => P.open('RPHubDB', db => { if (!db.objectStoreNames.contains('store')) db.createObjectStore('store'); });
    async function records(id) {
        const db = await open();
        try { const tx = db.transaction('store', 'readonly'), r = tx.objectStore('store').get(prefix + id); return await P.txDone(tx, () => Array.isArray(r.result) ? r.result : []); }
        finally { db.close(); }
    }
    async function save(id, record, previous) {
        if (retired.has(id)) return;
        const db = await open();
        try {
            const tx = db.transaction('store', 'readwrite'), store = tx.objectStore('store'), r = store.get(prefix + id);
            r.onsuccess = () => {
                if (retired.has(id)) return;
                const list = Array.isArray(r.result) ? r.result : [];
                const next = list.filter(item => recordKey(item) !== record.key && recordKey(item) !== previous?.key);
                next.push(record); store.put(next, prefix + id);
            };
            await P.txDone(tx);
        } finally { db.close(); }
    }
    function publish(task, job) {
        task.job = job;
        for (const card of task.cards) {
            if (!card.isConnected) { task.cards.delete(card); continue; }
            card.hidden = Boolean(job.suppressed);
            task.render(card, task, job);
            let warning = card.querySelector('[data-rp-image-save-error]');
            if (job.storageError && !warning) { warning = document.createElement('small'); warning.dataset.rpImageSaveError = ''; warning.className = 'magic-image-save-warning'; card.append(warning); }
            if (warning) { if (job.storageError) warning.textContent = '固定记录未保存，请勿刷新'; else warning.remove(); }
        }
        return job;
    }
    function prune() {
        for (const [slot, task] of tasks) {
            for (const card of task.cards) if (!card.isConnected) task.cards.delete(card);
            if (tasks.size <= 128) break;
            if (task.job.status === 'running' || task.cards.size) continue;
            if (task.objectUrl) URL.revokeObjectURL(task.objectUrl);
            tasks.delete(slot);
        }
    }
    async function run(task, input) {
        const source = new URL(input.requestUrl, location.href), descriptor = E.describeCard(input.card);
        if (!descriptor || retired.has(input.characterId)) return publish(task, { status: 'done', suppressed: true });
        const prompt = (source.searchParams.get('tag') || '').trim();
        const record = { storyScopeId: input.storyScopeId || 'main', messageId: String(input.message?.id || ''), messageIndex: descriptor.messageIndex, contentHash: hash(input.message?.content || prompt), occurrenceIndex: descriptor.occurrenceIndex, prompt, promptHash: hash(prompt), paramsSnapshot: {}, imageKey: '' };
        record.key = recordKey(record);
        const list = await records(input.characterId);
        const previous = list.find(item => recordKey(item) === record.key) || (input.fresh ? list.findLast(item => (item.storyScopeId || 'main') === record.storyScopeId && (record.messageId ? item.messageId === record.messageId : item.messageIndex === record.messageIndex) && item.occurrenceIndex === record.occurrenceIndex) : null);
        if (previous && (!input.fresh || input.autoImageGen === false)) {
            const url = previous.imageKey ? '/api/rp-image?key=' + encodeURIComponent(previous.imageKey) : restoreUrl(previous, input.characterName);
            return publish(task, { status: 'done', imageUrl: url });
        }
        if (input.autoImageGen === false) return publish(task, { status: 'done', suppressed: true });
        const url = new URL('/api/rp-image', location.origin);
        for (const name of params) if (source.searchParams.has(name)) url.searchParams.set(name, source.searchParams.get(name));
        const token = source.searchParams.get('token') || input.imageGenKey || '';
        if (token.toUpperCase().startsWith('YNAI-') && localStorage.getItem('rp_hub_magic_ynai_model')) url.searchParams.set('model', localStorage.getItem('rp_hub_magic_ynai_model'));
        url.searchParams.set('character_name', input.characterName || '未命名角色');
        if (input.fresh) url.searchParams.set('reroll_nonce', crypto.randomUUID());
        for (const [name, value] of url.searchParams) if (name !== 'token' && name !== 'tag') record.paramsSnapshot[name === 'character_name' ? 'characterName' : name === 'reroll_nonce' ? 'rerollNonce' : name] = value;
        url.searchParams.set('token', token);
        const response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(300000) });
        if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.error || '生图失败：HTTP ' + response.status); }
        const blob = await response.blob();
        if (!blob.size) throw new Error('生图服务返回空图片。');
        if (retired.has(input.characterId) || tasks.get(task.slot) !== task) return { status: 'done', suppressed: true };
        record.imageKey = decodeURIComponent(response.headers.get('x-rp-image-key') || '');
        task.objectUrl = URL.createObjectURL(blob);
        const job = { status: 'done', imageUrl: task.objectUrl, imageKey: record.imageKey };
        if (localStorage.getItem('rp_hub_magic_fixed_image') !== '0') {
            try { await save(input.characterId, record, previous); failures.delete(task.slot); }
            catch (e) { failures.set(task.slot, { id: input.characterId, record, previous, error: e }); job.storageError = true; }
        }
        return publish(task, job);
    }
    function restoreUrl(record, characterName) {
        const url = new URL('/api/rp-image', location.origin);
        url.searchParams.set('tag', record.prompt || '');
        for (const [name, value] of Object.entries(record.paramsSnapshot || {})) if (name !== 'token') url.searchParams.set(name === 'characterName' ? 'character_name' : name === 'rerollNonce' ? 'reroll_nonce' : name, value);
        if (!url.searchParams.has('character_name')) url.searchParams.set('character_name', characterName || '未命名角色');
        return url.href;
    }
    E.register('image-request', input => {
        const descriptor = E.describeCard(input.card);
        const slot = JSON.stringify([input.characterId, input.storyScopeId || 'main', input.message?.id || descriptor?.messageIndex, descriptor?.occurrenceIndex]);
        const existing = tasks.get(slot);
        if (!input.fresh && existing && existing.requestUrl === input.requestUrl && existing.job.status !== 'failed' && (!existing.job.suppressed || input.autoImageGen === false)) { existing.cards.add(input.card); existing.render = input.render; queueMicrotask(() => publish(existing, existing.job)); return existing; }
        const task = { slot, characterId: input.characterId, requestUrl: input.requestUrl, cards: new Set([input.card]), render: input.render, job: { status: 'running' }, objectUrl: '', promise: null };
        tasks.set(slot, task);
        task.promise = run(task, input).catch(e => publish(task, { status: 'failed', error: e.message })).finally(prune);
        writes.add(task.promise); task.promise.finally(() => writes.delete(task.promise));
        return task;
    });
    E.register('character-deleted', async id => {
        retired.add(String(id));
        for (const [slot, task] of tasks) if (task.characterId === id) { if (task.objectUrl) URL.revokeObjectURL(task.objectUrl); tasks.delete(slot); failures.delete(slot); }
        const db = await open();
        try { const tx = db.transaction('store', 'readwrite'); tx.objectStore('store').delete(prefix + id); await P.txDone(tx); }
        finally { db.close(); }
    });
    window.RPH_MAGIC_FLUSH_IMAGES = async () => {
        while (writes.size) await Promise.all([...writes]);
        for (const [slot, item] of failures) { await save(item.id, item.record, item.previous); failures.delete(slot); const task = tasks.get(slot); if (task) publish(task, { ...task.job, storageError: false }); }
    };
    window.addEventListener('pagehide', () => { for (const task of tasks.values()) if (task.objectUrl) URL.revokeObjectURL(task.objectUrl); });
    E.installUi();
})();

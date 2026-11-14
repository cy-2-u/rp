// 外部适配契约 v2。作者变化集中修改 ANCHORS；聊天卡片恒显原图。
(function () {
    'use strict';
    if (window.RPHubExternal) return;
    const ANCHORS = {
        version: 'author-2026-11', root: '#app', storage: 'RPHubStorage',
        save: ['_memorySettingsSaveTimer', 'debouncedCharacterSave', 'debouncedSave', 'scheduleChatHistorySave'],
        card: '.generated-image-card[data-image-request]', row: '[data-chat-index]', reroll: '.generated-image-reroll', label: '.generated-image-progress-label',
        user: '.app-navigation-user', nav: '.app-navigation-grid', settings: '沉浸模式', model: '生图版本', input: 'textarea.chat-input-scrollbar', chat: '.chat-view-root > .flex-1.overflow-y-auto'
    };
    let Vue;
    const hooks = new Map(), timers = new Map(), writes = new Set(), errors = new Map(), markers = new Set();
    const nativeTimer = window.setTimeout.bind(window), nativeClear = window.clearTimeout.bind(window);
    let setup = false, scope = false, state, storage, mounted = false, pendingMounts = 0, startupError, revision = 0, chatSave, preferences;
    const unref = value => Vue?.unref(value);
    const get = name => unref(state?.[name]);
    function scoped(fn) { const before = scope; scope = true; try { return fn(); } finally { scope = before; } }
    window.setTimeout = function (callback, ms, ...args) {
        if (!scope || typeof callback !== 'function') return nativeTimer(callback, ms, ...args);
        let id;
        const run = () => { nativeClear(id); timers.delete(id); revision++; return scoped(() => callback(...args)); };
        id = nativeTimer(run, ms); timers.set(id, run); revision++; return id;
    };
    window.clearTimeout = function (id) { timers.delete(id); return nativeClear(id); };
    function track(key, work) {
        revision++;
        const p = Promise.resolve().then(work); writes.add(p);
        p.then(() => errors.delete(key), e => errors.set(key, e)).finally(() => { writes.delete(p); revision++; });
        return p;
    }
    function wrap(original) {
        if (!original || original === storage) return original;
        const next = { ...original };
        if (original.getStoredValue) next.getStoredValue = async name => {
            const value = await original.getStoredValue(name);
            if (name === 'settings' && !mounted && value) preferences = { stream: value.stream, temperature: value.temperature };
            return value;
        };
        if (original.setStoredValue) next.setStoredValue = (name, value, options) => track(name, () => original.setStoredValue(name, value, options));
        if (original.deleteStoredValue) next.deleteStoredValue = name => track('delete:' + name, () => original.deleteStoredValue(name));
        if (original.setScopedStoredValue) next.setScopedStoredValue = (name, id, value, options) => track(name + ':' + id, () => original.setScopedStoredValue(name, id, value, options));
        if (original.deleteScopedStoredValue) next.deleteScopedStoredValue = (name, id) => track('delete:' + name + ':' + id, async () => {
            if (name === 'branches') await hooks.get('character-deleted')?.(id);
            return original.deleteScopedStoredValue(name, id);
        });
        storage = Object.freeze(next); return storage;
    }
    let exported = wrap(window[ANCHORS.storage]);
    Object.defineProperty(window, ANCHORS.storage, { configurable: true, get: () => exported, set(value) { exported = wrap(value); } });
    function context(card) {
        const row = card?.closest(ANCHORS.row), index = Number(row?.dataset.chatIndex);
        const character = get('currentCharacter'), branch = get('currentStoryBranch'), history = get('chatHistory');
        if (!row || !Number.isInteger(index) || !character?.uuid || !branch?.id || !history?.[index]) return null;
        return { characterId: character.uuid, characterName: character.name || '', storyScopeId: branch.id, message: history[index], messageIndex: index, autoImageGen: get('worldInfo')?.length ? get('isAutoImageGenEnabled') : undefined, imageGenKey: String(get('settings')?.imageGenKey || ''), busy: Boolean(get('isConversationBusy')) };
    }
    function describeCard(card) { const row = card?.closest(ANCHORS.row); return row ? { messageIndex: Number(row.dataset.chatIndex), occurrenceIndex: [...row.querySelectorAll(ANCHORS.card)].indexOf(card) } : null; }
    // 产品决策：聊天只显示原图；缩略图仅用于图库，勿回退聊天缩略图方案。
    const deferred = new WeakMap();
    const imageObserver = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
        for (const entry of entries) if (entry.isIntersecting) { const src = deferred.get(entry.target); if (src) entry.target.src = src; imageObserver.unobserve(entry.target); }
    }, { rootMargin: '300px' }) : null;
    function render(card, task, job) {
        if (!card.isConnected) { task.cards.delete(card); return; }
        card.dataset.imageJobState = job.status;
        card.classList.toggle('is-generating', job.status === 'running');
        const button = card.querySelector(ANCHORS.reroll); if (button) button.disabled = job.status === 'running';
        const label = card.querySelector(ANCHORS.label); if (label) label.textContent = job.error || (job.status === 'done' ? '' : '生成中');
        if (job.imageUrl) {
            const img = card.querySelector('img');
            if (img) { img.loading = 'lazy'; img.decoding = 'async'; if (imageObserver) { deferred.set(img, job.imageUrl); imageObserver.observe(img); } else img.src = job.imageUrl; }
        }
    }
    function load(card, requestUrl = card.dataset.imageRequest, fresh = false) {
        const current = context(card), handler = hooks.get('image-request');
        if (!current || !handler || !requestUrl) return;
        const url = new URL(requestUrl, location.href);
        if (!url.searchParams.get('token')) url.searchParams.set('token', current.imageGenKey);
        card.style.aspectRatio = { '横图': '1216/832', '方图': '1' }[url.searchParams.get('size')] || '832/1216';
        const task = handler({ card, requestUrl: url.href, fresh, ...current, render });
        task.cards.add(card); card.dataset.imageJobState = 'loading'; return task.promise;
    }
    function hydrate(root) {
        if (root?.matches?.(ANCHORS.card)) { if (!root.dataset.imageJobState) load(root); return; }
        root?.querySelectorAll?.(ANCHORS.card).forEach(card => { if (!card.dataset.imageJobState) load(card); });
    }
    function installVue(value) {
        if (!value || typeof value.createApp !== 'function' || Vue) return;
        Vue = value;
        const { watch, createApp, onMounted } = Vue;
        Vue.createApp = function (options, ...args) {
            if (!options?.setup || state) return createApp(options, ...args);
            const original = options.setup;
            return createApp({ ...options, setup(...params) { setup = true; try { state = original(...params); return state; } finally { setup = false; } } }, ...args);
        };
        Vue.watch = function (source, callback, options) {
            if (!setup || typeof callback !== 'function') return watch(source, callback, options);
            const text = Function.prototype.toString.call(callback), marker = ANCHORS.save.find(key => text.includes(key));
            if (marker) {
                markers.add(marker);
                if (marker === 'scheduleChatHistorySave') chatSave = () => scoped(() => callback());
                return watch(source, (...args) => scoped(() => callback(...args)), options);
            }
            return watch(source, (...args) => {
                if (state && source === state.chatContainer) {
                    const Original = window.MutationObserver;
                    window.MutationObserver = class extends Original { constructor(fn) { super((records, observer) => { for (const r of records) r.addedNodes.forEach(hydrate); fn(records, observer); }); } };
                    try { hydrate(args[0]); return callback(...args); } finally { window.MutationObserver = Original; }
                }
                return callback(...args);
            }, options);
        };
        Vue.onMounted = function (fn, target) {
            if (!setup) return onMounted(fn, target);
            pendingMounts++;
            return onMounted(async (...args) => { try { await fn(...args); if (preferences && get('settings')) Object.assign(get('settings'), preferences); if (--pendingMounts === 0) mounted = true; } catch (e) { startupError = e; throw e; } }, target);
        };
    }
    installVue(window.Vue);
    if (!Vue) {
        let pendingVue;
        Object.defineProperty(window, 'Vue', { configurable: true, get: () => pendingVue, set(value) {
            pendingVue = value;
            if (typeof value?.createApp === 'function') installVue(value);
            else queueMicrotask(() => installVue(value));
            Object.defineProperty(window, 'Vue', { configurable: true, writable: true, value });
        } });
    }
    async function flush() {
        if (!mounted || startupError || !storage || ANCHORS.save.some(key => !markers.has(key))) return { ok: false, reason: '作者保存链路未就绪，请检查适配脚本。' };
        if (get('isConversationBusy') || get('storyBranchSwitching') || Number(get('switchingCharacterIndex')) >= 0) return { ok: false, reason: '请等待生成或角色切换完成。' };
        for (let pass = 0; pass < 32; pass++) {
            await Vue.nextTick(); const before = revision;
            for (const run of [...timers.values()]) run();
            await Promise.allSettled([...writes]); await window.RPH_SYNC_TRACKER?.flush(); await Vue.nextTick();
            if (revision === before && !writes.size && !timers.size) return errors.size ? { ok: false, reason: '作者数据保存失败，请重试保存。' } : { ok: true };
        }
        return { ok: false, reason: '作者数据仍在变化，请稍后重试。' };
    }
    let started = false, scheduled = false, observer, modelToken = '', modelLoading = false, modelRetryAt = 0, modelList = [];
    const FIXED = 'rp_hub_magic_fixed_image', MODEL = 'rp_hub_magic_ynai_model';
    function button(text, fn, className = '') { const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.className = className; b.onclick = fn; return b; }
    async function updateModels(select, control) {
        const token = external.imageKey(), ynai = token.toUpperCase().startsWith('YNAI-');
        select.hidden = !ynai; control.hidden = ynai;
        if (!ynai) return;
        if (modelToken !== token) { modelToken = token; modelList = []; modelRetryAt = 0; }
        if (!modelList.length && !modelLoading && Date.now() >= modelRetryAt) {
            modelLoading = true; const expected = token;
            try {
                const r = await fetch('/api/rp-image-models', { headers: { 'x-rp-image-token': token }, signal: AbortSignal.timeout(30000) });
                const payload = await r.json();
                if (!r.ok || !payload.data?.length) throw new Error('模型列表无效');
                if (external.imageKey() !== expected) return;
                modelList = payload.data.filter(m => m.id);
            } catch { modelRetryAt = Date.now() + 60000; }
            finally { modelLoading = false; }
        }
        const models = modelList.length ? modelList : [{ id: 'nai-diffusion-4-5-full' }];
        const signature = models.map(m => m.id).join('\n');
        if (select.dataset.models !== signature) {
            select.replaceChildren(...models.map(m => { const option = document.createElement('option'); option.value = m.id; option.textContent = m.label || m.id; return option; }));
            select.dataset.models = signature;
            select.value = models.some(m => m.id === localStorage.getItem(MODEL)) ? localStorage.getItem(MODEL) : models[0].id;
            localStorage.setItem(MODEL, select.value);
        }
    }
    function reconcile() {
        observer?.disconnect();
        try {
            const user = document.querySelector(ANCHORS.user);
            if (user && !user.querySelector('[data-rp-sync]')) { const b = button('同步', () => window.RPH_R2_OPEN_SYNC?.()); b.dataset.rpSync = ''; user.append(b); }
            const nav = document.querySelector(ANCHORS.nav);
            if (nav && !nav.querySelector('[data-rp-gallery]')) { const b = button('图片管理', () => { location.href = '/image'; }, 'app-navigation-item'); b.dataset.rpGallery = ''; nav.append(b); }
            const labels = [...document.querySelectorAll('label')];
            const anchor = labels.filter(l => l.textContent.includes(ANCHORS.settings)).at(-1);
            const grid = anchor?.closest('.grid');
            if (grid && !grid.querySelector('[data-rp-fixed]')) {
                const label = document.createElement('label'); label.dataset.rpFixed = ''; label.className = 'settings-toggle-row'; label.textContent = '固定生图';
                const input = document.createElement('input'); input.type = 'checkbox'; input.checked = localStorage.getItem(FIXED) !== '0'; input.onchange = () => localStorage.setItem(FIXED, input.checked ? '1' : '0'); label.append(input); grid.append(label);
            }
            const modelLabel = labels.find(l => l.textContent.trim() === ANCHORS.model);
            if (modelLabel) {
                const box = modelLabel.parentElement, control = [...box.children].find(el => el !== modelLabel && !el.matches('[data-rp-model]') && el.querySelector('button.settings-control'));
                if (control) {
                    let select = box.querySelector('[data-rp-model]');
                    if (!select) { select = document.createElement('select'); select.dataset.rpModel = ''; select.className = 'settings-control'; select.onchange = () => localStorage.setItem(MODEL, select.value); box.append(select); }
                    updateModels(select, control).catch(() => {});
                }
            }
            const input = document.querySelector(ANCHORS.input), area = input?.closest('.input-area-mobile');
            if (area && !area.querySelector('[data-rp-scroll]')) { const b = button('↓', () => { const chat = document.querySelector(ANCHORS.chat); chat?.scrollTo({ top: chat.scrollHeight, behavior: 'smooth' }); }); b.dataset.rpScroll = ''; b.title = '滚动到底部'; area.prepend(b); }
        } finally { observer?.observe(document.querySelector(ANCHORS.root) || document.body, { childList: true, subtree: true }); }
    }
    function installUi() {
        if (started) return; started = true;
        const start = () => {
            observer = new MutationObserver(() => { if (scheduled) return; scheduled = true; requestAnimationFrame(() => { scheduled = false; reconcile(); }); });
            reconcile();
        };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
    }
    document.addEventListener('click', async event => {
        const b = event.target.closest?.(ANCHORS.reroll), card = b?.closest(ANCHORS.card), current = context(card);
        if (!b || !current || !hooks.has('image-request')) return;
        event.preventDefault(); event.stopImmediatePropagation();
        if (b.disabled || current.busy) return;
        const original = String(current.message.content || ''), index = describeCard(card).occurrenceIndex;
        const match = window.RPHubCardUtils?.findUnprotectedMatches(original, window.RPHubUtils?.getImageTagRegex())?.[index];
        if (!match || !chatSave) return;
        const tags = match[1].split(',').map(t => t.trim()).filter(Boolean);
        if (tags.length < 2) return;
        const i = Math.floor(Math.random() * (tags.length - 1)); [tags[i], tags[i + 1]] = [tags[i + 1], tags[i]];
        const url = new URL(card.dataset.imageRequest, location.href); url.searchParams.set('tag', tags.join(', '));
        b.disabled = true;
        try {
            const result = await load(card, url.href, true), latest = context(card);
            if (result?.status === 'done' && current.autoImageGen !== false && latest?.characterId === current.characterId && latest.storyScopeId === current.storyScopeId && latest.message === current.message && current.message.content === original) { current.message.content = original.slice(0, match.index) + 'image###' + tags.join(', ') + '###' + original.slice(match.index + match[0].length); chatSave(); }
        } finally { b.disabled = false; }
    }, true);
    const external = {
        version: 2, anchors: ANCHORS.version, flush, context, describeCard, installUi,
        imageKey: () => String(get('settings')?.imageGenKey || ''),
        register(name, handler) { hooks.set(name, handler); return () => { if (hooks.get(name) === handler) hooks.delete(name); }; },
        capabilities() { const missing = ANCHORS.save.filter(key => !markers.has(key)); if (!mounted) missing.push('mounted'); if (!storage) missing.push('storage'); return { flush: !missing.length, images: Boolean(state && hooks.has('image-request')), missing }; },
        status() { return { version: 2, anchors: ANCHORS.version, mounted, storage: Boolean(storage), startupError: startupError?.message || '', saveWatchers: Object.fromEntries(ANCHORS.save.map(key => [key, markers.has(key)])) }; }
    };
    window.RPHubExternal = external;
})();

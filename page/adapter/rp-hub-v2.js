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
    let started = false, modelToken = '', modelLoading = false, modelRetryAt = 0, modelList = [];
    const FIXED = 'rp_hub_magic_fixed_image', MODEL = 'rp_hub_magic_ynai_model';
    // 设置行/聊天浮层的锚点值与 v2 版锚点表一致（作者行样式类原样沿用）。
    const UI = {
        navContent: '.app-navigation-content', navSection: '.app-navigation-section', navHeading: '常用',
        settingsRowClass: 'settings-toggle-row group',
        settingsTextClass: 'text-sm font-medium text-gray-600 group-hover:text-gray-900 transition-colors',
        toggleWrapClass: 'relative inline-flex flex-none items-center', toggleClass: 'settings-toggle',
        chatRow: '.input-island', chatArea: '.input-area-mobile'
    };
    const textOf = node => String(node?.textContent || '').replace(/\s+/g, ' ').trim();
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
    function installStyle() {
        if (document.getElementById('magic-extension-style')) return;
        const style = document.createElement('style');
        style.id = 'magic-extension-style';
        style.textContent = [
            '.magic-extension-button{display:inline-flex;align-items:center;justify-content:center;gap:4px;border:1px solid rgba(148,163,184,.35);background:rgba(255,255,255,.92);color:#475569;border-radius:9px;padding:5px 8px;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;transition:.15s}',
            '.magic-extension-button:hover{color:#2563eb;background:#eff6ff}',
            '.magic-extension-button svg{width:14px;height:14px;flex:none}',
            '.magic-extension-actions{display:flex;align-items:center;gap:4px;margin-left:auto}',
            '.app-navigation-user .magic-extension-actions{display:flex;align-items:center;gap:4px;margin-left:auto}',
            '.magic-image-nav{margin-top:4px}',
            '.magic-image-nav svg{flex:none}',
            '.magic-image-nav span{white-space:nowrap;overflow:hidden}',
            '.app-navigation-item.magic-image-nav{display:flex;align-items:center;gap:.65rem;width:100%;text-align:left}',
            '.app-navigation-item.magic-image-nav .magic-image-nav-icon{display:inline-flex;align-items:center;justify-content:center;flex:none;width:1.5rem;height:1.5rem}',
            '.magic-fixed-image-toggle{display:flex;align-items:center;justify-content:space-between;gap:12px}',
            '.magic-fixed-image-toggle input{accent-color:#4f46e5}',
            '.magic-scroll-button{position:absolute;left:50%;top:-2.75rem;z-index:30;display:none;width:2.25rem;height:2.25rem;padding:0;pointer-events:auto;align-items:center;justify-content:center;border:1px solid #e5e7eb;border-radius:999px;transform:translateX(-50%);background:rgba(255,255,255,.95);color:#6b7280;box-shadow:0 10px 15px -3px rgba(15,23,42,.12),0 4px 6px -4px rgba(15,23,42,.12);backdrop-filter:blur(12px);cursor:pointer;transition:all .15s}',
            '.magic-scroll-button:hover{color:#4f46e5;border-color:#c7d2fe}',
            '.magic-scroll-button:active{transform:translateX(-50%) scale(.95)}',
            '.magic-scroll-button svg{width:1rem;height:1rem}',
            '.magic-scroll-button.is-visible{display:flex}',
            '.magic-scroll-sentinel{width:1px;height:1px;pointer-events:none}',
            '.magic-image-save-warning{position:absolute;bottom:8px;left:8px;right:8px;padding:5px 8px;border-radius:6px;background:#fff7ed;color:#9a3412;font-size:12px}',
            '.generated-image-card.is-generating ' + ANCHORS.reroll + '{opacity:.45;pointer-events:none}'
        ].join('');
        document.head.append(style);
    }
    function installSidebarActions() {
        const userCard = document.querySelector(ANCHORS.user);
        if (!userCard || userCard.querySelector('.magic-extension-actions')) return;
        const actions = document.createElement('div');
        actions.className = 'magic-extension-actions';
        const syncButton = document.createElement('button');
        syncButton.type = 'button';
        syncButton.className = 'magic-extension-button';
        syncButton.title = '同步';
        syncButton.setAttribute('aria-label', '同步');
        syncButton.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8.1 8.1 0 0 0-14.9-4L3 10"></path><path d="M3 4v6h6"></path><path d="M4 13a8.1 8.1 0 0 0 14.9 4L21 14"></path><path d="M21 20v-6h-6"></path></svg><span>同步</span>';
        syncButton.addEventListener('click', () => window.RPH_R2_OPEN_SYNC?.());
        actions.append(syncButton);
        userCard.append(actions);
    }
    function installImageNav() {
        const content = document.querySelector(UI.navContent);
        if (!content) return;
        const section = [...content.querySelectorAll(UI.navSection)].find(item => textOf(item.querySelector('h1,h2,h3,[role="heading"]') || item).includes(UI.navHeading));
        const grid = section?.querySelector(ANCHORS.nav);
        if (!grid || grid.querySelector('.magic-image-nav')) return;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'app-navigation-item magic-image-nav';
        button.title = '图片管理';
        button.setAttribute('aria-label', '图片管理');
        button.innerHTML = '<span class="app-navigation-icon magic-image-nav-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5zm3 10 3-3 2 2 2-2 3 3M8 8h.01"></path></svg></span><span>图片管理</span>';
        button.addEventListener('click', () => { location.href = '/image'; });
        const settingsButton = [...grid.querySelectorAll('.app-navigation-item')].find(item => textOf(item).includes('设置'));
        grid.insertBefore(button, settingsButton || null);
    }
    function installFixedImageSetting() {
        const labels = [...document.querySelectorAll('label')].filter(l => l.textContent.includes(ANCHORS.settings));
        const label = labels[labels.length - 1] || null;
        const grid = label?.closest('.grid');
        if (!grid) return null;
        if (grid.querySelector('.magic-fixed-image-toggle .magic-fixed-image-input')) return grid;
        const row = document.createElement('label');
        row.className = 'magic-fixed-image-toggle ' + UI.settingsRowClass;
        row.innerHTML = '<span class="' + UI.settingsTextClass + '">固定生图</span><span class="' + UI.toggleWrapClass + '"><input type="checkbox" class="magic-fixed-image-input settings-toggle-input sr-only"><span class="' + UI.toggleClass + '"></span></span>';
        const input = row.querySelector('input');
        input.checked = localStorage.getItem(FIXED) !== '0';
        input.addEventListener('change', () => localStorage.setItem(FIXED, input.checked ? '1' : '0'));
        grid.insertBefore(row, label);
        return grid;
    }
    let scrollContainer, scrollButtonNode, scrollSentinelNode, scrollObserver;
    function resetScrollNodes(button) {
        scrollObserver?.disconnect();
        scrollObserver = null;
        scrollContainer = null;
        scrollButtonNode = null;
        scrollSentinelNode = null;
        if (button) button.classList.remove('is-visible');
    }
    function installScrollButton() {
        const input = document.querySelector(ANCHORS.input);
        const inputRow = input?.closest(UI.chatRow);
        const inputArea = input?.closest(UI.chatArea) || inputRow?.parentElement;
        if (!inputRow || !inputArea) { resetScrollNodes(); return; }
        let button = inputArea.querySelector('.magic-scroll-button') || inputRow.querySelector('.magic-scroll-button');
        if (!button) {
            button = document.createElement('button');
            button.type = 'button';
            button.className = 'magic-scroll-button';
            button.title = '滚动到底部';
            button.setAttribute('aria-label', '滚动到底部');
            button.innerHTML = '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>';
            button.addEventListener('click', () => scrollContainer?.scrollTo({ top: scrollContainer.scrollHeight, behavior: 'smooth' }));
        }
        if (button.parentElement !== inputArea) inputArea.prepend(button);
        const chatView = inputRow.closest('.chat-view-root');
        const container = chatView ? chatView.querySelector(ANCHORS.chat) : null;
        if (!container) { resetScrollNodes(button); return; }
        let sentinel = container.querySelector(':scope > .magic-scroll-sentinel');
        if (!sentinel) {
            sentinel = document.createElement('div');
            sentinel.className = 'magic-scroll-sentinel';
            sentinel.setAttribute('aria-hidden', 'true');
            container.append(sentinel);
        }
        if (scrollContainer === container && scrollButtonNode === button && scrollSentinelNode === sentinel) return;
        resetScrollNodes();
        scrollContainer = container;
        scrollButtonNode = button;
        scrollSentinelNode = sentinel;
        scrollObserver = new IntersectionObserver(entries => {
            const entry = entries[entries.length - 1];
            scrollButtonNode?.classList.toggle('is-visible', !entry?.isIntersecting);
        }, { root: scrollContainer, rootMargin: '0px 0px 120px 0px', threshold: 0 });
        scrollObserver.observe(sentinel);
    }
    // 观察目标与 v2 一致：#app 开 subtree 覆盖条件渲染视图；固定生图网格、
    // 聊天输入行只看直接子节点变化，避免全页 subtree 开销。
    let reconcileScheduled = false;
    const uiObserver = new MutationObserver(() => {
        if (reconcileScheduled) return;
        reconcileScheduled = true;
        requestAnimationFrame(() => { reconcileScheduled = false; reconcile(); });
    });
    function observeUiTargets(fixedGrid) {
        uiObserver.disconnect();
        // body 必须在列：作者的导航抽屉经 Vue teleport 挂在 #app 之外。
        const targets = new Set([document.body, document.querySelector(ANCHORS.root) || null, fixedGrid || null, document.querySelector(ANCHORS.input)?.closest(UI.chatRow) || null].filter(Boolean));
        for (const target of targets) {
            let subtree = false;
            try { subtree = target.matches?.(ANCHORS.root) || false; } catch { subtree = false; }
            uiObserver.observe(target, { childList: true, subtree });
        }
    }
    function reconcile() {
        uiObserver.disconnect();
        // 每步独立兜底：条件渲染视图未挂载时单步拿不到锚点，任何一步异常
        // 都不允许炸断后续安装与观察者挂载。
        let fixedGrid = null;
        const steps = [
            () => installStyle(),
            () => installSidebarActions(),
            () => installImageNav(),
            () => { fixedGrid = installFixedImageSetting(); },
            () => {
                const labels = [...document.querySelectorAll('label')];
                const modelLabel = labels.find(l => l.textContent.trim() === ANCHORS.model);
                if (!modelLabel) return;
                const box = modelLabel.parentElement, control = [...box.children].find(el => el !== modelLabel && !el.matches('[data-rp-model]') && el.querySelector('button.settings-control'));
                if (!control) return;
                let select = box.querySelector('[data-rp-model]');
                if (!select) { select = document.createElement('select'); select.dataset.rpModel = ''; select.className = 'settings-control'; select.onchange = () => localStorage.setItem(MODEL, select.value); box.append(select); }
                updateModels(select, control).catch(() => {});
            },
            () => installScrollButton()
        ];
        for (const step of steps) { try { step(); } catch { /* 单步失败不阻塞其余安装 */ } }
        observeUiTargets(fixedGrid);
    }
    function installUi() {
        if (started) return; started = true;
        const start = () => {
            reconcile();
            // 作者导航抽屉开合是短窗口条件渲染（开→外部点击即关），触发器
            // 点击后立即+延迟各补装一轮，窗口内完成按钮注入。
            document.addEventListener('click', event => {
                if (!event.target.closest?.('.app-nav-trigger')) return;
                requestAnimationFrame(reconcile);
                window.setTimeout(reconcile, 250);
            }, true);
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

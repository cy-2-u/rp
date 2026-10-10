/* RPHUB_ADAPTER_CONFIG
{
  "schema": 2,
  "id": "rp-hub",
  "image": {
    "ynai": {
      "base": "https://nai.rinko.ai",
      "modelsPath": "/v1/models",
      "generatePath": "/v1/images/generations",
      "defaultModel": "nai-diffusion-4-5-full"
    }
  },
  "ui": {
    "navigation": {
      "mode": "section-grid",
      "content": ".app-navigation-content",
      "section": ".app-navigation-section",
      "sectionHeading": "常用",
      "grid": ".app-navigation-grid",
      "item": ".app-navigation-item",
      "insertBeforeLabel": "设置",
      "user": ".app-navigation-user",
      "buttonClass": "app-navigation-item",
      "iconClass": "app-navigation-icon"
    },
    "settings": {
      "labelSelector": "label",
      "labelText": "沉浸模式",
      "occurrence": "last",
      "anchorParentSelector": ".grid",
      "insert": "before",
      "modelLabel": "生图版本",
      "rowClass": "settings-toggle-row group",
      "textClass": "text-sm font-medium text-gray-600 group-hover:text-gray-900 transition-colors",
      "toggleWrapClass": "relative inline-flex flex-none items-center",
      "toggleClass": "settings-toggle"
    },
    "chat": {
      "input": "textarea.chat-input-scrollbar",
      "row": ".input-island",
      "area": ".input-area-mobile",
      "container": ".chat-view-root > .flex-1.overflow-y-auto"
    },
    "images": {
      "card": ".generated-image-card[data-image-request]",
      "row": "[data-chat-index]",
      "reroll": ".generated-image-reroll"
    }
  },
  "features": {
    "sync": true,
    "images": true,
    "navigation": true,
    "settings": true,
    "scroll": true,
    "preserveSettings": true
  },
  "capabilities": {
    "runtime": "vue3-setup-v1",
    "root": "#app"
  }
}
*/
(function () {
    'use strict';
    if (window.RPHubExternal) return;
    const config = window.RPHUB_PAGE_ADAPTER;
    const nativeTimer = window.setTimeout.bind(window);
    const nativeClear = window.clearTimeout.bind(window);
    const pendingTimers = new Map();
    const pendingWrites = new Set();
    const failedWrites = new Map();
    const hooks = new Map();
    const saveWatchers = new Set();
    let timerScope = false;
    let setupScope = false;
    let state = null;
    let scheduleChatSave = null;
    let storage = null;
    let mounted = false;
    let startupFailed = false;
    let savedPreferences = null;
    let revision = 0;
    let pendingMounts = 0;
    let transactionFailure = null;
    const nativeTransaction = window.IDBDatabase?.prototype.transaction;
    if (nativeTransaction) window.IDBDatabase.prototype.transaction = function (...args) {
        const tx = nativeTransaction.apply(this, args);
        if (this.name === 'RPHubDB' && args[1] === 'readwrite') {
            const done = new Promise(resolve => {
                tx.addEventListener('complete', resolve, { once: true });
                tx.addEventListener('abort', () => { transactionFailure = tx.error || new Error('保存事务中止'); resolve(); }, { once: true });
            });
            pendingWrites.add(done);
            done.then(() => { pendingWrites.delete(done); revision++; });
        }
        return tx;
    }
    const enabled = name => config.features?.[name] !== false;
    const value = ref => window.Vue?.unref(ref);
    const emit = (name, detail) => window.dispatchEvent(new CustomEvent(`rphub:${name}`, { detail }));
    const scoped = fn => {
        const previous = timerScope;
        timerScope = true;
        try { return fn(); } finally { timerScope = previous; }
    };
    window.setTimeout = function (callback, delay, ...args) {
        if (!timerScope || typeof callback !== 'function') return nativeTimer(callback, delay, ...args);
        let id;
        const run = () => {
            nativeClear(id);
            pendingTimers.delete(id);
            revision++;
            return scoped(() => callback(...args));
        };
        id = nativeTimer(run, delay);
        pendingTimers.set(id, run);
        revision++;
        return id;
    };
    window.clearTimeout = function (id) {
        pendingTimers.delete(id);
        return nativeClear(id);
    };
    const trackWrite = (key, fn) => {
        revision++;
        const promise = Promise.resolve().then(fn);
        pendingWrites.add(promise);
        promise.then(() => { failedWrites.delete(key); pendingWrites.delete(promise); revision++; }, error => {
            failedWrites.set(key, error);
            pendingWrites.delete(promise);
            revision++;
        });
        return promise;
    };
    const preservePreferences = () => {
        if (!enabled('preserveSettings') || !state || !savedPreferences) return;
        const settings = value(state.settings);
        for (const key of ['stream', 'temperature']) {
            if (Object.hasOwn(savedPreferences, key)) settings[key] = savedPreferences[key];
        }
    };
    const wrapStorage = original => {
        if (!original || storage) return original;
        const wrapped = { ...original };
        wrapped.getStoredValue = async name => {
            const result = await original.getStoredValue(name);
            if (name === 'settings' && !mounted && result) savedPreferences = Object.fromEntries(
                ['stream', 'temperature'].filter(key => Object.hasOwn(result, key)).map(key => [key, result[key]])
            );
            return result;
        };
        wrapped.setStoredValue = (name, data, options) => {
            if (name === 'settings' && !mounted) preservePreferences();
            return trackWrite(name, () => original.setStoredValue(name, data, options));
        };
        wrapped.setScopedStoredValue = (name, id, data, options) => trackWrite(`${name}:${id}`, () => original.setScopedStoredValue(name, id, data, options));
        wrapped.deleteScopedStoredValue = (name, id) => trackWrite(`delete:${name}:${id}`, async () => {
            if (name === 'branches') await hooks.get('character-deleted')?.(id);
            await original.deleteScopedStoredValue(name, id);
            if (name === 'branches') await original.deleteScopedStoredValue('image_renders', id);
        });
        wrapped.deleteStorageKeys = (db, keys) => {
            const extra = keys.filter(key => String(key).startsWith('rp_hub_branches_'))
                .map(key => String(key).replace('rp_hub_branches_', 'rp_hub_image_renders_'));
            return trackWrite('delete-keys', () => original.deleteStorageKeys(db, [...new Set([...keys, ...extra])]));
        };
        storage = wrapped;
        return Object.freeze(wrapped);
    };
    let storageExport = window.RPHubStorage;
    Object.defineProperty(window, 'RPHubStorage', {
        configurable: true,
        get: () => storageExport,
        set: next => { storageExport = wrapStorage(next); }
    });
    if (storageExport) storageExport = wrapStorage(storageExport);
    let composables = window.RPHubComposables;
    const wrapComposables = original => original && ({
        ...original,
        useStorageManagement(options) {
            if (Array.isArray(options.scopedStorageNames) && !options.scopedStorageNames.includes('image_renders')) {
                options.scopedStorageNames.push('image_renders');
            }
            return original.useStorageManagement(options);
        }
    });
    Object.defineProperty(window, 'RPHubComposables', {
        configurable: true, get: () => composables,
        set: next => { composables = wrapComposables(next); }
    });
    if (composables) composables = wrapComposables(composables);

    const imageUi = config.ui?.images || {};
    const context = card => {
        if (!state || !imageUi.row) return null;
        const character = value(state.currentCharacter);
        const branch = value(state.currentStoryBranch);
        const history = value(state.chatHistory);
        const row = card?.closest?.(imageUi.row);
        const index = Number(row?.dataset.chatIndex);
        if (!character?.uuid || !branch?.id || !Array.isArray(history) || !row || !Number.isInteger(index) || !history[index]) return null;
        return {
            characterId: character.uuid, characterName: character.name || '',
            storyScopeId: branch.id, message: history[index], messageIndex: index,
            autoImageGen: value(state.worldInfo)?.length && state.isAutoImageGenEnabled !== undefined ? Boolean(value(state.isAutoImageGenEnabled)) : undefined,
            imageGenKey: String(value(state.settings)?.imageGenKey || ''),
            busy: Boolean(value(state.isConversationBusy))
        };
    };
    const renderImage = (card, task, job) => {
        if (!card?.isConnected) return task.cards?.delete(card);
        card.dataset.imageJobState = job.status;
        card.classList.toggle('is-generating', !['done', 'failed'].includes(job.status));
        card.classList.toggle('is-generation-error', job.status === 'failed');
        if (job.imageUrl) {
            const image = card.querySelector('img');
            if (image) { image.style.height = '100%'; image.src = new URL(job.imageUrl, task.baseUrl || location.href).href; }
        }
        const label = card.querySelector('.generated-image-progress-label');
        if (label) label.textContent = job.error || (job.status === 'done' ? '' : '生成中');
        emit('image-rendered', { card, status: job.status });
    };
    const loadCard = (card, requestUrl = card?.dataset.imageRequest, fresh = false) => {
        const handler = hooks.get('image-request');
        const current = context(card);
        if (!handler || !current || !requestUrl) return null;
        const url = new URL(requestUrl, location.href);
        if (!url.searchParams.get('token')) url.searchParams.set('token', current.imageGenKey);
        const task = handler({ card, requestUrl: url.href, fresh, ...current, render: renderImage });
        task.cards.add(card);
        card.dataset.imageJobState = 'loading';
        card.classList.add('is-generating');
        return task.promise;
    };
    const hydrate = root => {
        if (!enabled('images') || !imageUi.card || !imageUi.row) return;
        const cards = root?.matches?.(imageUi.card) ? [root] : [...(root?.querySelectorAll?.(imageUi.card) || [])];
        cards.forEach(card => { if (!card.dataset.imageJobState) loadCard(card); });
    };
    const vue = window.Vue;
    if (vue && config.capabilities?.runtime === 'vue3-setup-v1') {
        const createApp = vue.createApp;
        const watch = vue.watch;
        const onMounted = vue.onMounted;
        vue.watch = function (source, callback, options) {
            if (!setupScope || typeof callback !== 'function') return watch(source, callback, options);
            // 仅捕获当前适配版本的四种保存入口，其他动画、网络和轮询定时器保持原行为。
            const body = Function.prototype.toString.call(callback);
            const saveKind = ['_memorySettingsSaveTimer', 'debouncedCharacterSave', 'debouncedSave', 'scheduleChatHistorySave'].find(marker => body.includes(marker));
            if (saveKind) {
                saveWatchers.add(saveKind);
                if (saveKind === 'scheduleChatHistorySave') scheduleChatSave = () => scoped(() => callback());
                return watch(source, (...args) => scoped(() => callback(...args)), options);
            }
            return watch(source, (...args) => {
                if (state && source === state.chatContainer) {
                    const NativeObserver = window.MutationObserver;
                    window.MutationObserver = class extends NativeObserver {
                        constructor(fn) {
                            super((records, observer) => {
                                records.forEach(record => record.addedNodes.forEach(hydrate));
                                fn(records, observer);
                            });
                        }
                    };
                    try { hydrate(args[0]); return callback(...args); }
                    finally { window.MutationObserver = NativeObserver; }
                }
                return callback(...args);
            }, options);
        };
        vue.onMounted = function (callback, target) {
            if (!setupScope) return onMounted(callback, target);
            pendingMounts++;
            return onMounted(async (...args) => {
                try {
                    await callback(...args);
                    preservePreferences();
                    if (--pendingMounts === 0) {
                        mounted = true;
                        emit('ready', { version: 1 });
                    }
                } catch (error) { startupFailed = true; throw error; }
            }, target);
        };
        vue.createApp = function (options, ...args) {
            if (!options || typeof options.setup !== 'function' || state) return createApp(options, ...args);
            const original = options.setup;
            return createApp({ ...options, setup(...setupArgs) {
                setupScope = true;
                try {
                    state = original(...setupArgs);
                    return state;
                } finally { setupScope = false; }
            } }, ...args);
        };
    }
    const flush = async () => {
        if (!enabled('sync') || !mounted || startupFailed || !storage || saveWatchers.size !== 4) {
            throw new Error('作者保存接口未就绪，当前页面不能确认内存数据已保存。');
        }
        if (value(state.isConversationBusy) || value(state.storyBranchSwitching) || value(state.switchingCharacterIndex) >= 0) {
            throw new Error('请等待当前生成或角色切换完成后同步。');
        }
        await vue.nextTick();
        for (let pass = 0; pass < 32; pass++) {
            const before = revision;
            for (const run of [...pendingTimers.values()]) run();
            await Promise.allSettled([...pendingWrites]);
            await vue.nextTick();
            if (!pendingTimers.size && !pendingWrites.size && revision === before) {
                if (transactionFailure) throw new Error('作者数据保存失败，事务已中止；请保留当前页面的数据，排除存储故障后刷新再同步。');
                if (failedWrites.size) throw new Error('作者数据保存失败，请先重试保存再同步。');
                await window.RPH_SYNC_TRACKER?.flush();
                emit('flushed', { version: 1 });
                return;
            }
        }
        throw new Error('作者数据仍在变化，请稍后重试同步。');
    };
    const describeCard = card => {
        if (!imageUi.row || !imageUi.card) return null;
        const row = card?.closest?.(imageUi.row);
        if (!row) return null;
        return { messageIndex: Number(row.dataset.chatIndex), occurrenceIndex: [...row.querySelectorAll(imageUi.card)].indexOf(card) };
    };
    const external = {
        version: 1, config, flush, context, describeCard,
        register(name, handler) { hooks.set(name, handler); return () => { if (hooks.get(name) === handler) hooks.delete(name); }; },
        capabilities() { return { flush: enabled('sync') && mounted && !startupFailed && saveWatchers.size === 4, context: Boolean(state), images: Boolean(enabled('images') && imageUi.card && imageUi.row && state && hooks.has('image-request')) }; },
        imageKey: () => String(value(state?.settings)?.imageGenKey || ''),
        installUi: null
    };
    window.RPHubExternal = external;
    window.addEventListener('rphub:flush', event => { if (typeof event.detail?.respond === 'function') event.detail.respond(flush()); });
    document.addEventListener('click', async event => {
        if (!enabled('images') || !imageUi.reroll || !imageUi.card) return;
        const button = event.target.closest?.(imageUi.reroll);
        const card = button?.closest(imageUi.card);
        const current = context(card);
        if (!button || !current || !hooks.has('image-request')) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (current.busy || button.disabled) return;
        button.disabled = true;
        try {
            const original = String(current.message.content || '');
            const index = describeCard(card)?.occurrenceIndex;
            const matches = window.RPHubCardUtils?.findUnprotectedMatches(original, window.RPHubUtils.getImageTagRegex());
            const match = matches?.[index];
            if (!match || !scheduleChatSave) return;
            const tags = match[1].split(',').map(tag => tag.trim()).filter(Boolean);
            if (tags.length < 2) return;
            const swap = Math.floor(Math.random() * (tags.length - 1));
            [tags[swap], tags[swap + 1]] = [tags[swap + 1], tags[swap]];
            const url = new URL(card.dataset.imageRequest, location.href);
            url.searchParams.set('tag', tags.join(', '));
            url.searchParams.set('nocache', '1');
            const job = await loadCard(card, url.href, true);
            const latest = context(card);
            if (job?.status === 'done' && current.autoImageGen !== false && latest?.message === current.message
                && latest.characterId === current.characterId && latest.storyScopeId === current.storyScopeId
                && current.message.content === original) {
                current.message.content = original.slice(0, match.index) + `image###${tags.join(', ')}###` + original.slice(match.index + match[0].length);
                current.message.shouldAnimate = false;
                scheduleChatSave();
            }
        } finally { button.disabled = false; }
    }, true);
    emit('adapter', { version: 1, id: config.id });
    const activeAdapter = config;
    const uiConfig = () => config.ui || {};
    const navigationConfig = () => uiConfig().navigation || {};
    const settingsConfig = () => uiConfig().settings || {};
    const chatConfig = () => uiConfig().chat || {};
    const textOf = node => String(node?.textContent || '').replace(/\s+/g, ' ').trim();
    const FIXED_IMAGE_KEY = 'rp_hub_magic_fixed_image';
    const YNAI_MODEL_KEY = 'rp_hub_magic_ynai_model';
    const YNAI_MODEL_LIST_KEY = 'rp_hub_magic_ynai_models';
    const isYnaiToken = token => String(token || '').trim().toUpperCase().startsWith('YNAI-');
    const isFixedImageEnabled = () => localStorage.getItem(FIXED_IMAGE_KEY) !== '0';
    const addButton = (parent, label, onClick) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.className = 'magic-extension-button';
        button.addEventListener('click', onClick);
        parent.appendChild(button);
        return button;
    };

    const installStyle = () => {
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
            '.magic-image-suppressed{display:none!important}',
            '.magic-image-load-error{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:12px;background:#f8fafc;color:#64748b;font-size:14px}',
            '.magic-image-load-error button{padding:6px 10px;border:1px solid #cbd5e1;border-radius:8px;background:white;color:#2563eb;cursor:pointer}',
            '.magic-image-save-warning{position:absolute;bottom:8px;left:8px;right:8px;padding:5px 8px;border-radius:6px;background:#fff7ed;color:#9a3412;font-size:12px}'
        ].join('');
        document.head.appendChild(style);
    };

    const installSidebarActions = () => {
        const cfg = navigationConfig();
        const userSelector = cfg.user || '.app-navigation-user';
        // 作者新版导航是浮层（app-navigation-layer > .app-navigation-user），
        // 没有常驻侧栏；旧版的 .app-sidebar 回退分支已随之移除。
        const userCard = document.querySelector(userSelector);
        if (!userCard || userCard.querySelector('.magic-extension-actions')) return;
        const actions = document.createElement('div');
        actions.className = 'magic-extension-actions';
        const syncButton = addButton(actions, '同步', () => window.RPH_R2_OPEN_SYNC?.());
        syncButton.title = '同步';
        syncButton.setAttribute('aria-label', '同步');
        syncButton.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8.1 8.1 0 0 0-14.9-4L3 10"></path><path d="M3 4v6h6"></path><path d="M4 13a8.1 8.1 0 0 0 14.9 4L21 14"></path><path d="M21 20v-6h-6"></path></svg><span>同步</span>';
        userCard.appendChild(actions);
    };
    const installImageNav = () => {
        const cfg = navigationConfig();
        if (cfg.mode === 'section-grid') {
            const content = document.querySelector(cfg.content || '.app-navigation-content');
            if (!content) return;
            const sections = [...content.querySelectorAll(cfg.section || '.app-navigation-section')];
            const section = sections.find(item => {
                const heading = item.querySelector('h1,h2,h3,[role="heading"]');
                return !cfg.sectionHeading || textOf(heading || item).includes(String(cfg.sectionHeading));
            });
            const grid = section?.querySelector(cfg.grid || '.app-navigation-grid');
            if (!grid || grid.querySelector('.magic-image-nav')) return;
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `${cfg.buttonClass || 'app-navigation-item'} magic-image-nav`;
            button.title = '图片管理';
            button.setAttribute('aria-label', '图片管理');
            const iconClass = cfg.iconClass || 'app-navigation-icon';
            button.innerHTML = `<span class="${iconClass} magic-image-nav-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5zm3 10 3-3 2 2 2-2 3 3M8 8h.01"></path></svg></span><span>图片管理</span>`;
            button.addEventListener('click', () => { window.location.href = '/image'; });
            const itemSelector = cfg.item || '.app-navigation-item';
            const settingsButton = [...grid.querySelectorAll(itemSelector)]
                .find(item => textOf(item).includes(String(cfg.insertBeforeLabel || '设置')));
            grid.insertBefore(button, settingsButton || null);
            return;
        }
    };
    const findFixedImageAnchor = () => {
        const cfg = settingsConfig();
        const labels = cfg.labelSelector
            ? [...document.querySelectorAll(cfg.labelSelector)]
                .filter(label => textOf(label).includes(String(cfg.labelText || '沉浸模式')))
                .filter(label => cfg.anchorParentSelector ? label.closest(cfg.anchorParentSelector) : true)
            : [...document.querySelectorAll('label')]
                .filter(label => [...label.querySelectorAll('span')].some(span => span.textContent.trim() === '沉浸模式'));
        const label = labels[cfg.occurrence === 'last' ? labels.length - 1 : 0] || null;
        if (!label) return { grid: null, anchor: null };
        const grid = cfg.labelSelector
            ? label.closest(cfg.anchorParentSelector || 'div')
            : (label.parentElement?.classList.contains('grid') ? label.parentElement : null);
        if (!grid) return { grid: null, anchor: null };
        // 锚点可能是网格的嵌套后代；插入位相对锚点计算，作者调整设置项
        // 顺序不再改变“固定生图”的落点。
        let anchor = label;
        while (anchor && anchor.parentElement !== grid) anchor = anchor.parentElement;
        if (anchor?.parentElement !== grid) anchor = null;
        return { grid, anchor };
    };
    const installFixedImageSetting = () => {
        const cfg = settingsConfig();
        const { grid, anchor } = findFixedImageAnchor();
        // 设置视图是条件渲染：网格尚未挂载时先跳过，等观察者在网格出现后补装。
        if (!grid) return { grid: null, anchor: null };
        // 安装判定看开关行特有的 input：模型行复用同一个行类，但不能被当成开关本体
        if (grid.querySelector('.magic-fixed-image-toggle .magic-fixed-image-input')) return { grid, anchor };
        const label = document.createElement('label');
        // 行样式类全部来自适配层 ui.settings：作者改设置行样式时只更新适配 JSON。
        // 兜底值跟随作者当前设置行语义类，适配键缺失也不渲染裸样式。
        label.className = `magic-fixed-image-toggle ${cfg.rowClass || 'settings-toggle-row group'}`;
        label.innerHTML = `<span class="${cfg.textClass || 'text-sm font-medium text-gray-600 group-hover:text-gray-900 transition-colors'}">固定生图</span><span class="${cfg.toggleWrapClass || 'relative inline-flex flex-none items-center'}"><input type="checkbox" class="magic-fixed-image-input settings-toggle-input sr-only"><span class="${cfg.toggleClass || 'settings-toggle'}"></span></span>`;
        const input = label.querySelector('input');
        input.checked = isFixedImageEnabled();
        input.addEventListener('change', () => localStorage.setItem(FIXED_IMAGE_KEY, input.checked ? '1' : '0'));
        const insertAfter = cfg.insert === 'after';
        grid.insertBefore(label, anchor
            ? (insertAfter ? anchor.nextSibling : anchor)
            : (insertAfter ? grid.children[0]?.nextSibling || null : null));
        return { grid, anchor };
    };

    // YNAI 模型劫持：密钥为 YNAI- 时隐藏作者“生图版本”浮窗，原位放入同款样式的
    // 下拉，选项来自中转站模型列表（经 worker /api/rp-image-models 拉取），默认
    // 取云端 defaultModel（缺失回退 nai-diffusion-4-5-full）；选择存本地并在构建
    // 请求时覆盖 model 参数。
    // sta1n 密钥时移除劫持、还原作者浮窗。浮窗定位不写死 DOM 结构：按适配层
    // ui.settings.modelLabel 文本找到设置标签，再找同容器里的 custom-select 渲染根。
    const YNAI_SELECT_CLASS = 'magic-ynai-select';
    const ynaiSelectState = { key: '', checkedAt: 0, loading: false, loaded: false, failedAt: 0, models: null, renderedModels: null, renderedSelect: null };

    const readAuthorImageGenKey = () => external.imageKey();

    const readStoredYnaiModels = () => {
        try {
            const value = JSON.parse(localStorage.getItem(YNAI_MODEL_LIST_KEY) || 'null');
            return Array.isArray(value) ? value.filter(item => item?.id) : null;
        } catch (_) {
            return null;
        }
    };

    const ynaiDefaultModel = () => String(activeAdapter?.image?.ynai?.defaultModel || '');

    const findImageModelControl = () => {
        const labelText = String(settingsConfig().modelLabel || '生图版本');
        const labels = [...document.querySelectorAll('label.settings-label')]
            .filter(label => label.textContent.trim() === labelText);
        for (const label of labels) {
            const box = label.parentElement;
            if (!box) continue;
            const control = [...box.children].find(el => el !== label
                && !el.classList.contains(YNAI_SELECT_CLASS)
                && el.querySelector(':scope > button.settings-control'));
            if (control) return { box, control };
        }
        return null;
    };

    const renderYnaiSelectOptions = (select, models) => {
        select.textContent = '';
        for (const model of models) {
            const option = document.createElement('option');
            option.value = String(model.id);
            option.textContent = String(model.label || model.id);
            select.appendChild(option);
        }
        const current = String(localStorage.getItem(YNAI_MODEL_KEY) || '');
        const preferred = current && models.some(model => String(model.id) === current)
            ? current
            : (models.some(model => model.id === ynaiDefaultModel()) ? ynaiDefaultModel() : String(models[0].id));
        select.value = preferred;
        localStorage.setItem(YNAI_MODEL_KEY, preferred);
    };

    // ynai 模型列表拉取：30 秒超时；失败后退避（同 key 60 秒内不重发），
    // 避免 reconcile 每 4 秒对故障端点连续打请求。
    const YNAI_MODEL_FETCH_TIMEOUT_MS = 30_000;
    const YNAI_MODEL_FAILURE_BACKOFF_MS = 60_000;
    const fetchYnaiModels = async key => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), YNAI_MODEL_FETCH_TIMEOUT_MS);
        try {
            const response = await fetch('/api/rp-image-models', {
                headers: { 'x-rp-image-token': key.trim() },
                signal: controller.signal
            });
            const payload = await response.json().catch(() => null);
            const models = payload && Array.isArray(payload.data) ? payload.data.filter(item => item?.id) : [];
            if (!response.ok || !models.length) throw new Error(payload?.error || `HTTP ${response.status}`);
            return models;
        } catch (error) {
            ynaiSelectState.failedAt = Date.now();
            throw error;
        } finally {
            clearTimeout(timer);
        }
    };

    const applyYnaiModelHijack = async (box, control, select, force = false) => {
        const now = Date.now();
        if (!force && select === ynaiSelectState.renderedSelect && now - ynaiSelectState.checkedAt < 4000) return;
        ynaiSelectState.checkedAt = now;
        const key = readAuthorImageGenKey();
        const ynai = isYnaiToken(key);
        select.style.display = ynai ? '' : 'none';
        control.style.display = ynai ? 'none' : '';
        if (!ynai) return;
        if (ynaiSelectState.key !== key) {
            ynaiSelectState.loaded = false;
            ynaiSelectState.failedAt = 0;
            ynaiSelectState.models = readStoredYnaiModels();
        }
        if (ynaiSelectState.models) {
            // 选项未变化时跳过重建：渲染会清空重挂 <option> 并写 localStorage，
            // 不加守卫时每次 reconcile（≤4 秒节流）都触发一轮 mutation→reconcile 循环。
            if (ynaiSelectState.renderedModels !== ynaiSelectState.models || ynaiSelectState.renderedSelect !== select) {
                renderYnaiSelectOptions(select, ynaiSelectState.models);
                ynaiSelectState.renderedModels = ynaiSelectState.models;
                ynaiSelectState.renderedSelect = select;
            }
        }
        if (ynaiSelectState.loading || ynaiSelectState.loaded) return;
        // 上次拉取失败后 60 秒内静默跳过（缓存列表仍可显示）。
        if (ynaiSelectState.failedAt && now - ynaiSelectState.failedAt < YNAI_MODEL_FAILURE_BACKOFF_MS) return;
        ynaiSelectState.key = key;
        ynaiSelectState.loading = true;
        try {
            const models = await fetchYnaiModels(key);
            ynaiSelectState.models = models;
            ynaiSelectState.loaded = true;
            ynaiSelectState.failedAt = 0;
            ynaiSelectState.renderedModels = models;
            ynaiSelectState.renderedSelect = select;
            try { localStorage.setItem(YNAI_MODEL_LIST_KEY, JSON.stringify(models)); } catch (_) { }
            renderYnaiSelectOptions(select, models);
        } catch (_) {
            // 失败保持已有缓存/回退默认；failedAt 已记录，退避到期后 reconcile 重试。
        } finally {
            ynaiSelectState.loading = false;
        }
    };

    const installYnaiModelHijack = () => {
        const found = findImageModelControl();
        if (!found) return;
        const { box, control } = found;
        let select = box.querySelector(`.${YNAI_SELECT_CLASS}`);
        if (!select) {
            select = document.createElement('select');
            select.className = `${YNAI_SELECT_CLASS} settings-control`;
            select.style.display = 'none';
            control.after(select);
            select.addEventListener('change', () => {
                localStorage.setItem(YNAI_MODEL_KEY, String(select.value || ''));
            });
        }
        applyYnaiModelHijack(box, control, select);
    };

    let scrollContainer = null;
    let scrollButtonNode = null;
    let scrollSentinelNode = null;
    let scrollIntersectionObserver = null;
    const installScrollButton = () => {
        const cfg = chatConfig();
        const input = document.querySelector(cfg.input || 'textarea.chat-input-scrollbar');
        // row = 文本areas 所在行（作者新版为 .input-island），area = 按钮插入
        // 的浮层容器（作者新版为 .input-area-mobile）。两者都是真实祖先，
        // 不再取 parentElement 猜测层级。
        const inputRow = input?.closest(cfg.row || '.input-island');
        const inputArea = input?.closest(cfg.area || '.input-area-mobile')
            || inputRow?.parentElement;
        if (!inputRow || !inputArea) {
            scrollIntersectionObserver?.disconnect();
            scrollIntersectionObserver = null;
            scrollContainer = null;
            scrollButtonNode = null;
            scrollSentinelNode = null;
            return;
        }
        let button = inputArea.querySelector('.magic-scroll-button') || inputRow.querySelector('.magic-scroll-button');
        if (!button) {
            button = document.createElement('button');
            button.type = 'button';
            button.className = 'magic-scroll-button';
            button.title = '滚动到底部';
            button.setAttribute('aria-label', '滚动到底部');
            button.innerHTML = '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>';
            button.addEventListener('click', () => {
                scrollContainer?.scrollTo({ top: scrollContainer.scrollHeight, behavior: 'smooth' });
            });
        }
        if (button.parentElement !== inputArea) inputArea.prepend(button);
        const chatView = inputRow.closest('.chat-view-root');
        const container = chatView?.querySelector(cfg.container || ':scope > .flex-1.overflow-y-auto') || null;
        if (!container) {
            // 与上面的 inputRow/inputArea 早退分支同规格清理：容器消失时
            // 断开观察器并释放节点引用，否则旧 observer 会一直持有已被 Vue
            // 移除的 sentinel，回调作用在悬垂节点上。
            scrollIntersectionObserver?.disconnect();
            scrollIntersectionObserver = null;
            scrollContainer = null;
            scrollButtonNode = null;
            scrollSentinelNode = null;
            button.classList.remove('is-visible');
            return;
        }
        let sentinel = container.querySelector(':scope > .magic-scroll-sentinel');
        if (!sentinel) {
            sentinel = document.createElement('div');
            sentinel.className = 'magic-scroll-sentinel';
            sentinel.setAttribute('aria-hidden', 'true');
            container.appendChild(sentinel);
        }
        if (scrollContainer === container && scrollButtonNode === button && scrollSentinelNode === sentinel) return;
        scrollIntersectionObserver?.disconnect();
        scrollContainer = container;
        scrollButtonNode = button;
        scrollSentinelNode = sentinel;
        scrollIntersectionObserver = new IntersectionObserver(entries => {
            const entry = entries[entries.length - 1];
            scrollButtonNode?.classList.toggle('is-visible', !entry?.isIntersecting);
        }, { root: scrollContainer, rootMargin: '0px 0px 120px 0px', threshold: 0 });
        scrollIntersectionObserver.observe(sentinel);
    };

    let reconcileScheduled = false;
    const uiObserver = new MutationObserver(() => {
        if (reconcileScheduled) return;
        reconcileScheduled = true;
        requestAnimationFrame(() => {
            reconcileScheduled = false;
            reconcileUi();
        });
    });
    const observeUiTargets = fixedAnchor => {
        uiObserver.disconnect();
        const chatCfg = chatConfig();
        const targets = new Set([
            document.body,
            // #app 开 subtree，覆盖作者所有视图的条件渲染（含设置网格、
            // 导航浮层），因此各视图出现/消失都能触发补装。
            document.querySelector(config.capabilities?.root || '#app'),
            document.querySelector(navigationConfig().content || '.app-navigation-content'),
        document.querySelector('.app-main'),
        // #app 的子树观察已覆盖消息列表增删；滚动容器只用于
        // IntersectionObserver，不要再监听整段历史的每次 append。
        fixedAnchor?.grid || null,
        document.querySelector(chatCfg.input || 'textarea.chat-input-scrollbar')?.closest(chatCfg.row || '.input-island'),

        ].filter(Boolean));
        targets.forEach(target => {
            const subtree = target.matches?.(config.capabilities?.root || '#app')
                || target.matches?.(navigationConfig().content || '.app-navigation-content')
                || false;
            uiObserver.observe(target, { childList: true, subtree });
        });
    };
    function reconcileUi() {
        // 每步独立兜底：条件渲染的视图未挂载时单步可能拿不到锚点，
        // 任何一步异常都不允许炸断后续安装与观察者挂载，否则视图
        // 出现后无人补装（固定生图按钮永久消失正是这个链条断裂）。
        let fixedAnchor = null;
        const steps = [
            () => { if (enabled('sync')) installSidebarActions(); },
            () => { if (enabled('navigation')) installImageNav(); },
            () => { if (enabled('settings')) fixedAnchor = installFixedImageSetting(); },
            () => { if (enabled('settings')) installYnaiModelHijack(); },
            () => { if (enabled('scroll')) installScrollButton(); },
        ];
        for (const step of steps) {
            try { step(); } catch (_) { /* 单步失败不阻塞其余安装 */ }
        }
        observeUiTargets(fixedAnchor);
    }
    const start = () => {
        installStyle();
        reconcileUi();
        document.addEventListener('click', event => {
            // 作者新版导航触发器只有 .app-nav-trigger（旧的
            // .sidebar-nav-button / .advanced-nav-trigger 已不存在）。
            if (!event.target.closest?.('.app-nav-trigger')) return;
            requestAnimationFrame(reconcileUi);
            setTimeout(reconcileUi, 250);
        }, true);
    };

    external.installUi = () => {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
        else start();
    };

}());

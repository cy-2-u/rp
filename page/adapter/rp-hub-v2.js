// RP Hub 魔改版 - 外部适配脚本（部署兜底版）
//
// 这是实现 window.RPHubExternal v2 契约的【可执行代码】：作者页面的 DOM 锚点、
// Vue 桥接、保存定时器捕获、UI 注入全部集中在这里。系统侧（_worker.js /
// magic-extension.js / DB/bootstrap.js）只依赖契约，不依赖作者内部实现。
//
// 作者改版后的维护方式：更新 ANCHORS 锚点表与必要的桥接逻辑，把新版脚本
// 传到外部源（config.json 的 adapter.externalUrl）即可生效；本文件是外部
// 脚本缺失/加载失败时的部署兜底。规则：
//   - 锚点选择器/标记全部集中在 ANCHORS，逻辑与锚点表分离；
//   - UI 安装每步独立 try/catch，单步失败不拖垮其余步骤；
//   - 无法确认作者保存完成时 flush 拒绝并报原因（数据安全底线）；
//   - 探测不到上下文时返回 null，图片退化为无固定记录、同步不受影响。
(function () {
    'use strict';
    if (window.RPHubExternal) return;

    // ==================================================== ANCHORS 锚点表
    // 基准：作者 2026-10 快照（fixture commit 8403e875）。选择器写成候选
    // 数组：逐个尝试，第一个命中者生效，作者改类名时按序补新候选。
    const ANCHORS = {
        version: 'author-2026-10',
        features: { sync: true, images: true, navigation: true, settings: true, scroll: true, preserveSettings: true },
        runtime: { vueGlobal: 'Vue', root: '#app' },
        // Vue setup 返回状态的属性名（候选列表）。
        stateNames: {
            currentCharacter: ['currentCharacter'],
            currentStoryBranch: ['currentStoryBranch'],
            chatHistory: ['chatHistory'],
            worldInfo: ['worldInfo'],
            autoImageGen: ['isAutoImageGenEnabled'],
            settings: ['settings'],
            busy: ['isConversationBusy'],
            branchSwitching: ['storyBranchSwitching'],
            switchingCharacter: ['switchingCharacterIndex'],
            chatContainer: ['chatContainer']
        },
        // 作者存储层的全局导出名；wrapStorage 只包装实际存在的方法。
        storageGlobal: 'RPHubStorage',
        utilsGlobal: 'RPHubUtils',
        cardUtilsGlobal: 'RPHubCardUtils',
        // 保存 watcher 的函数文本标记：flush 的存在性门禁（作者改变保存
        // 机制时此处更新；缺失时 flush 拒绝并逐项报名）。
        saveMarkers: ['_memorySettingsSaveTimer', 'debouncedCharacterSave', 'debouncedSave', 'scheduleChatHistorySave'],
        navigation: {
            content: ['.app-navigation-content'],
            section: ['.app-navigation-section'],
            sectionHeading: '常用',
            grid: ['.app-navigation-grid'],
            item: ['.app-navigation-item'],
            insertBeforeLabel: '设置',
            user: ['.app-navigation-user'],
            trigger: ['.app-nav-trigger', '.sidebar-nav-button', '.advanced-nav-trigger'],
            buttonClass: 'app-navigation-item',
            iconClass: 'app-navigation-icon'
        },
        settings: {
            labelSelector: 'label',
            labelText: '沉浸模式',
            occurrence: 'last',
            anchorParentSelector: '.grid',
            insert: 'before',
            modelLabel: '生图版本',
            modelLabelSelector: 'label.settings-label',
            rowClass: 'settings-toggle-row group',
            textClass: 'text-sm font-medium text-gray-600 group-hover:text-gray-900 transition-colors',
            toggleWrapClass: 'relative inline-flex flex-none items-center',
            toggleClass: 'settings-toggle'
        },
        chat: {
            input: ['textarea.chat-input-scrollbar'],
            row: ['.input-island'],
            area: ['.input-area-mobile'],
            container: ['.chat-view-root > .flex-1.overflow-y-auto', ':scope > .flex-1.overflow-y-auto']
        },
        images: {
            card: ['.generated-image-card[data-image-request]'],
            row: ['[data-chat-index]'],
            reroll: ['.generated-image-reroll'],
            progressLabel: '.generated-image-progress-label'
        },
        // 与 page/config.json 的 image.ynai.defaultModel 保持一致的镜像值，
        // 仅用于模型列表加载失败时的下拉默认项。
        ynaiDefaultModel: 'nai-diffusion-4-5-full'
    };

    const enabled = name => ANCHORS.features[name] !== false;
    const value = ref => window.Vue?.unref(ref);
    // 候选选择器解析：逐个尝试，返回第一个命中元素。
    const pick = (candidates, root = document) => {
        for (const selector of candidates || []) {
            try {
                const found = root.querySelector(selector);
                if (found) return found;
            } catch (_) { /* 非法选择器跳过 */ }
        }
        return null;
    };
    const stateRef = name => {
        for (const key of ANCHORS.stateNames[name] || []) {
            if (state && state[key] !== undefined) return state[key];
        }
        return undefined;
    };

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

    // RPHubDB 写事务Revision 追踪：flush 的稳定判定依据（连同 pendingTimers
    // 与 wrapped storage 的写入 promise 一起构成"作者数据已落盘"的证据链）。
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
    };

    const trackWrite = (key, fn) => {
        revision++;
        const promise = Promise.resolve().then(fn);
        pendingWrites.add(promise);
        promise.then(() => { failedWrites.delete(key); pendingWrites.delete(promise); revision++; }, err => {
            failedWrites.set(key, err);
            pendingWrites.delete(promise);
            revision++;
        });
        return promise;
    };

    const preservePreferences = () => {
        if (!enabled('preserveSettings') || !state || !savedPreferences) return;
        const settings = value(stateRef('settings'));
        for (const key of ['stream', 'temperature']) {
            if (Object.hasOwn(savedPreferences, key)) settings[key] = savedPreferences[key];
        }
    };

    const wrapStorage = original => {
        if (!original || storage) return original;
        const wrapped = { ...original };
        // 作者存储层只包装确实存在的方法；作者新增/删除方法经 spread 透传。
        if (typeof original.getStoredValue === 'function') {
            wrapped.getStoredValue = async name => {
                const result = await original.getStoredValue(name);
                if (name === 'settings' && !mounted && result) savedPreferences = Object.fromEntries(
                    ['stream', 'temperature'].filter(key => Object.hasOwn(result, key)).map(key => [key, result[key]])
                );
                return result;
            };
        }
        if (typeof original.setStoredValue === 'function') {
            wrapped.setStoredValue = (name, data, options) => {
                if (name === 'settings' && !mounted) preservePreferences();
                return trackWrite(name, () => original.setStoredValue(name, data, options));
            };
        }
        if (typeof original.setScopedStoredValue === 'function') {
            wrapped.setScopedStoredValue = (name, id, data, options) => trackWrite(`${name}:${id}`, () => original.setScopedStoredValue(name, id, data, options));
        }
        if (typeof original.deleteScopedStoredValue === 'function') {
            wrapped.deleteScopedStoredValue = (name, id) => trackWrite(`delete:${name}:${id}`, async () => {
                if (name === 'branches') await hooks.get('character-deleted')?.(id);
                await original.deleteScopedStoredValue(name, id);
                if (name === 'branches') await original.deleteScopedStoredValue('image_renders', id);
            });
        }
        storage = wrapped;
        return Object.freeze(wrapped);
    };
    // 作者脚本可能在适配层之后才赋值 RPHubStorage：用 defineProperty 捕获赋值。
    let storageExport = window[ANCHORS.storageGlobal];
    Object.defineProperty(window, ANCHORS.storageGlobal, {
        configurable: true,
        get: () => storageExport,
        set: next => { storageExport = wrapStorage(next); }
    });
    if (storageExport) storageExport = wrapStorage(storageExport);

    // ---- 图片渲染与缩略图 ----
    const imageUi = ANCHORS.images;
    const context = card => {
        if (!state) return null;
        const character = value(stateRef('currentCharacter'));
        const branch = value(stateRef('currentStoryBranch'));
        const history = value(stateRef('chatHistory'));
        const row = card?.closest?.(pickSelector(imageUi.row));
        const index = Number(row?.dataset.chatIndex);
        if (!character?.uuid || !branch?.id || !Array.isArray(history) || !row || !Number.isInteger(index) || !history[index]) return null;
        const autoGenRef = stateRef('autoImageGen');
        const settings = value(stateRef('settings'));
        return {
            characterId: character.uuid, characterName: character.name || '',
            storyScopeId: branch.id, message: history[index], messageIndex: index,
            autoImageGen: value(stateRef('worldInfo'))?.length && autoGenRef !== undefined ? Boolean(value(autoGenRef)) : undefined,
            imageGenKey: String(settings?.imageGenKey || ''),
            busy: Boolean(value(stateRef('busy')))
        };
    };
    // 行选择器用于 closest：候选数组取第一个合法者。
    const pickSelector = candidates => {
        for (const selector of candidates || []) {
            try { document.createDocumentFragment().querySelector(selector); } catch (_) { continue; }
            return selector;
        }
        return '';
    };

    const imageObserver = typeof IntersectionObserver === 'function'
        ? new IntersectionObserver(entries => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                const image = entry.target;
                imageObserver.unobserve(image);
                const src = image.dataset.rphDeferredSrc;
                if (src) image.src = src;
            }
        }, { rootMargin: '300px' })
        : null;
    const setCardImageSource = (image, src) => {
        if (!image || !src) return;
        image.loading = 'lazy';
        image.decoding = 'async';
        image.setAttribute('loading', 'lazy');
        image.setAttribute('decoding', 'async');
        if (imageObserver) {
            image.dataset.rphDeferredSrc = src;
            imageObserver.observe(image);
        } else {
            delete image.dataset.rphDeferredSrc;
            image.src = src;
        }
    };
    const renderImage = (card, task, job) => {
        if (!card?.isConnected) return task.cards?.delete(card);
        card.dataset.imageJobState = job.status;
        card.classList.toggle('is-generating', !['done', 'failed'].includes(job.status));
        card.classList.toggle('is-generation-error', job.status === 'failed');
        if (job.imageUrl) {
            const image = card.querySelector('img');
            if (image) {
                image.style.height = '100%';
                // 聊天卡片恒显原图（用户决策）：懒加载 + 300px 预取距离控制
                // 滚动集中加载；缩略图体系归图库页自管（自带按需回填）。
                setCardImageSource(image, new URL(job.imageUrl, task.baseUrl || location.href).href);
            }
        }
        const label = card.querySelector(imageUi.progressLabel);
        if (label) label.textContent = job.error || (job.status === 'done' ? '' : '生成中');
        // 重掷按钮跟随卡片状态：生成中禁用避免并发重掷；成功/失败恢复可用。
        const rerollSelector = pickSelector(imageUi.reroll);
        const reroll = rerollSelector ? card.querySelector(rerollSelector) : null;
        if (reroll) reroll.disabled = !['done', 'failed'].includes(job.status);
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
        // 防塌陷：按请求 URL 的 size 参数设 aspect-ratio 撑开卡片，保证加载
        // 态与失败态都有正常尺寸（重掷按钮可见可点）。
        const aspectBySize = { '竖图': '832 / 1216', '横图': '1216 / 832', '方图': '1' };
        card.style.aspectRatio = aspectBySize[url.searchParams.get('size')] || aspectBySize['竖图'];
        return task.promise;
    };
    const hydrate = root => {
        if (!enabled('images') || !imageUi.card?.length || !imageUi.row?.length) return;
        const cardSelector = pickSelector(imageUi.card);
        if (!cardSelector) return;
        const cards = root?.matches?.(cardSelector) ? [root] : [...(root?.querySelectorAll?.(cardSelector) || [])];
        cards.forEach(card => { if (!card.dataset.imageJobState) loadCard(card); });
    };

    // ---- Vue 桥接：捕获 setup 状态、保存 watcher 与消息列表变化 ----
    const vue = window[ANCHORS.runtime.vueGlobal];
    if (vue) {
        const createApp = vue.createApp;
        const watch = vue.watch;
        const onMounted = vue.onMounted;
        vue.watch = function (source, callback, options) {
            if (!setupScope || typeof callback !== 'function') return watch(source, callback, options);
            // 仅捕获保存入口 watcher；其他动画、网络和轮询 watcher 保持原行为。
            const body = Function.prototype.toString.call(callback);
            const saveKind = ANCHORS.saveMarkers.find(marker => body.includes(marker));
            if (saveKind) {
                saveWatchers.add(saveKind);
                if (saveKind === 'scheduleChatHistorySave') scheduleChatSave = () => scoped(() => callback());
                return watch(source, (...args) => scoped(() => callback(...args)), options);
            }
            // 聊天容器 watcher：在作者 MutationObserver 之前接管新增节点上的图片卡。
            return watch(source, (...args) => {
                if (state && source === stateRef('chatContainer')) {
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

    // 作用域定时器：只在 setup/watch 回调执行期间捕获作者防抖定时器，
    // flush 时重放这些定时器驱动作者保存链路完成。
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

    const flush = async () => {
        if (!enabled('sync')) return { ok: false, reason: 'sync 功能被适配层配置关闭' };
        if (!mounted) return { ok: false, reason: startupFailed ? '作者应用启动失败' : '作者应用尚未挂载完成' };
        if (!storage) return { ok: false, reason: '作者存储层未就绪' };
        const missingMarkers = ANCHORS.saveMarkers.filter(marker => !saveWatchers.has(marker));
        if (missingMarkers.length) {
            return { ok: false, reason: `作者保存接口未就绪：缺少 ${missingMarkers.join('、')}` };
        }
        const busy = value(stateRef('busy'));
        const switching = value(stateRef('branchSwitching'));
        const switchingCharacter = value(stateRef('switchingCharacter'));
        if (busy || switching || Number(switchingCharacter) >= 0) {
            return { ok: false, reason: '请等待当前生成或角色切换完成后同步。' };
        }
        await vue.nextTick();
        for (let pass = 0; pass < 32; pass++) {
            const before = revision;
            for (const run of [...pendingTimers.values()]) run();
            await Promise.allSettled([...pendingWrites]);
            await vue.nextTick();
            if (!pendingTimers.size && !pendingWrites.size && revision === before) {
                if (transactionFailure) return { ok: false, reason: '作者数据保存失败，事务已中止；请保留当前页面的数据，排除存储故障后刷新再同步。' };
                if (failedWrites.size) return { ok: false, reason: '作者数据保存失败，请先重试保存再同步。' };
                await window.RPH_SYNC_TRACKER?.flush();
                return { ok: true };
            }
        }
        return { ok: false, reason: '作者数据仍在变化，请稍后重试同步。' };
    };

    const describeCard = card => {
        const rowSelector = pickSelector(imageUi.row);
        const cardSelector = pickSelector(imageUi.card);
        if (!rowSelector || !cardSelector) return null;
        const row = card?.closest?.(rowSelector);
        if (!row) return null;
        return { messageIndex: Number(row.dataset.chatIndex), occurrenceIndex: [...row.querySelectorAll(cardSelector)].indexOf(card) };
    };

    const external = {
        version: 2,
        anchors: ANCHORS.version,
        flush,
        context,
        describeCard,
        register(name, handler) { hooks.set(name, handler); return () => { if (hooks.get(name) === handler) hooks.delete(name); }; },
        imageKey: () => String(value(stateRef('settings'))?.imageGenKey || ''),
        capabilities() {
            const features = Object.fromEntries(Object.keys(ANCHORS.features).map(name => [name, enabled(name)]));
            const saveMarkers = Object.fromEntries(ANCHORS.saveMarkers.map(name => [name, saveWatchers.has(name)]));
            const contextReady = Boolean(state);
            const storageReady = Boolean(storage);
            const mountedReady = mounted && !startupFailed;
            const imagesReady = features.images && Boolean(imageUi.card?.length && imageUi.row?.length && contextReady && hooks.has('image-request'));
            const missing = [];
            if (!mountedReady) missing.push(startupFailed ? 'startup' : 'mounted');
            if (!contextReady) missing.push('context');
            if (!storageReady) missing.push('storage');
            for (const marker of ANCHORS.saveMarkers) if (!saveMarkers[marker]) missing.push(marker);
            if (features.images && !imagesReady) missing.push('images');
            return {
                ...features,
                saveMarkers,
                context: contextReady,
                storage: storageReady,
                mounted: mountedReady,
                images: imagesReady,
                missing,
                // 任何保存入口缺失都视为不可同步：宁可显式失败，也不提交
                // 一份可能漏掉内存修改的快照。
                flush: features.sync && contextReady && storageReady && mountedReady
                    && ANCHORS.saveMarkers.every(marker => saveMarkers[marker])
            };
        },
        status() {
            return {
                version: 2,
                anchors: ANCHORS.version,
                vue: Boolean(vue),
                storage: Boolean(storage),
                state: Boolean(state),
                mounted,
                startupFailed,
                saveWatchers: Object.fromEntries(ANCHORS.saveMarkers.map(marker => [marker, saveWatchers.has(marker)])),
                hooks: [...hooks.keys()],
                features: { ...ANCHORS.features }
            };
        },
        installUi: null
    };
    window.RPHubExternal = external;

    // ---- 重掷拦截：交换提示词中相邻两个 tag 后重试生成 ----
    document.addEventListener('click', async event => {
        if (!enabled('images')) return;
        const rerollSelector = pickSelector(imageUi.reroll);
        const cardSelector = pickSelector(imageUi.card);
        if (!rerollSelector || !cardSelector) return;
        const button = event.target.closest?.(rerollSelector);
        const card = button?.closest(cardSelector);
        const current = context(card);
        if (!button || !current || !hooks.has('image-request')) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (current.busy || button.disabled) return;
        button.disabled = true;
        try {
            const original = String(current.message.content || '');
            const index = describeCard(card)?.occurrenceIndex;
            const utils = window[ANCHORS.utilsGlobal];
            const cardUtils = window[ANCHORS.cardUtilsGlobal];
            const matches = cardUtils?.findUnprotectedMatches?.(original, utils?.getImageTagRegex?.());
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

    // ==================================================== UI 安装
    const FIXED_IMAGE_KEY = 'rp_hub_magic_fixed_image';
    const YNAI_MODEL_KEY = 'rp_hub_magic_ynai_model';
    const YNAI_MODEL_LIST_KEY = 'rp_hub_magic_ynai_models';
    const YNAI_SELECT_CLASS = 'magic-ynai-select';
    const isYnaiToken = token => String(token || '').trim().toUpperCase().startsWith('YNAI-');
    const isFixedImageEnabled = () => localStorage.getItem(FIXED_IMAGE_KEY) !== '0';
    const textOf = node => String(node?.textContent || '').replace(/\s+/g, ' ').trim();
    const ynaiSelectState = { key: '', checkedAt: 0, loading: false, loaded: false, failedAt: 0, models: null, renderedModels: null, renderedSelect: null };

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
            '.magic-image-save-warning{position:absolute;bottom:8px;left:8px;right:8px;padding:5px 8px;border-radius:6px;background:#fff7ed;color:#9a3412;font-size:12px}',
            '.generated-image-card.is-generating ' + (pickSelector(imageUi.reroll) || '.generated-image-reroll') + '{opacity:.45;pointer-events:none}'
        ].join('');
        document.head.appendChild(style);
    };

    const installSidebarActions = () => {
        const userCard = pick(ANCHORS.navigation.user);
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
        const content = pick(ANCHORS.navigation.content);
        if (!content) return;
        const sectionSelector = pickSelector(ANCHORS.navigation.section);
        const sections = sectionSelector ? [...content.querySelectorAll(sectionSelector)] : [];
        const section = sections.find(item => {
            const heading = item.querySelector('h1,h2,h3,[role="heading"]');
            return !ANCHORS.navigation.sectionHeading || textOf(heading || item).includes(String(ANCHORS.navigation.sectionHeading));
        });
        const grid = section && pick(ANCHORS.navigation.grid, section);
        if (!grid || grid.querySelector('.magic-image-nav')) return;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `${ANCHORS.navigation.buttonClass || 'app-navigation-item'} magic-image-nav`;
        button.title = '图片管理';
        button.setAttribute('aria-label', '图片管理');
        const iconClass = ANCHORS.navigation.iconClass || 'app-navigation-icon';
        button.innerHTML = `<span class="${iconClass} magic-image-nav-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5zm3 10 3-3 2 2 2-2 3 3M8 8h.01"></path></svg></span><span>图片管理</span>`;
        button.addEventListener('click', () => { window.location.href = '/image'; });
        const itemSelector = pickSelector(ANCHORS.navigation.item);
        const settingsButton = itemSelector
            ? [...grid.querySelectorAll(itemSelector)].find(item => textOf(item).includes(String(ANCHORS.navigation.insertBeforeLabel || '设置')))
            : null;
        grid.insertBefore(button, settingsButton || null);
    };

    const findFixedImageAnchor = () => {
        const cfg = ANCHORS.settings;
        const labels = [...document.querySelectorAll(cfg.labelSelector || 'label')]
            .filter(label => textOf(label).includes(String(cfg.labelText || '沉浸模式')))
            .filter(label => cfg.anchorParentSelector ? label.closest(cfg.anchorParentSelector) : true);
        const label = labels[cfg.occurrence === 'last' ? labels.length - 1 : 0] || null;
        if (!label) return { grid: null, anchor: null };
        const grid = cfg.anchorParentSelector ? label.closest(cfg.anchorParentSelector) : label.parentElement;
        if (!grid) return { grid: null, anchor: null };
        // 锚点可能是网格的嵌套后代；插入位相对锚点计算，作者调整设置项
        // 顺序不再改变"固定生图"的落点。
        let anchor = label;
        while (anchor && anchor.parentElement !== grid) anchor = anchor.parentElement;
        if (anchor?.parentElement !== grid) anchor = null;
        return { grid, anchor };
    };

    const installFixedImageSetting = () => {
        const cfg = ANCHORS.settings;
        const { grid, anchor } = findFixedImageAnchor();
        // 设置视图是条件渲染：网格尚未挂载时先跳过，等观察者在网格出现后补装。
        if (!grid) return { grid: null, anchor: null };
        // 安装判定看开关行特有的 input：模型行复用同一个行类，但不能被当成开关本体。
        if (grid.querySelector('.magic-fixed-image-toggle .magic-fixed-image-input')) return { grid, anchor };
        const label = document.createElement('label');
        // 行样式类全部来自锚点表：作者改设置行样式时只更新 ANCHORS。
        label.className = `magic-fixed-image-toggle ${cfg.rowClass || 'settings-toggle-row group'}`;
        label.innerHTML = `<span class="${cfg.textClass || ''}">固定生图</span><span class="${cfg.toggleWrapClass || ''}"><input type="checkbox" class="magic-fixed-image-input settings-toggle-input sr-only"><span class="${cfg.toggleClass || ''}"></span></span>`;
        const input = label.querySelector('input');
        input.checked = isFixedImageEnabled();
        input.addEventListener('change', () => localStorage.setItem(FIXED_IMAGE_KEY, input.checked ? '1' : '0'));
        const insertAfter = cfg.insert === 'after';
        grid.insertBefore(label, anchor
            ? (insertAfter ? anchor.nextSibling : anchor)
            : (insertAfter ? grid.children[0]?.nextSibling || null : null));
        return { grid, anchor };
    };

    // YNAI 模型劫持：密钥为 YNAI- 时隐藏作者"生图版本"浮窗，原位放入同款
    // 样式的下拉，选项来自中转站模型列表（经 Worker /api/rp-image-models
    // 拉取）；sta1n 密钥时移除劫持、还原作者浮窗。浮窗定位按锚点表
    // settings.modelLabel 文本找到标签，再找同容器里的 custom-select 渲染根。
    const readStoredYnaiModels = () => {
        try {
            const parsed = JSON.parse(localStorage.getItem(YNAI_MODEL_LIST_KEY) || 'null');
            return Array.isArray(parsed) ? parsed.filter(item => item?.id) : null;
        } catch (_) {
            return null;
        }
    };
    const ynaiDefaultModel = () => String(ANCHORS.ynaiDefaultModel || '');

    const findImageModelControl = () => {
        const labelText = String(ANCHORS.settings.modelLabel || '生图版本');
        const labelSelector = ANCHORS.settings.modelLabelSelector || 'label.settings-label';
        let labels = [];
        try {
            labels = [...document.querySelectorAll(labelSelector)]
                .filter(label => label.textContent.trim() === labelText);
        } catch (_) { return null; }
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

    // ynai 模型列表拉取：30 秒超时；失败后退避（60 秒内不重发），
    // 避免 reconcile 每 4 秒对故障端点连续打请求。
    const YNAI_MODEL_FETCH_TIMEOUT_MS = 30_000;
    const YNAI_MODEL_FAILURE_BACKOFF_MS = 60_000;
    const fetchYnaiModels = async key => {
        const controller = new AbortController();
        const timer = nativeTimer(() => controller.abort(), YNAI_MODEL_FETCH_TIMEOUT_MS);
        try {
            const response = await fetch('/api/rp-image-models', {
                headers: { 'x-rp-image-token': key.trim() },
                signal: controller.signal
            });
            const payload = await response.json().catch(() => null);
            const models = payload && Array.isArray(payload.data) ? payload.data.filter(item => item?.id) : [];
            if (!response.ok || !models.length) throw new Error(payload?.error || `HTTP ${response.status}`);
            return models;
        } catch (err) {
            ynaiSelectState.failedAt = Date.now();
            throw err;
        } finally {
            nativeClear(timer);
        }
    };

    const applyYnaiModelHijack = async (box, control, select, force = false) => {
        const now = Date.now();
        if (!force && select === ynaiSelectState.renderedSelect && now - ynaiSelectState.checkedAt < 4000) return;
        ynaiSelectState.checkedAt = now;
        const key = external.imageKey();
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
    const resetScrollNodes = button => {
        scrollIntersectionObserver?.disconnect();
        scrollIntersectionObserver = null;
        scrollContainer = null;
        scrollButtonNode = null;
        scrollSentinelNode = null;
        if (button) button.classList.remove('is-visible');
    };
    const installScrollButton = () => {
        const cfg = ANCHORS.chat;
        const input = pick(cfg.input);
        // row = 文本框所在行，area = 按钮插入的浮层容器。两者都是真实祖先。
        const rowSelector = pickSelector(cfg.row);
        const inputRow = input?.closest(rowSelector);
        const areaSelector = pickSelector(cfg.area);
        const inputArea = input?.closest(areaSelector) || inputRow?.parentElement;
        if (!inputRow || !inputArea) {
            resetScrollNodes();
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
        const containerSelector = pickSelector(cfg.container);
        let container = null;
        if (chatView && containerSelector) {
            try { container = chatView.querySelector(containerSelector); } catch (_) { container = null; }
        }
        if (!container) {
            // 容器消失时断开观察器并释放节点引用，否则旧 observer 会一直
            // 持有已被 Vue 移除的 sentinel，回调作用在悬垂节点上。
            resetScrollNodes(button);
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
        resetScrollNodes();
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
        const contentSelector = pickSelector(ANCHORS.navigation.content);
        const targets = new Set([
            document.body,
            // #app 开 subtree，覆盖作者所有视图的条件渲染（含设置网格、
            // 导航浮层），因此各视图出现/消失都能触发补装。
            document.querySelector(ANCHORS.runtime.root || '#app'),
            contentSelector ? document.querySelector(contentSelector) : null,
            document.querySelector('.app-main'),
            fixedAnchor?.grid || null,
            pick(ANCHORS.chat.input)?.closest(pickSelector(ANCHORS.chat.row))
        ].filter(Boolean));
        targets.forEach(target => {
            let subtree = false;
            try {
                subtree = target.matches?.(ANCHORS.runtime.root || '#app')
                    || (contentSelector && target.matches?.(contentSelector))
                    || false;
            } catch (_) { subtree = false; }
            uiObserver.observe(target, { childList: true, subtree });
        });
    };
    function reconcileUi() {
        // 每步独立兜底：条件渲染的视图未挂载时单步可能拿不到锚点，
        // 任何一步异常都不允许炸断后续安装与观察者挂载。
        let fixedAnchor = null;
        const steps = [
            () => { if (enabled('sync')) installSidebarActions(); },
            () => { if (enabled('navigation')) installImageNav(); },
            () => { if (enabled('settings')) fixedAnchor = installFixedImageSetting(); },
            () => { if (enabled('settings')) installYnaiModelHijack(); },
            () => { if (enabled('scroll')) installScrollButton(); }
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
            const triggerSelector = pickSelector(ANCHORS.navigation.trigger);
            if (!triggerSelector || !event.target.closest?.(triggerSelector)) return;
            requestAnimationFrame(reconcileUi);
            nativeTimer(reconcileUi, 250);
        }, true);
    };

    external.installUi = () => {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
        else start();
    };
}());

(function () {
    if (location.pathname !== '/' && location.pathname !== '/index.html') return;

    const FIXED_IMAGE_KEY = 'rp_hub_magic_fixed_image';
    const YNAI_MODEL_KEY = 'rp_hub_magic_ynai_model';
    // 密钥即路由：YNAI- 前缀密钥走第三方中转（worker 按 provider 转发），其余 sta1n。
    const isYnaiToken = value => String(value || '').trim().toUpperCase().startsWith('YNAI-');
    const IMAGE_STORAGE_PREFIX = 'rp_hub_image_renders_';
    const DEFAULT_STORY_SCOPE_ID = 'main';
    const IMAGE_PARAM_KEYS = ['tag', 'model', 'artist', 'size', 'steps', 'scale', 'cfg', 'sampler', 'negative', 'nocache', 'noise_schedule'];
    const external = window.RPHubExternal;
    if (!external || external.version !== 1) return;

    const hashText = value => {
        let hash = 2166136261;
        const text = String(value || '');
        for (let index = 0; index < text.length; index += 1) {
            hash ^= text.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(16);
    };

    const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
    const normalizeStoryScopeId = value => {
        const normalized = String(value ?? '').trim();
        return normalized || DEFAULT_STORY_SCOPE_ID;
    };
    const isFixedImageEnabled = () => localStorage.getItem(FIXED_IMAGE_KEY) !== '0';
    const imageStores = new Map();
    const retiredCharacterIds = new Set();

    const buildRecordKey = descriptor => [
        encodeURIComponent(normalizeStoryScopeId(descriptor.storyScopeId)),
        descriptor.messageId || (descriptor.messageIndex !== null ? `index:${descriptor.messageIndex}` : descriptor.contentHash || 'message'),
        descriptor.occurrenceIndex ?? 0,
        descriptor.promptHash || hashText(descriptor.prompt || '')
    ].join(':');

    // 生图提供商由密钥决定（worker 以 token 为准）；ynai 请求用用户在劫持下拉里
    // 选的模型覆盖作者页面的模型参数，provider 不再写进 URL/快照（缓存不区分来源）。
    const normalizeRequestUrl = (value, characterName) => {
        const source = new URL(value, location.href);
        const target = new URL('/api/rp-image', location.origin);
        IMAGE_PARAM_KEYS.forEach(key => {
            if (source.searchParams.has(key)) target.searchParams.set(key, source.searchParams.get(key));
        });
        const token = source.searchParams.get('token') || '';
        if (isYnaiToken(token)) {
            const chosen = String(localStorage.getItem(YNAI_MODEL_KEY) || '').trim();
            if (chosen) target.searchParams.set('model', chosen);
        }
        if (source.searchParams.has('reroll_nonce')) target.searchParams.set('reroll_nonce', source.searchParams.get('reroll_nonce'));
        if (token) target.searchParams.set('token', token);
        target.searchParams.set('character_name', String(source.searchParams.get('character_name') || characterName || '未命名角色'));
        return target;
    };

    const buildDescriptor = (card, message, requestUrl, storyScopeId = DEFAULT_STORY_SCOPE_ID) => {
        const slot = external.describeCard(card);
        if (!slot || slot.occurrenceIndex < 0) return null;
        const { occurrenceIndex, messageIndex } = slot;
        const prompt = String(requestUrl.searchParams.get('tag') || '').trim();
        const descriptor = {
            storyScopeId: normalizeStoryScopeId(storyScopeId),
            messageId: String(message?.id || ''),
            messageIndex: Number.isFinite(messageIndex) ? messageIndex : null,
            contentHash: hashText(String(message?.content || prompt)),
            occurrenceIndex,
            prompt,
            promptHash: hashText(prompt)
        };
        descriptor.key = buildRecordKey(descriptor);
        return descriptor;
    };

    const normalizeRecord = (record = {}, characterName = '') => {
        const paramsSnapshot = isObject(record.paramsSnapshot) ? { ...record.paramsSnapshot } : {};
        delete paramsSnapshot.token;
        if (!paramsSnapshot.rerollNonce && paramsSnapshot.reroll_nonce) paramsSnapshot.rerollNonce = paramsSnapshot.reroll_nonce;
        delete paramsSnapshot.reroll_nonce;
        const prompt = String(record.prompt || paramsSnapshot.prompt || paramsSnapshot.tag || '').trim();
        delete paramsSnapshot.prompt;
        delete paramsSnapshot.tag;
        paramsSnapshot.characterName = String(paramsSnapshot.characterName || characterName || '未命名角色');
        const normalized = {
            storyScopeId: normalizeStoryScopeId(record.storyScopeId),
            messageId: String(record.messageId || ''),
            messageIndex: record.messageIndex === null || record.messageIndex === undefined
                ? null
                : (Number.isFinite(Number(record.messageIndex)) ? Number(record.messageIndex) : null),
            contentHash: String(record.contentHash || ''),
            occurrenceIndex: Math.max(0, Number(record.occurrenceIndex) || 0),
            prompt,
            promptHash: String(record.promptHash || hashText(prompt)),
            paramsSnapshot,
            imageKey: typeof record.imageKey === 'string' ? record.imageKey : ''
        };
        normalized.key = buildRecordKey(normalized);
        return normalized;
    };

    const openImageDatabase = () => new Promise((resolve, reject) => {
        const request = indexedDB.open('RPHubDB');
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains('store')) request.result.createObjectStore('store');
        };
        request.onerror = () => reject(request.error || new Error('图片记录数据库打开失败'));
        request.onsuccess = () => resolve(request.result);
    });

    // 注意：normalizeRecordList 对重复 key 是“删除后重设”（后写者排到末尾），
    // 与 mergeRecordLists 的 base 处理（Map 去重保首位置）顺序语义不同，不可合并。
    const normalizeRecordList = (value, characterName = '') => {
        if (!Array.isArray(value)) return [];
        const records = new Map();
        value.forEach(record => {
            const normalized = normalizeRecord(record, characterName);
            if (!normalized.prompt) return;
            records.delete(normalized.key);
            records.set(normalized.key, normalized);
        });
        return [...records.values()];
    };

    const mergeRecordLists = (base, additions, deletedKeys, characterName = '') => {
        const records = new Map(normalizeRecordList(base, characterName).map(record => [record.key, record]));
        deletedKeys.forEach(key => records.delete(key));
        for (const record of additions) {
            const normalized = normalizeRecord(record, characterName);
            if (!normalized.prompt) continue;
            records.delete(normalized.key);
            records.set(normalized.key, normalized);
        }
        return [...records.values()];
    };

    const withImageStoreLock = (state, callback) => {
        const lockName = `${IMAGE_STORAGE_PREFIX}${state.id}`;
        if (typeof navigator !== 'undefined' && navigator.locks?.request) {
            return navigator.locks.request(lockName, { mode: 'exclusive' }, callback);
        }
        return callback();
    };

    const loadImageStore = (characterId, characterName) => {
        const id = String(characterId || '');
        if (!id || retiredCharacterIds.has(id)) return Promise.resolve(null);
        if (imageStores.has(id)) return imageStores.get(id).loadPromise;
        const state = {
            id,
            retired: false,
            characterName: String(characterName || ''),
            records: [],
            transientRecords: new Map(),
            pendingUpserts: new Map(),
            pendingDeleteKeys: new Set(),
            writeQueue: Promise.resolve(),
            saveRevision: 0,
            savedRevision: 0,
            saveError: null,
            loadPromise: null
        };
        state.loadPromise = (async () => {
            const db = await openImageDatabase();
            try {
                const value = await new Promise((resolve, reject) => {
                    const request = db.transaction(['store'], 'readonly').objectStore('store').get(IMAGE_STORAGE_PREFIX + id);
                    request.onsuccess = () => resolve(request.result);
                    request.onerror = () => reject(request.error || new Error('图片记录读取失败'));
                });
                const rawRecords = Array.isArray(value)
                    ? value.map(record => normalizeRecord(record, state.characterName)).filter(record => record.prompt)
                    : [];
                state.records = rawRecords;
                return state;
            } finally {
                db.close();
            }
        })().catch(error => {
            if (imageStores.get(id) === state) imageStores.delete(id);
            throw error;
        });
        imageStores.set(id, state);
        return state.loadPromise;
    };

    const saveImageStore = (state, retry = false) => {
        if (!state || state.retired) return Promise.resolve();
        // 无待写内容且无未结算修订时完全短路：不开库、不排队、不递增
        // revision（过去 flush 重试路径会对空 pendings 白跑一次读改写）。
        if (state.savedRevision === state.saveRevision
            && state.pendingUpserts.size === 0 && state.pendingDeleteKeys.size === 0) {
            return Promise.resolve();
        }
        if (!retry) state.saveRevision += 1;
        const write = state.writeQueue.catch(() => undefined).then(async () => {
            if (state.retired) return;
            if (state.savedRevision === state.saveRevision
                && state.pendingUpserts.size === 0 && state.pendingDeleteKeys.size === 0) return;
            const revision = state.saveRevision;
            const upserts = new Map(state.pendingUpserts);
            const deletedKeys = new Set(state.pendingDeleteKeys);
            return withImageStoreLock(state, async () => {
                if (state.retired) return;
                const db = await openImageDatabase();
                try {
                    if (state.retired) return;
                    let merged;
                    await new Promise((resolve, reject) => {
                        const transaction = db.transaction(['store'], 'readwrite');
                        const store = transaction.objectStore('store');
                        const request = store.get(IMAGE_STORAGE_PREFIX + state.id);
                        request.onerror = () => reject(request.error || new Error('图片记录读取失败'));
                        request.onsuccess = () => {
                            if (state.retired) return;
                            merged = mergeRecordLists(request.result, upserts.values(), deletedKeys, state.characterName);
                            store.put(merged, IMAGE_STORAGE_PREFIX + state.id);
                        };
                        transaction.oncomplete = resolve;
                        transaction.onerror = () => reject(transaction.error || new Error('图片记录保存失败'));
                        transaction.onabort = () => reject(transaction.error || new Error('图片记录保存中止'));
                    });
                    if (state.retired) return;
                    state.pendingUpserts.forEach((record, key) => {
                        if (upserts.get(key) === record) state.pendingUpserts.delete(key);
                    });
                    deletedKeys.forEach(key => {
                        if (state.pendingDeleteKeys.has(key)) state.pendingDeleteKeys.delete(key);
                    });
                    state.records = mergeRecordLists(
                        merged,
                        state.pendingUpserts.values(),
                        state.pendingDeleteKeys,
                        state.characterName
                    );
                    state.savedRevision = revision;
                    state.saveError = null;
                } catch (error) {
                    state.saveError = error;
                    throw error;
                } finally {
                    db.close();
                }
            });
        });
        state.writeQueue = write;
        write.catch(error => { state.saveError = error; });
        return write;
    };

    const snapshotFromUrl = (url, characterName, reroll = false) => {
        const snapshot = {};
        IMAGE_PARAM_KEYS.forEach(key => { snapshot[key] = String(url.searchParams.get(key) || ''); });
        snapshot.nocache = reroll ? '1' : (snapshot.nocache || '0');
        snapshot.rerollNonce = reroll ? (crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`) : String(url.searchParams.get('reroll_nonce') || '');
        snapshot.characterName = String(url.searchParams.get('character_name') || characterName || '未命名角色');
        return snapshot;
    };

    const buildRecordUrl = (record, token = '', allowGeneration = false) => {
        const url = new URL('/api/rp-image', location.origin);
        if (!allowGeneration && record.imageKey) {
            url.searchParams.set('key', record.imageKey);
            return url.href;
        }
        const snapshot = record.paramsSnapshot || {};
        IMAGE_PARAM_KEYS.forEach(key => url.searchParams.set(key, key === 'tag' ? record.prompt : String(snapshot[key] || '')));
        if (snapshot.rerollNonce) url.searchParams.set('reroll_nonce', String(snapshot.rerollNonce));
        if (allowGeneration) {
            url.searchParams.set('generate', '1');
            if (token) url.searchParams.set('token', token);
        }
        url.searchParams.set('character_name', String(snapshot.characterName || '未命名角色'));
        return url.href;
    };

    const findSlotRecord = (records, descriptor) => records.find(record => (
        normalizeStoryScopeId(record.storyScopeId) === normalizeStoryScopeId(descriptor.storyScopeId)
        && record.occurrenceIndex === descriptor.occurrenceIndex
        && (descriptor.messageId
            ? record.messageId === descriptor.messageId
            : record.messageIndex === descriptor.messageIndex && record.contentHash === descriptor.contentHash)
    )) || null;

    const bindDirectImageEvents = card => {
        const image = card?.querySelector?.('img');
        if (!image || image.dataset.rphImageEvents === '1') return;
        image.dataset.rphImageEvents = '1';
        image.addEventListener('load', () => {
            delete image.dataset.rphRetry;
            card.classList.remove('is-image-load-error');
            card.querySelector('.magic-image-load-error')?.remove();
        });
        image.addEventListener('error', () => {
            let url;
            try {
                url = new URL(image.currentSrc || image.src || '', location.origin);
            } catch (_) {
                return;
            }
            if (url.origin === location.origin && url.pathname === '/api/rp-image'
                && url.searchParams.get('generate') !== '1' && image.dataset.rphRetry !== '1') {
                image.dataset.rphRetry = '1';
                url.searchParams.set('_rph_retry', String(Date.now()));
                image.src = url.href;
                return;
            }
            card.classList.add('is-image-load-error');
            const existingNotice = card.querySelector('.magic-image-load-error');
            if (existingNotice) {
                existingNotice.querySelector('span').textContent = '加载失败';
                return;
            }
            const notice = document.createElement('div');
            notice.className = 'magic-image-load-error';
            notice.innerHTML = '<span>加载失败</span><button type="button">重新加载</button>';
            notice.querySelector('button').addEventListener('click', event => {
                event.stopPropagation();
                const retryUrl = new URL(image.currentSrc || image.src, location.origin);
                retryUrl.searchParams.set('_rph_retry', String(Date.now()));
                image.dataset.rphRetry = '1';
                notice.querySelector('span').textContent = '加载中…';
                image.src = retryUrl.href;
            });
            card.appendChild(notice);
        });
    };

    const renderDirectImageJob = (render, card, task, job) => {
        if (job?.status === 'running' || job?.status === 'failed') {
            card?.querySelector?.('.magic-image-load-error')?.remove();
            card?.classList.remove('is-image-load-error');
        }
        if (job?.status === 'done') {
            const image = card?.querySelector?.('img');
            if (image) delete image.dataset.rphRetry;
        }
        render?.(card, task, job);
        if (job?.status === 'done') bindDirectImageEvents(card);
        let warning = card?.querySelector?.('.magic-image-save-warning');
        if (job?.storageError) {
            if (!warning && card) {
                warning = document.createElement('div');
                warning.className = 'magic-image-save-warning';
                card.appendChild(warning);
            }
            if (warning) warning.textContent = '固定记录未保存，请勿刷新';
        } else {
            warning?.remove();
        }
    };

    const imageGenerationTasks = new Map();
    const imageSlotTasks = new Map();
    const imageCardBindings = new WeakMap();
    const SLOT_TASK_CACHE_LIMIT = 128;

    // 已结算的槽位任务只用于复用渲染；超限后按插入顺序淘汰已完成的
    // 条目，进行中的任务保留。被淘汰的槽位重新渲染时走已保存记录的
    // 完成态路径，不会重新生成。
    const pruneSlotTasks = () => {
        if (imageSlotTasks.size <= SLOT_TASK_CACHE_LIMIT) return;
        for (const [key, task] of imageSlotTasks) {
            if (imageSlotTasks.size <= SLOT_TASK_CACHE_LIMIT) break;
            if (task.job?.status === 'running') continue;
            imageSlotTasks.delete(key);
        }
    };

    const publishImageJob = (task, job) => {
        task.job = job;
        [...task.cards].forEach(card => {
            if (!card.isConnected) task.cards.delete(card);
            else renderDirectImageJob(task.render, card, task, job);
        });
        pruneSlotTasks();
        return job;
    };

    const createCompletedImageTask = (requestUrl, imageUrl, render) => {
        const task = {
            requestUrl,
            baseUrl: location.origin,
            token: '',
            cards: new Set(),
            render,
            job: {
                status: 'done',
                imageUrl,
                generationProgress: { percent: 100 }
            },
            promise: null
        };
        task.promise = Promise.resolve(task.job);
        return task;
    };

    // 隐藏任务：作者的“自动生图”开关关闭时卡片整体隐藏，不渲染任何占位。
    // promise 必须正常完成，作者端的 reroll 处理器会等待它。
    const createSuppressedImageTask = (requestUrl, render) => {
        const task = {
            requestUrl,
            baseUrl: location.origin,
            token: '',
            cards: new Set(),
            render,
            suppressed: true,
            job: { status: 'done', imageUrl: '', generationProgress: { percent: 100 } },
            promise: null
        };
        task.promise = Promise.resolve(task.job);
        return task;
    };

    const createImageGenerationTask = (key, requestUrl) => {
        const existing = imageGenerationTasks.get(key);
        if (existing) return existing;
        const promise = requestImageGeneration(requestUrl)
            .then(imageKey => ({
                status: 'done', imageKey, imageUrl: imageKey ? `/api/rp-image?key=${encodeURIComponent(imageKey)}` : key, generationProgress: { percent: 100 }
            }))
            .catch(error => ({
                status: 'failed',
                error: error?.message || '生成失败',
                generationProgress: { percent: 0 }
            }));
        promise.finally(() => {
            if (imageGenerationTasks.get(key) === promise) imageGenerationTasks.delete(key);
        });
        imageGenerationTasks.set(key, promise);
        return promise;
    };

    const requestImageGeneration = async generateUrl => {
        const response = await fetch(generateUrl, { method: 'POST' });
        if (!response.ok) {
            const payload = await response.json().catch(() => null);
            throw new Error(payload?.error || `生图失败：HTTP ${response.status}`);
        }
        if (response.body) await response.body.cancel().catch(() => undefined);
        return response.headers.get('x-rp-image-key') ? decodeURIComponent(response.headers.get('x-rp-image-key')) : '';
    };

    const commitGeneratedRecord = async (state, record, previous, persistRequested) => {
        if (!state || state.retired) return;
        const previousWasStored = Boolean(previous && state.records.some(item => item.key === previous.key));
        if (previous) state.transientRecords.delete(previous.key);
        state.transientRecords.delete(record.key);
        if (persistRequested) {
            if (previousWasStored) state.pendingDeleteKeys.add(previous.key);
            state.records = [
                ...state.records.filter(item => item.key !== record.key && item.key !== previous?.key),
                record
            ];
            state.pendingUpserts.set(record.key, record);
            await saveImageStore(state);
            return;
        }
        // 关闭固定图后，旧的持久记录保留；reroll 只覆盖当前页的临时结果。
        state.transientRecords.set(record.key, record);
    };

    const createGenerationTask = ({ slotKey, sourcePromptHash, record, previous = null, state = null, characterId = state?.id || '', token = '', render, persistRequested = false }) => {
        const generateUrl = buildRecordUrl(record, token, true);
        const readUrl = buildRecordUrl(record);
        const task = {
            sourcePromptHash,
            record,
            state,
            characterId: String(state?.id || ''),
            requestUrl: generateUrl,
            baseUrl: location.origin,
            token: '',
            cards: new Set(),
            render,
            job: { status: 'running', generationProgress: { percent: 0 } },
            promise: null
        };
        imageSlotTasks.set(slotKey, task);
        pruneSlotTasks();
        task.promise = createImageGenerationTask(readUrl, generateUrl).then(async job => {
            // 只清理本任务的失败占位，不能删除同槽位新任务留下的记录。
            if (job.status === 'failed' && state?.transientRecords.get(record.key) === record) {
                state.transientRecords.delete(record.key);
            }
            if (imageSlotTasks.get(slotKey) !== task) return job;
            if (job.status === 'done') {
                record.imageKey = job.imageKey || record.imageKey;
                try {
                    await commitGeneratedRecord(state, record, previous, persistRequested);
                } catch (_) {
                    return publishImageJob(task, { ...job, storageError: true });
                }
            }
            return publishImageJob(task, job);
        });
        return task;
    };

    // 用既有记录恢复已完成任务的两条路径（非 fresh 命中、开关关闭时的重掷）
    // 共用同一份装配逻辑。
    const resumeRecordedImageTask = (record, descriptor, slotKey, token, render, state, characterId = state?.id || '') => {
        const readUrl = buildRecordUrl(record);
        const task = createCompletedImageTask(readUrl, readUrl, render);
        Object.assign(task, { record, state, characterId: String(characterId || ''), sourcePromptHash: descriptor.promptHash });
        imageSlotTasks.set(slotKey, task);
        pruneSlotTasks();
        return task;
    };

    const startMagicImageTask = async ({ card, requestUrl, fresh, message, storyScopeId = DEFAULT_STORY_SCOPE_ID, characterId, characterName, autoImageGen, render }) => {
        const currentUrl = normalizeRequestUrl(requestUrl, characterName);
        const token = currentUrl.searchParams.get('token') || '';
        const descriptor = buildDescriptor(card, message, currentUrl, storyScopeId);
        if (!descriptor) {
            // 无卡片上下文时无法定位槽位：作者的“自动生图”开关关闭时只隐藏。
            // 适配层未提供“自动生图”状态时，按作者原生行为放行。
            if (autoImageGen === false) return createSuppressedImageTask(currentUrl.href, render);
            const record = normalizeRecord({
                storyScopeId,
                prompt: currentUrl.searchParams.get('tag') || '',
                paramsSnapshot: snapshotFromUrl(currentUrl, characterName, fresh === true)
            }, characterName);
            return createGenerationTask({
                slotKey: JSON.stringify([String(characterId || ''), normalizeStoryScopeId(storyScopeId), buildRecordUrl(record)]),
                record,
                characterId,
                token,
                render
            });
        }
        const state = await loadImageStore(characterId, characterName);
        if (state?.retired) return createSuppressedImageTask(currentUrl.href, render);
        const slotKey = JSON.stringify([
            String(characterId || ''),
            normalizeStoryScopeId(descriptor.storyScopeId),
            descriptor.messageId || `index:${descriptor.messageIndex}`,
            descriptor.occurrenceIndex
        ]);
        const activeTask = imageSlotTasks.get(slotKey);
        if (fresh !== true && activeTask && activeTask.job?.status !== 'failed'
            && (activeTask.record?.promptHash === descriptor.promptHash || activeTask.sourcePromptHash === descriptor.promptHash)) {
            if (activeTask.record) activeTask.requestUrl = buildRecordUrl(activeTask.record);
            activeTask.render = render;
            return activeTask;
        }
        const storedRecord = state?.records.find(record => record.key === descriptor.key) || null;
        const transientRecord = state?.transientRecords.get(descriptor.key) || null;
        const slotRecord = fresh === true && state
            ? findSlotRecord([...state.transientRecords.values(), ...state.records], descriptor)
            : null;
        const previous = transientRecord || storedRecord || slotRecord;
        // 开关由适配层实时传入，不依赖存储；未提供状态时按作者原生行为放行。
        const generationAllowed = autoImageGen !== false;

        if (fresh !== true && previous) {
            return resumeRecordedImageTask(previous, descriptor, slotKey, token, render, state);
        }

        if (!previous && !generationAllowed) {
            // 作者“自动生图”开关关闭：卡片隐藏且不生成，不做任何持久化；
            // 重新打开开关后按作者原生行为重新生成。
            return createSuppressedImageTask(currentUrl.href, render);
        }

        if (fresh === true) {
            if (previous && !generationAllowed) {
                // 作者“自动生图”开关关闭时的重掷：保留已显示的旧图，不再生成。
                return resumeRecordedImageTask(previous, descriptor, slotKey, token, render, state);
            }
            const record = normalizeRecord({
                ...descriptor,
                paramsSnapshot: snapshotFromUrl(currentUrl, characterName, true)
            }, characterName);
            return createGenerationTask({
                slotKey,
                sourcePromptHash: previous?.promptHash || activeTask?.record?.promptHash || descriptor.promptHash,
                record,
                previous,
                state,
                characterId,
                token,
                render,
                persistRequested: isFixedImageEnabled()
            });
        }

        const record = normalizeRecord({
            ...descriptor,
            paramsSnapshot: snapshotFromUrl(currentUrl, characterName)
        }, characterName);
        if (state) state.transientRecords.set(record.key, record);
        return createGenerationTask({
            slotKey,
            sourcePromptHash: descriptor.promptHash,
            record,
            state,
            characterId,
            token,
            render,
            persistRequested: isFixedImageEnabled()
        });
    };

    const imageTask = options => {
        const deferredTask = { cards: new Set(), job: null, requestUrl: normalizeRequestUrl(options.requestUrl, options.characterName).href };
        const previousBinding = imageCardBindings.get(options.card);
        previousBinding?.task?.cards.delete(options.card);
        const binding = { task: null };
        imageCardBindings.set(options.card, binding);
        deferredTask.promise = Promise.resolve().then(() => {
            if (retiredCharacterIds.has(String(options.characterId || ''))) {
                return createSuppressedImageTask(deferredTask.requestUrl, options.render);
            }
            return startMagicImageTask(options);
        }).then(task => {
            if (!task) return { status: 'failed', error: '图片任务初始化失败' };
            deferredTask.requestUrl = task.requestUrl || deferredTask.requestUrl;
            deferredTask.job = task.job || null;
            deferredTask.cards.forEach(card => {
                if (imageCardBindings.get(card) !== binding) return;
                binding.task = task;
                task.cards?.forEach(node => { if (!node.isConnected) task.cards.delete(node); });
                task.cards?.add(card);
                card.dataset.imageRequest = deferredTask.requestUrl;
                card.classList?.toggle('magic-image-suppressed', task.suppressed === true);
                if (task.suppressed) return;
                if (task.job) renderDirectImageJob(options.render, card, task, task.job);
            });
            return task.promise || { status: 'failed', error: '图片任务初始化失败' };
        }).then(job => {
            deferredTask.job = job;
            return job;
        }).catch(error => {
            const job = { status: 'failed', error: error?.message || '图片任务初始化失败' };
            deferredTask.job = job;
            deferredTask.cards.forEach(card => {
                if (imageCardBindings.get(card) === binding) renderDirectImageJob(options.render, card, deferredTask, job);
            });
            return job;
        });
        return deferredTask;
    };

    window.RPH_MAGIC_FLUSH_IMAGES = async () => {
        await Promise.all([...imageStores.values()].map(async state => {
            await state.loadPromise;
            await state.writeQueue.catch(() => undefined);
            if (state.savedRevision !== state.saveRevision) await saveImageStore(state, true);
        }));
        imageSlotTasks.forEach(task => {
            if (task.job?.storageError && !task.state?.saveError) {
                publishImageJob(task, { ...task.job, storageError: false });
            }
        });
    };

    external.register('image-request', imageTask);
    external.register('character-deleted', async id => {
        id = String(id);
        retiredCharacterIds.add(id);
        const state = imageStores.get(id);
        if (state) state.retired = true;
        await state?.loadPromise.catch(() => undefined);
        imageStores.delete(id);
        for (const [key, task] of imageSlotTasks) {
            if (task.characterId === id) {
                task.cards.clear();
                imageSlotTasks.delete(key);
            }
        }
        await state?.writeQueue.catch(() => undefined);
    });
    external.installUi();
})();

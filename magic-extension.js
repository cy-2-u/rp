(function () {
    if (location.pathname !== '/' && location.pathname !== '/index.html') return;

    const FIXED_IMAGE_KEY = 'rp_hub_magic_fixed_image';
    const LEGACY_REGEX_MIGRATION_KEY = 'rp_hub_magic_regex_migration_v2';
    const IMAGE_STORAGE_PREFIX = 'rp_hub_image_renders_';
    const IMAGE_PARAM_KEYS = ['provider', 'tag', 'model', 'artist', 'size', 'steps', 'scale', 'cfg', 'sampler', 'negative', 'nocache', 'noise_schedule'];
    let activeAdapter = window.RPHUB_MAGIC_ADAPTER || null;
    let adapterLoadPromise = null;

    const loadUiAdapter = async () => {
        if (activeAdapter) return activeAdapter;
        if (adapterLoadPromise) return adapterLoadPromise;
        adapterLoadPromise = fetch('/__rphub/adapter.json', { cache: 'no-store' })
            .then(response => response.ok ? response.json() : null)
            .then(value => {
                activeAdapter = value && typeof value === 'object' ? value : null;
                return activeAdapter;
            })
            .catch(() => null);
        return adapterLoadPromise;
    };
    const uiConfig = () => activeAdapter?.ui || {};
    const navigationConfig = () => uiConfig().navigation || {};
    const settingsConfig = () => uiConfig().settings || {};
    const chatConfig = () => uiConfig().chat || {};
    const textOf = node => String(node?.textContent || '').replace(/\s+/g, ' ').trim();

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
    const isFixedImageEnabled = () => localStorage.getItem(FIXED_IMAGE_KEY) !== '0';
    const imageStores = new Map();

    const buildRecordKey = descriptor => [
        descriptor.messageId || (descriptor.messageIndex !== null ? `index:${descriptor.messageIndex}` : descriptor.contentHash || 'message'),
        descriptor.occurrenceIndex ?? 0,
        descriptor.promptHash || hashText(descriptor.prompt || '')
    ].join(':');

    const inferProvider = (url, token = '') => {
        const requested = String(url.searchParams.get('provider') || '').trim().toLowerCase();
        if (['rinko', 'sta1n', 'std'].includes(requested)) return requested;
        const host = url.hostname.toLowerCase();
        if (host.includes('nai.rinko.ai')) return 'rinko';
        if (host.includes('nai.sta1n.cn')) return 'sta1n';
        if (host.includes('std.loliyc.com')) return 'std';
        const normalizedToken = String(token || '').trim().toUpperCase();
        if (normalizedToken.startsWith('STA1N')) return 'sta1n';
        if (normalizedToken.startsWith('STD')) return 'std';
        return 'sta1n';
    };

    const normalizeRequestUrl = (value, characterName) => {
        const source = new URL(value, location.href);
        const target = new URL('/api/rp-image', location.origin);
        IMAGE_PARAM_KEYS.forEach(key => {
            if (source.searchParams.has(key)) target.searchParams.set(key, source.searchParams.get(key));
        });
        const token = source.searchParams.get('token') || '';
        target.searchParams.set('provider', inferProvider(source, token));
        if (source.searchParams.has('reroll_nonce')) target.searchParams.set('reroll_nonce', source.searchParams.get('reroll_nonce'));
        if (token) target.searchParams.set('token', token);
        target.searchParams.set('character_name', String(source.searchParams.get('character_name') || characterName || '未命名角色'));
        return target;
    };

    const buildDescriptor = (card, message, requestUrl) => {
        const row = card?.closest?.('[data-chat-index]');
        const occurrenceIndex = row ? [...row.querySelectorAll('.generated-image-card')].indexOf(card) : -1;
        if (occurrenceIndex < 0) return null;
        const messageIndex = Number(row?.dataset.chatIndex);
        const prompt = String(requestUrl.searchParams.get('tag') || '').trim();
        const descriptor = {
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
            messageId: String(record.messageId || ''),
            messageIndex: record.messageIndex === null || record.messageIndex === undefined
                ? null
                : (Number.isFinite(Number(record.messageIndex)) ? Number(record.messageIndex) : null),
            contentHash: String(record.contentHash || ''),
            occurrenceIndex: Math.max(0, Number(record.occurrenceIndex) || 0),
            prompt,
            promptHash: String(record.promptHash || hashText(prompt)),
            paramsSnapshot
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

    const loadImageStore = (characterId, characterName) => {
        const id = String(characterId || '');
        if (!id) return Promise.resolve(null);
        if (imageStores.has(id)) return imageStores.get(id).loadPromise;
        const state = {
            id,
            characterName: String(characterName || ''),
            records: [],
            transientRecords: new Map(),
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
                state.records = Array.isArray(value)
                    ? value.map(record => normalizeRecord(record, state.characterName)).filter(record => record.prompt)
                    : [];
                return state;
            } finally {
                db.close();
            }
        })();
        imageStores.set(id, state);
        return state.loadPromise;
    };

    const saveImageStore = (state, retry = false) => {
        if (!state) return Promise.resolve();
        if (!retry) state.saveRevision += 1;
        const write = state.writeQueue.catch(() => undefined).then(async () => {
            if (state.savedRevision === state.saveRevision) return;
            const revision = state.saveRevision;
            const payload = state.records.map(record => normalizeRecord(record, state.characterName));
            const db = await openImageDatabase();
            try {
                await new Promise((resolve, reject) => {
                    const transaction = db.transaction(['store'], 'readwrite');
                    transaction.objectStore('store').put(payload, IMAGE_STORAGE_PREFIX + state.id);
                    transaction.oncomplete = resolve;
                    transaction.onerror = () => reject(transaction.error || new Error('图片记录保存失败'));
                    transaction.onabort = () => reject(transaction.error || new Error('图片记录保存中止'));
                });
                state.savedRevision = revision;
                state.saveError = null;
            } catch (error) {
                state.saveError = error;
                throw error;
            } finally {
                db.close();
            }
        });
        state.writeQueue = write;
        write.catch(error => { state.saveError = error; });
        return write;
    };

    const snapshotFromUrl = (url, characterName, reroll = false) => {
        const snapshot = {};
        IMAGE_PARAM_KEYS.forEach(key => { snapshot[key] = String(url.searchParams.get(key) || ''); });
        snapshot.provider = inferProvider(url, url.searchParams.get('token') || '');
        snapshot.nocache = reroll ? '1' : (snapshot.nocache || '0');
        snapshot.rerollNonce = reroll ? (crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`) : String(url.searchParams.get('reroll_nonce') || '');
        snapshot.characterName = String(url.searchParams.get('character_name') || characterName || '未命名角色');
        return snapshot;
    };

    const buildRecordUrl = (record, token = '', allowGeneration = false) => {
        const url = new URL('/api/rp-image', location.origin);
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
        record.occurrenceIndex === descriptor.occurrenceIndex
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
            if (!warning) {
                warning = document.createElement('div');
                warning.className = 'magic-image-save-warning';
                card.appendChild(warning);
            }
            warning.textContent = '固定记录未保存，请勿刷新';
        } else {
            warning?.remove();
        }
    };

    const imageGenerationTasks = new Map();
    const imageSlotTasks = new Map();
    const imageCardBindings = new WeakMap();

    const publishImageJob = (task, job) => {
        task.job = job;
        [...task.cards].forEach(card => {
            if (!card.isConnected) task.cards.delete(card);
            else renderDirectImageJob(task.render, card, task, job);
        });
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

    const createImageGenerationTask = (key, requestUrl) => {
        const existing = imageGenerationTasks.get(key);
        if (existing) return existing;
        const promise = requestImageGeneration(requestUrl)
            .then(() => ({
                status: 'done', imageUrl: key, generationProgress: { percent: 100 }
            }))
            .catch(error => ({
                status: 'failed',
                error: error?.message || '生成失败',
                generationProgress: { percent: 0 }
            }));
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
    };

    const commitGeneratedRecord = async (state, record, previous, persistRequested) => {
        if (!state) return;
        const previousWasStored = Boolean(previous && state.records.some(item => item.key === previous.key));
        if (previous) state.transientRecords.delete(previous.key);
        state.transientRecords.delete(record.key);
        if (persistRequested || previousWasStored) {
            state.records = [
                ...state.records.filter(item => item.key !== record.key && item.key !== previous?.key),
                record
            ];
            await saveImageStore(state);
            return;
        }
        state.transientRecords.set(record.key, record);
    };

    const createGenerationTask = ({ slotKey, sourcePromptHash, record, previous = null, state = null, token = '', render, persistRequested = false }) => {
        const generateUrl = buildRecordUrl(record, token, true);
        const readUrl = buildRecordUrl(record);
        const task = {
            sourcePromptHash,
            record,
            state,
            requestUrl: generateUrl,
            baseUrl: location.origin,
            token: '',
            cards: new Set(),
            render,
            job: { status: 'running', generationProgress: { percent: 0 } },
            promise: null
        };
        imageSlotTasks.set(slotKey, task);
        task.promise = createImageGenerationTask(readUrl, generateUrl).then(async job => {
            if (imageSlotTasks.get(slotKey) !== task) return job;
            if (job.status === 'done') {
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

    const startMagicImageTask = async ({ card, requestUrl, fresh, message, characterId, characterName, render }) => {
        const currentUrl = normalizeRequestUrl(requestUrl, characterName);
        const token = currentUrl.searchParams.get('token') || '';
        const descriptor = buildDescriptor(card, message, currentUrl);
        if (!descriptor) {
            const record = normalizeRecord({
                prompt: currentUrl.searchParams.get('tag') || '',
                paramsSnapshot: snapshotFromUrl(currentUrl, characterName, fresh === true)
            }, characterName);
            return createGenerationTask({ slotKey: buildRecordUrl(record), record, token, render });
        }
        const state = await loadImageStore(characterId, characterName);
        const slotKey = JSON.stringify([String(characterId || ''), descriptor.messageId || `index:${descriptor.messageIndex}`, descriptor.occurrenceIndex]);
        const activeTask = imageSlotTasks.get(slotKey);
        if (fresh !== true && activeTask
            && (activeTask.record.promptHash === descriptor.promptHash || activeTask.sourcePromptHash === descriptor.promptHash)) {
            activeTask.requestUrl = buildRecordUrl(activeTask.record, token, true);
            activeTask.render = render;
            return activeTask;
        }
        const storedRecord = state?.records.find(record => record.key === descriptor.key) || null;
        const transientRecord = state?.transientRecords.get(descriptor.key) || null;
        const slotRecord = fresh === true && state
            ? findSlotRecord([...state.records, ...state.transientRecords.values()], descriptor)
            : null;
        const previous = storedRecord || transientRecord || slotRecord;

        if (fresh === true) {
            const record = normalizeRecord({
                ...descriptor,
                paramsSnapshot: snapshotFromUrl(currentUrl, characterName, true)
            }, characterName);
            return createGenerationTask({
                slotKey,
                sourcePromptHash: previous?.promptHash || activeTask?.record.promptHash || descriptor.promptHash,
                record,
                previous,
                state,
                token,
                render,
                persistRequested: isFixedImageEnabled()
            });
        }

        if (previous) {
            const readUrl = buildRecordUrl(previous);
            const task = createCompletedImageTask(buildRecordUrl(previous, token, true), readUrl, render);
            Object.assign(task, { record: previous, state, sourcePromptHash: descriptor.promptHash });
            imageSlotTasks.set(slotKey, task);
            return task;
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
            token,
            render,
            persistRequested: isFixedImageEnabled()
        });
    };

    window.RPH_MAGIC_IMAGE_TASK = options => {
        const deferredTask = { cards: new Set(), job: null, requestUrl: normalizeRequestUrl(options.requestUrl, options.characterName).href };
        const previousBinding = imageCardBindings.get(options.card);
        previousBinding?.task?.cards.delete(options.card);
        const binding = { task: null };
        imageCardBindings.set(options.card, binding);
        deferredTask.promise = startMagicImageTask(options).then(task => {
            if (!task) return { status: 'failed', error: '图片任务初始化失败' };
            deferredTask.requestUrl = task.requestUrl || deferredTask.requestUrl;
            deferredTask.job = task.job || null;
            deferredTask.cards.forEach(card => {
                if (imageCardBindings.get(card) !== binding) return;
                binding.task = task;
                task.cards?.forEach(node => { if (!node.isConnected) task.cards.delete(node); });
                task.cards?.add(card);
                card.dataset.imageRequest = deferredTask.requestUrl;
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

    const migrateRegexArray = value => {
        if (!Array.isArray(value)) return { value, changed: false };
        const oldRules = value.filter(rule => rule?.name === 'R2生图正则');
        if (oldRules.length === 0) return { value, changed: false };
        const enabled = oldRules.some(rule => rule.enabled === true);
        const next = value.filter(rule => rule?.name !== 'R2生图正则');
        const naiRule = next.find(rule => rule?.name === 'NAI画图正则');
        if (naiRule) {
            if (enabled) naiRule.enabled = true;
        } else {
            const replacement = { ...oldRules[0], name: 'NAI画图正则', enabled };
            next.splice(Math.min(value.indexOf(oldRules[0]), next.length), 0, replacement);
        }
        return { value: next, changed: true };
    };
    const migrateCharacterRegex = value => {
        if (!Array.isArray(value)) return { value, changed: false };
        let changed = false;
        const next = value.map(character => {
            if (!isObject(character) || !Array.isArray(character.regexScripts)) return character;
            const migrated = migrateRegexArray(character.regexScripts);
            if (!migrated.changed) return character;
            changed = true;
            return { ...character, regexScripts: migrated.value };
        });
        return { value: next, changed };
    };
    const migrateLegacyImageRegex = () => new Promise(resolve => {
        if (localStorage.getItem(LEGACY_REGEX_MIGRATION_KEY) === '1') return resolve(false);
        const request = indexedDB.open('RPHubDB');
        request.onupgradeneeded = event => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains('store')) db.createObjectStore('store');
        };
        request.onerror = () => resolve(false);
        request.onsuccess = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains('store')) {
                db.close();
                localStorage.setItem(LEGACY_REGEX_MIGRATION_KEY, '1');
                resolve(false);
                return;
            }
            let changed = false;
            const transaction = db.transaction(['store'], 'readwrite');
            const store = transaction.objectStore('store');
            ['rp_hub_regex', 'rp_hub_global_regex', 'rp_hub_characters'].forEach(key => {
                const getRequest = store.get(key);
                getRequest.onsuccess = () => {
                    const migrated = key === 'rp_hub_characters'
                        ? migrateCharacterRegex(getRequest.result)
                        : migrateRegexArray(getRequest.result);
                    if (!migrated.changed) return;
                    changed = true;
                    store.put(migrated.value, key);
                };
            });
            transaction.oncomplete = () => {
                db.close();
                localStorage.setItem(LEGACY_REGEX_MIGRATION_KEY, '1');
                resolve(changed);
            };
            transaction.onabort = () => {
                db.close();
                resolve(false);
            };
        };
    });

    migrateLegacyImageRegex().then(changed => {
        if (changed) location.reload();
    });

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
            '.app-sidebar[class~="md:w-16"] .magic-extension-actions{display:none}',
            '.app-navigation-user .magic-extension-actions{display:flex;align-items:center;gap:4px;margin-left:auto}',
            '.magic-image-nav{margin-top:4px}',
            '.magic-image-nav svg{flex:none}',
            '.magic-image-nav span{white-space:nowrap;overflow:hidden}',
            '.app-navigation-item.magic-image-nav{display:flex;align-items:center;gap:.65rem;width:100%;text-align:left}',
            '.app-navigation-item.magic-image-nav .magic-image-nav-icon{display:inline-flex;align-items:center;justify-content:center;flex:none;width:1.5rem;height:1.5rem}',
            '.app-sidebar[class~="md:w-16"] .magic-image-nav span{display:none}',
            '.app-sidebar[class~="md:w-16"] .magic-image-nav{width:3rem;height:3rem;margin-left:auto;margin-right:auto;justify-content:center;padding:0}',
            '.app-sidebar[class~="md:w-16"] .magic-image-nav svg{margin-right:0}',
            '.magic-fixed-image-toggle{display:flex;align-items:center;justify-content:space-between;gap:12px}',
            '.magic-fixed-image-toggle input{accent-color:#4f46e5}',
            '.magic-scroll-button{position:absolute;left:50%;top:-2.75rem;z-index:30;display:none;width:2.25rem;height:2.25rem;padding:0;pointer-events:auto;align-items:center;justify-content:center;border:1px solid #e5e7eb;border-radius:999px;transform:translateX(-50%);background:rgba(255,255,255,.95);color:#6b7280;box-shadow:0 10px 15px -3px rgba(15,23,42,.12),0 4px 6px -4px rgba(15,23,42,.12);backdrop-filter:blur(12px);cursor:pointer;transition:all .15s}',
            '.magic-scroll-button:hover{color:#4f46e5;border-color:#c7d2fe}',
            '.magic-scroll-button:active{transform:translateX(-50%) scale(.95)}',
            '.magic-scroll-button svg{width:1rem;height:1rem}',
            '.magic-scroll-button.is-visible{display:flex}',
            '.magic-scroll-sentinel{width:1px;height:1px;pointer-events:none}',
            '.magic-image-load-error{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:12px;background:#f8fafc;color:#64748b;font-size:14px}',
            '.magic-image-load-error button{padding:6px 10px;border:1px solid #cbd5e1;border-radius:8px;background:white;color:#2563eb;cursor:pointer}',
            '.magic-image-save-warning{position:absolute;bottom:8px;left:8px;right:8px;padding:5px 8px;border-radius:6px;background:#fff7ed;color:#9a3412;font-size:12px}'
        ].join('');
        document.head.appendChild(style);
    };

    const installSidebarActions = () => {
        if (typeof window.RPHubAuthorSaveData !== 'function') return;
        const cfg = navigationConfig();
        const userSelector = cfg.user || '.app-navigation-user';
        const userCard = document.querySelector(userSelector)
            || (() => {
                const sidebar = document.querySelector('.app-sidebar');
                return sidebar?.lastElementChild?.firstElementChild || sidebar?.lastElementChild || null;
            })();
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

        const nav = document.querySelector('.app-sidebar .sidebar-nav');
        if (!nav || nav.querySelector('.magic-image-nav')) return;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'sidebar-nav-button magic-image-nav flex items-center rounded-xl transition-all duration-200 font-medium w-full px-3 py-2.5 text-gray-600 hover:bg-gray-50 hover:text-gray-900';
        button.title = '图片管理';
        button.innerHTML = '<svg class="w-5 h-5 mr-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5zm3 10 3-3 2 2 2-2 3 3M8 8h.01"></path></svg><span>图片管理</span>';
        button.addEventListener('click', () => { window.location.href = '/image'; });
        const settingsButton = [...nav.querySelectorAll(':scope > button')].find(item => item.textContent.includes('设置'));
        nav.insertBefore(button, settingsButton || null);
    };
    const findFixedImageGrid = () => [...document.querySelectorAll('label')]
        .filter(label => [...label.querySelectorAll('span')].some(span => span.textContent.trim() === '沉浸模式'))
        .map(label => label.parentElement)
        .find(grid => grid?.classList.contains('grid')) || null;
    const installFixedImageSetting = () => {
        if (typeof window.RPHubAuthorSaveData !== 'function') return;
        const cfg = settingsConfig();
        const grid = cfg.labelSelector
            ? [...document.querySelectorAll(cfg.labelSelector)]
                .filter(label => textOf(label).includes(String(cfg.labelText || '沉浸模式')))
                .filter(label => cfg.anchorParentSelector ? label.closest(cfg.anchorParentSelector) : true)
                .slice(cfg.occurrence === 'last' ? -1 : 0)[0]?.closest(cfg.anchorParentSelector || 'div')
            : findFixedImageGrid();
        if (!grid || grid.querySelector('.magic-fixed-image-toggle')) return;
        const label = document.createElement('label');
        label.className = 'magic-fixed-image-toggle flex items-center justify-between gap-3 p-3 text-left rounded-xl border-2 border-transparent hover:border-gray-100 hover:bg-gray-50 transition-all cursor-pointer group';
        label.innerHTML = '<span class="text-sm font-medium text-gray-600 group-hover:text-gray-900">固定生图</span><span class="relative inline-flex flex-none items-center"><input type="checkbox" class="magic-fixed-image-input settings-toggle-input sr-only"><span class="settings-toggle settings-toggle--indigo"></span></span>';
        const input = label.querySelector('input');
        input.checked = isFixedImageEnabled();
        input.addEventListener('change', () => localStorage.setItem(FIXED_IMAGE_KEY, input.checked ? '1' : '0'));
        grid.insertBefore(label, cfg.insert === 'after' ? grid.children[0]?.nextSibling || null : grid.children[4] || null);
    };

    let scrollContainer = null;
    let scrollButtonNode = null;
    let scrollSentinelNode = null;
    let scrollIntersectionObserver = null;
    const installScrollButton = () => {
        const cfg = chatConfig();
        const input = document.querySelector(cfg.input || 'textarea.chat-input-scrollbar');
        const inputRow = input?.closest(cfg.row || '.relative.w-full.flex.items-end');
        const inputArea = input?.closest('.input-area-mobile')
            || input?.closest(cfg.area || '.input-island')?.parentElement
            || inputRow?.parentElement;
        if (!inputRow || !inputArea) {
            scrollIntersectionObserver?.disconnect();
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
    const observeUiTargets = () => {
        uiObserver.disconnect();
        const targets = new Set([
            document.body,
            document.getElementById('app'),
            document.querySelector('.app-sidebar'),
            document.querySelector(navigationConfig().content || '.app-navigation-content'),
            document.querySelector('.app-main'),
            findFixedImageGrid(),
            document.querySelector(chatConfig().input || 'textarea.chat-input-scrollbar')?.closest(chatConfig().row || '.relative.w-full.flex.items-end'),
            scrollContainer
        ].filter(Boolean));
        targets.forEach(target => {
            const subtree = target.classList?.contains('app-sidebar')
                || target.matches?.('#app, .app-navigation-content') || false;
            uiObserver.observe(target, { childList: true, subtree });
        });
    };
    function reconcileUi() {
        installSidebarActions();
        installImageNav();
        installFixedImageSetting();
        installScrollButton();
        observeUiTargets();
    }
    const start = () => {
        installStyle();
        loadUiAdapter().finally(reconcileUi);
        document.addEventListener('click', event => {
            if (!event.target.closest?.('.sidebar-nav-button, .advanced-nav-trigger, .app-nav-trigger')) return;
            requestAnimationFrame(reconcileUi);
            setTimeout(reconcileUi, 250);
        }, true);
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
})();

// RP Hub 魔改版 - 同步客户端 v2
//
// 协议：rp-sync/v2（全量根清单 + gzip 内容寻址分片，无服务端会话、无分页清单、
// 无 Bloom、无 GC 状态机）。上传 = 逐片 PUT（幂等）→ commit（CAS 切根，服务端
// 顺带回收孤儿分片）；恢复 = 读根清单 → 逐片 GET（边缘缓存）→ 两遍 staging 恢复。
// 设计前提：个人单用户、无并发写者；免费版网络（国内高延迟）优先优化请求数与字节。
function createAutoSaveScheduler(options = {}) {
    const setTimer = options.setTimeout || setTimeout;
    const clearTimer = options.clearTimeout || clearTimeout;
    const now = typeof options.now === 'function' ? options.now : () => performance.now();
    const wallNow = typeof options.wallNow === 'function' ? options.wallNow : Date.now;
    const isActive = typeof options.isActive === 'function' ? options.isActive : () => true;
    const tickMs = Number.isFinite(Number(options.tickMs)) && Number(options.tickMs) > 0
        ? Number(options.tickMs) : 30 * 1000;
    const lateToleranceMs = Number.isFinite(Number(options.lateToleranceMs))
        && Number(options.lateToleranceMs) >= 0 ? Number(options.lateToleranceMs) : 5000;
    let enabled = false;
    let active = false;
    let remainingMs = 0;
    let lastActiveAt = 0;
    let lastWallAt = 0;
    let timerId = null;
    let generation = 0;

    const emit = phase => options.onState?.({
        phase,
        enabled,
        active,
        remainingMs,
        timerActive: timerId !== null
    });
    const clearScheduled = () => {
        if (timerId === null) return;
        clearTimer(timerId);
        timerId = null;
    };
    const readNow = () => {
        const value = Number(now());
        return Number.isFinite(value) ? value : Date.now();
    };
    const consumeElapsed = current => {
        const wall = Number(wallNow());
        const elapsed = current - lastActiveAt;
        const wallElapsed = wall - lastWallAt;
        const expected = Math.min(remainingMs, tickMs);
        const uncertain = elapsed < 0 || !Number.isFinite(wall)
            || elapsed > expected + lateToleranceMs
            || Math.abs(wallElapsed - elapsed) > lateToleranceMs;
        lastActiveAt = current;
        lastWallAt = wall;
        // Browser clocks may include OS sleep; uncertain intervals only delay saving.
        if (!uncertain) remainingMs = Math.max(0, remainingMs - elapsed);
        return remainingMs === 0;
    };
    const schedule = () => {
        clearScheduled();
        if (!enabled || !active) return;
        const delay = Math.max(1, Math.min(remainingMs, tickMs));
        const expectedGeneration = generation;
        timerId = setTimer(() => {
            if (expectedGeneration !== generation) return;
            timerId = null;
            if (!enabled || !active) return;
            if (!isActive()) {
                pause();
                return;
            }
            const current = readNow();
            if (consumeElapsed(current)) {
                active = false;
                generation += 1;
                emit('due');
                let result;
                try {
                    result = options.onDue?.();
                } catch (error) {
                    options.onError?.(error);
                    return;
                }
                Promise.resolve(result).catch(error => options.onError?.(error));
                return;
            }
            schedule();
        }, delay);
    };
    function start(intervalMs) {
        const duration = Number(intervalMs);
        if (!Number.isFinite(duration) || duration <= 0) throw new RangeError('自动保存间隔无效。');
        clearScheduled();
        enabled = true;
        remainingMs = duration;
        lastActiveAt = readNow();
        lastWallAt = Number(wallNow());
        active = Boolean(isActive());
        generation += 1;
        schedule();
        emit('start');
    }
    function pause() {
        if (!enabled) return;
        if (active) {
            const current = readNow();
            consumeElapsed(current);
        }
        active = false;
        generation += 1;
        clearScheduled();
        emit('pause');
    }
    function resume() {
        if (!enabled || active) return;
        active = Boolean(isActive());
        if (!active) return;
        lastActiveAt = readNow();
        lastWallAt = Number(wallNow());
        generation += 1;
        schedule();
        emit('resume');
    }
    function stop() {
        enabled = false;
        active = false;
        remainingMs = 0;
        generation += 1;
        clearScheduled();
        emit('stop');
    }
    return Object.freeze({
        start,
        pause,
        resume,
        stop,
        getState: () => ({ enabled, active, remainingMs, timerActive: timerId !== null })
    });
}

(function () {
    // ---- 协议常量（客户端侧）----
    const SNAPSHOT_FORMAT = 'rp-sync-manifest-v2';
    const SNAPSHOT_COMPRESSION = 'gzip';
    const DOWNLOAD_STAGING_DB = 'RPHubSyncStaging';
    const DOWNLOAD_STAGING_DB_VERSION = 3;
    const DOWNLOAD_STAGING_STORE = 'packs';
    const RESTORE_PAGE = Boolean(
        typeof document !== 'undefined'
        && document.documentElement?.hasAttribute?.('data-rp-sync-restore')
        || typeof location !== 'undefined' && location.pathname === '/sync-restore'
    );
    // 恢复页判定与 dirty-tracker.js 头部的 RESTORE_PAGE 是同一判定的两份
    // 副本（bootstrap 多了非浏览器环境的 typeof 守卫），语义改动须双侧同步。
    const PAGE_SCOPE = ['/', '/index.html', '/sync-restore'];
    if (typeof location !== 'undefined' && !RESTORE_PAGE && !PAGE_SCOPE.includes(location.pathname)) {
        return;
    }
    if (RESTORE_PAGE && typeof location !== 'undefined' && location.pathname === '/sync-restore'
        && typeof history !== 'undefined' && typeof history.replaceState === 'function') {
        history.replaceState(null, '', '/');
    }

    const CONFIG = {
        apiEndpoint: '/api/rp-sync',
        packEndpoint: '/api/rp-sync/pack',
        passwordStorageKey: 'rp_hub_sync_password_v1',
        autoSaveEnabledKey: 'rp_hub_sync_auto_save_enabled_v1',
        autoSaveMinutesKey: 'rp_hub_sync_auto_save_minutes_v1',
        lastSyncKey: 'rp_hub_sync_last_result_v1',
        autoSaveDefaultMinutes: 5,
        autoSaveMinMinutes: 1,
        autoSaveMaxMinutes: 1440,
        autoSaveTickMs: 30 * 1000,
        autoSaveLateToleranceMs: 5000,
        knownDatabases: [
            { name: 'RPHubDB', stores: ['store'] },
            { name: 'AICharGen', stores: ['characters'] }
        ],
        localStoragePrefixes: ['rp_hub_', 'ai_chargen_'],
        maxSnapshotBytes: 1024 * 1024 * 1024,
        maxPackCount: 4096,
        // 分片原始上限 4MiB、记录上限 512 条；gzip 后传输（JSONL 压缩比通常 3-6 倍）。
        // 一请求仍只携带一片：Worker 把正文流式直通 R2，不在 isolate 内聚合。
        targetPackBytes: 4 * 1024 * 1024,
        maxPackEntries: 512,
        uploadConcurrency: 6,
        downloadPackConcurrency: 6,
        requestTimeoutMs: 60_000,
        packTransferTimeoutMs: 120_000,
        commitTimeoutMs: 120_000,
        retryCount: 3,
        retryDelayMs: 600,
        readBatchSize: 256,
        // 无变化自动保存的快速通道：本地校验和与云端一致时跳过网络，只确认
        // 水位。云端根此刻是否仍与本机记忆一致，由每满这个间隔的一次完整
        // 验证兜底（免费版个人单用户下，云端只可能被本机自己改写）。
        fastPathVerifyIntervalMs: 3600 * 1000,
        // 首扫批次：单条作者记录可能是一整段对话，批次在记录数与估算字节双限。
        scanBatchRecords: 64,
        scanBatchBytes: 8 * 1024 * 1024,
        restoreBatchSize: 64,
        cacheWriteBytes: 1024 * 1024,
        yieldIntervalMs: 12
    };

    // ---- 跨文件协议常量（人肉双写）----
    // 下面 JOURNAL_STORE / STORAGE_INTENT_PREFIX / TRACKING_EPOCH_KEY /
    // RESTORE_ACTIVE_KEY / RESTORE_EPOCH_KEY 与 DB/dirty-tracker.js 头部的
    // 同名常量是同一份协议的两份副本（纯静态文件没有构建注入）。任何一侧
    // 改名必须双侧同步；tests/audit-regressions.mjs 的静态断言逐字比较。
    const LOCAL_CACHE_DB = 'RPHubSyncCache';
    const LOCAL_CACHE_DB_VERSION = 5;
    const LOCAL_CACHE_ENTRY_STORE = 'entries';
    const LOCAL_CACHE_STATE_STORE = 'state';
    const LOCAL_CACHE_PACK_STORE = 'packs';
    const JOURNAL_STORE = '__rp_sync_journal_v2';
    // journal 里的追踪 epoch 标记键（string 键，值是 dirty-tracker 建库时
    // 写入的随机 UUID）：键名与 dirty-tracker.js L147 的字面量是同一份协议
    // 的两份副本，改名必须双侧同步。
    const JOURNAL_EPOCH_KEY = '__epoch__';
    const STORAGE_INTENT_PREFIX = 'rp_sync_intent_v2:';
    const TRACKING_EPOCH_KEY = 'rp_sync_tracking_epoch_v2';
    const CACHE_STATE_KEY = 'snapshot';
    const CACHE_FORMAT_VERSION = 9;
    const RESTORE_ACTIVE_KEY = 'rp_sync_restore_active';
    const RESTORE_EPOCH_KEY = 'rp_sync_restore_epoch';
    const STABLE_BUCKET_COUNT = 256;
    const ARRAY_BUCKET_ENTRIES = 32;

    const MAX_SUPPORTED_OBJECT_BYTES = 64 * 1024 * 1024;

    const state = {
        syncing: false,
        operationPending: false,
        progress: 0,
        statusText: '请选择同步方向。'
    };

    const AUTO_SAVE_CONFIG = Object.freeze({
        defaultMinutes: CONFIG.autoSaveDefaultMinutes,
        minMinutes: CONFIG.autoSaveMinMinutes,
        maxMinutes: CONFIG.autoSaveMaxMinutes
    });

    // ---- 面板样式（自注入，不依赖外部样式表时序）----
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
    let syncStyleInstalled = false;
    function ensureSyncStyle() {
        if (syncStyleInstalled) return;
        syncStyleInstalled = true;
        const style = document.createElement('style');
        style.textContent = SYNC_STYLE_TEXT;
        (document.head || document.documentElement).appendChild(style);
    }
    if (typeof document !== 'undefined') ensureSyncStyle();

    const textEncoder = new TextEncoder();

    let modalRoot = null;
    let modalStatus = null;
    let modalProgressBar = null;
    let modalProgressValue = null;
    let pullButton = null;
    let pushButton = null;
    let rebuildButton = null;
    let passwordModalRoot = null;
    let passwordInput = null;
    let passwordStatus = null;
    let passwordSubmitButton = null;
    let autoSaveToggle = null;
    let autoSaveMinutesInput = null;
    let autoSaveStatus = null;
    let autoSaveScheduler = null;
    let autoSaveLastError = '';
    let autoSaveRunning = false;
    let checkingPassword = false;

    function wait(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // 让出控制器：连续工作超过间隔后让出主线程。后台准备期间启用低占空比
    // 模式（工作 6ms → 睡 8ms，约 43%），手机上完整扫描不持续烧 CPU、不抢
    // 作者前端的性能；上传路径保持全速（工作 12ms → 让出 0ms）。
    let backgroundYield = false;
    function createYieldController() {
        let lastYieldAt = performance.now();
        return async function yieldIfNeeded() {
            const interval = backgroundYield ? 6 : CONFIG.yieldIntervalMs;
            if (performance.now() - lastYieldAt < interval) return;
            await wait(backgroundYield ? 8 : 0);
            lastYieldAt = performance.now();
        };
    }

    async function runSyncOperation(task, options = {}) {
        const automatic = Boolean(options.automatic);
        if (state.operationPending || state.syncing) return { skipped: true, reason: 'syncing' };
        if (automatic && (!isAutoSaveEnabled() || !isAutoSavePageActive())) {
            return { skipped: true, reason: 'inactive' };
        }
        state.operationPending = true;
        autoSaveScheduler?.pause();
        setActionButtonsDisabled(true);
        try {
            if (automatic && (!isAutoSaveEnabled() || !isAutoSavePageActive())) {
                return { skipped: true, reason: 'inactive' };
            }
            return await task();
        } finally {
            state.operationPending = false;
            setActionButtonsDisabled(false);
            restartAutoSaveCycle();
        }
    }

    function getStoredSyncPassword() {
        return localStorage.getItem(CONFIG.passwordStorageKey) || '';
    }

    function saveStoredSyncPassword(password) {
        localStorage.setItem(CONFIG.passwordStorageKey, password);
    }

    function clearStoredSyncPassword() {
        localStorage.removeItem(CONFIG.passwordStorageKey);
    }

    function waitForTransaction(tx, message, getValue = () => undefined) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (callback, value) => {
                if (settled) return;
                settled = true;
                callback(value);
            };
            tx.addEventListener('complete', () => {
                try {
                    finish(resolve, getValue());
                } catch (error) {
                    finish(reject, error);
                }
            }, { once: true });
            tx.addEventListener('error', () => {
                finish(reject, tx.error || new Error(message));
            }, { once: true });
            tx.addEventListener('abort', () => {
                finish(reject, tx.error || new Error(`${message} aborted`));
            }, { once: true });
        });
    }

    function openDbByName(dbName) {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(dbName);
            request.onerror = () => reject(request.error || new Error('IndexedDB open failed.'));
            request.onsuccess = () => resolve(request.result);
        });
    }

    // 读取变更日志：afterDatabases 给出各库已消费的水位（journal 自增主键）
    // 时只扫描其后的事件——历史事件早已差分进缓存，重放只会靠字节比较幂等
    // 地空转；watermark 记录本次扫到的末尾，供上传成功后整段确认。
    async function readDirtyState(afterDatabases = null) {
        const watermark = { databases: {}, intents: [] };
        const dirty = { localStorage: new Set(), stores: new Map(), watermark, epochs: {} };
        for (let index = 0; index < localStorage.length; index += 1) {
            const intent = localStorage.key(index);
            if (!intent?.startsWith(STORAGE_INTENT_PREFIX)) continue;
            const key = localStorage.getItem(intent);
            if (key !== null) { watermark.intents.push(intent); dirty.localStorage.add(key); }
        }
        for (const name of await listIndexedDbNames()) {
            const after = afterDatabases?.[name];
            const db = await openDbByName(name);
            try {
                if (!db.objectStoreNames.contains(JOURNAL_STORE)) throw new Error('本地变更追踪未就绪，请刷新后重试。');
                const tx = db.transaction(JOURNAL_STORE, 'readonly');
                // __epoch__ 是 string 键，恒排在全部数字键之后，增量范围同样会扫到。
                const range = typeof after === 'number' ? IDBKeyRange.lowerBound(after, true) : null;
                const request = tx.objectStore(JOURNAL_STORE).openCursor(range);
                request.onsuccess = () => {
                    const cursor = request.result;
                    if (!cursor) return;
                    if (cursor.key === '__epoch__') { dirty.epochs[name] = cursor.value; cursor.continue(); return; }
                    const event = cursor.value;
                    watermark.databases[name] = cursor.key;
                    const identity = `${name}/${event.store}`;
                    const item = dirty.stores.get(identity) || { clear: false, keys: new Map() };
                    if (event.clear) { item.clear = true; item.keys.clear(); }
                    else item.keys.set(stableKeyToken(event.key), event.key);
                    dirty.stores.set(identity, item);
                    cursor.continue();
                };
                await waitForTransaction(tx, '变更日志读取失败。');
            } finally { db.close(); }
        }
        return dirty;
    }

    function requestExplicitRebuild() {
        localStorage.setItem('rp_sync_rebuild_requested', '1');
    }

    // 无变化快速通道判定（纯本地读取，不发网络）。安全判据是"变更日志已
    // 全部确认"：数字键为空 = acknowledge 追平了最后一次快照准备的水位 =
    // 缓存快照与云端根一致（期间若有 prepare 消费过未上传的新写入，那些
    // 事件会留在 journal 里，判据自然不成立）。__epoch__ 变化说明追踪被
    // 重置，必须走完整流程；localStorage 意图存在说明有待同步的应用键写入。
    async function journalIsFullyAcknowledged(expectedEpochs) {
        for (let index = 0; index < localStorage.length; index += 1) {
            if (String(localStorage.key(index) || '').startsWith(STORAGE_INTENT_PREFIX)) return false;
        }
        try {
            for (const name of await listIndexedDbNames()) {
                const db = await openDbByName(name);
                try {
                    if (!db.objectStoreNames.contains(JOURNAL_STORE)) return false;
                    const tx = db.transaction(JOURNAL_STORE, 'readonly');
                    const keysRequest = tx.objectStore(JOURNAL_STORE).getAllKeys();
                    const epochRequest = tx.objectStore(JOURNAL_STORE).get(JOURNAL_EPOCH_KEY);
                    const { keys, epoch } = await waitForTransaction(tx, '变更日志读取失败。', () => ({ keys: keysRequest.result, epoch: epochRequest.result }));
                    if ((epoch || null) !== (expectedEpochs?.[name] || null)) return false;
                    if (keys.some(key => typeof key === 'number')) return false;
                } finally { db.close(); }
            }
        } catch (_) {
            return false; // 判定失败按"需要完整流程"处理
        }
        return true;
    }

    function assertRestoreStoreSchema(db, stores) {
        const existing = stores.filter(store => db.objectStoreNames.contains(store.name));
        if (!existing.length) return;
        const tx = db.transaction(existing.map(store => store.name), 'readonly');
        for (const definition of existing) {
            const store = tx.objectStore(definition.name);
            if (JSON.stringify(store.keyPath ?? null) !== JSON.stringify(definition.keyPath ?? null)
                || store.autoIncrement !== Boolean(definition.autoIncrement)) {
                throw new Error(`本地数据库 ${db.name}/${store.name} 的结构与云端快照不兼容，恢复已停止，本地数据未覆盖。`);
            }
        }
    }

    async function preflightRestoreDatabase(dbDef) {
        if (typeof indexedDB.databases === 'function') {
            const databases = await indexedDB.databases();
            if (!databases.some(db => db.name === dbDef.name)) return;
        }
        const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open(dbDef.name);
            let missing = false;
            request.onupgradeneeded = () => {
                missing = true;
                request.transaction.abort();
            };
            request.onerror = event => {
                event.preventDefault();
                if (missing) resolve(null);
                else reject(request.error || new Error('恢复前数据库结构检查失败。'));
            };
            request.onsuccess = () => resolve(request.result);
        });
        if (!db) return;
        try { assertRestoreStoreSchema(db, dbDef.stores); }
        finally { db.close(); }
    }

    function createObjectStoreFromSnapshot(db, storeDef) {
        if (db.objectStoreNames.contains(storeDef.name)) return;
        const options = {};
        if (storeDef.keyPath !== null && typeof storeDef.keyPath !== 'undefined') {
            options.keyPath = storeDef.keyPath;
        }
        if (storeDef.autoIncrement) {
            options.autoIncrement = true;
        }
        db.createObjectStore(storeDef.name, options);
    }

    function openDbForRestore(dbDef) {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(dbDef.name);
            request.onerror = () => reject(request.error || new Error('IndexedDB restore open failed.'));
            request.onupgradeneeded = () => {
                const db = request.result;
                for (const storeDef of dbDef.stores || []) {
                    createObjectStoreFromSnapshot(db, storeDef);
                }
            };
            request.onsuccess = () => {
                const db = request.result;
                const missingStores = (dbDef.stores || [])
                    .filter(storeDef => !db.objectStoreNames.contains(storeDef.name));
                if (missingStores.length === 0) {
                    resolve(db);
                    return;
                }
                const nextVersion = db.version + 1;
                db.close();
                const upgradeRequest = indexedDB.open(dbDef.name, nextVersion);
                upgradeRequest.onerror = () => reject(upgradeRequest.error || new Error('IndexedDB restore upgrade failed.'));
                upgradeRequest.onupgradeneeded = () => {
                    const upgradedDb = upgradeRequest.result;
                    for (const storeDef of dbDef.stores || []) {
                        createObjectStoreFromSnapshot(upgradedDb, storeDef);
                    }
                };
                upgradeRequest.onsuccess = () => resolve(upgradeRequest.result);
            };
        });
    }

    function isAppLocalStorageKey(key) {
        return key !== CONFIG.passwordStorageKey
            && !key.startsWith('rp_hub_sync_')
            && CONFIG.localStoragePrefixes.some(prefix => key.startsWith(prefix));
    }

    function isSyncExcludedRecord(database, store, key) {
        return database === 'RPHubDB'
            && store === 'store'
            && key === 'rp_hub_presets';
    }

    function compareCodeUnits(a, b) {
        return a < b ? -1 : a > b ? 1 : 0;
    }

    function readLocalStorageSnapshot() {
        const entries = [];
        for (let index = 0; index < localStorage.length; index += 1) {
            const key = localStorage.key(index);
            if (key === null || !isAppLocalStorageKey(key)) continue;
            entries.push({ key, value: localStorage.getItem(key) });
        }
        entries.sort((a, b) => compareCodeUnits(a.key, b.key));
        return entries;
    }

    async function listIndexedDbNames() {
        const knownNames = CONFIG.knownDatabases.map(dbDef => dbDef.name);
        if (typeof indexedDB.databases === 'function') {
            try {
                const databases = await indexedDB.databases();
                const existingNames = new Set((databases || [])
                    .map(dbInfo => dbInfo?.name)
                    .filter(name => typeof name === 'string' && name));
                return knownNames.filter(name => existingNames.has(name));
            } catch (error) {
                // Some browsers expose indexedDB.databases but may reject it.
            }
        }
        return knownNames;
    }

    function estimateRecordBytes(value, depth = 0) {
        if (value === null || value === undefined) return 16;
        const type = typeof value;
        if (type === 'string') return value.length * 2 + 24;
        if (type === 'number' || type === 'boolean' || type === 'bigint') return 24;
        if (value instanceof Date) return 24;
        if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value.byteLength + 24;
        if (depth >= 8) return 512;
        let bytes = 64;
        if (Array.isArray(value)) {
            for (const item of value) bytes += estimateRecordBytes(item, depth + 1);
        } else {
            for (const key of Object.keys(value)) {
                bytes += 24 + estimateRecordBytes(value[key], depth + 1);
            }
        }
        return bytes;
    }

    function readObjectStoreRecordBatch(db, storeName, afterKey, hasAfterKey) {
        const tx = db.transaction([storeName], 'readonly');
        const store = tx.objectStore(storeName);
        const range = hasAfterKey ? IDBKeyRange.lowerBound(afterKey, true) : null;
        const records = [];
        let batchBytes = 0;
        const request = store.openCursor(range);
        let result;
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) {
                result = { records, done: true, lastKey: afterKey };
                return;
            }
            // Stop before deserializing the next record into the batch, so a
            // single oversized author record never inflates it. lastKey must be
            // the last key already read: the next batch resumes with an
            // exclusive lower bound, so returning the unread cursor.key here
            // would silently skip that record.
            if (records.length >= CONFIG.scanBatchRecords || batchBytes >= CONFIG.scanBatchBytes) {
                result = { records, done: false, lastKey: records[records.length - 1].key };
                return;
            }
            records.push({ key: cursor.key, value: cursor.value });
            batchBytes += estimateRecordBytes(cursor.value);
            cursor.continue();
        };
        return waitForTransaction(tx, 'IndexedDB cursor read failed.', () => result);
    }

    async function* iterateObjectStoreRecords(db, storeName) {
        let hasAfterKey = false;
        let afterKey;
        const yieldIfNeeded = createYieldController();
        while (true) {
            const batch = await readObjectStoreRecordBatch(db, storeName, afterKey, hasAfterKey);
            for (const record of batch.records) {
                yield record;
            }
            if (batch.done) return;
            hasAfterKey = true;
            afterKey = batch.lastKey;
            await yieldIfNeeded();
        }
    }

    function stableKeyToken(key) {
        return JSON.stringify(key);
    }

    function readObjectStoreKeys(db, storeName) {
        const tx = db.transaction([storeName], 'readonly');
        const store = tx.objectStore(storeName);
        const keys = [];
        const request = store.openKeyCursor();
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) return;
            keys.push(cursor.key);
            cursor.continue();
        };
        return waitForTransaction(tx, 'IndexedDB key read failed.', () => keys);
    }

    function clearObjectStore(db, storeName) {
        if (!db.objectStoreNames.contains(storeName)) return Promise.resolve();
        const tx = db.transaction([storeName], 'readwrite');
        tx.objectStore(storeName).clear();
        return waitForTransaction(tx, 'IndexedDB clear failed.');
    }

    async function deleteObjectStoreKeys(db, storeName, keys) {
        const yieldIfNeeded = createYieldController();
        for (let start = 0; start < keys.length; start += CONFIG.restoreBatchSize) {
            const batch = keys.slice(start, start + CONFIG.restoreBatchSize);
            const tx = db.transaction([storeName], 'readwrite');
            const store = tx.objectStore(storeName);
            batch.forEach(key => store.delete(key));
            await waitForTransaction(tx, 'IndexedDB cleanup failed.');
            await yieldIfNeeded();
        }
    }

    async function clearKnownIndexedDbStores(dbDef, storeNames) {
        const dbNames = await listIndexedDbNames();
        if (!dbNames.includes(dbDef.name)) return;
        const db = await openDbByName(dbDef.name);
        try {
            for (const storeName of storeNames) {
                if (!db.objectStoreNames.contains(storeName)) continue;
                if (isSyncExcludedRecord(dbDef.name, storeName, 'rp_hub_presets')) {
                    const keys = await readObjectStoreKeys(db, storeName);
                    await deleteObjectStoreKeys(
                        db,
                        storeName,
                        keys.filter(key => !isSyncExcludedRecord(dbDef.name, storeName, key))
                    );
                } else {
                    await clearObjectStore(db, storeName);
                }
            }
        } finally {
            db.close();
        }
    }

    function writeObjectStoreRecordBatch(db, storeDef, records) {
        if (!Array.isArray(records) || records.length === 0) return Promise.resolve();
        const tx = db.transaction([storeDef.name], 'readwrite');
        const store = tx.objectStore(storeDef.name);
        for (const record of records) {
            if (storeDef.keyPath !== null && typeof storeDef.keyPath !== 'undefined') {
                store.put(record.value);
            } else {
                store.put(record.value, record.key);
            }
        }
        return waitForTransaction(tx, 'IndexedDB restore failed.');
    }

    async function deleteMissingObjectStoreRecords(db, database, storeName, incomingKeyTokens) {
        const existingKeys = await readObjectStoreKeys(db, storeName);
        const keysToDelete = existingKeys.filter(key => {
            if (isSyncExcludedRecord(database, storeName, key)) return false;
            const token = stableKeyToken(key);
            return !incomingKeyTokens.has(token);
        });
        await deleteObjectStoreKeys(db, storeName, keysToDelete);
    }

    async function waitForIndexedDbWriteBarrier() {
        const dbNames = await listIndexedDbNames();
        for (const dbDef of CONFIG.knownDatabases) {
            if (!dbNames.includes(dbDef.name)) continue;
            const db = await openDbByName(dbDef.name);
            try {
                const storeNames = dbDef.stores.filter(storeName => db.objectStoreNames.contains(storeName));
                for (const storeName of storeNames) {
                    const tx = db.transaction([storeName], 'readwrite');
                    const request = tx.objectStore(storeName).get('__rp_sync_write_barrier__');
                    request.onerror = () => { /* transaction handler below supplies the final error */ };
                    await waitForTransaction(tx, 'IndexedDB write barrier failed.');
                }
            } finally {
                db.close();
            }
        }
    }

    async function sha256(text) {
        return sha256Bytes(textEncoder.encode(text));
    }

    async function sha256Bytes(bytes) {
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
    }

    // gzip/解压：CompressionStream 在所有受支持浏览器可用；不可用时显式报错
    // （协议双方都固定 gzip，不做无压缩回退，保持键稳定）。
    async function gzipBytes(bytes) {
        if (typeof CompressionStream !== 'function') throw new Error('当前浏览器不支持 CompressionStream，无法同步。');
        const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }

    async function gunzipBytes(bytes) {
        if (typeof DecompressionStream !== 'function') throw new Error('当前浏览器不支持 DecompressionStream，无法恢复。');
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }

    function serializeSnapshotObject(value) {
        const seen = new Set();
        // 跨 realm 安全的"普通对象"判定：普通对象的原型链是 Object.prototype
        // （或 null），再往上一层必然是 null；类实例/Map/Set 的原型链更长。
        // 不直接比较 Object.prototype 是为了兼容多 realm 嵌入环境。
        const isPlainObject = item => {
            const proto = Object.getPrototypeOf(item);
            return proto === null || Object.getPrototypeOf(proto) === null;
        };
        const canonical = item => {
            // Date 是作者数据里合法且常见的类型；JSON 本身没有日期，统一转
            // ISO 字符串，保证同一时刻在不同浏览器得到相同 canonical 字节。
            if (item instanceof Date) {
                if (!Number.isFinite(item.getTime())) {
                    throw new Error('数据包含无效日期，已停止同步以避免丢失。');
                }
                return item.toISOString();
            }
            if (item === null || typeof item !== 'object') {
                if (item === undefined || (typeof item === 'number' && !Number.isFinite(item))
                    || typeof item === 'bigint' || typeof item === 'function' || typeof item === 'symbol') {
                    throw new Error('数据包含不支持的非 JSON 值，已停止同步以避免丢失。');
                }
                return item;
            }
            if (seen.has(item) || (!Array.isArray(item) && !isPlainObject(item))) {
                throw new Error('数据包含循环引用或非 JSON 对象，已停止同步以避免丢失。');
            }
            seen.add(item);
            const out = Array.isArray(item) ? item.map(canonical) : Object.create(null);
            if (!Array.isArray(item)) for (const key of Object.keys(item).sort()) out[key] = canonical(item[key]);
            seen.delete(item);
            return out;
        };
        const json = JSON.stringify(canonical(value));
        if (typeof json !== 'string') throw new Error('本地数据包含无法序列化的内容。');
        return textEncoder.encode(json);
    }

    function openLocalSyncCache() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(LOCAL_CACHE_DB, LOCAL_CACHE_DB_VERSION);
            request.onerror = () => reject(request.error || new Error('本地同步索引打开失败。'));
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(LOCAL_CACHE_ENTRY_STORE)) {
                    const store = db.createObjectStore(LOCAL_CACHE_ENTRY_STORE, { keyPath: 'id' });
                    store.createIndex('sourceKey', 'sourceKey', { unique: false });
                } else {
                    const store = request.transaction.objectStore(LOCAL_CACHE_ENTRY_STORE);
                    if (store.indexNames.contains('bucketKey')) store.deleteIndex('bucketKey');
                    if (!store.indexNames.contains('sourceKey')) store.createIndex('sourceKey', 'sourceKey', { unique: false });
                }
                const entries = request.transaction.objectStore(LOCAL_CACHE_ENTRY_STORE);
                if (!entries.indexNames.contains('order')) entries.createIndex('order', ['bucketKey', 'sortKey', 'id']);
                if (!db.objectStoreNames.contains(LOCAL_CACHE_STATE_STORE)) db.createObjectStore(LOCAL_CACHE_STATE_STORE);
                if (!db.objectStoreNames.contains(LOCAL_CACHE_PACK_STORE)) db.createObjectStore(LOCAL_CACHE_PACK_STORE);
            };
            request.onsuccess = () => resolve(request.result);
        });
    }

    function cacheReadState(db) {
        const tx = db.transaction([LOCAL_CACHE_STATE_STORE], 'readonly');
        const request = tx.objectStore(LOCAL_CACHE_STATE_STORE).get(CACHE_STATE_KEY);
        return waitForTransaction(tx, '本地同步索引读取失败。', () => request.result || null);
    }

    function cacheWriteState(db, value) {
        const tx = db.transaction([LOCAL_CACHE_STATE_STORE], 'readwrite');
        tx.objectStore(LOCAL_CACHE_STATE_STORE).put(value, CACHE_STATE_KEY);
        return waitForTransaction(tx, '本地同步索引写入失败。');
    }

    function cacheReadEntry(db, id) {
        const tx = db.transaction([LOCAL_CACHE_ENTRY_STORE], 'readonly');
        const request = tx.objectStore(LOCAL_CACHE_ENTRY_STORE).get(id);
        return waitForTransaction(tx, '本地同步对象读取失败.', () => request.result);
    }

    async function readCacheEntries(db, ids) {
        const entries = [];
        for (let start = 0; start < ids.length; start += CONFIG.restoreBatchSize) {
            const batch = ids.slice(start, start + CONFIG.restoreBatchSize);
            const tx = db.transaction([LOCAL_CACHE_ENTRY_STORE], 'readonly');
            const requests = batch.map(id => tx.objectStore(LOCAL_CACHE_ENTRY_STORE).get(id));
            const values = await waitForTransaction(tx, '本地同步对象读取失败。', () => requests.map(request => request.result));
            entries.push(...values);
        }
        return entries;
    }

    function cacheSourceKeys(db, sourceKey) {
        const tx = db.transaction([LOCAL_CACHE_ENTRY_STORE], 'readonly');
        const request = tx.objectStore(LOCAL_CACHE_ENTRY_STORE).index('sourceKey').getAllKeys(sourceKey);
        return waitForTransaction(tx, '本地同步对象索引读取失败。', () => request.result || []);
    }

    async function* iterateCachedBucket(db, bucketKey) {
        let after;
        while (true) {
            const tx = db.transaction(LOCAL_CACHE_ENTRY_STORE, 'readonly');
            const index = tx.objectStore(LOCAL_CACHE_ENTRY_STORE).index('order');
            const range = IDBKeyRange.bound(after || [bucketKey], [bucketKey, []], Boolean(after), true);
            const request = index.openCursor(range);
            const entries = [];
            let byteLength = 0;
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) return;
                entries.push(cursor.value);
                byteLength += cursor.value.bytes.byteLength;
                after = cursor.key;
                if (entries.length >= CONFIG.readBatchSize || byteLength >= CONFIG.cacheWriteBytes) return;
                cursor.continue();
            };
            const batch = await waitForTransaction(tx, '本地分片读取失败。', () => ({ entries, done: entries.length === 0 || entries.length < CONFIG.readBatchSize && byteLength < CONFIG.cacheWriteBytes }));
            for (const entry of batch.entries) yield entry;
            if (batch.done) return;
        }
    }

    function cachePack(db, checksum) {
        const tx = db.transaction(LOCAL_CACHE_PACK_STORE, 'readonly');
        const request = tx.objectStore(LOCAL_CACHE_PACK_STORE).get(checksum);
        return waitForTransaction(tx, '本地分片缓存失败。', () => request.result);
    }

    function cacheWritePacks(db, packs) {
        if (!Array.isArray(packs) || packs.length === 0) return Promise.resolve();
        const tx = db.transaction(LOCAL_CACHE_PACK_STORE, 'readwrite');
        const store = tx.objectStore(LOCAL_CACHE_PACK_STORE);
        packs.forEach(pack => store.put(pack.bytes, pack.checksum));
        return waitForTransaction(tx, '本地分片缓存失败。');
    }

    async function pruneCachedPacks(db, packs) {
        const active = new Set(packs.map(pack => pack.checksum));
        const keys = await readObjectStoreKeys(db, LOCAL_CACHE_PACK_STORE);
        await deleteObjectStoreKeys(db, LOCAL_CACHE_PACK_STORE, keys.filter(key => !active.has(key)));
    }

    function cacheWriteEntries(db, entries) {
        if (!Array.isArray(entries) || entries.length === 0) return Promise.resolve();
        const tx = db.transaction([LOCAL_CACHE_ENTRY_STORE], 'readwrite');
        const store = tx.objectStore(LOCAL_CACHE_ENTRY_STORE);
        entries.forEach(entry => store.put(entry));
        return waitForTransaction(tx, '本地同步对象写入失败。');
    }

    function cacheClear(db) {
        const tx = db.transaction([LOCAL_CACHE_ENTRY_STORE, LOCAL_CACHE_STATE_STORE, LOCAL_CACHE_PACK_STORE], 'readwrite');
        tx.objectStore(LOCAL_CACHE_ENTRY_STORE).clear();
        tx.objectStore(LOCAL_CACHE_STATE_STORE).clear();
        tx.objectStore(LOCAL_CACHE_PACK_STORE).clear();
        return waitForTransaction(tx, '本地同步索引清理失败。');
    }

    // 恢复失败时已下载并校验的包仍然有效：只清派生索引（entries/state），
    // 保留 packs 供下一次恢复/上传复用，避免整库重新下载。
    function cacheClearDerived(db) {
        const tx = db.transaction([LOCAL_CACHE_ENTRY_STORE, LOCAL_CACHE_STATE_STORE], 'readwrite');
        tx.objectStore(LOCAL_CACHE_ENTRY_STORE).clear();
        tx.objectStore(LOCAL_CACHE_STATE_STORE).clear();
        return waitForTransaction(tx, '本地同步派生索引清理失败。');
    }

    function stableHash(value) {
        let hash = 2166136261;
        const text = String(value || '');
        for (let index = 0; index < text.length; index += 1) {
            hash ^= text.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return hash >>> 0;
    }

    function snapshotEntryId(value) {
        if (value.type === 'localStorage') return `ls:${value.key}`;
        if (value.type === 'database') return `db:${value.name}`;
        if (value.type === 'record') return `record:${value.database}/${value.store}/${stableKeyToken(value.key)}`;
        if (value.type === 'recordArrayStart') return `array:${value.database}/${value.store}/${stableKeyToken(value.key)}:start`;
        if (value.type === 'recordArrayItem') return `array:${value.database}/${value.store}/${stableKeyToken(value.key || '')}:item:${String(value.index).padStart(12, '0')}`;
        if (value.type === 'recordArrayEnd') return `array:${value.database}/${value.store}/${stableKeyToken(value.key || '')}:end`;
        if (value.type === 'storeEnd') return `store-end:${value.database}/${value.store}`;
        if (value.type === 'databaseEnd') return `db-end:${value.name}`;
        throw new Error('未知同步对象类型。');
    }

    function snapshotEntryGroup(value) {
        if (value.type === 'localStorage') return 'localStorage';
        if (value.type === 'database') return `db:${value.name}:header`;
        if (value.type === 'storeEnd') return `store:${value.database}/${value.store}:footer`;
        if (value.type === 'databaseEnd') return `db:${value.name}:footer`;
        return `store:${value.database}/${value.store}:data`;
    }

    function snapshotEntrySource(value) {
        if (value.type === 'localStorage') return `ls:${value.key}`;
        if (value.type === 'database') return `db:${value.name}`;
        if (value.type === 'databaseEnd') return `db-end:${value.name}`;
        if (value.type === 'storeEnd') return `store-end:${value.database}/${value.store}`;
        return `${value.database}/${value.store}/${stableKeyToken(value.key)}`;
    }

    function arraySourceToken(sourceKey) {
        const left = stableHash(`a:${sourceKey}`).toString(16).padStart(8, '0');
        const right = stableHash(`b:${sourceKey}`).toString(16).padStart(8, '0');
        return `${left}${right}-${sourceKey.length}`;
    }

    function snapshotEntryBucket(value, id, sourceKey) {
        const group = snapshotEntryGroup(value);
        if (group.endsWith(':header')) return `${group}|h`;
        if (group.endsWith(':footer')) return `${group}|z`;
        if (value.type === 'recordArrayStart'
            || value.type === 'recordArrayItem'
            || value.type === 'recordArrayEnd') {
            const page = value.type === 'recordArrayItem'
                ? Math.floor(Number(value.index || 0) / ARRAY_BUCKET_ENTRIES)
                : value.type === 'recordArrayEnd' ? Math.floor(Number(value.length || 0) / ARRAY_BUCKET_ENTRIES) : 0;
            return `${group}|a${arraySourceToken(sourceKey)}|q${String(page).padStart(10, '0')}`;
        }
        return `${group}|s${String(stableHash(id) % STABLE_BUCKET_COUNT).padStart(3, '0')}`;
    }

    function buildCacheEntry(value, canonicalBytes = null) {
        const id = snapshotEntryId(value);
        const group = snapshotEntryGroup(value);
        const sourceKey = snapshotEntrySource(value);
        const sequence = value.type === 'recordArrayStart'
            ? '0'
            : value.type === 'recordArrayItem'
                ? `1:${String(value.index).padStart(12, '0')}`
                : value.type === 'recordArrayEnd'
                    ? '2'
                    : '1';
        // 恢复路径直接透传数据包里的行字节（本就是同一规范序列化器产出、
        // 上传时经 sha256 验证的），省掉对全量数据再跑一遍序列化。
        // 但行字节通常是分片的 subarray；在这里复制到精确长度的自有缓冲区，
        // 避免 structured clone 把整个分片的 backing buffer 一并持久化。
        const bytes = canonicalBytes ? new Uint8Array(canonicalBytes) : serializeSnapshotObject(value);
        if (bytes.byteLength > MAX_SUPPORTED_OBJECT_BYTES) throw new Error('单条本地数据超过 64MiB 同步上限。');
        return { id, group, sourceKey, sortKey: `${sourceKey}|${sequence}`, bucketKey: snapshotEntryBucket(value, id, sourceKey), bytes };
    }

    function snapshotBytesEqual(value, cachedBytes) {
        const bytes = serializeSnapshotObject(value);
        return bytesEqual(bytes, cachedBytes);
    }

    function bytesEqual(bytes, other) {
        return bytes.byteLength === other.byteLength
            && bytes.every((byte, index) => byte === other[index]);
    }

    // 读出缓存 header 里记录的版本号；解析失败或非法时返回 null，调用方回退当前版本。
    function readCachedHeaderVersion(bytes) {
        try {
            const value = JSON.parse(new TextDecoder().decode(bytes));
            return typeof value?.version === 'number' && Number.isFinite(value.version) ? value.version : null;
        } catch (_) {
            return null;
        }
    }

    function readRecordsByKeys(db, storeName, keys) {
        if (!keys.length || !db.objectStoreNames.contains(storeName)) return Promise.resolve(keys.map(() => undefined));
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const requests = keys.map(key => store.get(key));
        return waitForTransaction(tx, '本地同步记录读取失败。', () => requests.map(request => request.result));
    }

    // 分片组装：把一个桶的全部 canonical 行字节顺序填入 4MiB 缓冲，逐片
    // gzip 后内容寻址。缓存 packs 保存【gzip 后字节】（键 = gzip 校验和），
    // 上传直接复用、恢复直接落盘，raw 字节只存在于 entries 与组装缓冲中。
    async function buildCachedPacks(db, bucketKey, buffer) {
        const packs = [];
        buffer = buffer || new Uint8Array(CONFIG.targetPackBytes);
        let used = 0;
        let entryCount = 0;
        let group;
        const flush = async () => {
            if (used === 0) return;
            const raw = buffer.slice(0, used);
            const compressed = await gzipBytes(raw);
            const checksum = await sha256Bytes(compressed);
            await cacheWritePacks(db, [{ checksum, bytes: compressed }]);
            packs.push({
                bucket: bucketKey, group, part: packs.length,
                checksum, length: compressed.byteLength, entryCount
            });
            used = 0;
            entryCount = 0;
        };
        for await (const entry of iterateCachedBucket(db, bucketKey)) {
            group = entry.group;
            const bytes = entry.bytes instanceof Uint8Array ? entry.bytes : new Uint8Array(entry.bytes);
            for (let offset = 0; offset < bytes.byteLength;) {
                const length = Math.min(buffer.byteLength - used, bytes.byteLength - offset);
                buffer.set(bytes.subarray(offset, offset + length), used);
                used += length;
                offset += length;
                if (used === buffer.byteLength) await flush();
            }
            // 行分隔符写入前先保证还有一个字节的空位：条目正文刚好填满缓冲时，
            // 分隔符会越界（Uint8Array 静默丢弃），恢复侧就数不到这条记录。
            if (used === buffer.byteLength) await flush();
            buffer[used++] = 10;
            entryCount += 1;
            if (used === buffer.byteLength || entryCount === CONFIG.maxPackEntries) await flush();
        }
        await flush();
        return packs;
    }

    function orderPackItems(state, packItems) {
        const order = new Map((state.groups || []).map((group, index) => [group, index]));
        return packItems.slice().sort((a, b) => (
            (order.get(a.group) ?? 999999) - (order.get(b.group) ?? 999999)
            || compareCodeUnits(String(a.bucket), String(b.bucket))
            || Number(a.part) - Number(b.part)
        ));
    }

    // 组装当前快照的完整分片清单：changedBuckets 为空时全部复用 state.packs。
    async function finalizeCachedSnapshot(db, state, changedBuckets = null) {
        const targets = changedBuckets
            ? [...changedBuckets]
            : [...new Set((state.packs || []).map(pack => pack.bucket))];
        const targetSet = new Set(targets);
        const items = (state.packs || []).filter(pack => !targetSet.has(pack.bucket));
        let totalBytes = items.reduce((sum, pack) => sum + pack.length, 0);
        const packBuffer = new Uint8Array(CONFIG.targetPackBytes);
        for (const bucketKey of targets) {
            const packs = await buildCachedPacks(db, bucketKey, packBuffer);
            items.push(...packs);
            totalBytes += packs.reduce((sum, pack) => sum + pack.length, 0);
            if (totalBytes > CONFIG.maxSnapshotBytes) throw new Error('本地同步数据超过 1GiB 上限。');
            if (items.length > CONFIG.maxPackCount) throw new Error('本地同步分片超过 4096 个上限。');
        }
        const ordered = orderPackItems(state, items);
        state.packs = ordered;
        state.snapshot = {
            format: SNAPSHOT_FORMAT,
            compression: SNAPSHOT_COMPRESSION,
            totalBytes: ordered.reduce((sum, pack) => sum + pack.length, 0),
            entryCount: ordered.reduce((sum, pack) => sum + pack.entryCount, 0)
        };
        return state;
    }

    async function buildFullCachedSnapshot(cacheDb, progressStart, progressEnd) {
        await cacheClear(cacheDb);
        const buckets = new Map();
        const groups = [];
        let pendingEntries = [];
        let pendingBytes = 0;
        let totalBytes = 0;
        let processed = 0;
        for await (const value of iterateSnapshotObjects()) {
            const entry = buildCacheEntry(value);
            if (!groups.includes(entry.group)) groups.push(entry.group);
            if (!buckets.has(entry.bucketKey)) buckets.set(entry.bucketKey, entry.group);
            pendingEntries.push(entry);
            pendingBytes += entry.bytes.byteLength;
            totalBytes += entry.bytes.byteLength + 1;
            if (totalBytes > CONFIG.maxSnapshotBytes) throw new Error('本地同步数据超过 1GiB 上限。');
            if (pendingEntries.length >= CONFIG.readBatchSize || pendingBytes >= CONFIG.cacheWriteBytes) {
                await cacheWriteEntries(cacheDb, pendingEntries);
                pendingEntries = [];
                pendingBytes = 0;
            }
            processed += 1;
            updateProgress(progressStart + Math.min(progressEnd - progressStart, Math.round(processed / (processed + 256) * (progressEnd - progressStart))), '正在整理…');
        }
        await cacheWriteEntries(cacheDb, pendingEntries);
        const state = { version: CACHE_FORMAT_VERSION, groups, packs: [] };
        for (const [bucketKey, group] of buckets) {
            state.packs.push({ bucket: bucketKey, group, part: 0, checksum: '', length: 0, entryCount: 0 });
        }
        return finalizeCachedSnapshot(cacheDb, state, new Set(buckets.keys()));
    }

    async function updateCachedSnapshot(cacheDb, state, dirty) {
        const affectedBuckets = new Set(state.pendingBuckets || []);
        let bucketsDirty = false;
        // 触桶只做内存标记，条目落盘前由 flushPendingBuckets 统一持久化：保住
        // "条目已写入 ⇒ 其所在桶必已在 pendingBuckets"的崩溃安全不变量。
        const touchBucket = bucket => {
            if (affectedBuckets.has(bucket)) return;
            affectedBuckets.add(bucket);
            bucketsDirty = true;
        };
        const flushPendingBuckets = async () => {
            if (!bucketsDirty) return;
            bucketsDirty = false;
            state.pendingBuckets = [...affectedBuckets];
            await cacheWriteState(cacheDb, state);
        };
        const yieldIfNeeded = createYieldController();
        const removeEntries = async (keys, knownBuckets = null) => {
            const list = [...keys];
            if (!list.length) return;
            if (knownBuckets) {
                for (const bucketKey of knownBuckets) touchBucket(bucketKey);
            } else {
                for (const entry of await readCacheEntries(cacheDb, list)) {
                    if (entry) touchBucket(entry.bucketKey);
                }
            }
            await flushPendingBuckets();
            await deleteObjectStoreKeys(cacheDb, LOCAL_CACHE_ENTRY_STORE, list);
        };
        const replaceSource = async (sourceKey, value, previous = null) => {
            const remaining = new Set(await cacheSourceKeys(cacheDb, sourceKey));
            if (value) {
                const id = snapshotEntryId(value);
                if (!previous) previous = await cacheReadEntry(cacheDb, id);
                remaining.delete(id);
                const bytes = serializeSnapshotObject(value);
                if (!previous || !bytesEqual(bytes, previous.bytes)) {
                    const entry = buildCacheEntry(value, bytes);
                    if (previous) touchBucket(previous.bucketKey);
                    touchBucket(entry.bucketKey);
                    await flushPendingBuckets();
                    await cacheWriteEntries(cacheDb, [entry]);
                }
            }
            await removeEntries(remaining);
        };
        const replaceArraySource = async (database, store, key, value, sourceKey) => {
            const remaining = new Set(await cacheSourceKeys(cacheDb, sourceKey));
            const values = (function* () {
                yield { type: 'recordArrayStart', database, store, key };
                for (let index = 0; index < value.length; index++) {
                    yield { type: 'recordArrayItem', database, store, key, index, value: value[index] === undefined ? null : value[index] };
                }
                yield { type: 'recordArrayEnd', database, store, key, length: value.length };
            })();
            let batch = [];
            let batchBytes = 0;
            const flush = async () => {
                if (!batch.length) return;
                const previousEntries = await readCacheEntries(cacheDb, batch.map(entry => entry.id));
                const writes = [];
                for (let index = 0; index < batch.length; index += 1) {
                    const entry = batch[index];
                    const previous = previousEntries[index];
                    remaining.delete(entry.id);
                    if (previous && bytesEqual(entry.bytes, previous.bytes)) continue;
                    if (previous) touchBucket(previous.bucketKey);
                    touchBucket(entry.bucketKey);
                    writes.push(entry);
                }
                await flushPendingBuckets();
                await cacheWriteEntries(cacheDb, writes);
                batch = [];
                batchBytes = 0;
                await yieldIfNeeded();
            };
            for (const item of values) {
                const entry = buildCacheEntry(item);
                batch.push(entry);
                batchBytes += entry.bytes.byteLength;
                if (batch.length >= CONFIG.restoreBatchSize || batchBytes >= CONFIG.cacheWriteBytes) await flush();
            }
            await flush();
            await removeEntries(remaining);
        };
        for (const key of dirty.localStorage) {
            if (!isAppLocalStorageKey(key)) continue;
            const value = localStorage.getItem(key);
            if (value !== null && !state.groups.includes('localStorage')) state.groups.unshift('localStorage');
            await replaceSource(`ls:${key}`, value === null ? null : { type: 'localStorage', key, value });
        }
        for (const [storeName, item] of dirty.stores) {
            const slash = storeName.indexOf('/');
            if (slash <= 0) throw new Error('变更日志对象存储无效。');
            const database = storeName.slice(0, slash);
            const store = storeName.slice(slash + 1);
            const knownDb = CONFIG.knownDatabases.find(dbDef => dbDef.name === database);
            if (!knownDb || !knownDb.stores.includes(store)) continue;
            const db = await openDbByName(database);
            try {
                const stores = readStoreDefinitions(db, knownDb.stores.filter(name => db.objectStoreNames.contains(name)));
                let headerValue = { type: 'database', name: database, version: db.version, stores };
                const previousHeader = await cacheReadEntry(cacheDb, snapshotEntryId(headerValue));
                if (previousHeader && !snapshotBytesEqual(headerValue, previousHeader.bytes)) {
                    // 仅内置版本号变化（store 定义等价）时改用缓存 header 的版本号，
                    // 让随后的字节比较判等，不再制造无效的 header 分片；
                    // 真实 schema 变化仍以当前版本号写入。
                    const stabilized = { ...headerValue, version: readCachedHeaderVersion(previousHeader.bytes) };
                    if (stabilized.version !== null && snapshotBytesEqual(stabilized, previousHeader.bytes)) {
                        headerValue = stabilized;
                    }
                }
                await replaceSource(`db:${database}`, headerValue, previousHeader);
                await replaceSource(`db-end:${database}`, { type: 'databaseEnd', name: database });
                for (const definition of stores) {
                    await replaceSource(`store-end:${database}/${definition.name}`, { type: 'storeEnd', database, store: definition.name });
                }
                const dbGroups = stores.flatMap(def => [`store:${database}/${def.name}:data`, `store:${database}/${def.name}:footer`]);
                const otherGroups = state.groups.filter(group => !group.startsWith(`db:${database}:`) && !dbGroups.includes(group));
                const localGroup = otherGroups.includes('localStorage') ? ['localStorage'] : [];
                state.groups = [...localGroup, ...otherGroups.filter(group => group !== 'localStorage'), `db:${database}:header`, ...dbGroups, `db:${database}:footer`];
                if (item.clear) {
                    // clear 按最终键集合做差分：只删除真正消失的键；clear 后原样
                    // 回填的数据继续交给键循环字节比较去重，不再整店重写缓存。
                    const finalSources = new Set();
                    for (const key of item.keys.values()) {
                        if (!isSyncExcludedRecord(database, store, key)) {
                            finalSources.add(`${database}/${store}/${stableKeyToken(key)}`);
                        }
                    }
                    const prefix = `${database}/${store}/`;
                    const tx = cacheDb.transaction(LOCAL_CACHE_ENTRY_STORE, 'readonly');
                    const request = tx.objectStore(LOCAL_CACHE_ENTRY_STORE)
                        .index('sourceKey').openCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
                    const keys = [];
                    const staleBuckets = new Set();
                    request.onsuccess = () => {
                        const cursor = request.result;
                        if (!cursor) return;
                        if (!finalSources.has(cursor.key)) {
                            keys.push(cursor.primaryKey);
                            if (cursor.value?.bucketKey) staleBuckets.add(cursor.value.bucketKey);
                        }
                        cursor.continue();
                    };
                    const staleKeys = await waitForTransaction(tx, '本地同步索引读取失败。', () => keys);
                    await removeEntries(staleKeys, staleBuckets);
                }
                const dirtyKeys = [...item.keys.values()].filter(key => !isSyncExcludedRecord(database, store, key));
                for (let start = 0; start < dirtyKeys.length; start += CONFIG.restoreBatchSize) {
                    const batch = dirtyKeys.slice(start, start + CONFIG.restoreBatchSize);
                    const values = await readRecordsByKeys(db, store, batch);
                    for (let index = 0; index < batch.length; index += 1) {
                        const key = batch[index];
                        const value = values[index];
                        const sourceKey = `${database}/${store}/${stableKeyToken(key)}`;
                        if (Array.isArray(value)) await replaceArraySource(database, store, key, value, sourceKey);
                        else await replaceSource(sourceKey, value === undefined ? null : { type: 'record', database, store, key, value });
                    }
                    await yieldIfNeeded();
                }
            } finally { db.close(); }
        }
        const groupOrder = ['localStorage'];
        for (const definition of CONFIG.knownDatabases) {
            groupOrder.push(`db:${definition.name}:header`);
            for (const name of definition.stores) groupOrder.push(`store:${definition.name}/${name}:data`, `store:${definition.name}/${name}:footer`);
            groupOrder.push(`db:${definition.name}:footer`);
        }
        state.groups.sort((left, right) => groupOrder.indexOf(left) - groupOrder.indexOf(right));
        if (affectedBuckets.size === 0) return state;
        const result = await finalizeCachedSnapshot(cacheDb, state, affectedBuckets);
        result.pendingBuckets = [];
        return result;
    }

    function readStoreDefinitions(db, storeNames) {
        return storeNames.map(storeName => {
            const tx = db.transaction([storeName], 'readonly');
            const store = tx.objectStore(storeName);
            return {
                name: storeName,
                keyPath: store.keyPath,
                autoIncrement: Boolean(store.autoIncrement)
            };
        });
    }

    async function* iterateSnapshotObjects() {
        for (const entry of readLocalStorageSnapshot()) {
            yield { type: 'localStorage', key: entry.key, value: entry.value };
        }
        const dbNames = await listIndexedDbNames();
        for (const dbName of dbNames) {
            const knownDb = CONFIG.knownDatabases.find(dbDef => dbDef.name === dbName);
            if (!knownDb) continue;
            const db = await openDbByName(dbName);
            try {
                const storeNames = knownDb.stores.filter(name => db.objectStoreNames.contains(name));
                if (storeNames.length === 0) continue;
                const stores = readStoreDefinitions(db, storeNames);
                yield { type: 'database', name: dbName, version: db.version, stores };
                for (const storeDef of stores) {
                    for await (const record of iterateObjectStoreRecords(db, storeDef.name)) {
                        if (isSyncExcludedRecord(dbName, storeDef.name, record.key)) continue;
                        if (Array.isArray(record.value)) {
                            yield { type: 'recordArrayStart', database: dbName, store: storeDef.name, key: record.key };
                            for (let index = 0; index < record.value.length; index += 1) {
                                const value = Object.prototype.hasOwnProperty.call(record.value, index)
                                    ? record.value[index]
                                    : null;
                                yield {
                                    type: 'recordArrayItem', database: dbName, store: storeDef.name,
                                    key: record.key, index, value: value === undefined ? null : value
                                };
                            }
                            yield { type: 'recordArrayEnd', database: dbName, store: storeDef.name, key: record.key, length: record.value.length };
                        } else {
                            yield { type: 'record', database: dbName, store: storeDef.name, key: record.key, value: record.value };
                        }
                    }
                    yield { type: 'storeEnd', database: dbName, store: storeDef.name };
                }
                yield { type: 'databaseEnd', name: dbName };
            } finally {
                db.close();
            }
        }
    }

    // ---- 后台快照准备（消除"点上传才开始整理"的等待）----
    // 业务写入（rphub:dirty 事件）与页面加载会触发后台准备：把 journal 差分、
    // 缓存重建与 gzip 分片全部提前完成，上传时只剩网络阶段。单飞保证后台
    // 准备与上传准备永不并发写缓存；后台期间打开同步面板可实时看到进度。
    let prepareInFlight = null;
    let prepareTimer = null;

    function runPrepareOnce(progressStart, progressEnd) {
        if (prepareInFlight) return prepareInFlight;
        prepareInFlight = (async () => {
            try {
                return await prepareLocalSnapshot(progressStart, progressEnd);
            } finally {
                prepareInFlight = null;
            }
        })();
        return prepareInFlight;
    }

    function isBackgroundPrepareAllowed() {
        return !RESTORE_PAGE && !state.syncing && !state.operationPending
            && document.visibilityState !== 'hidden';
    }

    function scheduleBackgroundPrepare(delayMs = 8000) {
        if (RESTORE_PAGE) return;
        if (prepareTimer) clearTimeout(prepareTimer);
        prepareTimer = setTimeout(() => {
            prepareTimer = null;
            if (!isBackgroundPrepareAllowed()) return;
            const run = async () => {
                backgroundYield = true;
                try {
                    await runPrepareOnce(2, 96);
                } catch (error) {
                    if (error?.indexInvalid) {
                        // 索引缺失/过期：后台静默完整重建（只读本地数据），
                        // 上传路径从此不再遇到"需要人工重建"。
                        requestExplicitRebuild();
                        await runPrepareOnce(2, 96);
                        return;
                    }
                    throw error;
                } finally {
                    backgroundYield = false;
                }
            };
            run().catch(() => { /* 后台准备失败静默，上传路径兜底 */ });
        }, delayMs);
    }

    // 上传前的准备：先等在飞的后台准备收尾（避免并发写缓存），随后再跑一次
    // 增量——后台刚完成时差分为空、瞬间完成，同时保证覆盖最新写入。等待期间
    // 解除后台低占空比：用户已明确要上传，剩余增量全速完成。
    async function prepareForUpload(progressStart, progressEnd) {
        if (prepareInFlight) {
            backgroundYield = false;
            await prepareInFlight.catch(() => { });
        }
        if (prepareTimer) {
            clearTimeout(prepareTimer);
            prepareTimer = null;
        }
        return runPrepareOnce(progressStart, progressEnd);
    }

    // ---- 网络层 ----
    function buildSyncHeaders(options = {}, withContentType = true) {
        const headers = withContentType ? { 'content-type': 'application/json' } : {};
        const password = typeof options.password === 'string' ? options.password : getStoredSyncPassword();
        if (password) {
            headers['x-rp-sync-password'] = password;
        }
        return headers;
    }

    function shouldRetrySyncError(error) {
        const status = Number(error?.status || 0);
        return !status || status === 408 || status === 429 || status >= 500;
    }

    async function withSyncRetry(options, send) {
        const retryCount = Number.isInteger(options.retryCount) ? options.retryCount : CONFIG.retryCount;
        const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : CONFIG.requestTimeoutMs;
        const abortMessage = options.abortMessage || '同步请求超时，请检查网络后重试。';
        let lastError = null;
        for (let attempt = 0; ; attempt += 1) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
            try {
                return await send(controller.signal);
            } catch (error) {
                const isAbort = error?.name === 'AbortError';
                const status = isAbort ? 0 : error?.status;
                const normalizedError = isAbort
                    ? new Error(abortMessage)
                    : (error instanceof Error ? error : new Error(String(error)));
                lastError = Object.assign(normalizedError, { status });
                if (attempt >= retryCount || !shouldRetrySyncError(lastError)) {
                    throw lastError;
                }
                await wait(CONFIG.retryDelayMs * (attempt + 1));
            } finally {
                clearTimeout(timeoutId);
            }
        }
    }

    function throwSyncHttpError(response, data, keepPasswordOnAuthError) {
        if (response.status === 401 && !keepPasswordOnAuthError) {
            clearStoredSyncPassword();
        }
        throw Object.assign(
            new Error(data?.error || `HTTP ${response.status}`),
            { response: data, status: response.status }
        );
    }

    async function postSync(payload, options = {}) {
        return withSyncRetry(options, async signal => {
            const response = await fetch(CONFIG.apiEndpoint, {
                method: 'POST',
                headers: buildSyncHeaders(options),
                body: JSON.stringify(payload),
                credentials: 'same-origin',
                signal
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || !data.ok) throwSyncHttpError(response, data, options.keepPasswordOnAuthError);
            return data;
        });
    }

    // 分片上传：PUT gzip 字节，服务端流式直通 R2；204 = 新建或幂等命中。
    async function putPack(pack, bytes) {
        const params = new URLSearchParams({
            checksum: pack.checksum,
            length: String(pack.length),
            entries: String(pack.entryCount)
        });
        return withSyncRetry({
            timeoutMs: CONFIG.packTransferTimeoutMs,
            abortMessage: '上传超时，请检查网络后重试。'
        }, async signal => {
            const response = await fetch(`${CONFIG.packEndpoint}?${params.toString()}`, {
                method: 'PUT',
                headers: {
                    ...buildSyncHeaders({}, false),
                    'content-type': 'application/gzip'
                },
                body: bytes,
                credentials: 'same-origin',
                signal
            });
            if (response.status === 204) return;
            throwSyncHttpError(response, await response.json().catch(() => ({})));
        });
    }

    // 分片下载：GET gzip 字节；内容寻址 + 边缘缓存，客户端按清单校验和验证。
    async function getPack(checksum, options = {}) {
        return withSyncRetry({
            timeoutMs: CONFIG.packTransferTimeoutMs,
            abortMessage: '下载超时，请检查网络后重试。'
        }, async signal => {
            const response = await fetch(`${CONFIG.packEndpoint}?c=${encodeURIComponent(checksum)}`, {
                method: 'GET',
                headers: buildSyncHeaders({}, false),
                credentials: 'same-origin',
                signal
            });
            if (!response.ok) {
                throwSyncHttpError(response, await response.json().catch(() => ({})), options.keepPasswordOnAuthError);
            }
            return new Uint8Array(await response.arrayBuffer());
        });
    }

    // ---- 快照准备（journal → 缓存差分 → 分片清单）----
    async function prepareLocalSnapshot(progressStart, progressEnd) {
        const cacheDb = await openLocalSyncCache();
        try {
            const local = await cacheReadState(cacheDb);
            const rebuild = localStorage.getItem('rp_sync_rebuild_requested') === '1';
            // 增量消费：有可用本地索引时只扫描上次消费水位之后的新事件——
            // 历史事件早已差分进缓存，重放只会靠字节比较幂等地空转。重建/首建
            // 走全量扫描（相对全量数据读取可忽略；换新日志后旧水位不可复用，
            // 必须重新建立）。journalWatermark 失效于 version/epoch/reset 检查：
            // 一旦索引被判过期整体作废，不会把旧索引下的消费进度写回。
            const incremental = Boolean(local) && !rebuild;
            const afterDatabases = incremental ? local?.journalWatermark?.databases || null : null;
            const dirty = await readDirtyState(afterDatabases);
            const epoch = localStorage.getItem(TRACKING_EPOCH_KEY);
            const journalReset = local?.epochs && Object.entries(local.epochs).some(([name, value]) => dirty.epochs[name] !== value);
            if (!rebuild && local && (local?.version !== CACHE_FORMAT_VERSION || !local.snapshot || local.epoch !== epoch || journalReset)) {
                const error = new Error('本地同步索引缺失、过期或追踪已重置，需要完整重建索引后才能继续上传（只读本地数据，不会覆盖云端）。');
                error.indexInvalid = true;
                throw error;
            }
            const result = rebuild || !local
                ? await buildFullCachedSnapshot(cacheDb, progressStart, progressEnd)
                : await updateCachedSnapshot(cacheDb, local, dirty);
            // 消费水位推进到本次扫描末端：本次读取/差分已覆盖其全部效果；期间
            // 新到的事件键值必然更大，下轮增量补上。合并 afterDatabases 同时让
            // acknowledge 覆盖"以前消费过但上传未成功"的旧段——增量扫描没扫到
            // 新事件时它不出现，漏合并会让那段日志永远无法确认删除。
            const consumedDatabases = incremental
                ? { ...afterDatabases, ...dirty.watermark.databases }
                : { ...dirty.watermark.databases };
            result.journalWatermark = { databases: consumedDatabases };
            result.epoch = epoch;
            result.epochs = dirty.epochs;
            await cacheWriteState(cacheDb, result);
            localStorage.removeItem('rp_sync_rebuild_requested');
            await pruneCachedPacks(cacheDb, result.packs);
            return { local: result, watermark: { databases: consumedDatabases, intents: dirty.watermark.intents } };
        } finally {
            cacheDb.close();
        }
    }

    // commit 请求体里的根清单：与服务端 normalizeManifest 的 canonical 源
    // 完全一致（字段顺序、packs 元组顺序都固定；对外字段名为 entries）。
    // 校验和只覆盖内容（不含 version/updatedAt），同一内容重建根校验和恒定。
    function manifestChecksumSource(root) {
        return JSON.stringify([
            SNAPSHOT_FORMAT,
            root.compression,
            root.totalBytes,
            root.entryCount,
            root.packs.map(pack => [pack.bucket, pack.checksum, pack.length, pack.entries])
        ]);
    }

    async function buildRootManifest(local, remoteVersion) {
        const root = {
            format: SNAPSHOT_FORMAT,
            version: Number(remoteVersion || 0) + 1,
            updatedAt: Date.now(),
            compression: SNAPSHOT_COMPRESSION,
            totalBytes: local.packs.reduce((sum, pack) => sum + pack.length, 0),
            entryCount: local.packs.reduce((sum, pack) => sum + pack.entryCount, 0),
            packs: local.packs.map(({ bucket, checksum, length, entryCount }) => ({ bucket, checksum, length, entries: entryCount }))
        };
        root.checksum = await sha256(manifestChecksumSource(root));
        return root;
    }

    // 客户端校验云端根清单：与上传侧同一 canonical 源重算校验和。
    async function validateRemoteManifest(remote) {
        if (remote?.format !== SNAPSHOT_FORMAT || remote.compression !== SNAPSHOT_COMPRESSION) {
            throw new Error('服务器同步格式不受支持。');
        }
        if (!Array.isArray(remote.packs) || remote.packs.length > CONFIG.maxPackCount) {
            throw new Error('服务器同步根清单异常。');
        }
        let totalBytes = 0;
        let entryCount = 0;
        for (const pack of remote.packs) {
            const entries = Number(pack.entries);
            if (!pack.bucket || String(pack.bucket).length > 4000
                || !/^[a-f0-9]{64}$/.test(String(pack.checksum || '').toLowerCase())
                || !Number.isInteger(pack.length) || pack.length <= 0 || pack.length > 6 * 1024 * 1024
                || !Number.isInteger(entries) || entries < 0 || entries > CONFIG.maxPackEntries) {
                throw new Error('服务器同步数据包清单异常。');
            }
            totalBytes += pack.length;
            entryCount += entries;
        }
        if (totalBytes !== Number(remote.totalBytes) || entryCount !== Number(remote.entryCount)) {
            throw new Error('服务器同步清单合计不一致。');
        }
        if (Number(remote.totalBytes) > CONFIG.maxSnapshotBytes) {
            throw new Error(`服务器数据太大：${remote.totalBytes}/${CONFIG.maxSnapshotBytes}。`);
        }
        const normalized = {
            format: SNAPSHOT_FORMAT,
            version: Number(remote.version),
            updatedAt: Number(remote.updatedAt),
            compression: SNAPSHOT_COMPRESSION,
            totalBytes,
            entryCount,
            // 保留线上字段名 entries：与 manifestChecksumSource 一致；
            // 消费处（下载/恢复）按需转成内部 entryCount 命名。
            packs: remote.packs.map(pack => ({
                bucket: String(pack.bucket),
                checksum: String(pack.checksum).toLowerCase(),
                length: pack.length,
                entries: Number(pack.entries)
            }))
        };
        const checksum = await sha256(manifestChecksumSource(normalized));
        if (String(remote.checksum || '').toLowerCase() !== checksum) {
            throw new Error('服务器同步根清单校验失败。');
        }
        // 校验通过的根校验和必须带回：后续"无变化"判等依赖它。
        normalized.checksum = checksum;
        return normalized;
    }

    // ---- 上传 ----
    // 分片元数据预检：任何非法 entryCount/length/checksum 在客户端立即失败
    // 并携带完整诊断信息，而不是得到服务端一句泛化的 409。
    function assertPackMetadata(pack) {
        const bad = reason => {
            throw new Error(`本地分片元数据异常（${reason}）：${JSON.stringify({
                bucket: pack.bucket, checksum: pack.checksum, length: pack.length, entryCount: pack.entryCount
            })}；请重建本地索引后重试。`);
        };
        if (!pack.bucket || String(pack.bucket).length > 4000) bad('bucket');
        if (!/^[a-f0-9]{64}$/.test(String(pack.checksum || '').toLowerCase())) bad('checksum');
        if (!Number.isInteger(pack.length) || pack.length <= 0 || pack.length > 6 * 1024 * 1024) bad('length');
        // entryCount 允许 0：单条记录超过分片缓冲时 buildCachedPacks 先落
        // 纯字节填充片，记录本体跨片拼接，恢复端按行重组。
        if (!Number.isInteger(pack.entryCount) || pack.entryCount < 0 || pack.entryCount > CONFIG.maxPackEntries) bad('entryCount');
    }

    // 有界并发池：失败后停止派发新任务，已在途任务自然收尾。
    async function mapPool(items, limit, worker) {
        const results = new Array(items.length);
        let cursor = 0;
        let failure = null;
        const runnerCount = Math.min(Math.max(1, limit), items.length);
        await Promise.all(Array.from({ length: runnerCount }, async () => {
            while (cursor < items.length && !failure) {
                const index = cursor;
                cursor += 1;
                try {
                    results[index] = await worker(items[index], index);
                } catch (err) {
                    failure = failure || err;
                }
            }
        }));
        if (failure) throw failure;
        return results;
    }

    async function uploadPacks(cacheDb, local, progress, uploadedSet = null) {
        let uploadedBytes = 0;
        await mapPool(local.packs, CONFIG.uploadConcurrency, async pack => {
            assertPackMetadata(pack);
            // 同一次上传会话内已确认的分片跳过（commit 缺包重传时复用）。
            if (uploadedSet?.has(pack.checksum)) return;
            const bytes = await cachePack(cacheDb, pack.checksum);
            if (!bytes || bytes.byteLength !== pack.length) {
                await cacheWriteState(cacheDb, null);
                throw new Error('本地同步缓存不完整，请重新上传。');
            }
            await putPack(pack, bytes);
            uploadedSet?.add(pack.checksum);
            uploadedBytes += pack.length;
            const ratio = local.snapshot.totalBytes > 0
                ? Math.min(1, uploadedBytes / local.snapshot.totalBytes)
                : 1;
            updateProgress(progress.uploadStart + Math.round(ratio * (progress.uploadEnd - progress.uploadStart)), '正在按分片上传…');
        });
    }

    // commit：全部包已在云端后 CAS 切根。409 missing 时按【整桶】重建分片
    // 并重传（gzip 字节可能与上次不同，校验和随之更新），最多 3 轮。
    // 返回 { checksum, reclaimed }：reclaimed 是服务端未确认删除的孤儿数，
    // 0 表示本轮提交没有需要 sweep 兜底的残留。
    async function commitSnapshot(cacheDb, local, remote, progress, uploadedSet) {
        let root = await buildRootManifest(local, remote?.version || 0);
        for (let round = 0; round < 3; round += 1) {
            updateProgress(progress.commit, '正在提交…');
            const result = await postSync({ action: 'commit', manifest: root }, {
                timeoutMs: CONFIG.commitTimeoutMs,
                retryCount: 1
            });
            if (result.ok) return { checksum: root.checksum, reclaimed: Number(result.reclaimed) || 0 };
            const missing = Array.isArray(result.missing) ? result.missing : [];
            if (!missing.length) throw new Error('服务器没有确认新快照。');
            const missingSet = new Set(missing.map(item => String(item).toLowerCase()));
            const missingBuckets = [...new Set(local.packs.filter(pack => missingSet.has(pack.checksum)).map(pack => pack.bucket))];
            const missingBucketSet = new Set(missingBuckets);
            const packBuffer = new Uint8Array(CONFIG.targetPackBytes);
            const rebuiltByBucket = new Map();
            for (const bucket of missingBuckets) {
                rebuiltByBucket.set(bucket, await buildCachedPacks(cacheDb, bucket, packBuffer));
            }
            // 整桶替换：跳过该桶全部旧分片（含未缺失的），在首个出现位置
            // 插入重建结果，保持组顺序不变；被替换的旧对象成为孤儿，
            // 服务端 sweep 兜底回收。
            const kept = [];
            const inserted = new Set();
            for (const pack of local.packs) {
                if (missingBucketSet.has(pack.bucket)) {
                    if (!inserted.has(pack.bucket)) {
                        inserted.add(pack.bucket);
                        kept.push(...(rebuiltByBucket.get(pack.bucket) || []));
                    }
                    continue;
                }
                kept.push(pack);
            }
            local.packs = orderPackItems(local, kept);
            local.snapshot = {
                format: SNAPSHOT_FORMAT,
                compression: SNAPSHOT_COMPRESSION,
                totalBytes: local.packs.reduce((sum, pack) => sum + pack.length, 0),
                entryCount: local.packs.reduce((sum, pack) => sum + pack.entryCount, 0)
            };
            await cacheWriteState(cacheDb, local);
            await uploadPacks(cacheDb, local, progress, uploadedSet);
            root = await buildRootManifest(local, remote?.version || 0);
        }
        throw new Error('云端数据包反复缺失，请重新上传。');
    }

    function updateProgress(progress, text) {
        const next = Math.max(0, Math.min(100, progress));
        const statusText = text || state.statusText;
        if (state.progress === next && state.statusText === statusText) return;
        state.progress = next;
        state.statusText = statusText;
        modalRoot?.classList.remove('is-error');
        if (modalProgressBar) {
            modalProgressBar.style.width = `${state.progress}%`;
        }
        if (modalProgressValue) {
            modalProgressValue.textContent = `${Math.round(state.progress)}%`;
        }
        if (modalStatus) {
            modalStatus.textContent = state.statusText;
        }
    }

    function showSyncError(error) {
        state.statusText = error?.message || '同步失败，请重试。';
        if (modalStatus) modalStatus.textContent = state.statusText;
        modalRoot?.classList.add('is-error');
    }

    function setActionButtonsDisabled(disabled) {
        if (pullButton) pullButton.disabled = disabled;
        if (pushButton) pushButton.disabled = disabled;
        if (rebuildButton) rebuildButton.disabled = disabled;
    }

    // ---- 上次同步结果徽标 ----
    function readLastSync() {
        try {
            const raw = JSON.parse(localStorage.getItem(CONFIG.lastSyncKey) || 'null');
            if (!raw || typeof raw !== 'object' || !Number.isFinite(raw.at)) return null;
            return { at: raw.at, ok: raw.ok === true };
        } catch (error) {
            return null;
        }
    }

    function renderLastSync() {
        const badge = modalRoot?.querySelector('.rp-sync-last-sync');
        if (!badge) return;
        const record = readLastSync();
        if (!record) {
            badge.textContent = '';
            badge.className = 'rp-sync-last-sync';
            return;
        }
        const time = new Date(record.at);
        const text = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')} ${record.ok ? '同步成功' : '同步失败'}`;
        badge.textContent = text;
        badge.className = `rp-sync-last-sync ${record.ok ? 'is-ok' : 'is-fail'}`;
    }

    function recordLastSync(ok) {
        try {
            localStorage.setItem(CONFIG.lastSyncKey, JSON.stringify({ at: Date.now(), ok: ok === true }));
        } catch (error) { }
        renderLastSync();
    }

    function isAutoSavePageActive() {
        return document.visibilityState !== 'hidden';
    }

    function parseAutoSaveMinutes(value) {
        const text = String(value ?? '').trim();
        if (!/^\d+$/.test(text)) return null;
        const minutes = Number(text);
        if (!Number.isSafeInteger(minutes)
            || minutes < AUTO_SAVE_CONFIG.minMinutes
            || minutes > AUTO_SAVE_CONFIG.maxMinutes) return null;
        return minutes;
    }

    function getAutoSaveMinutes() {
        const stored = parseAutoSaveMinutes(localStorage.getItem(CONFIG.autoSaveMinutesKey));
        return stored ?? AUTO_SAVE_CONFIG.defaultMinutes;
    }

    function isAutoSaveEnabled() {
        return localStorage.getItem(CONFIG.autoSaveEnabledKey) === '1';
    }

    function setAutoSaveStatus(text) {
        if (autoSaveStatus) autoSaveStatus.textContent = text;
    }

    function renderAutoSaveControls() {
        if (!autoSaveToggle || !autoSaveMinutesInput) return;
        autoSaveToggle.checked = isAutoSaveEnabled();
        autoSaveMinutesInput.value = String(getAutoSaveMinutes());
        autoSaveMinutesInput.min = String(AUTO_SAVE_CONFIG.minMinutes);
        autoSaveMinutesInput.max = String(AUTO_SAVE_CONFIG.maxMinutes);
        autoSaveMinutesInput.step = '1';
        autoSaveMinutesInput.setAttribute('aria-invalid', 'false');
    }

    function restartAutoSaveCycle(text = '前台计时中') {
        if (!autoSaveScheduler || RESTORE_PAGE || !isAutoSaveEnabled()) return;
        if (state.operationPending || state.syncing) {
            autoSaveScheduler.pause();
            setAutoSaveStatus('同步进行中，自动保存将在当前操作结束后重新计时。');
            return;
        }
        autoSaveScheduler.start(getAutoSaveMinutes() * 60 * 1000);
        if (autoSaveScheduler.getState().enabled) {
            const detail = autoSaveLastError ? `；上次失败：${autoSaveLastError}` : '';
            setAutoSaveStatus(isAutoSavePageActive()
                ? `${text}${detail}，每 ${getAutoSaveMinutes()} 分钟自动保存。`
                : '后台已暂停自动保存。');
        }
    }

    function stopAutoSave(text = '自动保存已关闭') {
        autoSaveScheduler?.stop();
        setAutoSaveStatus(text);
    }

    function pauseAutoSave(text = '后台已暂停自动保存') {
        autoSaveScheduler?.pause();
        if (isAutoSaveEnabled()) setAutoSaveStatus(text);
    }

    function resumeAutoSave() {
        if (!autoSaveScheduler || !isAutoSaveEnabled()) return;
        if (state.operationPending || state.syncing) {
            autoSaveScheduler.pause();
            setAutoSaveStatus('同步进行中，自动保存将在当前操作结束后重新计时。');
            return;
        }
        const current = autoSaveScheduler.getState();
        if (current.remainingMs <= 0) {
            if (!autoSaveRunning) restartAutoSaveCycle();
            return;
        }
        autoSaveScheduler.resume();
        const schedulerState = autoSaveScheduler.getState();
        if (schedulerState.active) setAutoSaveStatus(`前台计时中，每 ${getAutoSaveMinutes()} 分钟自动保存。`);
        else if (!isAutoSavePageActive()) setAutoSaveStatus('后台已暂停自动保存。');
    }

    function persistAutoSaveMinutes(value) {
        const minutes = parseAutoSaveMinutes(value);
        if (minutes === null) {
            autoSaveMinutesInput?.setAttribute('aria-invalid', 'true');
            setAutoSaveStatus(`请输入 ${AUTO_SAVE_CONFIG.minMinutes}～${AUTO_SAVE_CONFIG.maxMinutes} 的整数分钟。`);
            return false;
        }
        try {
            localStorage.setItem(CONFIG.autoSaveMinutesKey, String(minutes));
        } catch (error) {
            setAutoSaveStatus(`自动保存设置保存失败：${error?.message || '请稍后重试。'}`);
            return false;
        }
        autoSaveMinutesInput?.setAttribute('aria-invalid', 'false');
        if (isAutoSaveEnabled()) restartAutoSaveCycle();
        else setAutoSaveStatus(`已设置每 ${minutes} 分钟自动保存。`);
        return true;
    }

    function reportAutoSaveFailure(error) {
        autoSaveLastError = error?.message || '自动保存失败。';
        if (isAutoSaveEnabled()) {
            setAutoSaveStatus(isAutoSavePageActive()
                ? `自动保存失败：${autoSaveLastError}；下一完整周期重试。`
                : `后台已暂停自动保存；上次失败：${autoSaveLastError}`);
        }
    }

    async function runAutomaticUpload() {
        if (!isAutoSaveEnabled() || !isAutoSavePageActive()) {
            pauseAutoSave();
            return;
        }
        if (autoSaveRunning) {
            setAutoSaveStatus('同步正在进行，自动保存将在下一轮重试。');
            return;
        }
        autoSaveRunning = true;
        setAutoSaveStatus('正在自动保存…');
        try {
            await runSyncOperation(
                () => pushToServerUnlocked({ automatic: true }),
                { automatic: true }
            );
        } catch (error) {
            reportAutoSaveFailure(error);
        } finally {
            autoSaveRunning = false;
        }
    }

    function initializeAutoSave() {
        if (RESTORE_PAGE || autoSaveScheduler) return;
        autoSaveScheduler = createAutoSaveScheduler({
            tickMs: CONFIG.autoSaveTickMs,
            lateToleranceMs: CONFIG.autoSaveLateToleranceMs,
            isActive: isAutoSavePageActive,
            onState: event => {
                if (event.phase === 'pause' && isAutoSaveEnabled() && !isAutoSavePageActive()) {
                    setAutoSaveStatus('后台已暂停自动保存。');
                }
            },
            onDue: runAutomaticUpload,
            onError: error => {
                reportAutoSaveFailure(error);
                if (isAutoSaveEnabled() && isAutoSavePageActive()) restartAutoSaveCycle();
            }
        });
        renderAutoSaveControls();
        autoSaveToggle?.addEventListener('change', () => {
            const enabled = Boolean(autoSaveToggle.checked);
            try {
                localStorage.setItem(CONFIG.autoSaveEnabledKey, enabled ? '1' : '0');
            } catch (error) {
                autoSaveToggle.checked = !enabled;
                setAutoSaveStatus(`自动保存设置保存失败：${error?.message || '请稍后重试。'}`);
                return;
            }
            autoSaveLastError = '';
            if (enabled) restartAutoSaveCycle();
            else stopAutoSave();
        });
        autoSaveMinutesInput?.addEventListener('change', () => {
            persistAutoSaveMinutes(autoSaveMinutesInput.value);
            autoSaveMinutesInput.value = String(getAutoSaveMinutes());
        });
        document.addEventListener('visibilitychange', () => {
            if (isAutoSavePageActive()) resumeAutoSave();
            else pauseAutoSave();
        });
        window.addEventListener('pagehide', () => pauseAutoSave('页面已离开，自动保存已暂停。'));
        window.addEventListener('pageshow', () => resumeAutoSave());
        document.addEventListener('freeze', () => pauseAutoSave('页面已冻结，自动保存已暂停。'));
        document.addEventListener('resume', () => resumeAutoSave());
        if (isAutoSaveEnabled()) restartAutoSaveCycle();
        else stopAutoSave();
    }

    async function flushAppState() {
        const external = window.RPHubExternal;
        if (external?.version !== 2 || typeof external.flush !== 'function') {
            throw new Error('作者保存接口未就绪，请刷新后重试。');
        }
        const result = await external.flush();
        if (result && result.ok === false) throw new Error(result.reason || '作者数据保存失败。');
        if (window.RPH_MAGIC_FLUSH_IMAGES) await window.RPH_MAGIC_FLUSH_IMAGES();
        await window.RPH_SYNC_TRACKER.flush();
    }

    async function getAuthStatus(password = getStoredSyncPassword(), options = {}) {
        return postSync({ action: 'auth-status' }, {
            password,
            keepPasswordOnAuthError: true,
            ...options
        });
    }

    function ensurePasswordModal() {
        if (passwordModalRoot) return;

        passwordModalRoot = document.createElement('div');
        passwordModalRoot.className = 'rp-sync-modal rp-sync-password-modal';
        passwordModalRoot.innerHTML = `
            <div class="rp-sync-modal__backdrop"></div>
            <form class="rp-sync-modal__panel rp-sync-password-panel">
                <div class="rp-sync-modal__header">
                    <div>
                        <div class="rp-sync-modal__eyebrow">云端访问</div>
                        <h3 class="rp-sync-modal__title">同步密码</h3>
                    </div>
                    <button type="button" class="rp-sync-modal__close" aria-label="关闭">×</button>
                </div>
                <p class="rp-sync-modal__intro">请输入访问密码。</p>
                <label class="rp-sync-password-field">
                    <span>密码</span>
                    <input type="password" autocomplete="current-password" placeholder="请输入同步密码">
                </label>
                <p class="rp-sync-password-status">请输入同步密码。</p>
                <div class="rp-sync-modal__actions">
                    <button type="button" class="rp-sync-modal__button" data-action="cancel-password">取消</button>
                    <button type="submit" class="rp-sync-modal__button is-primary" data-action="submit-password">继续同步</button>
                </div>
            </form>
        `;

        document.body.appendChild(passwordModalRoot);
        passwordInput = passwordModalRoot.querySelector('input');
        passwordStatus = passwordModalRoot.querySelector('.rp-sync-password-status');
        passwordSubmitButton = passwordModalRoot.querySelector('[data-action="submit-password"]');

        const closePasswordModal = () => {
            if (checkingPassword) return;
            passwordModalRoot.classList.remove('is-open');
        };

        passwordModalRoot.querySelector('.rp-sync-modal__close').addEventListener('click', closePasswordModal);
        passwordModalRoot.querySelector('[data-action="cancel-password"]').addEventListener('click', closePasswordModal);
        passwordModalRoot.querySelector('.rp-sync-modal__backdrop').addEventListener('click', closePasswordModal);
        passwordModalRoot.querySelector('form').addEventListener('submit', event => {
            event.preventDefault();
            submitSyncPassword().catch(() => { });
        });
    }

    function openPasswordModal(message = '请输入同步密码。') {
        ensurePasswordModal();
        passwordStatus.textContent = message;
        passwordInput.value = '';
        passwordSubmitButton.disabled = false;
        passwordModalRoot.classList.add('is-open');
        setTimeout(() => passwordInput.focus(), 0);
    }

    // ---- 访问门禁 ----
    // 站点打开时先静默校验一次同步密码：已保存密码验证通过则不出现任何
    // 登录 UI；云端要求密码且本地无有效密码时才显示锁页。云端不可达直接
    // 放行：门禁只是体验层，真正的数据防护由 Worker 端 401 承担。
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

    let lockStyleInstalled = false;
    let lockOverlay = null;
    let lockIntro = null;
    let lockError = null;
    let lockForm = null;
    let lockFormInput = null;
    let lockFormToggle = null;
    let lockFormSubmit = null;
    let lockSubmitLabel = null;
    let lockBody = null;
    let lockBodyOverflow = null;
    let lockVerifying = false;
    let resolveAccessGate = null;
    const accessGateDone = new Promise(resolve => { resolveAccessGate = resolve; });

    function ensureLockStyle() {
        if (lockStyleInstalled) return;
        lockStyleInstalled = true;
        const style = document.createElement('style');
        style.textContent = LOCK_STYLE_TEXT;
        (document.head || document.documentElement).appendChild(style);
    }

    function openAccessGate(introText) {
        if (lockOverlay) {
            if (lockIntro) lockIntro.textContent = introText;
            return;
        }
        ensureLockStyle();
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
                    <button type="submit" class="rp-sync-lock__submit"><span class="rp-sync-lock__submit-label">解锁并进入</span><span class="rp-sync-lock__spinner"></span></button>
                </form>
            </div>
        `;
        lockIntro = overlay.querySelector('.rp-sync-lock__intro');
        lockError = overlay.querySelector('.rp-sync-lock__error');
        lockForm = overlay.querySelector('.rp-sync-lock__form');
        lockFormInput = overlay.querySelector('.rp-sync-lock__field input');
        lockFormToggle = overlay.querySelector('.rp-sync-lock__toggle');
        lockFormSubmit = overlay.querySelector('.rp-sync-lock__submit');
        lockSubmitLabel = overlay.querySelector('.rp-sync-lock__submit-label');
        if (lockIntro) lockIntro.textContent = introText;
        if (lockFormToggle) {
            lockFormToggle.innerHTML = LOCK_EYE_SVG;
            lockFormToggle.addEventListener('click', () => {
                const reveal = lockFormInput.type === 'password';
                lockFormInput.type = reveal ? 'text' : 'password';
                lockFormToggle.innerHTML = reveal ? LOCK_EYE_OFF_SVG : LOCK_EYE_SVG;
                lockFormToggle.setAttribute('aria-label', reveal ? '隐藏密码' : '显示密码');
                lockFormInput.focus();
            });
        }
        if (lockForm) {
            lockForm.addEventListener('submit', event => {
                event.preventDefault?.();
                submitLockPassword().catch(() => { });
            });
        }
        (document.body || document.documentElement).appendChild(overlay);
        lockOverlay = overlay;
        lockBody = document.body || null;
        if (lockBody) {
            lockBodyOverflow = lockBody.style.overflow || '';
            lockBody.style.overflow = 'hidden';
        }
        setTimeout(() => {
            try { lockFormInput?.focus(); } catch (_) { }
        }, 0);
    }

    function closeAccessGate() {
        const overlay = lockOverlay;
        lockOverlay = null;
        if (overlay) {
            overlay.classList.add('is-leaving');
            setTimeout(() => {
                overlay.remove();
                if (lockBody) lockBody.style.overflow = lockBodyOverflow || '';
            }, 240);
        }
        resolveAccessGate();
    }

    function showLockError(text) {
        if (!lockError) return;
        lockError.textContent = text;
        if (lockOverlay) {
            lockOverlay.classList.remove('is-error');
            void lockOverlay.offsetWidth;
            lockOverlay.classList.add('is-error');
        }
    }

    function setLockBusy(busy) {
        if (!lockFormSubmit) return;
        lockFormSubmit.disabled = Boolean(busy);
        lockFormSubmit.classList.toggle('is-busy', Boolean(busy));
        if (lockSubmitLabel) lockSubmitLabel.textContent = busy ? '验证中…' : '解锁并进入';
    }

    // 锁页与同步面板密码弹窗共用的验证核心：请求 auth-status、按结果
    // 决定保存还是清除密码；两个调用方各自渲染自己的 UI 反馈。
    async function verifySyncPasswordCore(password, options) {
        const auth = await getAuthStatus(password, options);
        if (auth.authRequired && !auth.authenticated) return { ok: false };
        if (auth.authRequired) saveStoredSyncPassword(password);
        else clearStoredSyncPassword();
        return { ok: true };
    }

    async function submitLockPassword() {
        if (!lockOverlay || lockVerifying) return;
        const password = lockFormInput.value;
        if (!password) {
            showLockError('请输入访问密码。');
            lockFormInput.focus();
            return;
        }
        lockVerifying = true;
        setLockBusy(true);
        try {
            const result = await verifySyncPasswordCore(password, { retryCount: 0, timeoutMs: 10000 });
            if (!result.ok) {
                showLockError('密码不正确，请重新输入。');
                lockFormInput.select();
                return;
            }
            closeAccessGate();
        } catch (error) {
            showLockError(error?.message || '密码验证失败，请稍后再试。');
        } finally {
            lockVerifying = false;
            setLockBusy(false);
        }
    }

    function startAccessGate() {
        if (typeof fetch !== 'function' || typeof localStorage === 'undefined') {
            resolveAccessGate();
            return accessGateDone;
        }
        const stored = getStoredSyncPassword();
        getAuthStatus(stored, { retryCount: 0, timeoutMs: 8000 }).then(auth => {
            if (!auth?.authRequired || auth.authenticated) {
                resolveAccessGate();
                return;
            }
            clearStoredSyncPassword();
            openAccessGate(stored
                ? '已保存的密码已失效，请重新输入。'
                : '此站点受同步密码保护，请输入访问密码继续。');
        }).catch(() => {
            resolveAccessGate();
        });
        return accessGateDone;
    }

    function openSyncPanel() {
        state.statusText = '请选择同步方向。';
        state.progress = 0;
        openModal();
    }

    async function submitSyncPassword() {
        if (checkingPassword) return;
        const password = passwordInput.value;
        if (!password) {
            passwordStatus.textContent = '请输入同步密码。';
            passwordInput.focus();
            return;
        }
        checkingPassword = true;
        passwordSubmitButton.disabled = true;
        passwordStatus.textContent = '验证中…';
        try {
            const result = await verifySyncPasswordCore(password, {});
            if (!result.ok) {
                clearStoredSyncPassword();
                passwordStatus.textContent = '密码不正确，请重新输入。';
                passwordInput.select();
                return;
            }
            passwordModalRoot.classList.remove('is-open');
            if (RESTORE_PAGE) pullFromServer().catch(showSyncError);
            else openSyncPanel();
        } catch (error) {
            passwordStatus.textContent = error.message || '密码验证失败，请稍后再试。';
        } finally {
            checkingPassword = false;
            passwordSubmitButton.disabled = false;
        }
    }

    async function handleSyncButtonClick() {
        await accessGateDone;
        if (state.syncing || checkingPassword) return;
        openSyncPanel();
    }

    function ensureModal() {
        if (modalRoot) return;

        modalRoot = document.createElement('div');
        modalRoot.className = RESTORE_PAGE
            ? 'rp-sync-modal rp-sync-modal--restore'
            : 'rp-sync-modal';
        modalRoot.innerHTML = RESTORE_PAGE ? `
            <div class="rp-sync-modal__backdrop"></div>
            <main class="rp-sync-modal__panel" aria-live="polite">
                <h1 class="rp-sync-modal__title-main">恢复数据</h1>
                <p class="rp-sync-modal__status">正在恢复…</p>
                <div class="rp-sync-progress">
                    <div class="rp-sync-progress__bar"></div>
                </div>
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
                    <h3 class="rp-sync-modal__title">
                        <span class="rp-sync-modal__title-main">云同步</span>
                    </h3>
                    <button type="button" class="rp-sync-modal__close" aria-label="关闭">×</button>
                </div>
                <div class="rp-sync-main-actions">
                    <button type="button" class="rp-sync-action-button is-primary" data-action="push">上传到云端</button>
                    <button type="button" class="rp-sync-action-button" data-action="pull">从云端恢复</button>
                    <button type="button" class="rp-sync-action-button" data-action="rebuild">重建本地索引</button>
                </div>
                <section class="rp-sync-auto-save" aria-label="自动保存">
                    <div class="rp-sync-auto-save__row">
                        <label class="rp-sync-auto-save__toggle">
                            <input type="checkbox" data-action="auto-save-toggle">
                            <span>自动保存</span>
                        </label>
                        <label class="rp-sync-auto-save__interval">
                            <span>间隔（分钟）</span>
                            <input type="number" data-action="auto-save-minutes" inputmode="numeric">
                        </label>
                    </div>
                    <div class="rp-sync-auto-save__footer">
                        <p class="rp-sync-auto-save__status" aria-live="polite"></p>
                        <span class="rp-sync-last-sync" aria-live="polite"></span>
                    </div>
                </section>
                <p class="rp-sync-modal__status">请选择同步方向。</p>
                <div class="rp-sync-progress">
                    <div class="rp-sync-progress__bar"></div>
                </div>
                <div class="rp-sync-progress__value">0%</div>
            </div>
        `;

        document.body.appendChild(modalRoot);
        modalStatus = modalRoot.querySelector('.rp-sync-modal__status');
        modalProgressBar = modalRoot.querySelector('.rp-sync-progress__bar');
        modalProgressValue = modalRoot.querySelector('.rp-sync-progress__value');
        pullButton = modalRoot.querySelector('[data-action="pull"]');
        autoSaveToggle = modalRoot.querySelector('[data-action="auto-save-toggle"]');
        autoSaveMinutesInput = modalRoot.querySelector('[data-action="auto-save-minutes"]');
        autoSaveStatus = modalRoot.querySelector('.rp-sync-auto-save__status');

        if (RESTORE_PAGE) {
            pullButton.addEventListener('click', () => pullFromServer().catch(showSyncError));
            modalRoot.querySelector('[data-action="return"]').addEventListener('click', () => location.replace('/'));
            return;
        }

        pushButton = modalRoot.querySelector('[data-action="push"]');
        rebuildButton = modalRoot.querySelector('[data-action="rebuild"]');
        renderLastSync();
        // 重建是恢复手段不是常规操作：默认隐藏。推送遇索引错误时经确认
        // 自动重建并继续；拒绝时才显示按钮走手动路径。
        rebuildButton.style.display = 'none';
        initializeAutoSave();

        modalRoot.querySelector('.rp-sync-modal__close').addEventListener('click', closeModal);
        modalRoot.querySelector('.rp-sync-modal__backdrop').addEventListener('click', () => {
            if (!state.syncing) closeModal();
        });
        pullButton.addEventListener('click', () => {
            if (confirm('从云端恢复将替换此浏览器的本地数据。继续吗？')) {
                location.replace('/sync-restore');
            }
        });
        rebuildButton.addEventListener('click', async () => {
            if (state.syncing || !confirm('这会完整读取本地数据重建索引，但不会上传或覆盖云端。请先导出本地数据备份。继续吗？')) return;
            pauseAutoSave('正在重建索引，自动保存已暂停。');
            await runSyncOperation(async () => {
                state.syncing = true;
                try {
                    setActionButtonsDisabled(true);
                    await flushAppState();
                    requestExplicitRebuild();
                    await prepareLocalSnapshot(5, 95);
                    updateProgress(100, '本地索引已重建，云端未修改。');
                } catch (error) { showSyncError(error); }
                finally { state.syncing = false; setActionButtonsDisabled(false); }
            });
        });
        pushButton.addEventListener('click', () => pushToServer().catch(() => { }));
    }

    function openModal() {
        ensureModal();
        modalRoot.classList.add('is-open');
        updateProgress(state.progress, state.statusText || '请选择同步方向。');
        setActionButtonsDisabled(state.syncing);
    }

    function closeModal() {
        if (state.syncing || !modalRoot) return;
        modalRoot.classList.remove('is-open');
    }

    // ---- 上传主流程 ----
    async function commitObjectSnapshot(progress, options = {}) {
        updateProgress(progress.check, '准备中…');
        // 无变化自动保存快速通道：journal 无新事件 + 有未过期的"上次提交校验
        // 和"→ 数据与上次成功提交完全一致，整次跳过网络（省一次 status RTT），
        // 只确认水位。定期（fastPathVerifyIntervalMs）放行一次完整验证，防止
        // 云端根被外部改写后永不自愈；手动上传永远走完整流程（用户在等结果，
        // 要确定性）。
        if (options.automatic) {
            const cacheDb = await openLocalSyncCache();
            let fastPath = null;
            try {
                const localState = await cacheReadState(cacheDb);
                const committed = localState?.committed;
                if (committed?.checksum
                    && Date.now() - Number(committed.at || 0) < CONFIG.fastPathVerifyIntervalMs
                    && await journalIsFullyAcknowledged(localState.epochs)) {
                    fastPath = committed;
                }
            } catch (_) { /* 判定失败走完整流程 */ } finally {
                cacheDb.close();
            }
            if (fastPath) {
                // 判据本身保证 journal 数字键为空、无意图键：没有待确认的
                // 水位，直接返回（期间新落库的写入事件留在 journal，由下一
                // 轮同步照常消费）。
                return true;
            }
        }
        // status 往返（网络）与本地快照准备（CPU/IndexedDB）互不依赖，并行跑
        const statusPromise = postSync({ action: 'status' }, {
            timeoutMs: CONFIG.commitTimeoutMs
        });
        statusPromise.catch(() => { }); // 并行期间先失败时不产生未处理拒绝
        let prepared;
        try {
            prepared = await prepareForUpload(progress.check, progress.uploadStart);
        } catch (err) {
            if (!err?.indexInvalid) throw err;
            // 索引过期不再要求用户离开当前流程：一次确认后自动重建并继续
            // 上传。后台准备通常已提前完成重建，走到这里属于兜底。
            if (options.automatic) {
                throw new Error('本地同步索引需要人工重建，请打开同步面板后重试。');
            }
            if (!confirm('本地同步索引缺失、过期或追踪已重置，需要完整扫描本地数据重建索引后才能继续上传。\n\n重建只读取本地数据，不会覆盖云端。继续吗？')) {
                if (rebuildButton) rebuildButton.style.display = '';
                throw err;
            }
            updateProgress(progress.check, '正在完整重建本地索引…');
            requestExplicitRebuild();
            prepared = await prepareForUpload(progress.check, progress.uploadStart);
        }
        const { local, watermark } = prepared;
        const statusResponse = await statusPromise;
        const remote = statusResponse.manifest ? await validateRemoteManifest(statusResponse.manifest) : null;

        // 本地快照与云端一致：只确认水位，不发起任何上传。
        const localRoot = await buildRootManifest(local, remote?.version || 0);
        if (remote?.checksum === localRoot.checksum) {
            await rememberCommittedRoot(localRoot.checksum);
            await window.RPH_SYNC_TRACKER.acknowledge(watermark);
            return true;
        }

        const cacheDb = await openLocalSyncCache();
        let reclaimed = 0;
        try {
            updateProgress(progress.uploadStart, '正在上传并提交…');
            // 云端已有的分片（内容寻址、put 时经 sha256 校验）无需重传：
            // 预置进已确认集合，增量上传只传真正新增/变化的分片。
            const uploaded = new Set((remote?.packs || []).map(pack => pack.checksum));
            await uploadPacks(cacheDb, local, progress, uploaded);
            // 服务端已校验全部包存在并 CAS 切根；返回值带孤儿残留数。
            ({ reclaimed } = await commitSnapshot(cacheDb, local, remote, progress, uploaded));
        } finally {
            cacheDb.close();
        }
        await rememberCommittedRoot(localRoot.checksum);
        await window.RPH_SYNC_TRACKER.acknowledge(watermark);
        // sweep 只为服务端未确认删除的孤儿兜底（正常提交由服务端顺带回收，
        // 缺包重传轮的整桶替换也会在响应里带回残留数）。零残留时省掉这趟
        // 往返——高延迟线路上每次上传少花一个 RTT。
        if (reclaimed > 0) {
            postSync({ action: 'sweep' }, { retryCount: 1, timeoutMs: CONFIG.commitTimeoutMs }).catch(() => { });
        }
        return false;
    }

    // 上次成功提交的根校验和与时刻：无变化快速通道的判定材料（校验和只覆盖
    // 内容，与 version 无关，本地可复算）。
    async function rememberCommittedRoot(checksum) {
        const cacheDb = await openLocalSyncCache();
        try {
            const localState = await cacheReadState(cacheDb);
            if (localState) {
                localState.committed = { checksum, at: Date.now() };
                await cacheWriteState(cacheDb, localState);
            }
        } finally {
            cacheDb.close();
        }
    }

    async function pushToServerUnlocked(options = {}) {
        if (state.syncing) return { skipped: true, reason: 'syncing' };

        pauseAutoSave(options.automatic ? '正在自动保存…' : '正在手动上传，自动保存已暂停。');
        state.syncing = true;
        const automatic = Boolean(options.automatic);
        if (automatic) autoSaveLastError = '';

        try {
            if (!automatic) openModal();
            setActionButtonsDisabled(true);
            updateProgress(8, automatic ? '正在自动保存…' : '准备中…');
            await flushAppState();
            await waitForIndexedDbWriteBarrier();

            const alreadyUpToDate = await commitObjectSnapshot({
                check: 30,
                uploadStart: 36,
                uploadEnd: 88,
                commit: 92
            }, { automatic });
            if (alreadyUpToDate) {
                updateProgress(100, automatic ? '数据相同，已是最新' : '已是最新');
                recordLastSync(true);
                if (automatic) {
                    autoSaveLastError = '';
                    setAutoSaveStatus('数据相同，已是最新。');
                }
                return { alreadyUpToDate: true };
            }
            updateProgress(100, automatic ? '自动保存完成' : '已完成');
            recordLastSync(true);
            if (automatic) {
                autoSaveLastError = '';
                setAutoSaveStatus('自动保存完成。');
            }
            return { alreadyUpToDate: false };
        } catch (error) {
            recordLastSync(false);
            if (!automatic) {
                showSyncError(error);
                if (error.status === 401) {
                    clearStoredSyncPassword();
                    openPasswordModal('同步密码已失效，请重新输入。');
                }
            }
            if (!automatic) return { error };
            throw error;
        } finally {
            state.syncing = false;
            setActionButtonsDisabled(false);
        }
    }

    // ---- 恢复主流程 ----
    function openDownloadStagingDb() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DOWNLOAD_STAGING_DB, DOWNLOAD_STAGING_DB_VERSION);
            request.onerror = () => reject(request.error || new Error('同步临时数据库打开失败。'));
            request.onupgradeneeded = () => {
                const stagingDb = request.result;
                if (stagingDb.objectStoreNames.contains('chunks')) {
                    stagingDb.deleteObjectStore('chunks');
                }
                if (stagingDb.objectStoreNames.contains('objects')) {
                    stagingDb.deleteObjectStore('objects');
                }
                if (!stagingDb.objectStoreNames.contains(DOWNLOAD_STAGING_STORE)) {
                    stagingDb.createObjectStore(DOWNLOAD_STAGING_STORE);
                }
            };
            request.onsuccess = () => resolve(request.result);
        });
    }

    function clearDownloadStagingStore(stagingDb) {
        const tx = stagingDb.transaction([DOWNLOAD_STAGING_STORE], 'readwrite');
        tx.objectStore(DOWNLOAD_STAGING_STORE).clear();
        return waitForTransaction(tx, '同步临时数据清理失败。');
    }

    function writeDownloadStagingObjects(stagingDb, objects) {
        if (!Array.isArray(objects) || objects.length === 0) return Promise.resolve();
        const tx = stagingDb.transaction([DOWNLOAD_STAGING_STORE], 'readwrite');
        const store = tx.objectStore(DOWNLOAD_STAGING_STORE);
        objects.forEach(object => store.put(object.raw, object.index));
        return waitForTransaction(tx, '同步临时数据写入失败。');
    }

    function readDownloadStagingObjects(stagingDb, packManifest, start) {
        const packs = packManifest.slice(start, start + CONFIG.downloadPackConcurrency);
        if (packs.length === 0) return Promise.resolve([]);
        const tx = stagingDb.transaction([DOWNLOAD_STAGING_STORE], 'readonly');
        const store = tx.objectStore(DOWNLOAD_STAGING_STORE);
        const requests = packs.map((_, offset) => store.get(start + offset));
        return waitForTransaction(tx, '同步临时数据读取失败。', () => requests.map((request, offset) => {
            const value = request.result;
            const bytes = value instanceof Uint8Array
                ? value
                : value instanceof ArrayBuffer
                    ? new Uint8Array(value)
                    : null;
            if (!bytes) {
                throw new Error(`同步临时对象 ${start + offset + 1} 校验失败。`);
            }
            // 线上字段名 entries → 内部 entryCount（与下载路径同一转换）。
            return {
                bucket: packs[offset].bucket,
                checksum: packs[offset].checksum,
                length: packs[offset].length,
                entryCount: packs[offset].entries,
                index: start + offset,
                bytes
            };
        }));
    }

    // 下载批次：滑动窗口维持 6 路在途；下载字节先按清单校验（gzip 字节的
    // SHA-256 与长度），再解压出 raw JSONL 写 staging；gzip 字节同时写入
    // 本地缓存（命中缓存只验证长度，写入缓存前已按校验和完整验证过）。
    async function* downloadPacksToStaging(remote, stagingDb) {
        await clearDownloadStagingStore(stagingDb);
        const cacheDb = await openLocalSyncCache().catch(() => null);
        const packManifest = remote.packs;
        const concurrency = CONFIG.downloadPackConcurrency;
        let nextToFetch = 0;
        let completed = 0;
        const inflight = new Map();
        const startNext = () => {
            if (nextToFetch >= packManifest.length) return;
            const index = nextToFetch++;
            const pack = packManifest[index];
            const pending = (async () => {
                let compressed = cacheDb ? await cachePack(cacheDb, pack.checksum).catch(() => null) : null;
                let cacheHit = false;
                if (compressed?.byteLength === pack.length) {
                    cacheHit = true;
                } else {
                    compressed = await getPack(pack.checksum);
                    if (compressed.byteLength !== pack.length) {
                        throw new Error(`服务器数据包 ${index + 1} 大小校验失败。`);
                    }
                    if (await sha256Bytes(compressed) !== pack.checksum) {
                        throw new Error(`服务器数据包 ${index + 1} 校验失败。`);
                    }
                }
                const raw = await gunzipBytes(compressed);
                return { pack, index, raw, compressed, cacheHit };
            })();
            pending.catch(() => { });
            inflight.set(index, pending);
        };
        let staged = [];
        let pendingCachePacks = [];
        try {
            for (let i = 0; i < concurrency && nextToFetch < packManifest.length; i += 1) startNext();
            while (inflight.size) {
                const index = Math.min(...inflight.keys());
                const downloaded = await inflight.get(index);
                inflight.delete(index);
                startNext();
                completed += 1;
                updateProgress(8 + Math.round((completed / packManifest.length) * 57), '正在恢复…');
                // 线上字段名 entries 转内部 entryCount，parse/断言按内部命名消费。
                yield {
                    bucket: downloaded.pack.bucket,
                    checksum: downloaded.pack.checksum,
                    length: downloaded.pack.length,
                    entryCount: downloaded.pack.entries,
                    index,
                    bytes: downloaded.raw
                };
                staged.push({ index: downloaded.index, raw: downloaded.raw });
                if (!downloaded.cacheHit) pendingCachePacks.push({ checksum: downloaded.pack.checksum, bytes: downloaded.compressed });
                if (staged.length >= concurrency) {
                    await writeDownloadStagingObjects(stagingDb, staged);
                    if (cacheDb && pendingCachePacks.length) await cacheWritePacks(cacheDb, pendingCachePacks);
                    staged = [];
                    pendingCachePacks = [];
                }
            }
            await writeDownloadStagingObjects(stagingDb, staged);
            if (cacheDb && pendingCachePacks.length) await cacheWritePacks(cacheDb, pendingCachePacks);
        } finally {
            for (const pending of inflight.values()) pending.catch(() => { });
            cacheDb?.close();
        }
    }

    async function* iterateStagedSnapshotPacks(stagingDb, packManifest) {
        for (let start = 0; start < packManifest.length; start += CONFIG.downloadPackConcurrency) {
            for (const pack of await readDownloadStagingObjects(stagingDb, packManifest, start)) {
                yield pack;
            }
        }
    }

    class ObjectSnapshotRestorer {
        constructor(expectedEntryCount, { validateOnly = false } = {}) {
            this.expectedEntryCount = Number(expectedEntryCount || 0);
            this.validateOnly = validateOnly;
            this.entryCount = 0;
            this.finished = false;
            this.localStorageEnded = false;
            this.localStorageKeys = new Set();
            this.seenDatabases = new Set();
            this.currentDatabase = null;
            this.yieldIfNeeded = createYieldController();
        }

        async consume(value) {
            const object = value;
            if (!object || typeof object !== 'object' || Array.isArray(object)) {
                throw new Error('服务器同步对象格式不正确。');
            }
            switch (object.type) {
                case 'localStorage':
                    this.restoreLocalStorageEntry(object);
                    break;
                case 'database':
                    await this.startDatabase(object);
                    break;
                case 'record':
                    await this.restoreRecord(object);
                    break;
                case 'recordArrayStart':
                    this.startArrayRecord(object);
                    break;
                case 'recordArrayItem':
                    this.restoreArrayRecordItem(object);
                    break;
                case 'recordArrayEnd':
                    await this.finishArrayRecord(object);
                    break;
                case 'storeEnd':
                    await this.finishStore(object);
                    break;
                case 'databaseEnd':
                    await this.finishDatabase(object);
                    break;
                default:
                    throw new Error('服务器同步包含未知对象。');
            }
            this.entryCount += 1;
        }

        restoreLocalStorageEntry(line) {
            if (this.localStorageEnded || this.currentDatabase || typeof line.key !== 'string') {
                throw new Error('服务器本地设置记录顺序不正确。');
            }
            if (!isAppLocalStorageKey(line.key)) throw new Error('服务器包含无效的本地设置。');
            if (!this.validateOnly) localStorage.setItem(line.key, String(line.value ?? ''));
            this.localStorageKeys.add(line.key);
        }

        finishLocalStorage() {
            if (this.currentDatabase) {
                throw new Error('服务器本地设置结束标记不正确。');
            }
            if (this.localStorageEnded) return;
            if (!this.validateOnly) {
                for (const entry of readLocalStorageSnapshot()) {
                    if (!this.localStorageKeys.has(entry.key)) localStorage.removeItem(entry.key);
                }
            }
            this.localStorageEnded = true;
        }

        async startDatabase(line) {
            this.finishLocalStorage();
            if (this.currentDatabase || this.seenDatabases.has(line.name) || typeof line.name !== 'string') {
                throw new Error('服务器数据库记录顺序不正确。');
            }
            const knownDb = CONFIG.knownDatabases.find(dbDef => dbDef.name === line.name);
            if (!knownDb) {
                this.currentDatabase = { name: line.name, ignored: true };
                return;
            }
            const seenStoreNames = new Set();
            const stores = (Array.isArray(line.stores) ? line.stores : []).filter(storeDef => {
                if (!storeDef || !knownDb.stores.includes(storeDef.name) || seenStoreNames.has(storeDef.name)) return false;
                seenStoreNames.add(storeDef.name);
                return true;
            }).map(storeDef => ({
                name: storeDef.name,
                keyPath: storeDef.keyPath,
                autoIncrement: Boolean(storeDef.autoIncrement)
            }));
            if (this.validateOnly && stores.length) await preflightRestoreDatabase({ name: line.name, stores });
            const db = !this.validateOnly && stores.length > 0
                ? await openDbForRestore({ name: line.name, stores })
                : null;
            this.currentDatabase = {
                name: line.name,
                db,
                knownDb,
                stores: new Map(stores.map(storeDef => [storeDef.name, {
                    definition: storeDef,
                    incomingKeys: new Set(),
                    batch: [],
                    batchBytes: 0,
                    arrayRecord: null,
                    finished: false
                }]))
            };
            this.seenDatabases.add(line.name);
        }

        getStoreState(line) {
            const current = this.currentDatabase;
            if (!current || line.database !== current.name || typeof line.store !== 'string') {
                throw new Error('服务器数据库记录归属不正确。');
            }
            if (current.ignored) return null;
            const storeState = current.stores.get(line.store);
            if (!storeState || storeState.finished) throw new Error('服务器对象存储记录顺序不正确。');
            return storeState;
        }

        async queueStoreRecord(storeState, record) {
            const token = stableKeyToken(record.key);
            // 校验路径也要发现重复键：真实恢复写入时后一条会覆盖前一条，
            // 静默接受会让"校验通过"和服务端快照语义不一致。
            if (storeState.incomingKeys.has(token)) {
                throw new Error('服务器同步包含重复的对象键。');
            }
            storeState.incomingKeys.add(token);
            if (this.validateOnly) return;
            storeState.batch.push(record);
            storeState.batchBytes += estimateRecordBytes(record.value);
            if (storeState.batch.length >= CONFIG.restoreBatchSize || storeState.batchBytes >= CONFIG.scanBatchBytes) {
                await this.flushStore(storeState);
            }
        }

        async restoreRecord(line) {
            const storeState = this.getStoreState(line);
            if (!storeState) return;
            if (storeState.arrayRecord) throw new Error('服务器数组记录尚未结束。');
            if (isSyncExcludedRecord(this.currentDatabase.name, line.store, line.key)) {
                return;
            }
            const record = {
                key: line.key,
                value: Object.prototype.hasOwnProperty.call(line, 'value') ? line.value : undefined
            };
            await this.queueStoreRecord(storeState, record);
        }

        startArrayRecord(line) {
            const storeState = this.getStoreState(line);
            if (!storeState) return;
            if (storeState.arrayRecord) {
                throw new Error('服务器数组记录头信息不正确。');
            }
            storeState.arrayRecord = {
                key: line.key,
                value: [],
                nextIndex: 0,
                excluded: isSyncExcludedRecord(this.currentDatabase.name, line.store, line.key)
            };
        }

        restoreArrayRecordItem(line) {
            const storeState = this.getStoreState(line);
            if (!storeState) return;
            const arrayRecord = storeState.arrayRecord;
            if (!arrayRecord || stableKeyToken(line.key) !== stableKeyToken(arrayRecord.key)
                || Number(line.index) !== arrayRecord.nextIndex) {
                throw new Error('服务器数组记录顺序不正确。');
            }
            if (!arrayRecord.excluded && !this.validateOnly) {
                arrayRecord.value.push(Object.prototype.hasOwnProperty.call(line, 'value') ? line.value : null);
            }
            arrayRecord.nextIndex += 1;
        }

        async finishArrayRecord(line) {
            const storeState = this.getStoreState(line);
            if (!storeState) return;
            const arrayRecord = storeState.arrayRecord;
            if (!arrayRecord || stableKeyToken(line.key) !== stableKeyToken(arrayRecord.key)
                || Number(line.length) !== arrayRecord.nextIndex) {
                throw new Error('服务器数组记录数据不完整。');
            }
            storeState.arrayRecord = null;
            if (arrayRecord.excluded) {
                return;
            }
            await this.queueStoreRecord(storeState, { key: arrayRecord.key, value: arrayRecord.value });
            await this.flushStore(storeState);
        }

        async flushStore(storeState) {
            if (this.validateOnly || storeState.batch.length === 0) return;
            const batch = storeState.batch;
            storeState.batch = [];
            storeState.batchBytes = 0;
            await writeObjectStoreRecordBatch(this.currentDatabase.db, storeState.definition, batch);
            await this.yieldIfNeeded();
        }

        async finishStore(line) {
            const current = this.currentDatabase;
            if (!current || line.database !== current.name || typeof line.store !== 'string') {
                throw new Error('服务器对象存储结束顺序不正确。');
            }
            if (current.ignored) return;
            const storeState = current.stores.get(line.store);
            if (!storeState || storeState.finished) throw new Error('服务器对象存储结束顺序不正确。');
            if (storeState.arrayRecord) throw new Error('服务器数组记录尚未结束。');
            await this.flushStore(storeState);
            if (!this.validateOnly) {
                await deleteMissingObjectStoreRecords(current.db, current.name, line.store, storeState.incomingKeys);
            }
            storeState.incomingKeys.clear();
            storeState.finished = true;
        }

        async finishDatabase(line) {
            const current = this.currentDatabase;
            if (!current || line.name !== current.name) throw new Error('服务器数据库结束标记不正确。');
            if (!current.ignored) {
                if ([...current.stores.values()].some(storeState => !storeState.finished)) {
                    throw new Error('服务器对象存储数据不完整。');
                }
                if (current.db) current.db.close();
                const missingStores = current.knownDb.stores.filter(storeName => !current.stores.has(storeName));
                if (!this.validateOnly && missingStores.length > 0) {
                    await clearKnownIndexedDbStores(current.knownDb, missingStores);
                }
            }
            this.currentDatabase = null;
        }

        async finish() {
            if (this.finished) throw new Error('服务器同步恢复已结束。');
            if (this.currentDatabase) throw new Error('服务器数据库数据不完整。');
            this.finishLocalStorage();
            if (this.entryCount !== this.expectedEntryCount) {
                throw new Error('服务器同步对象数量校验失败。');
            }
            if (!this.validateOnly) {
                for (const knownDb of CONFIG.knownDatabases) {
                    if (!this.seenDatabases.has(knownDb.name)) {
                        await clearKnownIndexedDbStores(knownDb, knownDb.stores);
                    }
                }
            }
            this.finished = true;
        }

        abort() {
            if (this.currentDatabase?.db) this.currentDatabase.db.close();
            this.currentDatabase = null;
        }
    }

    async function parsePackSnapshot(packSource, packCount, consumer, options = {}) {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        let completed = 0;
        let fragments = [];
        let fragmentBytes = 0;
        let previousBucket = null;
        for await (const pack of packSource) {
            if (previousBucket !== pack.bucket && fragmentBytes) {
                throw new Error('服务器同步分片记录不完整。');
            }
            previousBucket = pack.bucket;
            let count = 0;
            let offset = 0;
            while (offset < pack.bytes.byteLength) {
                const end = pack.bytes.indexOf(10, offset);
                const piece = pack.bytes.subarray(offset, end === -1 ? pack.bytes.byteLength : end);
                fragmentBytes += piece.byteLength;
                if (fragmentBytes > MAX_SUPPORTED_OBJECT_BYTES) throw new Error('服务器单条数据超过 64MiB 上限。');
                fragments.push(piece);
                if (end === -1) break;
                let bytes = fragments[0];
                if (fragments.length > 1) {
                    bytes = new Uint8Array(fragmentBytes);
                    let position = 0;
                    for (const fragment of fragments) { bytes.set(fragment, position); position += fragment.byteLength; }
                }
                let value;
                try { value = JSON.parse(decoder.decode(bytes)); }
                catch (_) { throw new Error('服务器同步数据包 JSON 不正确。'); }
                fragments = [];
                fragmentBytes = 0;
                await consumer.consume(value, pack, bytes);
                count += 1;
                offset = end + 1;
            }
            if (count !== pack.entryCount) throw new Error('服务器同步数据包记录数量不一致。');
            if (typeof consumer.packComplete === 'function') await consumer.packComplete(pack);
            completed += 1;
            if (typeof options.onProgress === 'function') options.onProgress(completed, packCount);
        }
        if (completed !== packCount) throw new Error('服务器同步数据包数量不一致。');
        if (fragmentBytes || fragments.length) throw new Error('服务器同步记录尚未结束。');
        await consumer.finish();
    }

    // entry 传入时复用已算好的 id/group/sourceKey/bucketKey（恢复热路径
    // buildCacheEntry 刚算过同一套值），缺省时从 value 现算。
    function assertPackEntryPlacement(value, pack, entry = null) {
        const bucket = entry?.bucketKey ?? snapshotEntryBucket(
            value, snapshotEntryId(value), snapshotEntrySource(value)
        );
        if (bucket !== pack.bucket) {
            throw new Error('服务器同步分片索引不一致。');
        }
    }

    async function restoreSnapshotAndCache(stagingDb, remote, dirtyState) {
        const cacheDb = await openLocalSyncCache();
        const restorer = new ObjectSnapshotRestorer(remote.entryCount);
        let pendingEntries = [];
        let pendingBytes = 0;
        let entryCount = 0;
        const flushEntries = async () => {
            if (pendingEntries.length === 0) return;
            const entries = pendingEntries;
            pendingEntries = [];
            pendingBytes = 0;
            await cacheWriteEntries(cacheDb, entries);
        };
        try {
            // 只清派生索引（entries/state），保留分片缓存：分片在下载阶段
            // 已按校验和验证并写入缓存，清掉会让下次恢复重新下载整库。
            await cacheClearDerived(cacheDb);
            await parsePackSnapshot(
                iterateStagedSnapshotPacks(stagingDb, remote.packs),
                remote.packs.length,
                {
                    async consume(value, pack, lineBytes) {
                        await restorer.consume(value);
                        const entry = buildCacheEntry(value, lineBytes);
                        // 恢复热路径：placement 断言直接复用 entry 的派生字段。
                        assertPackEntryPlacement(value, pack, entry);
                        entry.bucketKey = pack.bucket;
                        pendingEntries.push(entry);
                        pendingBytes += entry.bytes.byteLength;
                        entryCount += 1;
                        if (pendingBytes >= CONFIG.cacheWriteBytes || pendingEntries.length >= CONFIG.readBatchSize) {
                            await flushEntries();
                        }
                    },
                    async finish() {
                        await restorer.finish();
                        await flushEntries();
                    }
                },
                {
                    onProgress: (completed, total) => {
                        updateProgress(72 + Math.round((completed / total) * 27), '正在恢复…');
                    }
                }
            );
            if (entryCount !== Number(remote.entryCount)) {
                throw new Error('服务器同步缓存记录数量不一致。');
            }
            // 恢复侧重建内部分片状态：group 从 bucket 键反解（'|' 前缀），
            // part 按同桶出现顺序编号，顺序沿用清单数组顺序。
            const groups = [];
            const partByBucket = new Map();
            const packs = remote.packs.map(pack => {
                const group = String(pack.bucket).split('|')[0];
                if (!groups.includes(group)) groups.push(group);
                const part = partByBucket.get(pack.bucket) || 0;
                partByBucket.set(pack.bucket, part + 1);
                return { bucket: pack.bucket, group, part, checksum: pack.checksum, length: pack.length, entryCount: pack.entries };
            });
            await cacheWriteState(cacheDb, {
                version: CACHE_FORMAT_VERSION,
                groups,
                packs,
                epoch: localStorage.getItem(TRACKING_EPOCH_KEY),
                epochs: dirtyState.epochs,
                // 恢复完成即本机与该根一致：带上"已提交"记忆，无变化自动保存
                // 从恢复后第一次起可走快速通道（journalWatermark 由
                // acknowledge 后的下一次快照准备补齐；缺失时快速通道自退回
                // 完整流程）。
                committed: { checksum: String(remote.checksum || ''), at: Date.now() },
                journalWatermark: { databases: dirtyState.watermark.databases },
                snapshot: {
                    format: SNAPSHOT_FORMAT,
                    compression: SNAPSHOT_COMPRESSION,
                    totalBytes: Number(remote.totalBytes),
                    entryCount: Number(remote.entryCount)
                }
            });
            await window.RPH_SYNC_TRACKER.acknowledge(dirtyState.watermark);
        } catch (error) {
            restorer.abort();
            await cacheClearDerived(cacheDb);
            throw error;
        } finally {
            cacheDb.close();
        }
    }

    async function restorePackSnapshot(remote) {
        const stagingDb = await openDownloadStagingDb();
        try {
            const validator = new ObjectSnapshotRestorer(remote.entryCount, { validateOnly: true });
            await parsePackSnapshot(
                downloadPacksToStaging(remote, stagingDb),
                remote.packs.length,
                {
                    async consume(value, pack) {
                        assertPackEntryPlacement(value, pack);
                        await validator.consume(value);
                    },
                    async finish() { await validator.finish(); }
                }
            );
            updateProgress(72, '正在恢复…');
            const restoreEpoch = crypto.randomUUID();
            // 写冻结信号先于任何业务库写入：其他标签页收到 storage 事件后
            // 暂停写入并显示恢复遮罩；本标签页由 waitForIndexedDbWriteBarrier
            // 等待在途写事务收尾。恢复中途失败时保留该标记（其他标签页
            // 维持写冻结），由中断恢复流程接管或完整重试后清除。
            localStorage.setItem(RESTORE_ACTIVE_KEY, restoreEpoch);
            localStorage.setItem(RESTORE_EPOCH_KEY, restoreEpoch);
            await waitForIndexedDbWriteBarrier();
            // 一次 readDirtyState 同时供恢复水印（acknowledge）与
            // 缓存 epochs 使用，避免恢复路径重复全量扫描变更日志。
            const dirtyState = await readDirtyState();
            await restoreSnapshotAndCache(stagingDb, remote, dirtyState);
            if (localStorage.getItem(RESTORE_ACTIVE_KEY) === restoreEpoch) {
                localStorage.removeItem(RESTORE_ACTIVE_KEY);
            }
        } finally {
            try { await clearDownloadStagingStore(stagingDb); } catch (_) { }
            stagingDb.close();
        }
    }

    async function pullFromServerUnlocked() {
        if (state.syncing) return;
        state.syncing = true;
        pauseAutoSave('正在恢复，自动保存已暂停。');

        try {
            openModal();
            setActionButtonsDisabled(true);
            updateProgress(4, '正在恢复…');
            const manifestResponse = await postSync({ action: 'status' });
            const remote = manifestResponse.manifest ? await validateRemoteManifest(manifestResponse.manifest) : null;

            if (!remote) {
                updateProgress(100, '没有可恢复的数据');
                if (RESTORE_PAGE) location.replace('/');
                return;
            }
            updateProgress(8, '正在恢复…');
            await restorePackSnapshot(remote);
            // committed/journalWatermark 已由 restoreSnapshotAndCache 一并写
            // 入缓存状态：恢复完成后本机即与云端根一致，无变化自动保存可直接
            // 走快速通道（每满验证间隔重新完整验证一次）。

            recordLastSync(true);
            updateProgress(100, '恢复完成');
            if (RESTORE_PAGE) {
                location.replace('/');
            } else {
                location.reload();
            }
        } catch (error) {
            recordLastSync(false);
            showSyncError(error);
            if (error.status === 401) openPasswordModal('请输入同步密码后恢复。');
        } finally {
            state.syncing = false;
            setActionButtonsDisabled(false);
        }
    }

    const pullFromServer = () => runSyncOperation(() => pullFromServerUnlocked());
    const pushToServer = () => runSyncOperation(() => pushToServerUnlocked());

    window.RPH_R2_OPEN_SYNC = () => {
        handleSyncButtonClick().catch(() => { });
    };

    const accessGateReady = startAccessGate();

    if (!RESTORE_PAGE) {
        // 后台快照准备触发器：业务写入后防抖 8 秒；回到前台尽快补一次；
        // 页面加载预热 3 秒——首次使用（无本地索引）时提前完整扫描，
        // 让"首次上传"不再从零等待。
        window.addEventListener('rphub:dirty', () => scheduleBackgroundPrepare());
        document.addEventListener('visibilitychange', () => {
            if (isAutoSavePageActive()) scheduleBackgroundPrepare(1000);
        });
        scheduleBackgroundPrepare(3000);
    }

    if (RESTORE_PAGE) {
        const beginRestore = () => {
            ensureModal();
            openModal();
            pullFromServer().catch(() => { });
        };
        const domReady = document.readyState === 'loading'
            ? new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, { once: true }))
            : Promise.resolve();
        Promise.all([domReady, accessGateReady]).then(beginRestore);
    } else if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            ensureModal();
        }, { once: true });
    } else {
        ensureModal();
    }
})();

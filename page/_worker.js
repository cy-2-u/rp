// RP Hub 魔改版 Worker（v2 重写版）
//
// 单文件、无构建、无 import。职责：
//   1. 反向代理作者站（sta1n156.github.io/RP-Hub），主页注入增强脚本；
//   2. 适配脚本链：外部脚本 → 部署兜底脚本 → R2 last-good（全部失败则降级）；
//   3. 同步 API v2（rp-sync/v2/，全量根清单 + gzip 内容寻址分片，无会话无 GC 状态机）；
//   4. 图片 API（R2 托管、缩略图、墓碑、ynai/sta1n 密钥路由）与图库管理页。
// 免费版约束优先于抽象美观：单请求不做全量聚合，分片正文永远直通 R2。

const AUTHOR_BASE = 'https://sta1n156.github.io/RP-Hub/';

// ---- 部署配置与适配脚本链 ----
const CONFIG_ASSET_PATH = '/config.json';
const ADAPTER_ASSET_PATH = '/adapter/rp-hub-v2.js';
const ADAPTER_URL_ENV = 'RPHUB_ADAPTER_URL';
const ADAPTER_SUMMARY_PATH = '/__rphub/adapter.json';
// 脚本链各源共用的轻校验上限与契约标记：外部脚本是可执行代码，Worker 不做
// 字段级 schema 校验，只确认"非空、不超限、含契约标记"，避免新增一票否决点。
const ADAPTER_MAX_BYTES = 512 * 1024;
const ADAPTER_CONTRACT_MARKER = 'RPHubExternal';
const CONFIG_MAX_BYTES = 64 * 1024;
const ADAPTER_FETCH_TIMEOUT_MS = 10 * 1000;
const ADAPTER_CACHE_TTL_MS = 30 * 1000;
const ADAPTER_FAILURE_TTL_MS = 5 * 1000;
const CONFIG_CACHE_TTL_MS = 30 * 1000;
const DEPLOY_CONFIG_FORMAT = 'rp-magic-config-v2';
// last-good 副本使用 v2 键名，与旧部署（last-good-script-v1.js）互不干扰。
const ADAPTER_LASTGOOD_KEY = 'rp-adapter/last-good-script-v2.js';
const CONFIG_LASTGOOD_KEY = 'rp-adapter/last-good-config-v2.json';

const R2_BINDING = 'RP_SYNC_R2';
const SYNC_PASSWORD_ENV = 'RP_SYNC_PASSWORD';
const SYNC_PASSWORD_HEADER = 'x-rp-sync-password';

// ---- 同步 v2 协议 ----
// 数据全部在 rp-sync/v2/ 前缀下，与旧版部署的前缀互不读写；
// 云端快照全新开始，首次上传完整重建。
const SYNC_API_PATH = '/api/rp-sync';
const SYNC_PREFIX = 'rp-sync/v2';
const MANIFEST_KEY = `${SYNC_PREFIX}/manifest.json`;
const PACK_PREFIX = `${SYNC_PREFIX}/packs`;
const MANIFEST_FORMAT = 'rp-sync-manifest-v2';
const MANIFEST_COMPRESSION = 'gzip';
const MAX_SNAPSHOT_BYTES = 1024 * 1024 * 1024;
const MAX_PACKS = 4096;
const MAX_PACK_ENTRIES = 512;
// 分片原始上限 4MiB 由客户端保证；Worker 只能看到 gzip 后字节，放宽到 6MiB。
const MAX_PACK_STORED_BYTES = 6 * 1024 * 1024;
const MANIFEST_MAX_BYTES = 1024 * 1024;
const SYNC_REQUEST_MAX_BYTES = 1024 * 1024;
const COMMIT_ATTEMPTS = 3;
const PACK_CACHE_TTL_SECONDS = 31536000;
const SWEEP_GRACE_MS = 60 * 60 * 1000;
// 根清单按 etag 索引缓存（内容寻址语义下同一 etag 必然同一内容）；
// 写路径一律 fresh 读取。首版单用户，缓存只为省重复 GET。
const manifestStateCache = new Map();
const MANIFEST_STATE_CACHE_MAX = 8;
const manifestByBucket = new WeakMap();
const MANIFEST_STATE_TTL_MS = 1500;

// ---- 图片 API ----
const IMAGE_API_PATH = '/api/rp-image';
const IMAGE_MODELS_PATH = '/api/rp-image-models';
const IMAGE_ADMIN_PATH = '/image';
const IMAGE_GALLERY_ASSET = '/gallery.html';
const IMAGE_PREFIX = 'rp-images';
const IMAGE_OBJECT_PREFIX = `${IMAGE_PREFIX}/characters`;
const IMAGE_THUMB_PREFIX = `${IMAGE_PREFIX}/thumbs`;
const IMAGE_DELETED_PREFIX = `${IMAGE_PREFIX}/_deleted`;
// 墓碑与图库列表的 isolate 内短缓存：图库页整库加载是热点路径。
const IMAGE_TOMBSTONE_CACHE_TTL_MS = 7 * 1000;
const IMAGE_LIBRARY_CACHE_TTL_MS = 7 * 1000;
const imageTombstoneCache = new WeakMap();
const imageLibraryCache = new WeakMap();
const IMAGE_DELETE_MAX_KEYS_PER_REQUEST = 20;
const IMAGE_DELETE_MAX_CHARACTER_NAMES_PER_REQUEST = 4;
const IMAGE_MAX_BYTES = 24 * 1024 * 1024;
const YNAI_MAX_BYTES = 16 * 1024 * 1024;
const YNAI_JSON_MAX_BYTES = Math.ceil(YNAI_MAX_BYTES / 3) * 4 + 64 * 1024;
const IMAGE_THUMB_MAX_BYTES = 2 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 300000;
const IMAGE_DEFAULT_MODEL = 'nai-diffusion-4-5-full';
const IMAGE_DEFAULT_SIZE = '竖图';
const IMAGE_DEFAULT_STEPS = '40';
const IMAGE_DEFAULT_STEPS_YNAI = '28';
const IMAGE_DEFAULT_SCALE = '6';
const IMAGE_DEFAULT_CFG = '0';
const IMAGE_DEFAULT_SAMPLER = 'k_dpmpp_2m_sde';
const IMAGE_DEFAULT_NOISE_SCHEDULE = 'karras';
const IMAGE_PARAM_KEYS = ['tag', 'model', 'artist', 'size', 'steps', 'scale', 'cfg', 'sampler', 'negative', 'nocache', 'noise_schedule'];
// 密钥即路由：YNAI- 前缀密钥走第三方中转（OpenAI images 形状），其余走 sta1n 原生。
// 签名里 provider 恒为 'sta1n'，两个提供商共享同一内容寻址缓存，历史图键稳定。
const IMAGE_UPSTREAM_STA1N = 'https://nai.sta1n.cn';
const IMAGE_SIZE_PIXELS = { '竖图': '832x1216', '横图': '1216x832', '方图': '1024x1024' };
const IMAGE_MODELS_CACHE_TTL_MS = 30 * 1000;
const IMAGE_MODELS_MAX_BYTES = 256 * 1024;
const imageModelsCache = new Map();

// ---- 作者站代理 ----
const AUTHOR_HEADER_TIMEOUT_MS = 8 * 1000;
const AUTHOR_BODY_IDLE_TIMEOUT_MS = 30 * 1000;
const AUTHOR_CACHE_TTL_SECONDS = 45;

const textEncoder = new TextEncoder();

// ============================================================ 通用工具

function json(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            ...extraHeaders
        }
    });
}

function error(message, status = 400, extra = {}) {
    return json({ ok: false, error: message, ...extra }, status);
}

class SyncRequestError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}

function sha256Hex(bytes) {
    return crypto.subtle.digest('SHA-256', bytes).then(digest =>
        Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('')
    );
}

function sha256Text(text) {
    return sha256Hex(textEncoder.encode(text));
}

function checksumBytes(checksum) {
    const bytes = new Uint8Array(32);
    for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = parseInt(checksum.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes.buffer;
}

async function runConcurrent(items, limit, worker) {
    const results = new Array(items.length);
    let cursor = 0;
    const workerCount = Math.min(Math.max(1, limit), items.length);
    async function runNext() {
        while (cursor < items.length) {
            const index = cursor;
            cursor += 1;
            results[index] = await worker(items[index], index);
        }
    }
    if (workerCount === 0) return results;
    await Promise.all(Array.from({ length: workerCount }, () => runNext()));
    return results;
}

// 有界文本读取：声明长度超限直接拒绝，逐块累计兜底流式响应。
async function readBoundedText(response, maxBytes, signal) {
    const reader = response.body?.getReader();
    if (!reader) return '';
    const cancel = () => { void reader.cancel().catch(() => {}); };
    signal?.addEventListener('abort', cancel, { once: true });
    let text = '';
    let total = 0;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    try {
        const declaredLength = Number(response.headers?.get?.('content-length') ?? 0);
        if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
            throw new Error('Response exceeds size limit.');
        }
        while (true) {
            if (signal?.aborted) throw new Error('Response read timed out.');
            const { done, value } = await reader.read();
            if (signal?.aborted) throw new Error('Response read timed out.');
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) throw new Error('Response exceeds size limit.');
            text += decoder.decode(value, { stream: true });
        }
        return text + decoder.decode();
    } catch (err) {
        cancel();
        throw err;
    } finally {
        signal?.removeEventListener('abort', cancel);
        reader.releaseLock();
    }
}

// 有界二进制读取：优先按声明长度一次分配、各分片零拷贝写入，峰值内存单倍。
async function readBoundedBytes(message, maxBytes, label, signal) {
    const reader = message.body?.getReader();
    const cancel = () => { if (reader) void reader.cancel().catch(() => {}); };
    const tooLarge = size => Object.assign(new Error(`${label}：${size}/${maxBytes}`), { status: 413 });
    signal?.addEventListener('abort', cancel, { once: true });
    try {
        const declaredLength = Number(message.headers.get('content-length') || 0);
        if (declaredLength > maxBytes) throw tooLarge(declaredLength);
        let buffer = Number.isSafeInteger(declaredLength) && declaredLength >= 1 ? new Uint8Array(declaredLength) : null;
        let total = 0;
        while (reader) {
            if (signal?.aborted) throw new Error('Read timed out.');
            const { done, value } = await reader.read();
            if (signal?.aborted) throw new Error('Read timed out.');
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) throw tooLarge(total);
            if (!buffer || total > buffer.byteLength) {
                const grown = new Uint8Array(Math.min(maxBytes, Math.max(total, (buffer?.byteLength || 0) * 2, 1024 * 1024)));
                if (buffer) grown.set(buffer.subarray(0, total - value.byteLength));
                buffer = grown;
            }
            buffer.set(value, total - value.byteLength);
        }
        if (!buffer) return new ArrayBuffer(0);
        if (total === buffer.byteLength) return buffer.buffer;
        return buffer.slice(0, total).buffer;
    } catch (err) {
        cancel();
        throw err;
    } finally {
        signal?.removeEventListener('abort', cancel);
        reader?.releaseLock();
    }
}

// 作者正文空闲超时守卫：只约束"块与块之间"的停顿，大文件整体不被总时长截断。
function guardBodyIdleTimeout(body, timeoutMs) {
    const reader = body.getReader();
    let timer = null;
    const clear = () => {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
    };
    return new ReadableStream({
        async pull(controller) {
            clear();
            timer = setTimeout(() => {
                timer = null;
                void reader.cancel().catch(() => {});
                controller.error(new Error('Response body idle timeout.'));
            }, timeoutMs);
            try {
                const { done, value } = await reader.read();
                clear();
                if (done) controller.close();
                else controller.enqueue(value);
            } catch (err) {
                clear();
                controller.error(err);
            }
        },
        cancel(reason) {
            clear();
            return reader.cancel(reason);
        }
    });
}

function formatBytes(bytes) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = Math.max(0, Number(bytes) || 0);
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
        value /= 1024;
        index += 1;
    }
    return `${value.toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}

function getBucket(env) {
    const bucket = env?.[R2_BINDING];
    if (!bucket) throw new Error('Missing R2 bucket binding.');
    return bucket;
}

// ============================================================ 部署配置（config.json）

// config.json 是 Worker 侧自己的云端配置（外部适配脚本 URL、ynai 中转端点），
// 随部署发布、经 ASSETS 读取；读取失败回退 R2 last-good，两者都不可用才失败。
const deployConfigCache = new WeakMap();
// 上次写入 last-good 的序列化值：内容未变不重复写 R2（免费版 Class A 写额
// 有限），与适配脚本链的 adapterLastGoodPersisted 同一守卫模式。
let configLastGoodPersisted = null;

function defaultDeployConfig() {
    return { format: DEPLOY_CONFIG_FORMAT, adapter: { externalUrl: '' }, image: { ynai: null } };
}

async function loadDeployConfig(env) {
    const cached = env ? deployConfigCache.get(env) : null;
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const loading = (async () => {
        let value = null;
        try {
            const asset = await env?.ASSETS?.fetch(new Request(`https://assets.local${CONFIG_ASSET_PATH}`));
            if (asset?.ok) {
                const text = (await readBoundedText(asset, CONFIG_MAX_BYTES)).replace(/^\uFEFF/, '');
                const parsed = JSON.parse(text);
                if (parsed && typeof parsed === 'object') value = parsed;
            }
        } catch (_) { /* 走 last-good 兜底 */ }
        if (!value) {
            const lastGood = await env?.[R2_BINDING]?.get(CONFIG_LASTGOOD_KEY);
            if (lastGood) {
                try {
                    const parsed = JSON.parse(await readBoundedText(lastGood, CONFIG_MAX_BYTES));
                    if (parsed && typeof parsed === 'object') value = parsed;
                } catch (_) { /* last-good 也损坏则按无配置处理 */ }
            }
        }
        const config = { ...defaultDeployConfig(), ...value, format: DEPLOY_CONFIG_FORMAT };
        // 成功读取部署正本时顺手刷新 last-good（写入失败不影响服务）；
        // 内容未变时跳过写入，避免每个 isolate 每 30 秒都消耗一次 R2 写额。
        const lastGoodValue = value ? JSON.stringify(value) : null;
        if (lastGoodValue !== null && env?.[R2_BINDING] && lastGoodValue !== configLastGoodPersisted) {
            configLastGoodPersisted = lastGoodValue;
            try {
                await env[R2_BINDING].put(CONFIG_LASTGOOD_KEY, lastGoodValue, {
                    httpMetadata: { contentType: 'application/json; charset=utf-8' }
                });
            } catch (_) { }
        }
        if (env) deployConfigCache.set(env, { value: config, expiresAt: Date.now() + CONFIG_CACHE_TTL_MS });
        return config;
    })();
    try {
        return await loading;
    } catch (err) {
        if (env) deployConfigCache.set(env, { value: null, expiresAt: Date.now() + ADAPTER_FAILURE_TTL_MS });
        throw err;
    }
}

// ynai 中转端点只认 config.json：换中转站改配置文件重新部署即可；
// 配置缺失或形状非法时返回 null，ynai 生图显式报错（不做代码兜底）。
function resolveYnaiConfig(config) {
    const cfg = config?.image?.ynai;
    const base = typeof cfg?.base === 'string' && cfg.base.startsWith('https://') ? cfg.base.replace(/\/+$/, '') : null;
    const modelsPath = typeof cfg?.modelsPath === 'string' && cfg.modelsPath.startsWith('/') ? cfg.modelsPath : null;
    const generatePath = typeof cfg?.generatePath === 'string' && cfg.generatePath.startsWith('/') ? cfg.generatePath : null;
    if (!base || !modelsPath || !generatePath) return null;
    const defaultModel = typeof cfg?.defaultModel === 'string' && cfg.defaultModel ? cfg.defaultModel : null;
    return { base, modelsPath, generatePath, defaultModel };
}

// ============================================================ 适配脚本链

// 优先级：外部脚本（config.json / 环境变量）→ 部署兜底脚本（ASSETS）→ R2 last-good。
// 作者前端改版后只更新外部脚本这一个文件；兜底脚本保证首次部署开箱即用；
// last-good 保证外部源故障时站点仍可用。全部失败时主页只注入 dirty-tracker。
let adapterCacheByKey = new Map();
let adapterLastGoodPersisted = null;

function lightValidateScript(source) {
    if (!source || !source.trim()) throw new Error('适配脚本为空。');
    if (textEncoder.encode(source).byteLength > ADAPTER_MAX_BYTES) throw new Error('适配脚本超过大小上限。');
    if (!source.includes(ADAPTER_CONTRACT_MARKER)) throw new Error('适配脚本缺少契约标记。');
    return source;
}

async function fetchExternalAdapter(url) {
    const signal = AbortSignal.timeout(ADAPTER_FETCH_TIMEOUT_MS);
    const response = await fetch(url, { headers: { accept: 'application/javascript,text/plain' }, signal, redirect: 'follow' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = (await readBoundedText(response, ADAPTER_MAX_BYTES, signal)).replace(/^\uFEFF/, '');
    return lightValidateScript(text);
}

async function fetchBundledAdapter(env) {
    const asset = await env?.ASSETS?.fetch(new Request(`https://assets.local${ADAPTER_ASSET_PATH}`));
    if (!asset?.ok) throw new Error(`兜底脚本读取失败：HTTP ${asset?.status ?? 'no ASSETS'}`);
    const text = (await readBoundedText(asset, ADAPTER_MAX_BYTES)).replace(/^\uFEFF/, '');
    return lightValidateScript(text);
}

async function loadAdapterScript(env) {
    const bucket = env?.[R2_BINDING] || null;
    let externalUrl = String(env?.[ADAPTER_URL_ENV] || '').trim();
    if (!externalUrl) {
        try {
            const config = await loadDeployConfig(env);
            externalUrl = String(config?.adapter?.externalUrl || '').trim();
        } catch (_) { /* 配置失败视同无外部源 */ }
    }
    // 缓存按解析后的源键控：外部 URL 变化后 30 秒内也不会拿到旧脚本。
    const cacheKey = externalUrl ? `ext:${externalUrl}` : 'bundled';
    const cached = adapterCacheByKey.get(cacheKey);
    if (cached) {
        if (cached.value) {
            if (cached.expiresAt > Date.now()) return cached.value;
        } else if (cached.expiresAt > Date.now()) {
            throw new Error('适配脚本加载失败：所有源均不可用。');
        }
    }
    const sources = [];
    if (externalUrl) sources.push({ origin: 'external', run: () => fetchExternalAdapter(externalUrl) });
    sources.push({ origin: 'bundled', run: () => fetchBundledAdapter(env) });
    sources.push({
        origin: 'last-good',
        run: async () => {
            const lastGood = bucket && await bucket.get(ADAPTER_LASTGOOD_KEY);
            if (!lastGood) throw new Error('没有 last-good 副本。');
            return lightValidateScript((await readBoundedText(lastGood, ADAPTER_MAX_BYTES)).replace(/^\uFEFF/, ''));
        }
    });

    let lastError = null;
    for (const source of sources) {
        try {
            const text = await source.run();
            const value = {
                source: text,
                origin: source.origin,
                sha256: await sha256Text(text),
                bytes: textEncoder.encode(text).byteLength
            };
            if (adapterCacheByKey.size >= 4) adapterCacheByKey.clear();
            adapterCacheByKey.set(cacheKey, { value, expiresAt: Date.now() + ADAPTER_CACHE_TTL_MS });
            // 外部脚本与兜底脚本成功时都刷新 last-good：last-good 的语义是
            // "最近一次验证通过的脚本"，不区分来源。
            if (bucket && text !== adapterLastGoodPersisted) {
                adapterLastGoodPersisted = text;
                try {
                    await bucket.put(ADAPTER_LASTGOOD_KEY, text, {
                        httpMetadata: { contentType: 'application/javascript; charset=utf-8' }
                    });
                } catch (_) { /* 兜底缓存写入失败不影响服务 */ }
            }
            return value;
        } catch (err) {
            lastError = err;
        }
    }
    adapterCacheByKey.set(cacheKey, { value: null, expiresAt: Date.now() + ADAPTER_FAILURE_TTL_MS });
    throw lastError || new Error('适配脚本加载失败。');
}

async function tryLoadAdapterScript(env) {
    try {
        return await loadAdapterScript(env);
    } catch (_) {
        return null;
    }
}

async function serveAdapterSummary(request, env) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
    }
    const adapter = await tryLoadAdapterScript(env);
    const payload = adapter
        ? { ok: true, origin: adapter.origin, sha256: adapter.sha256, bytes: adapter.bytes }
        : { ok: false };
    const response = json(payload, adapter ? 200 : 503);
    return request.method === 'HEAD'
        ? new Response(null, { status: response.status, headers: response.headers })
        : response;
}

// ============================================================ 作者站代理与注入

async function fetchAuthorUpstream(path, init, search) {
    const rel = String(path || '').replace(/^\/+/, '');
    const url = new URL(rel, AUTHOR_BASE);
    if (search) url.search = search;
    const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(AUTHOR_HEADER_TIMEOUT_MS),
        redirect: 'follow'
    });
    if (!response.body) return response;
    const guarded = guardBodyIdleTimeout(response.body, AUTHOR_BODY_IDLE_TIMEOUT_MS);
    return new Response(guarded, { status: response.status, statusText: response.statusText, headers: response.headers });
}

// 主页注入顺序固定：dirty-tracker → 适配脚本（内联正文，不发第二次请求）→
// magic-extension → bootstrap。适配脚本加载失败时只注入 dirty-tracker，
// 作者 app.js 始终保持原文；后续 app.js 请求不重新判断适配、不改写源码。
function rewriteAuthorHtml(response, pathname, adapter = null) {
    const isMain = pathname === '/' || pathname === '/index.html';
    const injection = '<script src="/DB/dirty-tracker.js"></script>'
        + (isMain && adapter
            ? '<script>' + adapter.source.replace(/<\/script/gi, '<\\/script') + '</script>'
                + '<script src="/magic-extension.js"></script>'
                + '<script src="/DB/bootstrap.js"></script>'
            : '');
    const headers = new Headers(response.headers);
    headers.set('content-type', 'text/html; charset=utf-8');
    headers.set('cache-control', 'no-store');
    headers.delete('content-length');
    headers.delete('content-encoding');
    headers.delete('etag');
    const htmlResponse = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    return new HTMLRewriter()
        .on('head', { element(element) { element.append(injection, { html: true }); } })
        .transform(htmlResponse);
}

function authorCacheRequest(requestUrl) {
    return new Request(new URL(`/__rphub-author-cache${requestUrl.pathname}${requestUrl.search}`, requestUrl.origin), { method: 'GET' });
}

async function matchAuthorCache(requestUrl) {
    const cache = typeof caches !== 'undefined' ? caches.default : null;
    if (!cache || typeof cache.match !== 'function') return null;
    try {
        return await cache.match(authorCacheRequest(requestUrl));
    } catch {
        return null;
    }
}

function cacheAuthorResponse(ctx, requestUrl, response) {
    const cache = typeof caches !== 'undefined' ? caches.default : null;
    if (!cache || typeof cache.put !== 'function') return;
    const headers = new Headers(response.headers);
    headers.set('cache-control', `public, max-age=${AUTHOR_CACHE_TTL_SECONDS}`);
    const putting = cache.put(authorCacheRequest(requestUrl), new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
    })).catch(() => {});
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(putting);
}

async function serveAuthor(request, env, ctx) {
    const requestUrl = new URL(request.url);
    let upstreamPath = requestUrl.pathname;
    if (upstreamPath === '/') upstreamPath = '/index.html';
    if (upstreamPath === '/character') upstreamPath = '/character/index.html';
    if (upstreamPath === '/novel') upstreamPath = '/novel/index.html';

    const upstreamHeaders = new Headers(request.headers);
    upstreamHeaders.delete('host');
    upstreamHeaders.delete('cookie');
    upstreamHeaders.delete('authorization');
    upstreamHeaders.delete(SYNC_PASSWORD_HEADER);

    const isAuthorScript = /\.js$/i.test(requestUrl.pathname);
    const isPage = !/\.[a-z0-9]+$/i.test(requestUrl.pathname) || requestUrl.pathname.endsWith('.html');
    const mayUseCache = request.method === 'GET' && (isAuthorScript || isPage)
        && !request.headers.has('if-none-match') && !request.headers.has('if-modified-since');
    let response = mayUseCache ? await matchAuthorCache(requestUrl) : null;
    if (!response) {
        response = await fetchAuthorUpstream(upstreamPath, {
            method: request.method,
            headers: upstreamHeaders,
            body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
            redirect: 'follow'
        }, requestUrl.search);
        // 上游没有 ETag/Last-Modified 时没有协商缓存可用，用 45 秒 Cache API
        // 兜底；有验证器时交给条件请求。
        if (request.method === 'GET' && response.status === 200
            && !response.headers.get('etag') && !response.headers.get('last-modified')) {
            cacheAuthorResponse(ctx, requestUrl, response.clone());
        }
    }
    const contentType = response.headers.get('content-type') || '';
    const isHtml = contentType.toLowerCase().includes('text/html');
    const headers = new Headers(response.headers);
    if (isAuthorScript || isPage || isHtml) headers.set('cache-control', 'no-cache');
    if (request.method === 'HEAD' || [204, 205, 304].includes(response.status)) {
        return new Response(null, { status: response.status, statusText: response.statusText, headers });
    }
    const proxied = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    if (!response.ok || !isHtml) return proxied;
    const adapter = requestUrl.pathname === '/' || requestUrl.pathname === '/index.html'
        ? await tryLoadAdapterScript(env) : null;
    return rewriteAuthorHtml(proxied, requestUrl.pathname, adapter);
}

async function serveStatic(request, env) {
    // 本地资源（DB/*、magic-extension.js 由 _routes.json 直接静态服务；
    // 其余如 gallery.html、adapter 资产走这里）统一 no-cache 协商缓存：
    // 每次部署 etag 必然变化，刷新必得当前部署副本，未变化 304。
    const assetResponse = await env?.ASSETS?.fetch(request);
    if (!assetResponse || assetResponse.status !== 200) return assetResponse;
    const headers = new Headers(assetResponse.headers);
    headers.set('cache-control', 'no-cache');
    return new Response(assetResponse.body, {
        status: assetResponse.status,
        statusText: assetResponse.statusText,
        headers
    });
}

function serveSyncRestorePage() {
    // 内部恢复文档：卸载作者应用的安全执行边界，地址栏立即还原为 /。
    return new Response(`<!doctype html><html lang="zh-CN" data-rp-sync-restore><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RP Hub</title><script>history.replaceState(null,'','/')</script></head><body><script src="/DB/dirty-tracker.js"></script><script src="/DB/bootstrap.js"></script></body></html>`, {
        headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store'
        }
    });
}

// ============================================================ 同步 v2 API

// 协议要点（与 bootstrap.js 客户端、tests 三方一致）：
//   manifest.json = {
//     format: 'rp-sync-manifest-v2', version, updatedAt,
//     compression: 'gzip', totalBytes, entryCount,
//     checksum,                                       // 下方 canonical 源的 SHA-256
//     packs: [{ bucket, checksum, length, entries }]   // 权威顺序，恢复按此顺序应用
//   }
//   checksum 只覆盖内容（不含 version/updatedAt）：同一份内容无论哪个客户端
//   何时重建根，校验和恒定，"无变化上传"才能稳定判等。version/updatedAt 是
//   元信息，由版本单调守卫与 CAS etag 保护。
//   checksum 源 = JSON.stringify([MANIFEST_FORMAT, compression, totalBytes,
//     entryCount, packs.map(p => [p.bucket, p.checksum, p.length, p.entries])])
//   packs/<sha256>.bin 为 gzip 后字节，内容寻址，R2 按 sha256 参数校验写入。

function normalizePackEntry(item, index) {
    const bucket = String(item?.bucket || '');
    const checksum = String(item?.checksum || '').toLowerCase();
    const length = Number(item?.length);
    const entries = Number(item?.entries);
    if (!bucket || bucket.length > 4000) {
        throw new SyncRequestError(`数据包桶标识异常：第 ${index} 个。`, 409);
    }
    if (!/^[a-f0-9]{64}$/.test(checksum)) {
        throw new SyncRequestError(`数据包校验码异常：第 ${index} 个。`, 409);
    }
    if (!Number.isInteger(length) || length <= 0 || length > MAX_PACK_STORED_BYTES) {
        throw new SyncRequestError(`数据包大小异常：第 ${index} 个。`, 409);
    }
    // entries 允许 0：单条记录超过分片缓冲时 buildCachedPacks 会先落一个
    // 纯字节的填充片，记录本体跨片拼接，恢复端按行重组（v1 同语义）。
    if (!Number.isInteger(entries) || entries < 0 || entries > MAX_PACK_ENTRIES) {
        throw new SyncRequestError(`数据包记录数量异常：第 ${index} 个。`, 409);
    }
    return { bucket, checksum, length, entries };
}

function manifestChecksumSource(root) {
    return JSON.stringify([
        MANIFEST_FORMAT,
        root.compression,
        root.totalBytes,
        root.entryCount,
        root.packs.map(pack => [pack.bucket, pack.checksum, pack.length, pack.entries])
    ]);
}

// 读取侧与提交侧共用同一校验；返回规范化根或抛 SyncRequestError。
function normalizeManifest(value) {
    if (!value || typeof value !== 'object' || value.format !== MANIFEST_FORMAT) {
        throw new SyncRequestError('同步根清单格式无效。', 409);
    }
    const version = Number(value.version);
    const updatedAt = Number(value.updatedAt);
    const totalBytes = Number(value.totalBytes);
    const entryCount = Number(value.entryCount);
    const checksum = String(value.checksum || '').toLowerCase();
    if (!Number.isInteger(version) || version < 1) throw new SyncRequestError('同步根清单版本无效。', 409);
    if (!Number.isFinite(updatedAt) || updatedAt <= 0) throw new SyncRequestError('同步根清单时间无效。', 409);
    if (value.compression !== MANIFEST_COMPRESSION) throw new SyncRequestError('同步根清单压缩格式无效。', 409);
    if (!Number.isInteger(totalBytes) || totalBytes < 0 || totalBytes > MAX_SNAPSHOT_BYTES) {
        throw new SyncRequestError('同步根清单总量无效。', 409);
    }
    if (!Number.isInteger(entryCount) || entryCount < 0 || entryCount > 10_000_000) {
        throw new SyncRequestError('同步根清单记录数无效。', 409);
    }
    if (!Array.isArray(value.packs) || value.packs.length > MAX_PACKS) {
        throw new SyncRequestError('同步根清单分片数无效。', 409);
    }
    const empty = value.packs.length === 0;
    if (empty && (totalBytes !== 0 || entryCount !== 0)) {
        throw new SyncRequestError('空快照字段必须同时为空。', 409);
    }
    const packs = value.packs.map((pack, index) => normalizePackEntry(pack, index));
    const seen = new Set();
    let sumBytes = 0;
    let sumEntries = 0;
    for (const pack of packs) {
        if (seen.has(pack.checksum)) throw new SyncRequestError('同步根清单包含重复分片。', 409);
        seen.add(pack.checksum);
        sumBytes += pack.length;
        sumEntries += pack.entries;
    }
    if (sumBytes !== totalBytes || sumEntries !== entryCount) {
        throw new SyncRequestError('同步根清单合计不一致。', 409);
    }
    const root = {
        format: MANIFEST_FORMAT,
        version,
        updatedAt,
        compression: MANIFEST_COMPRESSION,
        totalBytes,
        entryCount,
        packs,
        // 校验和必须挂在 root 上：幂等提交比较、写回 R2 的根对象、以及
        // canonical 源（不含 checksum 字段）都依赖它存在。
        checksum
    };
    return { root, providedChecksum: checksum, source: manifestChecksumSource(root) };
}

async function verifyManifestChecksum(normalized) {
    const expected = await sha256Text(normalized.source);
    if (expected !== normalized.providedChecksum) {
        throw new SyncRequestError('同步根清单校验失败。', 409);
    }
}

function publicManifest(root) {
    // v2 根清单本身就是全量索引（数百包、数十 KB），status/commit 直接返回
    // 完整根对象，客户端无需二次拉取。
    return {
        format: root.format,
        version: root.version,
        updatedAt: root.updatedAt,
        compression: root.compression,
        totalBytes: root.totalBytes,
        entryCount: root.entryCount,
        packs: root.packs
    };
}

// 读根清单并做完整校验。fresh=true 供写路径使用；读路径走 1.5 秒 TTL 缓存。
async function readManifestState(bucket, { fresh = false } = {}) {
    if (!fresh) {
        const cached = manifestByBucket.get(bucket);
        if (cached && cached.expiresAt > Date.now()) return cached.state;
    }
    const state = await loadManifestState(bucket);
    if (!fresh) manifestByBucket.set(bucket, { state, expiresAt: Date.now() + MANIFEST_STATE_TTL_MS });
    return state;
}

async function loadManifestState(bucket) {
    const object = await bucket.get(MANIFEST_KEY);
    if (!object) return { manifest: null, etag: null };
    if (Number(object.size || 0) > MANIFEST_MAX_BYTES) {
        await object.body?.cancel?.();
        throw new SyncRequestError('服务器同步根清单超过大小上限。', 409);
    }
    let value;
    try {
        value = JSON.parse(await object.text());
    } catch (_) {
        throw new SyncRequestError('服务器同步根清单损坏。', 409);
    }
    const etag = object.etag || null;
    const cached = etag ? manifestStateCache.get(etag) : null;
    if (cached) return { manifest: cached, etag };
    const normalized = normalizeManifest(value);
    await verifyManifestChecksum(normalized);
    if (etag) {
        if (manifestStateCache.size >= MANIFEST_STATE_CACHE_MAX) {
            manifestStateCache.delete(manifestStateCache.keys().next().value);
        }
        manifestStateCache.set(etag, normalized.root);
    }
    return { manifest: normalized.root, etag };
}

function invalidateManifestState(bucket) {
    manifestByBucket.delete(bucket);
}

async function handleSyncStatus(bucket) {
    const state = await readManifestState(bucket);
    return json({
        ok: true,
        manifest: state.manifest
            ? { ...publicManifest(state.manifest), checksum: state.manifest.checksum }
            : null
    });
}

async function listStoredPacks(bucket) {
    // commit 的存在性校验用整体 list 代替逐包 head：1-5 次 list 覆盖全部
    // 分片（免费版 1000/页），且同时给出对象大小用于与声明比对。
    const map = new Map();
    let cursor;
    do {
        const page = await bucket.list({ prefix: `${PACK_PREFIX}/`, cursor, limit: 1000 });
        for (const object of page.objects || []) {
            const checksum = parsePackKey(object.key);
            if (checksum) map.set(checksum, Number(object.size || 0));
        }
        cursor = page.truncated ? page.cursor : '';
        if (cursor && typeof cursor !== 'string') throw new Error('同步分片列表暂时无法继续，请重试。');
    } while (cursor);
    return map;
}

function parsePackKey(key) {
    const match = String(key || '').match(new RegExp(`^${PACK_PREFIX}/([a-f0-9]{64})\\.bin$`));
    return match ? match[1] : null;
}

function createPackKey(checksum) {
    return `${PACK_PREFIX}/${String(checksum || '').toLowerCase()}.bin`;
}

async function deletePackKeys(bucket, keys) {
    let failed = 0;
    for (let start = 0; start < keys.length; start += 1000) {
        try {
            await bucket.delete(keys.slice(start, start + 1000));
        } catch (_) { failed += 1; /* 残留孤儿由 sweep 兜底 */ }
    }
    return failed;
}

async function handleSyncCommit(bucket, body) {
    const normalized = normalizeManifest(body.manifest);
    await verifyManifestChecksum(normalized);
    const root = normalized.root;
    const newChecksums = new Set(root.packs.map(pack => pack.checksum));

    for (let attempt = 0; attempt < COMMIT_ATTEMPTS; attempt += 1) {
        const current = await readManifestState(bucket, { fresh: true });
        if (current.manifest?.checksum === root.checksum) {
            // 同内容幂等提交：返回云端现存根（版本保持不变）。
            return json({ ok: true, committed: true, manifest: { ...publicManifest(current.manifest), checksum: current.manifest.checksum } });
        }
        // 版本单调：客户端根版本 = status 返回的远端版本 + 1。落后的提交
        // 说明客户端状态过期，拒绝并让其重新拉取状态后重试；否则过期页面
        // 可能用旧版本号覆盖新根。
        if (current.manifest && root.version <= current.manifest.version) {
            return error('同步根清单版本已落后，请刷新同步状态后重试。', 409, { currentVersion: current.manifest.version });
        }
        const stored = await listStoredPacks(bucket);
        const missing = root.packs
            .filter(pack => stored.get(pack.checksum) !== pack.length)
            .map(pack => pack.checksum);
        if (missing.length) {
            return json({
                ok: false,
                error: '云端缺少部分数据包，请重新上传后提交。',
                missing,
                missingCount: missing.length
            }, 409);
        }
        let committed;
        try {
            committed = await bucket.put(MANIFEST_KEY, JSON.stringify(root), {
                httpMetadata: { contentType: 'application/json; charset=utf-8' },
                onlyIf: current.etag ? { etagMatches: current.etag } : { etagDoesNotMatch: '*' }
            });
        } catch (err) {
            // 写入结果未知时先复核当前根：已提交则直接成功。
            const observed = await readManifestState(bucket, { fresh: true });
            if (observed.manifest?.checksum === root.checksum) {
                invalidateManifestState(bucket);
                return json({ ok: true, committed: true, manifest: { ...publicManifest(root), checksum: root.checksum } });
            }
            throw err;
        }
        if (committed) {
            invalidateManifestState(bucket);
            const orphans = current.manifest
                ? current.manifest.packs.map(pack => pack.checksum).filter(checksum => !newChecksums.has(checksum))
                : [];
            let reclaimed = 0;
            if (orphans.length) {
                // 删除失败数如实带回：客户端只在有残留时补发 sweep 兜底。
                reclaimed = await deletePackKeys(bucket, orphans.map(createPackKey));
            }
            return json({ ok: true, committed: true, reclaimed, manifest: { ...publicManifest(root), checksum: root.checksum } });
        }
        // CAS 失败：另一标签页刚提交过。重读后进入下一轮（可能已同快照）。
    }
    const final = await readManifestState(bucket, { fresh: true });
    if (final.manifest?.checksum === root.checksum) {
        return json({ ok: true, committed: true, manifest: { ...publicManifest(final.manifest), checksum: root.checksum } });
    }
    return error('同步提交未确认，请查看同步状态后重试。', 503);
}

async function handleSyncSweep(bucket) {
    // 兜底回收：列出全部分片，删除当前根不引用且超过宽限期的对象。
    const state = await readManifestState(bucket, { fresh: true });
    if (!state.manifest) return json({ ok: true, deleted: 0, skipped: 0 });
    const referenced = new Set(state.manifest.packs.map(pack => pack.checksum));
    const cutoff = Date.now() - SWEEP_GRACE_MS;
    const candidates = [];
    let scanned = 0;
    let cursor;
    do {
        const page = await bucket.list({ prefix: `${PACK_PREFIX}/`, cursor, limit: 1000 });
        for (const object of page.objects || []) {
            const checksum = parsePackKey(object.key);
            if (!checksum || referenced.has(checksum)) continue;
            scanned += 1;
            const uploadedAt = object.uploaded instanceof Date ? object.uploaded.getTime() : Date.parse(String(object.uploaded || '')) || 0;
            if (uploadedAt && uploadedAt >= cutoff) continue;
            candidates.push(object.key);
        }
        cursor = page.truncated ? page.cursor : '';
    } while (cursor);
    let deleted = 0;
    for (let start = 0; start < candidates.length; start += 1000) {
        try {
            await bucket.delete(candidates.slice(start, start + 1000));
            deleted += Math.min(1000, candidates.length - start);
        } catch (_) { /* 下一轮 sweep 重判 */ }
    }
    return json({ ok: true, deleted, skipped: scanned - deleted });
}

// 分片上传：流式直通 R2，条件创建（内容寻址不可变），已存在时补一次 head
// 核对元数据。正常稳态每分片只付 1 次 put。
async function handlePackUpload(request, bucket, url) {
    const checksum = String(url.searchParams.get('checksum') || '').toLowerCase();
    const length = Number(url.searchParams.get('length'));
    const entries = Number(url.searchParams.get('entries'));
    if (!/^[a-f0-9]{64}$/.test(checksum)) return error('上传数据包校验码无效。', 400);
    if (!Number.isInteger(length) || length <= 0 || length > MAX_PACK_STORED_BYTES) {
        return error('上传数据包大小异常。', 413);
    }
    // entries 允许 0：单条记录超过分片缓冲时的纯字节填充片（v1 同语义），
    // 记录本体跨片拼接，恢复端按行重组。
    if (!Number.isInteger(entries) || entries < 0 || entries > MAX_PACK_ENTRIES) {
        return error('上传数据包记录数量异常。', 409);
    }
    const contentType = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'application/gzip' && contentType !== 'application/octet-stream') {
        return error('上传数据包必须使用二进制格式。', 415);
    }
    const contentLength = request.headers.get('content-length');
    if (contentLength !== null && Number(contentLength) !== length) {
        return error('上传数据包长度与声明不一致。', 409);
    }
    if (!request.body) return error('上传数据包正文为空。', 400);

    const key = createPackKey(checksum);
    const stored = await bucket.put(key, request.body, {
        sha256: checksumBytes(checksum),
        httpMetadata: { contentType: 'application/gzip' },
        customMetadata: { entries: String(entries) },
        onlyIf: { etagDoesNotMatch: '*' }
    });
    if (stored) return new Response(null, { status: 204 });
    const existing = await bucket.head(key);
    if (existing && Number(existing.size) === length
        && Number(existing.customMetadata?.entries) === entries) {
        return new Response(null, { status: 204 });
    }
    if (existing) return error('内容寻址数据包已存在但元数据不同。', 409);
    return error('内容寻址数据包写入未确认，请重试。', 503);
}

// 分片下载：边缘 Cache API（内容寻址不可变）→ R2。校验和由客户端对照
// 根清单执行；响应附带 entries 供客户端交叉核对。
function packCacheRequest(requestUrl, checksum) {
    return new Request(new URL(`/__rphub-pack-cache/${checksum}`, requestUrl.origin), { method: 'GET' });
}

async function handlePackDownload(request, bucket, url, ctx) {
    const checksum = String(url.searchParams.get('c') || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(checksum)) return error('下载数据包校验码无效。', 400);
    const requestUrl = new URL(request.url);
    const cache = typeof caches !== 'undefined' ? caches.default : null;
    if (cache && typeof cache.match === 'function') {
        try {
            const cached = await cache.match(packCacheRequest(requestUrl, checksum));
            if (cached) {
                return new Response(cached.body, {
                    status: 200,
                    headers: {
                        'content-type': 'application/gzip',
                        'cache-control': 'no-store',
                        'content-length': cached.headers.get('content-length') || '',
                        'x-rp-sync-entries': cached.headers.get('x-rp-sync-entries') || ''
                    }
                });
            }
        } catch (_) { }
    }
    const object = await bucket.get(createPackKey(checksum));
    if (!object) return error('R2 同步数据不存在。', 404);
    const entries = Number(object.customMetadata?.entries || 0);
    const headers = {
        'content-type': 'application/gzip',
        'cache-control': 'no-store',
        'content-length': String(object.size || 0),
        'x-rp-sync-entries': String(entries)
    };
    let responseBody = object.body;
    if (cache && typeof cache.put === 'function' && responseBody) {
        const [clientBody, cacheBody] = responseBody.tee();
        responseBody = clientBody;
        const cacheHeaders = new Headers({
            'content-type': 'application/gzip',
            'cache-control': `public, max-age=${PACK_CACHE_TTL_SECONDS}, immutable`,
            'content-length': String(object.size || 0),
            'x-rp-sync-entries': String(entries)
        });
        const putting = cache.put(packCacheRequest(requestUrl, checksum), new Response(cacheBody, {
            status: 200,
            headers: cacheHeaders
        })).catch(() => {});
        if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(putting);
    }
    return new Response(responseBody, { status: 200, headers });
}

function getSyncPassword(env) {
    const password = env?.[SYNC_PASSWORD_ENV];
    return typeof password === 'string' && password.length > 0 ? password : '';
}

function isRequestAuthorized(request, env) {
    const expectedPassword = getSyncPassword(env);
    if (!expectedPassword) return true;
    return (request.headers.get(SYNC_PASSWORD_HEADER) || '') === expectedPassword;
}

async function authStatusPayload(request, env, checkAuthorized) {
    const authRequired = Boolean(getSyncPassword(env));
    const authenticated = !authRequired || Boolean(await checkAuthorized(request, env));
    return { ok: true, authRequired, authenticated };
}

async function readSyncJsonBody(request) {
    const contentLength = request.headers.get('content-length');
    const declaredLength = contentLength === null ? null : Number(contentLength);
    if (contentLength !== null && (!/^\d+$/.test(contentLength) || !Number.isSafeInteger(declaredLength))) {
        throw new SyncRequestError('上传请求长度无效。', 400);
    }
    if (declaredLength !== null && declaredLength > SYNC_REQUEST_MAX_BYTES) {
        throw new SyncRequestError('上传请求超过大小上限。', 413);
    }
    const reader = request.body?.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let text = '';
    let received = 0;
    try {
        while (reader) {
            const { done, value } = await reader.read();
            if (done) break;
            received += value.byteLength;
            if (received > SYNC_REQUEST_MAX_BYTES) throw new SyncRequestError('上传请求超过大小上限。', 413);
            text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
        if (declaredLength !== null && received !== declaredLength) {
            throw new SyncRequestError('上传请求长度与正文不一致。', 409);
        }
        const body = JSON.parse(text);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            throw new SyncRequestError('Invalid JSON body.', 400);
        }
        return body;
    } catch (err) {
        if (err instanceof SyntaxError || err instanceof TypeError) {
            throw new SyncRequestError('Invalid JSON body.', 400);
        }
        throw err;
    } finally {
        // 中途失败时放弃剩余正文；正常读完再 cancel 是无害的空操作。
        try { await reader?.cancel(); } catch (_) { }
    }
}

async function handleSyncApi(request, env, ctx) {
    const url = new URL(request.url);
    // 分片端点：PUT 上传 / GET 下载，均要求密码。
    if (url.pathname === `${SYNC_API_PATH}/pack`) {
        if (request.method === 'PUT' || request.method === 'POST') {
            if (!await isRequestAuthorized(request, env)) return error('Sync password required.', 401, { authRequired: true });
            return handlePackUpload(request, getBucket(env), url);
        }
        if (request.method === 'GET') {
            if (!await isRequestAuthorized(request, env)) return error('Sync password required.', 401, { authRequired: true });
            return handlePackDownload(request, getBucket(env), url, ctx);
        }
        return error('Method not allowed.', 405);
    }
    if (request.method !== 'POST') return error('Method not allowed.', 405);

    const body = await readSyncJsonBody(request);
    if (body.action === 'auth-status') {
        return json(await authStatusPayload(request, env, isRequestAuthorized));
    }
    if (!await isRequestAuthorized(request, env)) return error('Sync password required.', 401, { authRequired: true });
    const bucket = getBucket(env);
    if (body.action === 'status') return handleSyncStatus(bucket);
    if (body.action === 'commit') return handleSyncCommit(bucket, body);
    if (body.action === 'sweep') return handleSyncSweep(bucket);
    return error('Unsupported action.', 404);
}

// ============================================================ 图片 API

function normalizeImageParam(value, maxLength = 30000) {
    const text = String(value || '').trim();
    return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function sanitizeImageKeySegment(value, fallback = '未命名角色') {
    const normalized = String(value || '')
        .normalize('NFKC')
        .trim()
        .replace(/[\\/:*?"<>|#%&{}$!`'@+=\s]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 96);
    return normalized || fallback;
}

function isYnaiImageToken(token) {
    return String(token || '').trim().toUpperCase().startsWith('YNAI-');
}

function applyImageParamDefaults(params, token, characterName, ynaiDefaultModel = null) {
    params.character_name = sanitizeImageKeySegment(characterName, '未命名角色');
    params.model = params.model
        || (isYnaiImageToken(token) ? (ynaiDefaultModel || IMAGE_DEFAULT_MODEL) : IMAGE_DEFAULT_MODEL);
    params.size = params.size || IMAGE_DEFAULT_SIZE;
    params.steps = params.steps || (isYnaiImageToken(token) ? IMAGE_DEFAULT_STEPS_YNAI : IMAGE_DEFAULT_STEPS);
    params.scale = params.scale || IMAGE_DEFAULT_SCALE;
    params.cfg = params.cfg || IMAGE_DEFAULT_CFG;
    params.sampler = params.sampler || IMAGE_DEFAULT_SAMPLER;
    params.nocache = params.nocache || '0';
    params.noise_schedule = params.noise_schedule || IMAGE_DEFAULT_NOISE_SCHEDULE;
    return params;
}

function buildImageParams(url, token, ynaiDefaultModel = null) {
    const params = {};
    for (const key of IMAGE_PARAM_KEYS) {
        params[key] = normalizeImageParam(url.searchParams.get(key));
    }
    params.reroll_nonce = normalizeImageParam(url.searchParams.get('reroll_nonce'), 120);
    return applyImageParamDefaults(params, token, url.searchParams.get('character_name'), ynaiDefaultModel);
}

function buildImageSignature(params) {
    const signature = { provider: 'sta1n' };
    for (const key of IMAGE_PARAM_KEYS) {
        signature[key] = params[key] || '';
    }
    if (params.reroll_nonce) signature.reroll_nonce = params.reroll_nonce;
    return JSON.stringify(signature);
}

async function buildImageLookupCandidate(params) {
    const checksum = await sha256Text(buildImageSignature(params));
    return {
        params,
        key: createImageKey(params.character_name, checksum),
        deletedKey: createImageDeletedKey(params.character_name, checksum)
    };
}

function createImageKey(characterName, checksum) {
    return `${IMAGE_OBJECT_PREFIX}/${characterName}/${checksum}`;
}

function createImageThumbKey(characterName, checksum) {
    return `${IMAGE_THUMB_PREFIX}/${characterName}/${checksum}.webp`;
}

function createImageDeletedKey(characterName, checksum) {
    return `${IMAGE_DELETED_PREFIX}/${characterName}/${checksum}.json`;
}

function isValidImageObjectKey(key) {
    if (typeof key !== 'string') return false;
    const parts = key.split('/');
    return parts.length === 4 && parts[0] === IMAGE_PREFIX && parts[1] === 'characters'
        && Boolean(parts[2]) && parts[2] !== '.' && parts[2] !== '..'
        && sanitizeImageKeySegment(parts[2]) === parts[2]
        && /^[a-f0-9]{64}$/i.test(parts[3]);
}

function getImageChecksumFromKey(key) {
    const fileName = String(key || '').split('/').pop() || '';
    const match = fileName.match(/[a-f0-9]{64}/i);
    return match ? match[0].toLowerCase() : '';
}

function getImageCharacterFromKey(key) {
    const parts = String(key || '').split('/');
    if (parts.length < 4 || parts[0] !== IMAGE_PREFIX || parts[1] !== 'characters') return '';
    return parts[2] || '';
}

function createImageThumbKeyFromImageKey(key) {
    const checksum = getImageChecksumFromKey(key);
    const characterName = getImageCharacterFromKey(key);
    return checksum && characterName ? createImageThumbKey(characterName, checksum) : '';
}

function buildImageUpstreamUrl(params, token) {
    const upstream = new URL('/generate', IMAGE_UPSTREAM_STA1N);
    upstream.searchParams.set('tag', params.tag);
    upstream.searchParams.set('token', token);
    upstream.searchParams.set('model', params.model);
    upstream.searchParams.set('artist', params.artist || '');
    upstream.searchParams.set('size', params.size);
    upstream.searchParams.set('steps', params.steps);
    upstream.searchParams.set('scale', params.scale);
    upstream.searchParams.set('cfg', params.cfg);
    upstream.searchParams.set('sampler', params.sampler);
    upstream.searchParams.set('negative', params.negative || '');
    upstream.searchParams.set('nocache', params.nocache);
    upstream.searchParams.set('noise_schedule', params.noise_schedule);
    return upstream.toString();
}

async function fetchImageWithTimeout(url, options, consume, timeoutMs = IMAGE_FETCH_TIMEOUT_MS) {
    const signal = AbortSignal.timeout(timeoutMs);
    let response;
    try {
        response = await fetch(url, {
            ...options,
            headers: {
                accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
                'user-agent': 'RPH-R2-Image-Cache',
                ...(options.headers || {})
            },
            signal
        });
        return await consume(response, signal);
    } catch (err) {
        if (signal.aborted && (err?.name === 'TimeoutError' || err?.name === 'AbortError')) {
            throw new Error('Image fetch timed out.');
        }
        throw err;
    } finally {
        if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
    }
}

function imageResponse(body, contentType, extraHeaders = {}) {
    return new Response(body, {
        headers: {
            'content-type': contentType || 'image/png',
            'cache-control': 'private, max-age=3600',
            ...extraHeaders
        }
    });
}

function imageEtag(key) {
    const checksum = getImageChecksumFromKey(key);
    return checksum ? `"${checksum}"` : null;
}

function isNotModified(request, etag) {
    if (!etag) return false;
    const header = request.headers.get('if-none-match');
    if (!header) return false;
    return header.split(',').some(value => value.trim() === etag || value.trim() === '*');
}

function notModifiedResponse(headers) {
    return new Response(null, { status: 304, headers });
}

function imageCacheHeaders(etag, extra = {}) {
    return {
        ...(etag ? { etag } : {}),
        'cache-control': 'private, max-age=3600',
        ...extra
    };
}

async function readBoundedJson(response, maxBytes, signal) {
    const reader = response.body?.getReader();
    const cancel = () => { if (reader) void reader.cancel().catch(() => {}); };
    signal?.addEventListener('abort', cancel, { once: true });
    let text = '';
    let total = 0;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    try {
        if (Number(response.headers.get('content-length')) > maxBytes) {
            throw Object.assign(new Error('JSON 响应超过大小上限。'), { status: 413 });
        }
        while (reader) {
            if (signal?.aborted) throw new Error('Image fetch timed out.');
            const { done, value } = await reader.read();
            if (signal?.aborted) throw new Error('Image fetch timed out.');
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) throw Object.assign(new Error('JSON 响应超过大小上限。'), { status: 413 });
            text += decoder.decode(value, { stream: true });
        }
        return JSON.parse(text + decoder.decode());
    } catch (err) {
        cancel();
        throw err;
    } finally {
        signal?.removeEventListener('abort', cancel);
        reader?.releaseLock();
    }
}

function decodeImageBase64(encoded) {
    if (typeof encoded !== 'string' || !encoded.length) throw new Error('图片编码为空。');
    if (encoded.length > Math.ceil(YNAI_MAX_BYTES / 3) * 4) {
        throw Object.assign(new Error('YNAI 图片超过 16MiB 上限。'), { status: 413 });
    }
    let bytes;
    if (typeof Uint8Array.fromBase64 === 'function') {
        bytes = Uint8Array.fromBase64(encoded);
    } else {
        const binary = atob(encoded);
        bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    }
    if (bytes.byteLength > YNAI_MAX_BYTES) throw Object.assign(new Error('YNAI 图片超过 16MiB 上限。'), { status: 413 });
    if (!bytes.byteLength) throw new Error('图片编码为空。');
    return bytes;
}

async function fetchYnaiGeneratedImage(params, token, ynai) {
    return fetchImageWithTimeout(ynai.base + ynai.generatePath, {
        method: 'POST',
        headers: {
            accept: 'application/json',
            authorization: `Bearer ${token}`,
            'content-type': 'application/json'
        },
        body: JSON.stringify({
            model: params.model,
            prompt: [params.tag, params.artist].filter(Boolean).join(', '),
            size: IMAGE_SIZE_PIXELS[params.size] || String(params.size || '832x1216'),
            n: 1,
            response_format: 'b64_json',
            parameters: {
                negative_prompt: params.negative || '',
                steps: Number(params.steps) || Number(IMAGE_DEFAULT_STEPS_YNAI),
                scale: Number(params.scale) || Number(IMAGE_DEFAULT_SCALE),
                cfg_scale: Number(params.cfg) || Number(IMAGE_DEFAULT_CFG),
                sampler: params.sampler,
                noise_schedule: params.noise_schedule
            }
        })
    }, async (upstreamResponse, signal) => {
        if (!upstreamResponse.ok) {
            return error(`生图服务返回异常：HTTP ${upstreamResponse.status}`, upstreamResponse.status);
        }
        try {
            const payload = await readBoundedJson(upstreamResponse, YNAI_JSON_MAX_BYTES, signal);
            return { bytes: decodeImageBase64(payload?.data?.[0]?.b64_json), contentType: 'image/png' };
        } catch (err) {
            if (signal.aborted) throw err;
            return error(err.status === 413 ? err.message : '生图服务图片数据无效。', err.status === 413 ? 413 : 502);
        }
    });
}

async function handleImageModels(request, env) {
    if (request.method !== 'GET') return error('Method not allowed.', 405);
    const url = new URL(request.url);
    const token = normalizeImageParam(request.headers.get('x-rp-image-token'), 1000)
        || normalizeImageParam(url.searchParams.get('token'), 1000);
    if (!isYnaiImageToken(token)) return error('第三方生图密钥无效。', 401);
    const cacheKey = String(token).trim();
    const cached = imageModelsCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
        return json({ ok: true, data: cached.data });
    }
    let ynai;
    try {
        ynai = resolveYnaiConfig(await loadDeployConfig(env));
    } catch (_) {
        ynai = null;
    }
    if (!ynai) return error('中转生图配置未加载，请检查 config.json。', 503);
    let response;
    const signal = AbortSignal.timeout(15000);
    try {
        response = await fetch(ynai.base + ynai.modelsPath, {
            headers: { accept: 'application/json', authorization: `Bearer ${token}` },
            signal
        });
    } catch (_) {
        return error('模型列表获取失败，请稍后再试。', 503);
    }
    if (!response.ok) {
        try { await response.body?.cancel(); } catch (_) { }
        return error(`模型列表获取失败：HTTP ${response.status}`, response.status);
    }
    let data;
    try {
        const text = await readBoundedText(response, IMAGE_MODELS_MAX_BYTES, signal);
        const parsed = JSON.parse(text);
        data = Array.isArray(parsed?.data) ? parsed.data.filter(item => item?.id) : [];
    } catch (_) {
        return error('模型列表响应超过大小上限或格式无效。', 502);
    }
    const now = Date.now();
    for (const [staleKey, entry] of imageModelsCache) {
        if (entry.expiresAt <= now) imageModelsCache.delete(staleKey);
    }
    imageModelsCache.set(cacheKey, { data, expiresAt: now + IMAGE_MODELS_CACHE_TTL_MS });
    return json({ ok: true, data });
}

function deletedImagePlaceholder(characterName) {
    const safeName = String(characterName || 'character')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .slice(0, 80);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="640" viewBox="0 0 960 640">
<rect width="960" height="640" rx="28" fill="#f6f7f9"/>
<rect x="56" y="56" width="848" height="528" rx="24" fill="#ffffff" stroke="#dfe3e8" stroke-width="2"/>
<text x="480" y="292" text-anchor="middle" font-family="Arial, sans-serif" font-size="34" font-weight="700" fill="#3f4652">图片已清理</text>
<text x="480" y="348" text-anchor="middle" font-family="Arial, sans-serif" font-size="22" fill="#7b8491">${safeName}</text>
</svg>`;
}

async function readThumbnailBytes(request) {
    const contentType = request.headers.get('content-type') || '';
    if (!contentType.toLowerCase().startsWith('image/webp')) {
        throw new Error('缩略图格式必须是 WebP。');
    }
    const bytes = await readBoundedBytes(request, IMAGE_THUMB_MAX_BYTES, '缩略图大小异常');
    if (!bytes.byteLength) throw new Error('缩略图大小异常：0 字节。');
    return bytes;
}

async function putImageThumbnail(bucket, imageKey, bytes) {
    const checksum = getImageChecksumFromKey(imageKey);
    const characterName = getImageCharacterFromKey(imageKey);
    if (!checksum || !characterName) throw new Error('图片路径无效。');
    const thumbKey = createImageThumbKey(characterName, checksum);
    await bucket.put(thumbKey, bytes, { httpMetadata: { contentType: 'image/webp' } });
    return thumbKey;
}

// 缩略图读取/写入（图库管理端点使用；聊天卡片恒显原图，聊天端不写缩略图）：写入要求原图存在。
async function handleThumbRequest(request, bucket, key) {
    const thumbKey = createImageThumbKeyFromImageKey(key);
    if (!thumbKey) return error('图片路径无效。', 400);
    const etag = imageEtag(key);
    if (request.method === 'PUT' || request.method === 'POST') {
        if (!await bucket.head(key)) return error('原图不存在，不能保存缩略图。', 404);
        let bytes;
        try {
            bytes = await readThumbnailBytes(request);
        } catch (err) {
            return error(err instanceof Error ? err.message : '缩略图大小异常。', err?.status === 413 ? 413 : 400);
        }
        await putImageThumbnail(bucket, key, bytes);
        return json({ ok: true, thumbUrl: `/api/rp-image?key=${encodeURIComponent(key)}&thumb=1` });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return error('Method not allowed.', 405);
    const deleted = await bucket.head(createImageDeletedKey(getImageCharacterFromKey(key), getImageChecksumFromKey(key)));
    if (deleted) return error('图片已清理。', 404);
    if (request.method === 'HEAD') {
        const head = await bucket.head(thumbKey);
        if (!head) return error('缩略图不存在。', 404);
        const headers = imageCacheHeaders(etag, {
            'content-type': head.httpMetadata?.contentType || 'image/webp',
            'content-length': String(head.size || 0),
            'cache-control': 'private, max-age=86400, immutable'
        });
        if (isNotModified(request, etag)) return notModifiedResponse(headers);
        return imageResponse(null, head.httpMetadata?.contentType || 'image/webp', headers);
    }
    const object = await bucket.get(thumbKey);
    if (!object) return error('缩略图不存在。', 404);
    const headers = imageCacheHeaders(etag, {
        'content-length': String(object.size || 0),
        'cache-control': 'private, max-age=86400, immutable'
    });
    if (isNotModified(request, etag)) {
        try { await object.body?.cancel?.(); } catch (_) { }
        return notModifiedResponse(headers);
    }
    return imageResponse(object.body, object.httpMetadata?.contentType || 'image/webp', headers);
}

async function handleImageRender(request, env) {
    const url = new URL(request.url);
    // 缩略图端点先分发：图库页经 /image/api/thumb 使用同一处理器，此处是
    // 历史聊天端 PUT 入口，不受生图端点的方法守卫约束。
    if (url.searchParams.get('thumb') === '1') {
        const key = url.searchParams.get('key') || '';
        if (!isValidImageObjectKey(key)) return error('图片路径无效。', 400);
        return handleThumbRequest(request, getBucket(env), key);
    }
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'POST') {
        return error('Method not allowed.', 405);
    }
    const bucket = getBucket(env);
    const token = normalizeImageParam(url.searchParams.get('token'), 1000);
    // 生图只接受 POST：GET/HEAD 一律只读（读缓存或 404），链接预取、
    // 爬虫或旧分享链接都不会意外触发生图扣费。
    const generateOnMiss = request.method === 'POST';
    const imageKey = url.searchParams.get('key');
    if (imageKey && (generateOnMiss || !isValidImageObjectKey(imageKey))) return error('图片读取路径无效。', 400);
    // ynai 的 defaultModel 必须在签名计算前解析（缓存键与实际模型一致）。
    const ynaiConfig = !imageKey && isYnaiImageToken(token)
        ? resolveYnaiConfig(await loadDeployConfig(env).catch(() => null))
        : null;
    const params = buildImageParams(url, token, ynaiConfig?.defaultModel || null);
    const primary = imageKey ? {
        key: imageKey,
        deletedKey: createImageDeletedKey(getImageCharacterFromKey(imageKey), getImageChecksumFromKey(imageKey)),
        params: { character_name: getImageCharacterFromKey(imageKey) }
    } : await buildImageLookupCandidate(params);
    const identityHeaders = { 'x-rp-image-key': encodeURIComponent(primary.key) };
    const etag = imageEtag(primary.key);

    if (request.method === 'HEAD') {
        const [deleted, head] = await Promise.all([
            bucket.head(primary.deletedKey),
            bucket.head(primary.key)
        ]);
        if (deleted) {
            return imageResponse(null, 'image/svg+xml; charset=utf-8', {
                ...identityHeaders, 'cache-control': 'private, max-age=60'
            });
        }
        if (!head) return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
        const headers = imageCacheHeaders(etag, {
            ...identityHeaders,
            'content-type': head.httpMetadata?.contentType || 'image/png',
            'content-length': String(head.size || 0)
        });
        if (isNotModified(request, etag)) return notModifiedResponse(headers);
        return imageResponse(null, head.httpMetadata?.contentType || 'image/png', headers);
    }

    // 墓碑优先：删除请求先写墓碑、后台再清理原图，"原图还在"不能证明未删除。
    const [deleted, cached] = await Promise.all([
        bucket.head(primary.deletedKey),
        bucket.get(primary.key)
    ]);
    if (deleted) {
        try { await cached?.body?.cancel?.(); } catch (_) { }
        return imageResponse(deletedImagePlaceholder(primary.params.character_name), 'image/svg+xml; charset=utf-8', {
            ...identityHeaders, 'cache-control': 'private, max-age=60'
        });
    }
    if (cached) {
        const headers = imageCacheHeaders(etag, {
            ...identityHeaders,
            'content-length': String(cached.size || 0)
        });
        if (isNotModified(request, etag)) {
            try { await cached.body?.cancel?.(); } catch (_) { }
            return notModifiedResponse(headers);
        }
        return imageResponse(cached.body, cached.httpMetadata?.contentType, headers);
    }

    if (!generateOnMiss) {
        return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
    }
    if (!token) return error('缺少生图密钥。', 401);
    if (!primary.params.tag) return error('缺少生图提示词。', 400);
    let result;
    if (isYnaiImageToken(token)) {
        if (!ynaiConfig) return error('中转生图配置未加载，请检查 config.json。', 503);
        result = await fetchYnaiGeneratedImage(primary.params, token, ynaiConfig);
    } else {
        result = await fetchImageWithTimeout(buildImageUpstreamUrl(primary.params, token), {}, async (upstreamResponse, signal) => {
            if (!upstreamResponse.ok) {
                return error(`生图服务返回异常：HTTP ${upstreamResponse.status}`, upstreamResponse.status);
            }
            const contentType = upstreamResponse.headers.get('content-type') || 'image/png';
            if (!contentType.toLowerCase().startsWith('image/')) {
                return error('生图服务没有返回图片。', 502);
            }
            if (!upstreamResponse.body) return error('生图服务返回了空图片。', 502);
            // R2 的 put 不接受 tee 出来的流，先把上游正文有界读成字节；
            // 24MiB 上限由逐块计数在落盘前拦截。
            let bytes;
            try {
                bytes = await readBoundedBytes(upstreamResponse, IMAGE_MAX_BYTES, '图片过大', signal);
            } catch (err) {
                if (err?.status === 413) return error(err.message, 413);
                throw err;
            }
            if (!bytes.byteLength) return error('生图服务返回了空图片。', 502);
            return { bytes, contentType };
        });
    }
    if (result instanceof Response) return result;
    const { bytes, contentType } = result;
    try {
        await bucket.put(primary.key, bytes, { httpMetadata: { contentType } });
    } catch (_) {
        return error('生图图片写入失败。', 503);
    }
    return imageResponse(bytes, contentType, {
        ...identityHeaders,
        ...(etag ? { etag } : {}),
        'content-length': String(bytes.byteLength),
        'cache-control': 'private, max-age=31536000, immutable'
    });
}

// ---- 图库管理（/image）----

async function serveGalleryPage(request, env) {
    try {
        const asset = await env?.ASSETS?.fetch(new Request(`https://assets.local${IMAGE_GALLERY_ASSET}`));
        if (asset?.ok) {
            const headers = new Headers(asset.headers);
            headers.set('content-type', 'text/html; charset=utf-8');
            headers.set('cache-control', 'no-store');
            return new Response(asset.body, { status: 200, headers });
        }
    } catch (_) { }
    return error('图库页面缺失，请检查部署是否包含 gallery.html。', 500);
}

// 图库鉴权只认密码头（gallery.html 每个请求都从 localStorage 带上
// x-rp-sync-password）；个人项目不需要第二通道。
async function isImageAdminAuthorized(request, env) {
    const expectedPassword = getSyncPassword(env);
    if (!expectedPassword) return true;
    return (request.headers.get(SYNC_PASSWORD_HEADER) || '') === expectedPassword;
}

function normalizeImageObject(object) {
    // key 只拆一次，角色名/校验和与两条派生键一次算完。
    const parts = String(object.key || '').split('/');
    const characterName = parts.length >= 4 && parts[0] === IMAGE_PREFIX && parts[1] === 'characters'
        ? parts[2] || ''
        : '';
    const checksum = getImageChecksumFromKey(parts[parts.length - 1]);
    const derivable = Boolean(checksum && characterName);
    return {
        key: object.key,
        thumbKey: derivable ? createImageThumbKey(characterName, checksum) : '',
        deletedKey: derivable ? createImageDeletedKey(characterName, checksum) : '',
        size: Number(object.size || 0),
        uploaded: object.uploaded ? new Date(object.uploaded).toISOString() : '',
        characterName
    };
}

async function listImageObjects(bucket, prefix = `${IMAGE_OBJECT_PREFIX}/`, cursor, limit) {
    if (cursor || limit) {
        const page = await bucket.list({ prefix, cursor: cursor || undefined, limit });
        const nextCursor = page.truncated ? page.cursor : '';
        return { objects: (page.objects || []).map(normalizeImageObject), cursor: nextCursor || null };
    }
    const rawObjects = [];
    let nextCursor;
    do {
        const page = await bucket.list({ prefix, cursor: nextCursor, limit: 1000 });
        for (const object of page.objects || []) rawObjects.push(object);
        nextCursor = page.truncated ? page.cursor : undefined;
    } while (nextCursor);
    return { objects: rawObjects.map(normalizeImageObject), cursor: null };
}

async function listImageTombstoneKeys(bucket, fresh = false) {
    if (!fresh) {
        const cached = imageTombstoneCache.get(bucket);
        if (cached && cached.expiresAt > Date.now()) return cached.keys;
    }
    const keys = new Set();
    let cursor;
    do {
        const page = await bucket.list({ prefix: `${IMAGE_DELETED_PREFIX}/`, cursor, limit: 1000 });
        for (const object of page.objects || []) keys.add(object.key);
        cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    imageTombstoneCache.set(bucket, { keys, expiresAt: Date.now() + IMAGE_TOMBSTONE_CACHE_TTL_MS });
    return keys;
}

async function writeImageTombstone(bucket, key) {
    const checksum = getImageChecksumFromKey(key);
    const characterName = getImageCharacterFromKey(key);
    if (!checksum || !characterName) return;
    await bucket.put(createImageDeletedKey(characterName, checksum), '1', {
        httpMetadata: { contentType: 'text/plain; charset=utf-8' }
    });
    imageTombstoneCache.delete(bucket);
    imageLibraryCache.delete(bucket);
}

async function deleteImageObjectFiles(bucket, objects) {
    const keys = objects.flatMap(object => [object.key, object.thumbKey].filter(Boolean));
    for (let start = 0; start < keys.length; start += 1000) {
        await bucket.delete(keys.slice(start, start + 1000));
    }
}

function buildImageLibrary(objects) {
    const characters = new Map();
    for (const object of objects) {
        const name = object.characterName || '未命名角色';
        if (!characters.has(name)) {
            characters.set(name, { name, count: 0, size: 0, sizeHuman: '0 B', images: [] });
        }
        const character = characters.get(name);
        character.count += 1;
        character.size += object.size;
        character.images.push({
            key: object.key,
            size: object.size,
            sizeHuman: formatBytes(object.size),
            uploaded: object.uploaded
        });
    }
    return Array.from(characters.values())
        .map(character => ({
            ...character,
            sizeHuman: formatBytes(character.size),
            images: character.images
                .sort((a, b) => (a.uploaded < b.uploaded ? 1 : a.uploaded > b.uploaded ? -1 : 0))
                .map(image => ({ key: image.key, size: image.size, sizeHuman: image.sizeHuman }))
        }))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

async function handleImageAdmin(request, env, url, ctx) {
    if (url.pathname === IMAGE_ADMIN_PATH || url.pathname === `${IMAGE_ADMIN_PATH}/`) {
        return serveGalleryPage(request, env);
    }
    if (url.pathname === `${IMAGE_ADMIN_PATH}/api/auth-status`) {
        return json(await authStatusPayload(request, env, isImageAdminAuthorized));
    }
    if (!await isImageAdminAuthorized(request, env)) {
        return error('Sync password required.', 401, { authRequired: true });
    }
    const bucket = getBucket(env);

    if (url.pathname === `${IMAGE_ADMIN_PATH}/api/library`) {
        const cachedLibrary = imageLibraryCache.get(bucket);
        if (cachedLibrary && cachedLibrary.expiresAt > Date.now()) return json(cachedLibrary.value);
        const [{ objects: allObjects }, tombstoneSet] = await Promise.all([
            listImageObjects(bucket),
            listImageTombstoneKeys(bucket)
        ]);
        const staleObjects = [];
        const objects = allObjects.filter(object => {
            const deleted = tombstoneSet.has(object.deletedKey);
            if (deleted) staleObjects.push(object);
            return !deleted;
        });
        if (staleObjects.length) {
            const cleanup = deleteImageObjectFiles(bucket, staleObjects);
            if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(cleanup);
            else await cleanup;
        }
        const totalBytes = objects.reduce((sum, object) => sum + object.size, 0);
        const value = {
            ok: true,
            totalCount: objects.length,
            totalBytes,
            totalHuman: formatBytes(totalBytes),
            characters: buildImageLibrary(objects)
        };
        imageLibraryCache.set(bucket, { value, expiresAt: Date.now() + IMAGE_LIBRARY_CACHE_TTL_MS });
        return json(value);
    }

    if (url.pathname === `${IMAGE_ADMIN_PATH}/api/image`) {
        const key = url.searchParams.get('key') || '';
        if (!isValidImageObjectKey(key)) return error('图片路径无效。', 400);
        const etag = imageEtag(key);
        if (request.method === 'HEAD') {
            const head = await bucket.head(key);
            if (!head) return error('图片不存在。', 404);
            const headers = imageCacheHeaders(etag, {
                'content-type': head.httpMetadata?.contentType || 'image/png',
                'content-length': String(head.size || 0)
            });
            if (isNotModified(request, etag)) return notModifiedResponse(headers);
            return imageResponse(null, head.httpMetadata?.contentType || 'image/png', headers);
        }
        if (request.method !== 'GET') return error('Method not allowed.', 405);
        const object = await bucket.get(key);
        if (!object) return error('图片不存在。', 404);
        const headers = imageCacheHeaders(etag, { 'content-length': String(object.size || 0) });
        if (isNotModified(request, etag)) {
            try { await object.body?.cancel?.(); } catch (_) { }
            return notModifiedResponse(headers);
        }
        return imageResponse(object.body, object.httpMetadata?.contentType, headers);
    }

    if (url.pathname === `${IMAGE_ADMIN_PATH}/api/thumb`) {
        const key = url.searchParams.get('key') || '';
        if (!isValidImageObjectKey(key)) return error('图片路径无效。', 400);
        return handleThumbRequest(request, bucket, key);
    }

    if (url.pathname === `${IMAGE_ADMIN_PATH}/api/delete`) {
        if (request.method !== 'POST') return error('Method not allowed.', 405);
        const body = await request.json().catch(() => null);
        if (!body || typeof body !== 'object') return error('Invalid JSON body.', 400);
        const keys = [...new Set(Array.isArray(body.keys) ? body.keys : [])];
        const characterNames = [...new Set(Array.isArray(body.characterNames) ? body.characterNames : [])];
        if (keys.length > IMAGE_DELETE_MAX_KEYS_PER_REQUEST) {
            return error(`单次最多删除 ${IMAGE_DELETE_MAX_KEYS_PER_REQUEST} 张图片，请分批删除。`, 400);
        }
        if (characterNames.length > IMAGE_DELETE_MAX_CHARACTER_NAMES_PER_REQUEST) {
            return error(`单次最多清空 ${IMAGE_DELETE_MAX_CHARACTER_NAMES_PER_REQUEST} 个角色分组，请分批删除。`, 400);
        }
        if (keys.some(key => typeof key !== 'string' || !isValidImageObjectKey(key))
            || characterNames.some(name => typeof name !== 'string' || !name)
            || (keys.length && characterNames.length)
            || (body.cursor !== undefined && (typeof body.cursor !== 'string' || body.cursor.length > 4096))) {
            return error('删除参数无效。', 400);
        }
        // 目录展开（characterNames + cursor 游标续传）或显式键列表。
        let targets;
        let continuation;
        if (characterNames.length) {
            const name = sanitizeImageKeySegment(characterNames[0]);
            const page = await listImageObjects(bucket, `${IMAGE_OBJECT_PREFIX}/${name}/`, body.cursor, IMAGE_DELETE_MAX_KEYS_PER_REQUEST);
            targets = page.objects;
            continuation = page.cursor
                ? { characterNames, cursor: page.cursor }
                : characterNames.length > 1 ? { characterNames: characterNames.slice(1) } : null;
        } else {
            const heads = await runConcurrent(keys, 6, async key => {
                const object = await bucket.head(key);
                return object ? normalizeImageObject({ ...object, key }) : null;
            });
            targets = heads.filter(Boolean);
            continuation = null;
        }
        // 两阶段删除：先写墓碑并返回，后台再清理原图/缩略图。
        const tombstoneResults = await runConcurrent(targets, 6, async object => {
            try {
                await writeImageTombstone(bucket, object.key);
                return { object, accepted: true };
            } catch (_) {
                return { object, accepted: false };
            }
        });
        const acceptedTargets = tombstoneResults.filter(result => result.accepted).map(result => result.object);
        const failedCount = targets.length - acceptedTargets.length;
        if (targets.length && acceptedTargets.length === 0) {
            return error('删除标记写入失败。', 502, { failedCount });
        }
        const deletedBytes = acceptedTargets.reduce((total, object) => total + object.size, 0);
        const cleanup = deleteImageObjectFiles(bucket, acceptedTargets);
        if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(cleanup);
        else await cleanup;
        return json({
            ok: true,
            acceptedKeys: acceptedTargets.map(object => object.key),
            deletedCount: acceptedTargets.length,
            deletedBytes,
            failedCount,
            remainingKeys: tombstoneResults.filter(result => !result.accepted).map(result => result.object.key),
            continuation
        });
    }

    return error('Not found.', 404);
}

// ============================================================ 路由入口

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        try {
            if (url.pathname === ADAPTER_SUMMARY_PATH) {
                return await serveAdapterSummary(request, env);
            }
            if (url.pathname === IMAGE_API_PATH) {
                return await handleImageRender(request, env);
            }
            if (url.pathname === IMAGE_MODELS_PATH) {
                return await handleImageModels(request, env);
            }
            if (url.pathname === IMAGE_ADMIN_PATH || url.pathname.startsWith(`${IMAGE_ADMIN_PATH}/`)) {
                return await handleImageAdmin(request, env, url, ctx);
            }
            if (url.pathname === SYNC_API_PATH || url.pathname.startsWith(`${SYNC_API_PATH}/`)) {
                return await handleSyncApi(request, env, ctx);
            }
            if (url.pathname === '/sync-restore') {
                return serveSyncRestorePage();
            }
            // 部署目录里只有我们自己的静态文件；本地资源命中就直接返回，
            // 其余路径（包括作者以后新增的页面和资源）一律回源作者站点。
            const assetResponse = await serveStatic(request, env);
            if (assetResponse && assetResponse.status !== 404) return assetResponse;
            return await serveAuthor(request, env, ctx);
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Unexpected server error.';
            const status = err instanceof SyncRequestError
                ? err.status
                : /\b(?:10014|10037|10031)\b|BadDigest|(?:checksum|SHA-?256).*(?:mismatch|did not match|does not match)/i.test(message)
                    ? 409
                    : 500;
            return error(message, status);
        }
    }
};

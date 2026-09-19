const AUTHOR_BASE = 'https://sta1n156.github.io/RP-Hub/';

// 生产适配地址固定；file:// 仅供本地测试 fetch mock 使用。
const DEFAULT_ADAPTER_URL = 'https://raw.githubusercontent.com/cy-2-u/rp/main/adapter/rp-hub.json';

function authorSourcePattern(snippet) {
    const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const gap = String.raw`(?:\s|\/\*(?:[^*]|\*(?!\/))*\*\/|\/\/[^\r\n]*(?=[\r\n]|$))*`;
    const tokens = snippet.match(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|===|=>|\.{3}|[^\s]/g);
    const pattern = tokens.map(token => {
        if (/^['"]/.test(token)) {
            const text = token.slice(1, -1);
            return text.includes('\\') || /['"]/.test(text)
                ? escape(token)
                : `(?:'${escape(text)}'|"${escape(text)}")`;
        }
        return /^[A-Za-z_$]/.test(token)
            ? `(?<![\\w$])${escape(token)}(?![\\w$])`
            : escape(token);
    }).join(gap);
    return new RegExp(pattern, 'g');
}

const ADAPTER_URL_ENV = 'RPHUB_ADAPTER_URL';
const ADAPTER_PATH = '/__rphub/adapter.json';
const ADAPTER_MAX_BYTES = 512 * 1024;
const ADAPTER_CACHE_TTL_MS = 30 * 1000;
const adapterCache = new Map();

function validateAdapter(adapter) {
    if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) {
        throw new Error('适配清单格式无效。');
    }
    if (Number(adapter.schema) !== 1 || typeof adapter.id !== 'string' || !adapter.id.trim()) {
        throw new Error('适配清单版本无效。');
    }
    const replacements = adapter.author?.script?.replacements;
    if (!Array.isArray(replacements) || replacements.length === 0) {
        throw new Error('适配清单缺少脚本替换规则。');
    }
    replacements.forEach((item, index) => {
        if (!item || typeof item.name !== 'string' || typeof item.find !== 'string'
            || typeof item.replace !== 'string' || !item.find.trim()) {
            throw new Error(`适配清单替换规则无效：${index}。`);
        }
        const expected = item.expectedMatches === undefined ? 1 : Number(item.expectedMatches);
        if (!Number.isInteger(expected) || expected < 0 || expected > 8) {
            throw new Error(`适配清单匹配数量无效：${item.name}。`);
        }
    });
    const sourceChecks = adapter.author?.sourceChecks;
    if (sourceChecks !== undefined && !Array.isArray(sourceChecks)) {
        throw new Error('适配清单源码检查无效。');
    }
    for (const check of sourceChecks || []) {
        if (!check || typeof check.path !== 'string' || !Array.isArray(check.contains)
            || check.contains.some(value => typeof value !== 'string')) {
            throw new Error('适配清单源码检查无效。');
        }
    }
    if (adapter.ui !== undefined && (typeof adapter.ui !== 'object' || Array.isArray(adapter.ui))) {
        throw new Error('适配清单 UI 配置无效。');
    }
    return adapter;
}

function resolveAdapterUrl(env) {
    const override = String(env?.[ADAPTER_URL_ENV] || '').trim();
    const raw = override.startsWith('file:') ? override : DEFAULT_ADAPTER_URL;
    let url;
    try {
        url = new URL(raw, AUTHOR_BASE);
    } catch (_) {
        throw new Error('外部适配清单地址无效。');
    }
    if (!['https:', 'http:', 'file:'].includes(url.protocol)) {
        throw new Error('外部适配清单地址协议不受支持。');
    }
    return url;
}

function adapterPublicView(adapter) {
    return {
        schema: Number(adapter.schema),
        id: String(adapter.id),
        ui: adapter.ui || {}
    };
}

async function loadAdapter(env) {
    const url = resolveAdapterUrl(env);
    const cacheKey = url.href;
    const cached = adapterCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const response = await fetch(url, { headers: { accept: 'application/json,text/plain' } });
    if (!response.ok) throw new Error(`适配清单读取失败：HTTP ${response.status}`);
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > ADAPTER_MAX_BYTES) throw new Error('适配清单超过大小上限。');
    const source = String(await response.text()).replace(/^\uFEFF/, '');
    if (textEncoder.encode(source).byteLength > ADAPTER_MAX_BYTES) {
        throw new Error('适配清单超过大小上限。');
    }
    let adapter;
    try {
        adapter = validateAdapter(JSON.parse(source));
    } catch (error) {
        throw error instanceof Error ? error : new Error('适配清单解析失败。');
    }
    adapterCache.set(cacheKey, { value: adapter, expiresAt: Date.now() + ADAPTER_CACHE_TTL_MS });
    return adapter;
}

function rewriteAuthorScript(source, adapter) {
    let output = String(source || '');
    const replacements = adapter?.author?.script?.replacements;
    if (!Array.isArray(replacements) || replacements.length === 0) {
        throw new Error('适配清单缺少脚本替换规则。');
    }
    for (const item of replacements) {
        const pattern = authorSourcePattern(item.find);
        const matches = [...output.matchAll(pattern)].length;
        const expected = item.expectedMatches === undefined ? 1 : Number(item.expectedMatches);
        if (matches !== expected) {
            throw new Error(`作者代码未匹配：${item.name}（${matches}/${expected}）`);
        }
        output = output.replace(pattern, () => item.replace);
    }
    return output;
}

const DATASET_ID = 'main';
const R2_BINDING = 'RP_SYNC_R2';
const SYNC_PASSWORD_ENV = 'RP_SYNC_PASSWORD';
const SYNC_PASSWORD_HEADER = 'x-rp-sync-password';
const IMAGE_ADMIN_AUTH_COOKIE = 'rp_image_admin_auth';
const API_PATH = '/api/rp-sync';
const R2_PREFIX = `rp-sync/${DATASET_ID}`;
const MANIFEST_KEY = `${R2_PREFIX}/manifest.json`;
const MIGRATION_MARKER_KEY = `${R2_PREFIX}/migration-v12.done`;
const PACK_PREFIX = `${R2_PREFIX}/packs`;
const MAX_PACK_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_OBJECT_COUNT = 8192;
const MAX_PACK_ENTRIES = 256;
// TextEncoder.encode 无内部状态，全 isolate 共享一个实例，避免热路径反复分配。
const textEncoder = new TextEncoder();
const SYNC_CONTROL_MAX_BYTES = 2 * 1024 * 1024;
const SYNC_UPLOAD_BATCH_MAX_PACKS = 8;
const SYNC_UPLOAD_BATCH_MAX_BYTES = 4 * 1024 * 1024;
const SYNC_UPLOAD_BATCH_MAX_HEADER_BYTES = 16 * 1024;
const SYNC_UPLOAD_BATCH_MAX_BODY_BYTES = 4 + SYNC_UPLOAD_BATCH_MAX_HEADER_BYTES + SYNC_UPLOAD_BATCH_MAX_BYTES;
const SYNC_UPLOAD_BATCH_PUT_CONCURRENCY = 3;
const SYNC_DELETE_BATCH_SIZE = 1000;
const SYNC_COMMIT_MAX_LIST_PAGES = 32;
const SYNC_PACK_GC_GRACE_MS = 24 * 60 * 60 * 1000;
const SYNC_PACK_GC_MAX_LIST_PAGES = 8;
// R2 batch delete takes up to 1000 keys per call, so one delete subrequest
// clears up to 1000 orphans — the cap bounds work, not subrequests.
const SYNC_PACK_GC_MAX_DELETES = 1000;
const STREAM_SNAPSHOT_FORMAT = 'rp-sync-bounded-jsonl-v3';
const STREAM_SNAPSHOT_SCHEMA_VERSION = 12;
const IMAGE_API_PATH = '/api/rp-image';
const IMAGE_ADMIN_PATH = '/image';
const IMAGE_PREFIX = 'rp-images';
const IMAGE_OBJECT_PREFIX = `${IMAGE_PREFIX}/characters`;
const IMAGE_THUMB_PREFIX = `${IMAGE_PREFIX}/thumbs`;
const IMAGE_DELETED_PREFIX = `${IMAGE_PREFIX}/_deleted`;
// R2 subrequest budget: one tombstone put per image plus per-directory
// listings and batched deletes must stay under the free plan's 50
// subrequests per request, so deletes process at most this many targets.
const IMAGE_DELETE_MAX_TARGETS_PER_REQUEST = 20;
const IMAGE_DELETE_MAX_KEYS_PER_REQUEST = 20;
const IMAGE_DELETE_MAX_CHARACTER_NAMES_PER_REQUEST = 4;
const IMAGE_MAX_BYTES = 64 * 1024 * 1024;
const IMAGE_THUMB_MAX_BYTES = 2 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 120000;
const IMAGE_DEFAULT_MODEL = 'nai-diffusion-4-5-full';
const IMAGE_DEFAULT_SIZE = '竖图';
const IMAGE_DEFAULT_STEPS = '40';
const IMAGE_DEFAULT_SCALE = '6';
const IMAGE_DEFAULT_CFG = '0';
const IMAGE_DEFAULT_SAMPLER = 'k_dpmpp_2m_sde';
const IMAGE_DEFAULT_NOISE_SCHEDULE = 'karras';
const IMAGE_UPSTREAM_BASE = 'https://nai.sta1n.cn';
const IMAGE_PARAM_KEYS = [
    'provider',
    'tag',
    'model',
    'artist',
    'size',
    'steps',
    'scale',
    'cfg',
    'sampler',
    'negative',
    'nocache',
    'noise_schedule'
];

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

async function sha256Text(text) {
    return sha256Bytes(textEncoder.encode(text));
}

async function sha256Bytes(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function getSyncPassword(env) {
    const password = env?.[SYNC_PASSWORD_ENV];
    return typeof password === 'string' && password.length > 0 ? password : '';
}

async function imageAdminSessionToken(password) {
    return sha256Text(`rp-image-admin:${password}`);
}

function readCookie(request, name) {
    const header = request.headers.get('cookie') || '';
    const prefix = `${name}=`;
    return header
        .split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith(prefix))
        ?.slice(prefix.length) || '';
}

function imageAdminSessionCookie(value) {
    return `${IMAGE_ADMIN_AUTH_COOKIE}=${value}; Path=/image; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`;
}

function isRequestAuthorized(request, env) {
    const expectedPassword = getSyncPassword(env);
    if (!expectedPassword) return true;
    const providedPassword = request.headers.get(SYNC_PASSWORD_HEADER) || '';
    return providedPassword === expectedPassword;
}

async function handleAuthStatus(request, env) {
    const authRequired = Boolean(getSyncPassword(env));
    const authenticated = !authRequired || await isRequestAuthorized(request, env);
    return json({ ok: true, authRequired, authenticated });
}

function getBucket(env) {
    const bucket = env?.[R2_BINDING];
    if (!bucket) throw new Error('Missing R2 bucket binding.');
    return bucket;
}

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

function applyImageParamDefaults(params, token, characterName) {
    const requestedProvider = String(params.provider || '').trim().toLowerCase();
    const normalizedToken = String(token || '').trim().toUpperCase();
    params.provider = ['rinko', 'sta1n', 'std'].includes(requestedProvider)
        ? requestedProvider
        : normalizedToken.startsWith('STD') ? 'std' : 'sta1n';
    params.character_name = sanitizeImageKeySegment(characterName, '未命名角色');
    params.model = params.model || IMAGE_DEFAULT_MODEL;
    params.size = params.size || IMAGE_DEFAULT_SIZE;
    params.steps = params.steps || IMAGE_DEFAULT_STEPS;
    params.scale = params.scale || IMAGE_DEFAULT_SCALE;
    params.cfg = params.cfg || IMAGE_DEFAULT_CFG;
    params.sampler = params.sampler || IMAGE_DEFAULT_SAMPLER;
    params.nocache = params.nocache || '0';
    params.noise_schedule = params.noise_schedule || IMAGE_DEFAULT_NOISE_SCHEDULE;
    return params;
}

function buildImageParams(url, token) {
    const params = {};
    for (const key of IMAGE_PARAM_KEYS) {
        params[key] = normalizeImageParam(url.searchParams.get(key));
    }
    params.reroll_nonce = normalizeImageParam(url.searchParams.get('reroll_nonce'), 120);
    return applyImageParamDefaults(params, token, url.searchParams.get('character_name'));
}

function buildImageSignature(params) {
    const signature = {};
    for (const key of IMAGE_PARAM_KEYS) {
        signature[key] = params[key] || '';
    }
    if (params.reroll_nonce) {
        signature.reroll_nonce = params.reroll_nonce;
    }
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
    return `${IMAGE_OBJECT_PREFIX}/${sanitizeImageKeySegment(characterName)}/${checksum}`;
}

function createImageThumbKey(characterName, checksum) {
    return `${IMAGE_THUMB_PREFIX}/${sanitizeImageKeySegment(characterName)}/${checksum}.webp`;
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

function createImageDeletedKey(characterName, checksum) {
    return `${IMAGE_DELETED_PREFIX}/${sanitizeImageKeySegment(characterName)}/${checksum}.json`;
}

function createImageThumbKeyFromImageKey(key) {
    const checksum = getImageChecksumFromKey(key);
    const characterName = getImageCharacterFromKey(key);
    return checksum && characterName ? createImageThumbKey(characterName, checksum) : '';
}

// 前置校验（tag/token）已在 handleImageRender 完成，这里只负责拼上游地址。
function buildImageUpstreamUrl(params, token) {
    const upstream = new URL('/generate', IMAGE_UPSTREAM_BASE);
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

async function readBoundedImageBytes(message, maxBytes, label, signal) {
    const reader = message.body?.getReader();
    const cancel = () => { if (reader) void reader.cancel().catch(() => {}); };
    const tooLarge = size => Object.assign(new Error(`${label}：${size}/${maxBytes}`), { status: 413 });
    signal?.addEventListener('abort', cancel, { once: true });
    try {
        const declaredLength = Number(message.headers.get('content-length') || 0);
        if (declaredLength > maxBytes) throw tooLarge(declaredLength);
        const chunks = [];
        let total = 0;
        while (reader) {
            if (signal?.aborted) throw new Error('Image fetch timed out.');
            const { done, value } = await reader.read();
            if (signal?.aborted) throw new Error('Image fetch timed out.');
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) throw tooLarge(total);
            chunks.push(value);
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return bytes.buffer;
    } catch (err) {
        cancel();
        throw err;
    } finally {
        signal?.removeEventListener('abort', cancel);
        reader?.releaseLock();
    }
}

// The deadline covers both response headers and the bounded body consumer.
async function fetchImageWithTimeout(url, options, consume) {
    const controller = new AbortController();
    let response;
    let timeout;
    const deadline = new Promise((_, reject) => {
        timeout = setTimeout(() => {
            controller.abort();
            reject(new Error('Image fetch timed out.'));
        }, IMAGE_FETCH_TIMEOUT_MS);
    });
    try {
        return await Promise.race([deadline, (async () => {
            response = await fetch(url, {
                ...options,
                headers: {
                    accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
                    'user-agent': 'RPH-R2-Image-Cache',
                    ...(options.headers || {})
                },
                signal: controller.signal
            });
            if (controller.signal.aborted) {
                void response.body?.cancel().catch(() => {});
                throw new Error('Image fetch timed out.');
            }
            return await consume(response, controller.signal);
        })()]);
    } finally {
        clearTimeout(timeout);
        if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
    }
}

function imageResponse(body, contentType, extraHeaders = {}) {
    return new Response(body, {
        headers: {
            'content-type': contentType || 'image/png',
            'cache-control': 'public, max-age=3600, must-revalidate',
            ...extraHeaders
        }
    });
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
<text x="480" y="292" text-anchor="middle" font-family="Arial, sans-serif" font-size="34" font-weight="700" fill="#3f4652">\u56fe\u7247\u5df2\u6e05\u7406</text>
<text x="480" y="348" text-anchor="middle" font-family="Arial, sans-serif" font-size="22" fill="#7b8491">${safeName}</text>
</svg>`;
}

async function handleImageRender(request, env) {
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'POST') {
        return error('Method not allowed.', 405);
    }
    const url = new URL(request.url);
    const bucket = getBucket(env);
    const token = normalizeImageParam(url.searchParams.get('token'), 1000);
    const generateOnMiss = request.method === 'POST'
        || (request.method === 'GET' && url.searchParams.get('generate') === '1');
    const params = buildImageParams(url, token);
    const primary = await buildImageLookupCandidate(params);
    // 墓碑优先：删除请求先写墓碑、后台再清理原图，所以“原图还在”不能
    // 证明未删除；先查墓碑才能保证删除后的读取立即返回占位图。
    const deleted = await bucket.get(primary.deletedKey);
    if (deleted) {
        return imageResponse(request.method === 'HEAD' ? null : deletedImagePlaceholder(primary.params.character_name), 'image/svg+xml; charset=utf-8', {
            'cache-control': 'public, max-age=3600'
        });
    }
    // 非删除路径：命中原图（最常见的浏览路径）只花 2 个 R2 get（原图 +
    // 墓碑），未命中的生图请求也需要墓碑来排除“已删除”。
    const cached = await bucket.get(primary.key);
    if (cached) {
        return imageResponse(request.method === 'HEAD' ? null : cached.body, cached.httpMetadata?.contentType, {
            'content-length': String(cached.size || 0)
        });
    }

    if (!generateOnMiss) {
        return new Response(null, {
            status: 404,
            headers: { 'cache-control': 'no-store' }
        });
    }

    if (!token) return error('缺少生图密钥。', 401);
    if (!primary.params.tag) return error('缺少生图提示词。', 400);
    const result = await fetchImageWithTimeout(buildImageUpstreamUrl(primary.params, token), {}, async (upstreamResponse, signal) => {
        if (!upstreamResponse.ok) {
            return error(`\u751f\u56fe\u670d\u52a1\u8fd4\u56de\u5f02\u5e38\uff1aHTTP ${upstreamResponse.status}`, upstreamResponse.status);
        }
        const contentType = upstreamResponse.headers.get('content-type') || 'image/png';
        if (!contentType.toLowerCase().startsWith('image/')) {
            return error('\u751f\u56fe\u670d\u52a1\u6ca1\u6709\u8fd4\u56de\u56fe\u7247\u3002', 502);
        }
        try {
            const bytes = await readBoundedImageBytes(upstreamResponse, IMAGE_MAX_BYTES, '图片过大', signal);
            return { bytes, contentType };
        } catch (err) {
            if (err.status === 413) return error(err.message, 413);
            throw err;
        }
    });
    if (result instanceof Response) return result;
    const { bytes, contentType } = result;

    await bucket.put(primary.key, bytes, {
        httpMetadata: { contentType }
    });

    return imageResponse(bytes, contentType, {
        'content-length': String(bytes.byteLength)
    });
}

async function readThumbnailBytes(request) {
    const contentType = request.headers.get('content-type') || '';
    if (!contentType.toLowerCase().startsWith('image/webp')) {
        throw new Error('\u7f29\u7565\u56fe\u683c\u5f0f\u5fc5\u987b\u662f WebP\u3002');
    }
    const bytes = await readBoundedImageBytes(request, IMAGE_THUMB_MAX_BYTES, '缩略图大小异常');
    if (!bytes.byteLength) {
        throw new Error(`\u7f29\u7565\u56fe\u5927\u5c0f\u5f02\u5e38\uff1a${bytes.byteLength}/${IMAGE_THUMB_MAX_BYTES}`);
    }
    return bytes;
}

async function putImageThumbnail(bucket, imageKey, bytes) {
    const checksum = getImageChecksumFromKey(imageKey);
    const characterName = getImageCharacterFromKey(imageKey);
    if (!checksum || !characterName) throw new Error('\u56fe\u7247\u8def\u5f84\u65e0\u6548\u3002');
    const thumbKey = createImageThumbKey(characterName, checksum);
    await bucket.put(thumbKey, bytes, {
        httpMetadata: { contentType: 'image/webp' }
    });
    return thumbKey;
}

function imageAdminHtml() {
    return new Response(`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>\u89d2\u8272\u56fe\u7247\u7ba1\u7406</title>
<style>
:root{color-scheme:light;--blue:#2563eb;--blue-dark:#1d4ed8;--red:#dc2626;--red-soft:#fee2e2;--text:#111827;--muted:#687386;--line:#dde3ec;--bg:#f6f8fb;--panel:#fff;--soft:#eef2f7}
*{box-sizing:border-box}
body{min-height:100svh;margin:0;font-family:Inter,"Microsoft YaHei",Arial,sans-serif;background:var(--bg);color:var(--text)}
body:before{content:"";position:fixed;inset:0 0 auto 0;height:46vh;pointer-events:none;background-image:linear-gradient(var(--line) 1px,transparent 1px),linear-gradient(90deg,var(--line) 1px,transparent 1px);background-size:34px 34px;opacity:.42;mask-image:linear-gradient(to bottom,#000 0%,transparent 78%)}
header{position:sticky;top:0;z-index:5;background:rgba(246,248,251,.9);backdrop-filter:blur(16px);border-bottom:1px solid var(--line)}
.bar{position:relative;max-width:1180px;margin:auto;padding:14px 16px;display:grid;grid-template-columns:auto minmax(180px,1fr) auto;gap:12px;align-items:center}
.title-block{min-width:0;display:flex;align-items:center;gap:12px}
.title-copy{min-width:0}
.selection-info{font-size:13px;color:var(--muted);white-space:nowrap}
h1{font-size:22px;margin:0;font-weight:850;letter-spacing:0;white-space:nowrap}
.subline{margin-top:4px;color:var(--muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.search{width:100%;min-width:0;height:40px;border:1px solid var(--line);border-radius:8px;background:#fff;padding:0 14px;font-size:14px;outline:none}
.search:focus,.auth input:focus{border-color:#9bb7f4;box-shadow:0 0 0 3px rgba(37,99,235,.12)}
.controls{display:flex;align-items:center;gap:8px;justify-content:flex-end}
.btn{height:40px;border:1px solid var(--line);border-radius:8px;background:#fff;color:#374151;font-weight:800;padding:0 14px;cursor:pointer;white-space:nowrap}
.btn.primary{background:var(--blue);border-color:var(--blue);color:#fff}
.btn.primary:hover{background:var(--blue-dark)}
.btn.danger{background:#fff;border-color:#f0a8ad;color:#b91c1c}
.btn.danger:not(:disabled):hover{background:var(--red-soft)}
.btn.ghost{background:transparent}
.btn:disabled{opacity:.45;cursor:not-allowed}
main{position:relative;max-width:1180px;margin:auto;padding:18px 16px 48px}
.auth{position:relative;min-height:100svh;display:flex;align-items:center;justify-content:center;padding:32px 16px}
.auth-card{width:min(420px,100%);background:rgba(255,255,255,.94);border:1px solid var(--line);border-radius:8px;padding:24px;box-shadow:0 18px 48px rgba(15,23,42,.08)}
.auth-kicker{font-size:11px;font-weight:850;letter-spacing:.16em;color:var(--blue);text-transform:uppercase;margin-bottom:10px}
.auth h2{margin:0 0 8px;font-size:22px;line-height:1.2}
.auth p,.empty,.meta{color:var(--muted);font-size:13px}
.auth input{width:100%;height:44px;border:1px solid var(--line);border-radius:8px;padding:0 12px;margin:16px 0 12px;outline:none;font-size:14px}
.auth .btn{width:100%;height:44px}
.auth-msg{min-height:18px;margin:12px 0 0;color:#b91c1c;font-weight:700}
.album{padding:14px 0 18px;border-top:1px solid rgba(221,227,236,.78)}
.album:first-child{border-top:0;padding-top:0}
.album-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin:4px 0 10px}
.album-head-main{min-width:0;display:flex;flex-direction:column;gap:4px;flex:1}
.album-title{font-size:16px;font-weight:850;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.album-meta{color:var(--muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.album-actions{display:flex;align-items:center;gap:8px;justify-content:space-between;margin-top:10px}
.album-primary-actions{display:flex;align-items:center;gap:8px}
.album-clear{height:32px;border:1px solid #fecaca;border-radius:8px;background:#fff;color:#b91c1c;font-weight:850;padding:0 12px;cursor:pointer;white-space:nowrap}
.album-clear:hover{background:#fef2f2;border-color:#fca5a5}
.album-more{height:34px;border:1px solid var(--line);border-radius:8px;background:#fff;color:#2563eb;font-weight:850;padding:0 12px;cursor:pointer;white-space:nowrap}
.album-more:hover{background:#eff6ff;border-color:#bfdbfe}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(142px,1fr));gap:10px}
.photo{position:relative;display:block;padding:0;border:0;border-radius:8px;overflow:hidden;background:#e9eef5;cursor:pointer;box-shadow:inset 0 0 0 1px rgba(17,24,39,.07)}
.photo img{display:block;width:100%;aspect-ratio:1/1;object-fit:cover;transition:transform .18s ease}
.photo:hover img{transform:scale(1.025)}
.photo-info{position:absolute;left:0;right:0;bottom:0;padding:22px 8px 7px;background:linear-gradient(to top,rgba(15,23,42,.58),transparent);color:#fff;font-size:11px;text-align:left}
.photo-check{position:absolute;top:8px;right:8px;width:24px;height:24px;border-radius:999px;border:2px solid rgba(255,255,255,.88);background:rgba(15,23,42,.2);display:none;align-items:center;justify-content:center;color:#fff;font-size:14px;font-weight:900}
.delete-mode .photo-check{display:flex}
.photo.selected .photo-check{background:var(--blue);border-color:var(--blue)}
.photo.selected .photo-check:after{content:"\\2713"}
.notice{min-height:20px;color:#4b5563;font-size:13px;margin-bottom:10px}
.hidden{display:none!important}
.viewer{position:fixed;inset:0;z-index:30;background:rgba(246,248,251,.96);backdrop-filter:blur(10px);display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr) auto;gap:12px;padding:14px;overflow:hidden}
.viewer-top{display:flex;align-items:center;gap:10px;min-width:0;width:100%}
.viewer-title{font-weight:850;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.viewer-count{color:var(--muted);font-size:12px;margin-left:auto;white-space:nowrap}
.viewer-stage{min-width:0;width:100%;min-height:0;display:flex;align-items:center;justify-content:center}
.viewer-stage img{max-width:100%;max-height:100%;object-fit:contain;border-radius:8px;box-shadow:0 24px 70px rgba(15,23,42,.14)}
.viewer-nav{position:fixed;top:50%;transform:translateY(-50%);width:42px;height:54px;border:1px solid var(--line);border-radius:8px;background:rgba(255,255,255,.9);font-size:24px;color:#1f2937}
.viewer-nav.prev{left:14px}.viewer-nav.next{right:14px}
.filmstrip{display:flex;gap:8px;overflow-x:auto;padding:4px 14px 2px;justify-content:flex-start;min-width:0;width:100%}
.film{flex:0 0 58px;width:58px;height:58px;border:2px solid transparent;border-radius:8px;padding:0;overflow:hidden;background:#e5e7eb}
.film.active{border-color:var(--blue)}
.film img{width:100%;height:100%;object-fit:cover;display:block}
.film-placeholder{display:block;width:100%;height:100%;background:linear-gradient(135deg,#e5ebf3,#f8fafc)}
@media(max-width:720px){
  body:before{height:34vh;background-size:30px 30px}
  .bar{grid-template-columns:minmax(0,1fr) auto;gap:10px;padding:12px}
  .title-block{grid-column:1/2}
  .controls{grid-column:1/-1;justify-content:space-between;gap:7px}
  .search{grid-column:1/-1}
  h1{font-size:20px}
  .btn{height:38px;padding:0 11px}
  .btn span{display:none}
  main{padding:14px 10px 36px}
  .auth{align-items:flex-start;padding:22vh 12px 24px}
  .auth-card{padding:20px;border-radius:8px}
  .auth h2{font-size:21px}
  .gallery{grid-template-columns:repeat(3,minmax(0,1fr));gap:5px}
  .album{padding:13px 0 16px}
  .album-head{margin:3px 0 8px;flex-direction:column;align-items:stretch;gap:8px}
  .album-actions{gap:7px;margin-top:10px}
.album-clear,.album-more{height:34px;padding:0 11px}
  .photo,.photo img{border-radius:4px}
  .photo-info{display:none}
  .viewer{padding:10px;gap:10px}
  .viewer-nav{width:36px;height:48px}
  .film{flex-basis:52px;width:52px;height:52px}
}
</style>
</head>
<body>
<section id="auth" class="auth hidden">
  <div class="auth-card">
    <div class="auth-kicker">Image Library</div>
    <h2>\u89d2\u8272\u56fe\u7247\u7ba1\u7406</h2>
    <p>\u8f93\u5165\u4e91\u540c\u6b65\u5bc6\u7801\u540e\u8fdb\u5165\u3002</p>
    <input id="password" type="password" placeholder="\u540c\u6b65\u5bc6\u7801" autocomplete="current-password">
    <button id="login" class="btn primary">\u8fdb\u5165</button>
    <p id="authMsg" class="auth-msg"></p>
  </div>
</section>
<section id="app" class="hidden">
  <header>
    <div class="bar">
      <div class="title-block">
        <button id="back" class="btn">\u8fd4\u56de</button>
        <div class="title-copy"><h1>\u89d2\u8272\u56fe\u7247\u7ba1\u7406</h1>
        <div id="stats" class="subline">\u6b63\u5728\u8bfb\u53d6...</div></div>
      </div>
      <input id="filter" class="search" type="search" placeholder="\u641c\u7d22\u89d2\u8272\u5361">
      <div class="controls">
        <button id="refresh" class="btn">\u5237\u65b0</button>
        <button id="deleteMode" class="btn">\u9009\u62e9</button>
        <span id="selectionCount" class="selection-info hidden"></span>
        <button id="cancelDelete" class="btn ghost hidden">\u53d6\u6d88</button>
        <button id="deleteSelected" class="btn danger hidden" disabled>\u786e\u8ba4</button>
      </div>
    </div>
  </header>
  <main>
    <div id="notice" class="notice"></div>
    <div id="library"></div>
  </main>
</section>
<section id="viewer" class="viewer hidden">
  <div class="viewer-top">
    <button id="closeViewer" class="btn">\u5173\u95ed</button>
    <div id="viewerTitle" class="viewer-title"></div>
    <div id="viewerCount" class="viewer-count"></div>
  </div>
  <button id="prevImage" class="viewer-nav prev">&#8249;</button>
  <div class="viewer-stage"><img id="viewerImage" alt=""></div>
  <button id="nextImage" class="viewer-nav next">&#8250;</button>
  <div id="filmstrip" class="filmstrip"></div>
</section>
<script>
var passwordStorageKey='rp_hub_sync_password_v1';
var passwordInput=document.getElementById('password');
var authBox=document.getElementById('auth');
var appBox=document.getElementById('app');
var authMsg=document.getElementById('authMsg');
var library=document.getElementById('library');
var stats=document.getElementById('stats');
var notice=document.getElementById('notice');
var filter=document.getElementById('filter');
var backButton=document.getElementById('back');
var refreshButton=document.getElementById('refresh');
var deleteModeButton=document.getElementById('deleteMode');
var cancelDeleteButton=document.getElementById('cancelDelete');
var deleteSelectedButton=document.getElementById('deleteSelected');
var selectionCount=document.getElementById('selectionCount');
var viewer=document.getElementById('viewer');
var viewerImage=document.getElementById('viewerImage');
var viewerTitle=document.getElementById('viewerTitle');
var viewerCount=document.getElementById('viewerCount');
var filmstrip=document.getElementById('filmstrip');
var selected=new Set();
var data=null;
var deleteMode=false;
var previewList=[];
var previewIndex=-1;
var characterRenderLimits=Object.create(null);
var deleteBusy=false;
function esc(s){return String(s||'').replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function pass(){return localStorage.getItem(passwordStorageKey)||'';}
function savePass(value){localStorage.setItem(passwordStorageKey,value);}
function headers(){return {'x-rp-sync-password':pass(),'content-type':'application/json'};}
async function api(path,options){var res=await fetch(path,Object.assign({},options||{},{headers:Object.assign(headers(),(options&&options.headers)||{})}));var json=await res.json().catch(function(){return {ok:false,error:'\u54cd\u5e94\u5f02\u5e38'};});if(!res.ok||json.ok===false)throw new Error(json.error||('HTTP '+res.status));return json;}
function setNotice(text,isError){notice.textContent=text||'';notice.style.color=isError?'#dc2626':'#4b5563';}
function formatBytes(bytes){var units=['B','KB','MB','GB','TB'];var value=Math.max(0,Number(bytes)||0);var index=0;while(value>=1024&&index<units.length-1){value/=1024;index+=1;}return value.toFixed(index===0?0:2)+' '+units[index];}
function albumPageSize(){return window.matchMedia&&window.matchMedia('(max-width:720px)').matches?6:8;}
function resetCharacterRenderLimits(){characterRenderLimits=Object.create(null);}
function getCharacterRenderLimit(name){return characterRenderLimits[name]||albumPageSize();}
function increaseCharacterRenderLimit(name,total){characterRenderLimits[name]=Math.min(total,getCharacterRenderLimit(name)+albumPageSize());}
async function checkAuth(password){try{var r=await api('/image/api/auth-status',{method:'GET',headers:{'x-rp-sync-password':typeof password==='string'?password:pass()}});return r.authenticated;}catch(e){return false;}}
async function enter(){var password=passwordInput.value;authMsg.textContent='';if(await checkAuth(password)){savePass(password);authBox.classList.add('hidden');appBox.classList.remove('hidden');load();}else{authMsg.textContent='\u5bc6\u7801\u4e0d\u6b63\u786e';passwordInput.focus();}}
function imgUrl(key){return '/image/api/image?key='+encodeURIComponent(key);}
function thumbUrl(key){return '/image/api/thumb?key='+encodeURIComponent(key);}
function filmThumbHtml(item){return '<img loading="lazy" decoding="async" src="'+esc(thumbUrl(item.key))+'" alt="" onerror="this.classList.add(\\'hidden\\');this.nextElementSibling.classList.remove(\\'hidden\\')"><span class="film-placeholder hidden"></span>';}
function thumbFailed(img){var tile=img.closest('.photo');var key=tile&&tile.dataset.key;if(!key)return;img.onerror=null;img.dataset.needsThumb='1';img.src=imgUrl(key);}
function visibleImages(){var q=filter.value.trim().toLowerCase();var out=[];(data&&data.characters||[]).forEach(function(c){if(q&&!c.name.toLowerCase().includes(q))return;(c.images||[]).forEach(function(img){out.push(Object.assign({characterName:c.name},img));});});return out;}
function syncToolbar(){deleteSelectedButton.disabled=selected.size===0||deleteBusy;deleteSelectedButton.textContent='\u5220\u9664';selectionCount.textContent='\u5df2\u9009 '+selected.size+' \u5f20';selectionCount.classList.toggle('hidden',!deleteMode);document.body.classList.toggle('delete-mode',deleteMode);refreshButton.classList.toggle('hidden',deleteMode);deleteModeButton.classList.toggle('hidden',deleteMode);cancelDeleteButton.classList.toggle('hidden',!deleteMode);deleteSelectedButton.classList.toggle('hidden',!deleteMode);refreshButton.disabled=deleteBusy;}
function thumbBlobFromImage(img){return new Promise(function(resolve,reject){var w=img.naturalWidth||0;var h=img.naturalHeight||0;if(!w||!h)return reject(new Error('\u56fe\u7247\u672a\u52a0\u8f7d\u5b8c\u6210'));var max=480;var scale=Math.min(1,max/Math.max(w,h));var canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(w*scale));canvas.height=Math.max(1,Math.round(h*scale));canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);canvas.toBlob(function(blob){blob?resolve(blob):reject(new Error('\u7f29\u7565\u56fe\u751f\u6210\u5931\u8d25'));},'image/webp',0.8);});}
async function uploadAdminThumb(key,img){if(!img.complete||!img.naturalWidth)return;var blob=await thumbBlobFromImage(img);var res=await fetch(thumbUrl(key),{method:'PUT',headers:{'x-rp-sync-password':pass(),'content-type':'image/webp'},body:blob});if(!res.ok)throw new Error('\u7f29\u7565\u56fe\u4e0a\u4f20\u5931\u8d25');img.removeAttribute('data-needs-thumb');img.src=thumbUrl(key);}
var thumbBackfillRunning=0;
var thumbBackfillQueue=[];
var thumbBackfillQueued=new Set();
var thumbBackfillDone=new Set();
var thumbBackfillAttempts=new Map();
function queueThumbBackfill(img){if(!img||!img.isConnected||!img.matches('img[data-needs-thumb="1"]')||!img.complete||!img.naturalWidth)return;var tile=img.closest('.photo');var key=tile&&tile.dataset.key;if(!key||thumbBackfillDone.has(key)||thumbBackfillQueued.has(key))return;thumbBackfillQueued.add(key);thumbBackfillQueue.push({key:key,img:img});scheduleThumbBackfill();}
function scheduleThumbBackfill(){while(thumbBackfillRunning<3&&thumbBackfillQueue.length){const item=thumbBackfillQueue.shift();if(!item||!item.img.isConnected){if(item)thumbBackfillQueued.delete(item.key);continue;}thumbBackfillRunning+=1;Promise.resolve(uploadAdminThumb(item.key,item.img)).then(function(){thumbBackfillDone.add(item.key);thumbBackfillAttempts.delete(item.key);}).catch(function(){var attempts=(thumbBackfillAttempts.get(item.key)||0)+1;thumbBackfillAttempts.set(item.key,attempts);if(attempts<3)setTimeout(function(){thumbBackfillQueued.delete(item.key);queueThumbBackfill(item.img);},800);}).finally(function(){thumbBackfillRunning-=1;thumbBackfillQueued.delete(item.key);scheduleThumbBackfill();});}}
function refreshLibraryStats(){var images=(data&&data.characters||[]).flatMap(function(character){return character.images||[];});stats.textContent=images.length+' \u5f20\u56fe\u7247 / '+formatBytes(images.reduce(function(total,image){return total+(Number(image.size)||0);},0));}
function removeDeletedImages(payload){var keys=new Set(payload.keys||[]);var names=new Set(payload.characterNames||[]);data.characters=data.characters.map(function(character){var images=names.has(character.name)?[]:(character.images||[]).filter(function(image){return !keys.has(image.key);});if(!images.length)return null;var size=images.reduce(function(total,image){return total+(Number(image.size)||0);},0);return Object.assign({},character,{images:images,count:images.length,size:size,sizeHuman:formatBytes(size)});}).filter(Boolean);selected.clear();resetCharacterRenderLimits();refreshLibraryStats();render();}
function render(){if(!data)return;var q=filter.value.trim().toLowerCase();var characters=data.characters.filter(function(c){return !q||c.name.toLowerCase().includes(q);});var total=characters.reduce(function(sum,c){return sum+(c.images||[]).length;},0);if(!total){library.innerHTML='<div class="empty">\u6ca1\u6709\u56fe\u7247</div>';syncToolbar();return;}var html=[];characters.forEach(function(c){var images=c.images||[];if(!images.length)return;var limit=getCharacterRenderLimit(c.name);var shown=images.slice(0,limit);var remaining=Math.max(0,images.length-shown.length);var imgs=shown.map(function(img){var selectedClass=selected.has(img.key)?' selected':'';return '<button class="photo'+selectedClass+'" data-key="'+esc(img.key)+'"><img loading="lazy" decoding="async" src="'+esc(thumbUrl(img.key))+'" onerror="thumbFailed(this)" alt=""><span class="photo-check"></span><span class="photo-info">'+esc(img.sizeHuman)+'</span></button>';}).join('');var more=remaining>0?'<button class="album-more" data-character="'+esc(c.name)+'" data-total="'+images.length+'">\u663e\u793a\u66f4\u591a '+Math.min(albumPageSize(),remaining)+'</button>':'';var actionText=c.count>0?'\u6e05\u7a7a\u672c\u7ec4 ('+c.count+')':'\u6e05\u7a7a\u672c\u7ec4';var actions='<div class="album-actions"><div class="album-primary-actions"><button class="album-clear" data-character="'+esc(c.name)+'" data-count="'+esc(c.count)+'">'+actionText+'</button></div>'+more+'</div>';html.push('<section class="album"><div class="album-head"><div class="album-head-main"><div class="album-title">'+esc(c.name)+'</div><div class="album-meta">'+shown.length+' / '+c.count+' \u5f20 \u00b7 '+esc(c.sizeHuman)+'</div></div></div><div class="gallery">'+imgs+'</div>'+actions+'</section>');});library.innerHTML=html.join('');syncToolbar();scheduleThumbBackfill();}
function setDeleteMode(value){deleteMode=!!value;selected.clear();library.querySelectorAll('.photo.selected').forEach(function(tile){tile.classList.remove('selected');});syncToolbar();}
async function load(){if(deleteBusy)return;var scrollPosition=window.scrollY;setNotice('');stats.textContent='\u6b63\u5728\u8bfb\u53d6...';syncToolbar();refreshButton.disabled=true;try{data=await api('/image/api/library',{method:'GET'});var keys=new Set(visibleImages().map(function(image){return image.key;}));selected.forEach(function(key){if(!keys.has(key))selected.delete(key);});stats.textContent=data.totalCount+' \u5f20\u56fe\u7247 / '+data.totalHuman;render();requestAnimationFrame(function(){window.scrollTo({top:scrollPosition,behavior:'instant'});});}catch(e){stats.textContent='\u8bfb\u53d6\u5931\u8d25';if(!data)library.innerHTML='<div class="empty">'+esc(e.message)+'</div>';setNotice(e.message,true);}finally{refreshButton.disabled=deleteBusy;}}
var deleteChunkSize=20;
async function deletePayload(payload,message){if(deleteBusy||!confirm(message||'\u786e\u5b9a\u5220\u9664\u9009\u4e2d\u7684\u56fe\u7247\u5417\uff1f\u5220\u9664\u540e\u65e7\u94fe\u63a5\u4e0d\u4f1a\u91cd\u65b0\u751f\u56fe\u3002'))return;deleteBusy=true;var previousCharacters=data&&data.characters;var previousSelected=new Set(selected);var previousLimits=Object.assign({},characterRenderLimits);removeDeletedImages(payload);var accepted=[],deletedCount=0,deletedBytes=0,failedCount=0,queue=[];function pushKeyChunks(keys){for(var start=0;start<keys.length;start+=deleteChunkSize)queue.push({keys:keys.slice(start,start+deleteChunkSize)});}try{if(payload.characterNames&&payload.characterNames.length){queue.push({characterNames:payload.characterNames.slice(0,4)});}else{var seenKeys=new Set();pushKeyChunks((payload.keys||[]).filter(function(key){if(seenKeys.has(key))return false;seenKeys.add(key);return true;}));}for(var index=0;index<queue.length;index+=1){var r=await api('/image/api/delete',{method:'POST',body:JSON.stringify(queue[index])});deletedCount+=r.deletedCount||0;deletedBytes+=r.deletedBytes||0;failedCount+=r.failedCount||0;(r.acceptedKeys||[]).forEach(function(key){accepted.push(key);});pushKeyChunks(r.remainingKeys||[]);}if(failedCount){data.characters=previousCharacters;characterRenderLimits=previousLimits;removeDeletedImages({keys:accepted});}setNotice('\u5df2\u5220\u9664 '+deletedCount+' \u5f20 / '+formatBytes(deletedBytes)+(failedCount?'\uff0c'+failedCount+' \u5f20\u672a\u5b8c\u6210':''),failedCount>0);}catch(e){data.characters=previousCharacters;characterRenderLimits=previousLimits;if(accepted.length){removeDeletedImages({keys:accepted});}else{selected=previousSelected;refreshLibraryStats();render();}setNotice(e.message,true);}finally{deleteBusy=false;syncToolbar();}}
function deleteCharacterImages(characterName,count){if(!characterName)return;deletePayload({characterNames:[characterName]},'\u786e\u5b9a\u6e05\u7a7a\u300c'+characterName+'\u300d\u4e0b\u7684 '+(Number(count)||0)+' \u5f20\u56fe\u7247\u5417\uff1f\u5220\u9664\u540e\u65e7\u94fe\u63a5\u4e0d\u4f1a\u91cd\u65b0\u751f\u56fe\u3002');}
function openViewer(key){previewList=visibleImages();previewIndex=previewList.findIndex(function(img){return img.key===key;});if(previewIndex<0)previewIndex=0;renderViewer();viewer.classList.remove('hidden');}
function closeViewer(){viewer.classList.add('hidden');}
function moveViewer(delta){if(!previewList.length)return;previewIndex=(previewIndex+delta+previewList.length)%previewList.length;renderViewer();}
function renderFilmstrip(){var total=previewList.length;if(!total){filmstrip.innerHTML='';return;}var size=Math.min(18,total);var half=Math.floor(size/2);var items=[];for(var i=0;i<size;i++){var real=(previewIndex-half+i+total)%total;items.push({item:previewList[real],real:real});}filmstrip.innerHTML=items.map(function(entry){var active=entry.real===previewIndex;return '<button class="film'+(active?' active':'')+'" data-index="'+entry.real+'">'+filmThumbHtml(entry.item)+'</button>';}).join('');requestAnimationFrame(function(){var active=filmstrip.querySelector('.film.active');if(active)active.scrollIntoView({block:'nearest',inline:'center'});});}
function renderViewer(){var img=previewList[previewIndex];if(!img)return;viewerImage.src=imgUrl(img.key);viewerTitle.textContent=img.characterName;viewerCount.textContent=(previewIndex+1)+' / '+previewList.length+' \u00b7 '+img.sizeHuman;renderFilmstrip();}
document.getElementById('login').onclick=enter;
backButton.onclick=function(){location.href='/';};
passwordInput.onkeydown=function(e){if(e.key==='Enter')enter();};
refreshButton.onclick=load;
deleteModeButton.onclick=function(){setDeleteMode(true);};
cancelDeleteButton.onclick=function(){setDeleteMode(false);};
deleteSelectedButton.onclick=function(){deletePayload({keys:Array.from(selected)},'\u786e\u5b9a\u5220\u9664\u9009\u4e2d\u7684 '+selected.size+' \u5f20\u56fe\u7247\u5417\uff1f\u5220\u9664\u540e\u65e7\u94fe\u63a5\u4e0d\u4f1a\u91cd\u65b0\u751f\u56fe\u3002');};
filter.oninput=function(){resetCharacterRenderLimits();render();};
library.onclick=function(e){var clear=e.target.closest('.album-clear');if(clear){deleteCharacterImages(clear.dataset.character,clear.dataset.count);return;}var more=e.target.closest('.album-more');if(more){increaseCharacterRenderLimit(more.dataset.character,Number(more.dataset.total)||0);render();return;}var tile=e.target.closest('.photo');if(!tile)return;var key=tile.dataset.key;if(deleteMode){if(selected.has(key))selected.delete(key);else selected.add(key);tile.classList.toggle('selected',selected.has(key));syncToolbar();return;}openViewer(key);};
library.addEventListener('load',function(e){if(e.target&&e.target.matches&&e.target.matches('img[data-needs-thumb="1"]'))queueThumbBackfill(e.target);},true);
document.getElementById('closeViewer').onclick=closeViewer;
document.getElementById('prevImage').onclick=function(){moveViewer(-1);};
document.getElementById('nextImage').onclick=function(){moveViewer(1);};
filmstrip.onclick=function(e){var b=e.target.closest('.film');if(!b)return;previewIndex=Number(b.dataset.index)||0;renderViewer();};
passwordInput.value=pass();
checkAuth().then(function(ok){
  if(ok){
    authBox.classList.add('hidden');
    appBox.classList.remove('hidden');
    load();
  }else{
    authBox.classList.remove('hidden');
    passwordInput.focus();
  }
});
</script>
</body>
</html>`, {
        headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store'
        }
    });
}
async function isImageAdminAuthorized(request, env) {
    const expectedPassword = getSyncPassword(env);
    if (!expectedPassword) return true;
    const providedPassword = request.headers.get(SYNC_PASSWORD_HEADER) || '';
    if (providedPassword === expectedPassword) return true;
    const sessionToken = readCookie(request, IMAGE_ADMIN_AUTH_COOKIE);
    return Boolean(sessionToken) && sessionToken === await imageAdminSessionToken(expectedPassword);
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

function normalizeImageObject(object) {
    // 图库列表是热点路径：key 只拆一次，角色名/校验和与两条派生键一次算完
    // （原实现对同一 key 重复 split/正则 4-5 次）。派生键仍走
    // createImageThumbKey/createImageDeletedKey，保留 sanitize 语义。
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

async function listImageObjects(bucket, prefix = `${IMAGE_OBJECT_PREFIX}/`) {
    const rawObjects = [];
    let cursor;
    do {
        const page = await bucket.list({
            prefix,
            cursor,
            limit: 1000
        });
        for (const object of page.objects || []) {
            rawObjects.push(object);
        }
        cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return rawObjects.map(normalizeImageObject);
}

async function listImageTombstoneKeys(bucket) {
    const keys = new Set();
    let cursor;
    do {
        const page = await bucket.list({ prefix: `${IMAGE_DELETED_PREFIX}/`, cursor, limit: 1000 });
        for (const object of page.objects || []) keys.add(object.key);
        cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return keys;
}

async function getImageDeleteTargets(bucket, keys, characterNames) {
    // Existence is resolved with one listing per character directory instead
    // of a per-key head, so the subrequest count scales with distinct
    // characters rather than with the number of selected images.
    const directories = new Map();
    for (const key of keys) {
        if (!isValidImageObjectKey(key)) continue;
        const characterName = getImageCharacterFromKey(key);
        if (!characterName) continue;
        const directory = directories.get(characterName) || { includeAll: false, requestedKeys: new Set() };
        directory.requestedKeys.add(key);
        directories.set(characterName, directory);
    }
    for (const name of characterNames) {
        const characterName = sanitizeImageKeySegment(name);
        if (!characterName) continue;
        const directory = directories.get(characterName) || { includeAll: false, requestedKeys: new Set() };
        directory.includeAll = true;
        directories.set(characterName, directory);
    }
    const names = [...directories.keys()];
    const groups = await runConcurrent(names, 4, name => (
        listImageObjects(bucket, `${IMAGE_OBJECT_PREFIX}/${name}/`)
    ));
    const targets = new Map();
    groups.forEach((objects, index) => {
        const directory = directories.get(names[index]);
        for (const object of objects) {
            if (directory.includeAll || directory.requestedKeys.has(object.key)) {
                targets.set(object.key, object);
            }
        }
    });
    return [...targets.values()];
}

function buildImageLibrary(objects) {
    const characters = new Map();
    for (const object of objects) {
        const name = object.characterName || '\u672a\u547d\u540d\u89d2\u8272';
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
    // uploaded 是 normalizeImageObject 产出的定长 ISO 串，字典序即时间序，
    // 用普通比较替代 localeCompare（免 ICU 排序与每次比较的 String 分配）。
    return Array.from(characters.values())
        .map((character) => ({
            ...character,
            sizeHuman: formatBytes(character.size),
            images: character.images
                .sort((a, b) => (a.uploaded < b.uploaded ? 1 : a.uploaded > b.uploaded ? -1 : 0))
                .map(image => ({
                    key: image.key,
                    size: image.size,
                    sizeHuman: image.sizeHuman
                }))
        }))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}
async function writeImageTombstone(bucket, key) {
    const checksum = getImageChecksumFromKey(key);
    const characterName = getImageCharacterFromKey(key);
    if (!checksum || !characterName) return;
    await bucket.put(createImageDeletedKey(characterName, checksum), '1', {
        httpMetadata: { contentType: 'text/plain; charset=utf-8' }
    });
}

function chunkR2DeleteKeys(keys, size = 1000) {
    const chunks = [];
    for (let start = 0; start < keys.length; start += size) chunks.push(keys.slice(start, start + size));
    return chunks;
}

async function deleteImageObjectFiles(bucket, objects) {
    // R2 delete accepts up to 1000 keys per call, so cleanup costs two
    // subrequests per 1000 images instead of two per image.
    const objectKeys = objects.map(object => object.key);
    const thumbKeys = objects.map(object => object.thumbKey).filter(Boolean);
    await Promise.allSettled([
        ...chunkR2DeleteKeys(objectKeys).map(chunk => bucket.delete(chunk)),
        ...chunkR2DeleteKeys(thumbKeys).map(chunk => bucket.delete(chunk))
    ]);
}

async function handleImageAdmin(request, env, url, ctx) {
    if (url.pathname === IMAGE_ADMIN_PATH || url.pathname === `${IMAGE_ADMIN_PATH}/`) {
        return imageAdminHtml();
    }
    if (url.pathname === `${IMAGE_ADMIN_PATH}/api/auth-status`) {
        const authRequired = Boolean(getSyncPassword(env));
        const authenticated = !authRequired || await isImageAdminAuthorized(request, env);
        const headers = authRequired && authenticated
            ? { 'set-cookie': imageAdminSessionCookie(await imageAdminSessionToken(getSyncPassword(env))) }
            : {};
        return json({ ok: true, authRequired, authenticated }, 200, headers);
    }
    if (!await isImageAdminAuthorized(request, env)) {
        return error('Sync password required.', 401, { authRequired: true });
    }

    const bucket = getBucket(env);
    if (url.pathname === `${IMAGE_ADMIN_PATH}/api/library`) {
        const [allObjects, tombstoneKeys] = await Promise.all([
            listImageObjects(bucket),
            listImageTombstoneKeys(bucket)
        ]);
        const staleObjects = [];
        const objects = allObjects.filter(object => {
            const deleted = tombstoneKeys.has(object.deletedKey);
            if (deleted) staleObjects.push(object);
            return !deleted;
        });
        if (staleObjects.length) {
            const cleanup = deleteImageObjectFiles(bucket, staleObjects);
            if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(cleanup);
        }
        const totalBytes = objects.reduce((sum, object) => sum + object.size, 0);
        return json({
            ok: true,
            totalCount: objects.length,
            totalBytes,
            totalHuman: formatBytes(totalBytes),
            characters: buildImageLibrary(objects)
        });
    }
    if (url.pathname === `${IMAGE_ADMIN_PATH}/api/image`) {
        const key = url.searchParams.get('key') || '';
        if (!isValidImageObjectKey(key)) return error('\u56fe\u7247\u8def\u5f84\u65e0\u6548\u3002', 400);
        const object = await bucket.get(key);
        if (!object) return error('\u56fe\u7247\u4e0d\u5b58\u5728\u3002', 404);
        return imageResponse(request.method === 'HEAD' ? null : object.body, object.httpMetadata?.contentType, {
            'content-length': String(object.size || 0),
            'cache-control': 'private, max-age=3600'
        });
    }
    if (url.pathname === `${IMAGE_ADMIN_PATH}/api/thumb`) {
        const key = url.searchParams.get('key') || '';
        if (!isValidImageObjectKey(key)) return error('\u56fe\u7247\u8def\u5f84\u65e0\u6548\u3002', 400);
        const thumbKey = createImageThumbKeyFromImageKey(key);
        if (!thumbKey) return error('\u56fe\u7247\u8def\u5f84\u65e0\u6548\u3002', 400);
        if (request.method === 'GET' || request.method === 'HEAD') {
            const object = await bucket.get(thumbKey);
            if (!object) return error('\u7f29\u7565\u56fe\u4e0d\u5b58\u5728\u3002', 404);
            return imageResponse(request.method === 'HEAD' ? null : object.body, object.httpMetadata?.contentType || 'image/webp', {
                'content-length': String(object.size || 0),
                'cache-control': 'private, max-age=86400'
            });
        }
        if (request.method !== 'PUT' && request.method !== 'POST') return error('Method not allowed.', 405);
        const imageObject = await bucket.get(key);
        if (!imageObject) return error('\u539f\u56fe\u4e0d\u5b58\u5728\uff0c\u4e0d\u80fd\u4fdd\u5b58\u7f29\u7565\u56fe\u3002', 404);
        const bytes = await readThumbnailBytes(request);
        const savedKey = await putImageThumbnail(bucket, key, bytes);
        return json({ ok: true, key: savedKey, bytes: bytes.byteLength });
    }
    if (url.pathname === `${IMAGE_ADMIN_PATH}/api/delete`) {
        if (request.method !== 'POST') return error('Method not allowed.', 405);
        const body = await request.json().catch(() => null);
        if (!body || typeof body !== 'object') return error('Invalid JSON body.');
        const keys = [...new Set(Array.isArray(body.keys) ? body.keys : [])];
        const characterNames = [...new Set(Array.isArray(body.characterNames) ? body.characterNames : [])];
        if (keys.length > IMAGE_DELETE_MAX_KEYS_PER_REQUEST) {
            return error(`单次最多删除 ${IMAGE_DELETE_MAX_KEYS_PER_REQUEST} 张图片，请分批删除。`, 400);
        }
        if (characterNames.length > IMAGE_DELETE_MAX_CHARACTER_NAMES_PER_REQUEST) {
            return error(`单次最多清空 ${IMAGE_DELETE_MAX_CHARACTER_NAMES_PER_REQUEST} 个角色分组，请分批删除。`, 400);
        }
        const targets = await getImageDeleteTargets(bucket, keys, characterNames);
        // 超出单次预算的目标以 remainingKeys 返回，由客户端继续分批提交。
        const processTargets = targets.slice(0, IMAGE_DELETE_MAX_TARGETS_PER_REQUEST);
        const remainingTargets = targets.slice(IMAGE_DELETE_MAX_TARGETS_PER_REQUEST);
        const tombstoneResults = await runConcurrent(processTargets, 8, async (object) => {
            try {
                await writeImageTombstone(bucket, object.key);
                return { object, accepted: true };
            } catch (_) {
                return { object, accepted: false };
            }
        });
        const acceptedTargets = tombstoneResults.filter(result => result.accepted).map(result => result.object);
        const failedCount = processTargets.length - acceptedTargets.length;
        if (processTargets.length && acceptedTargets.length === 0) {
            return error('\u5220\u9664\u6807\u8bb0\u5199\u5165\u5931\u8d25\u3002', 502, { failedCount });
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
            deletedHuman: formatBytes(deletedBytes),
            failedCount,
            remainingKeys: remainingTargets.map(object => object.key)
        });
    }
    return error('Not found.', 404);
}
function createPackKey(checksum) {
    return `${PACK_PREFIX}/${String(checksum || '').toLowerCase()}.bin`;
}

// Single pass over the client manifest: validates every pack entry and
// builds both the normalized entries and the snapshot-checksum source arrays,
// so the cold manifest path walks the data once instead of twice.
function normalizePackManifest(manifest, totalBytes, entryCount) {
    if (!Array.isArray(manifest) || manifest.length > MAX_OBJECT_COUNT) return null;
    const emptySnapshot = Number(totalBytes) === 0 && Number(entryCount) === 0 && manifest.length === 0;
    if (emptySnapshot) return { packs: [], checksumSource: [] };
    if (manifest.length === 0) return null;

    let manifestBytes = 0;
    let manifestEntries = 0;
    const bucketParts = new Map();
    const contentDefinitions = new Map();
    const packs = new Array(manifest.length);
    const checksumSource = new Array(manifest.length);
    for (let index = 0; index < manifest.length; index += 1) {
        const item = manifest[index];
        const bucketKey = String(item?.bucketKey || '');
        const group = String(item?.group || '');
        const part = Number(item?.part);
        const checksum = String(item?.checksum || '').toLowerCase();
        const length = Number(item?.length);
        const entries = Number(item?.entryCount);
        if (!/^[a-f0-9]{64}$/.test(checksum)) throw new Error(`数据包校验码异常：第 ${index} 个。`);
        if (!Number.isInteger(length) || length <= 0 || length > MAX_PACK_BYTES) {
            throw new Error(`数据包大小异常：第 ${index} 个。`);
        }
        if (!Number.isInteger(entries) || entries < 0 || entries > MAX_PACK_ENTRIES) {
            throw new Error(`数据包记录数量异常：第 ${index} 个。`);
        }
        if (!bucketKey || bucketKey.length > 4000 || !group || group.length > 1000 || !Number.isInteger(part) || part < 0) {
            throw new Error(`数据包索引异常：第 ${index} 个。`);
        }
        const bucketState = bucketParts.get(bucketKey) || { group, nextPart: 0 };
        if (bucketState.group !== group || part !== bucketState.nextPart) {
            throw new Error(`数据包顺序异常：第 ${index} 个。`);
        }
        bucketState.nextPart += 1;
        bucketParts.set(bucketKey, bucketState);
        const content = contentDefinitions.get(checksum);
        if (content && (content.length !== length || content.entryCount !== entries)) {
            throw new Error(`相同数据包的内容描述不一致：第 ${index} 个。`);
        }
        contentDefinitions.set(checksum, { length, entryCount: entries });
        manifestBytes += length;
        manifestEntries += entries;
        packs[index] = { bucketKey, group, part, checksum, length, entryCount: entries };
        // Entries are already canonical (lowercase checksum, plain strings and
        // numbers), so this tuple serializes byte-identically to the old
        // String()/Number() wrapping in buildStreamSnapshotChecksumSource.
        checksumSource[index] = [bucketKey, group, part, checksum, length, entries];
    }

    if (manifestBytes !== totalBytes) throw new Error('数据包大小合计不一致。');
    if (manifestEntries !== entryCount) throw new Error('记录数量合计不一致。');
    return { packs, checksumSource };
}

function normalizeManifest(value) {
    if (!value || typeof value !== 'object') return null;
    const snapshotFormat = value.snapshotFormat;
    const schemaVersion = Number(value.schemaVersion);
    const version = Number(value.version || 0);
    const packCount = Number(value.packCount);
    const entryCount = Number(value.entryCount);
    const totalBytes = Number(value.totalBytes);
    const packManifest = Array.isArray(value.packManifest) ? value.packManifest : [];
    if (!Number.isInteger(version) || version < 0) return null;
    const emptySnapshot = packCount === 0 && entryCount === 0 && totalBytes === 0 && packManifest.length === 0;
    if (!Number.isInteger(packCount) || packCount < 0 || packCount > MAX_OBJECT_COUNT) return null;
    if (!Number.isInteger(entryCount) || entryCount < 0 || entryCount > MAX_OBJECT_COUNT * MAX_PACK_ENTRIES) return null;
    if (!Number.isInteger(totalBytes) || totalBytes < 0 || totalBytes > MAX_TOTAL_BYTES) return null;
    if (!emptySnapshot && (packCount === 0 || entryCount === 0 || totalBytes === 0)) return null;
    if (typeof value.checksum !== 'string' || !/^[a-f0-9]{64}$/i.test(value.checksum)) return null;
    if (snapshotFormat !== STREAM_SNAPSHOT_FORMAT || schemaVersion !== STREAM_SNAPSHOT_SCHEMA_VERSION) return null;
    if (packManifest.length !== packCount) return null;
    let normalized;
    try {
        normalized = normalizePackManifest(packManifest, totalBytes, entryCount);
    } catch (err) {
        return null;
    }
    if (!normalized || normalized.packs.length !== packCount) return null;

    // checksumSource is consumed by validation and then dropped: keeping it on
    // the cached manifest would double the cache footprint for no reuse.
    return {
        manifest: {
            version,
            checksum: value.checksum.toLowerCase(),
            updatedAt: Number(value.updatedAt || 0),
            totalBytes,
            packCount,
            entryCount,
            packManifest: normalized.packs,
            snapshotFormat,
            schemaVersion
        },
        checksumSource: normalized.checksumSource
    };
}

function buildStreamSnapshotChecksumSource(totalBytes, packCount, entryCount, checksumSource) {
    return JSON.stringify([
        STREAM_SNAPSHOT_FORMAT,
        STREAM_SNAPSHOT_SCHEMA_VERSION,
        Number(totalBytes || 0),
        Number(packCount || 0),
        Number(entryCount || 0),
        checksumSource
    ]);
}

async function isValidPackSnapshotChecksum(checksum, totalBytes, packCount, entryCount, packManifest) {
    return await sha256Text(buildStreamSnapshotChecksumSource(totalBytes, packCount, entryCount, packManifest)) === checksum;
}

// Manifests are re-verified against the live R2 etag on every call, so a
// cached entry can never be stale; the cache only avoids re-parsing the
// manifest for each pack pull and commit check.
const MANIFEST_CACHE_TTL_MS = 30 * 1000;
const manifestCache = new Map();

function cacheManifestByEtag(etag, manifest) {
    const now = Date.now();
    for (const [key, entry] of manifestCache) {
        if (entry.expiresAt <= now) manifestCache.delete(key);
    }
    manifestCache.set(etag, { manifest, expiresAt: now + MANIFEST_CACHE_TTL_MS });
}

// Second-level validation cache keyed by the manifest's own checksum. The
// checksum is content-derived (sha256 over format, schema, sizes and every
// pack entry), so a manifest that once passed validation never needs
// re-validating; the cache only skips the parse-and-derive work when the etag
// cache has expired but the same manifest version is seen again (the common
// case: each push commits a new etag, so the next push's first read is always
// an etag miss). Bounded to the last few versions per isolate.
const validatedManifestCache = new Map();
const VALIDATED_MANIFEST_CACHE_MAX = 8;

function rememberValidatedManifest(manifest) {
    const key = `${manifest.checksum}:${manifest.totalBytes}:${manifest.packCount}:${manifest.entryCount}`;
    if (validatedManifestCache.has(key)) return;
    validatedManifestCache.set(key, manifest);
    while (validatedManifestCache.size > VALIDATED_MANIFEST_CACHE_MAX) {
        validatedManifestCache.delete(validatedManifestCache.keys().next().value);
    }
}

function readValidatedManifest(value) {
    if (!value || typeof value !== 'object' || typeof value.checksum !== 'string') return null;
    const key = `${value.checksum.toLowerCase()}:${Number(value.totalBytes)}:${Number(value.packCount)}:${Number(value.entryCount)}`;
    const cached = validatedManifestCache.get(key);
    if (!cached) return null;
    // Structural guard: a corrupted or forged object must fall through to
    // full validation (and rejection) instead of being silently healed. Only
    // version/updatedAt are checked here because everything else is bound by
    // the cache key and, transitively, by the verified checksum.
    if (Number(value.version || 0) !== cached.version || Number(value.updatedAt || 0) !== cached.updatedAt) return null;
    return cached;
}

async function getManifestState(bucket) {
    const head = await bucket.head(MANIFEST_KEY);
    if (!head) return { manifest: null, etag: null };
    const headEtag = head.etag || null;
    if (Number(head.size || 0) > SYNC_CONTROL_MAX_BYTES) throw new SyncRequestError('现有云端清单超过上限，已停止读写以保护数据。', 409);
    if (headEtag) {
        const cached = manifestCache.get(headEtag);
        if (cached && cached.expiresAt > Date.now()) return { manifest: cached.manifest, etag: headEtag };
    }
    const object = await bucket.get(MANIFEST_KEY);
    if (!object) return { manifest: null, etag: headEtag };
    const etag = object.etag || headEtag;
    if (Number(object.size) > SYNC_CONTROL_MAX_BYTES) {
        if (object.body?.cancel) await object.body.cancel();
        throw new SyncRequestError('现有云端清单超过上限，已停止读写以保护数据。', 409);
    }
    const text = await object.text();
    let value;
    try {
        value = JSON.parse(text);
    } catch (err) {
        throw new SyncRequestError('现有云端清单 JSON 损坏，已停止读写以保护数据。', 409);
    }
    const validated = readValidatedManifest(value);
    if (validated) {
        if (object.etag) cacheManifestByEtag(object.etag, validated);
        return { manifest: validated, etag };
    }
    const normalized = normalizeManifest(value);
    if (normalized
        && await isValidPackSnapshotChecksum(
            normalized.manifest.checksum,
            normalized.manifest.totalBytes,
            normalized.manifest.packCount,
            normalized.manifest.entryCount,
            normalized.checksumSource
        )) {
        rememberValidatedManifest(normalized.manifest);
        if (object.etag) cacheManifestByEtag(object.etag, normalized.manifest);
        return { manifest: normalized.manifest, etag };
    }
    throw new SyncRequestError('现有云端清单格式或校验无效，已停止读写以保护数据。', 409);
}

async function getManifest(bucket) {
    return (await getManifestState(bucket)).manifest;
}

function buildRemoteInfo(manifest) {
    return {
        version: manifest.version,
        checksum: manifest.checksum,
        updatedAt: manifest.updatedAt,
        totalBytes: manifest.totalBytes,
        packCount: manifest.packCount,
        entryCount: manifest.entryCount,
        snapshotFormat: manifest.snapshotFormat,
        schemaVersion: manifest.schemaVersion,
        // packManifest entries are already canonical plain objects in this key
        // order; re-mapping them would only allocate a second copy.
        packManifest: manifest.packManifest
    };
}

async function handleStatus(bucket, body) {
    if (Number(body?.schemaVersion) !== STREAM_SNAPSHOT_SCHEMA_VERSION) {
        return error('同步存储版本已升级，请刷新页面后重试。', 409);
    }
    if (!await bucket.head(MIGRATION_MARKER_KEY)) return json({ ok: true, remote: null, resetRequired: true });
    const manifest = await getManifest(bucket);
    return json({ ok: true, remote: manifest ? buildRemoteInfo(manifest) : null, resetRequired: false });
}

function getSyncCursor(body) {
    if (body.cursor == null || body.cursor === '') return undefined;
    if (typeof body.cursor !== 'string' || body.cursor.length > 8192) {
        throw new SyncRequestError('同步分页游标无效。', 400);
    }
    return body.cursor;
}

function getNextSyncCursor(page, previousCursor) {
    if (!page.truncated) return null;
    if (typeof page.cursor !== 'string' || !page.cursor || page.cursor === previousCursor) {
        throw new Error('服务器同步分页暂时无法继续，请重试。');
    }
    return page.cursor;
}

async function handleResetUpload(bucket, body) {
    if (Number(body.schemaVersion) !== STREAM_SNAPSHOT_SCHEMA_VERSION) {
        return error('同步存储版本已升级，请刷新页面后重试。', 409);
    }
    const cursor = getSyncCursor(body);
    if (await bucket.head(MIGRATION_MARKER_KEY)) {
        return json({ ok: true, done: true, resetRequired: false, cursor: null });
    }
    const migrationSource = `${R2_PREFIX}/`;
    const page = await bucket.list({ prefix: migrationSource, cursor, limit: SYNC_DELETE_BATCH_SIZE });
    const nextCursor = getNextSyncCursor(page, cursor);
    const keys = (page.objects || []).map(object => object.key).filter(key => key !== MIGRATION_MARKER_KEY);
    if (keys.length) await bucket.delete(keys);
    if (nextCursor) return json({ ok: true, done: false, cursor: nextCursor, resetRequired: true });
    await bucket.put(MIGRATION_MARKER_KEY, '1', {
        httpMetadata: { contentType: 'text/plain; charset=utf-8' }
    });
    return json({ ok: true, done: true, resetRequired: false, cursor: null });
}

async function handleListUploadPacks(bucket, body) {
    const cursor = getSyncCursor(body);
    if (!await bucket.head(MIGRATION_MARKER_KEY)) {
        return error('同步存储尚未初始化，请先完成无损初始化。', 409, { resetRequired: true });
    }
    const prefix = `${PACK_PREFIX}/`;
    const page = await bucket.list({ prefix, cursor, limit: SYNC_DELETE_BATCH_SIZE });
    const nextCursor = getNextSyncCursor(page, cursor);
    const availablePacks = [];
    for (const object of page.objects || []) {
        if (!object?.key?.startsWith(prefix)) continue;
        const match = object.key.slice(prefix.length).match(/^([a-f0-9]{64})\.bin$/);
        const length = Number(object.size);
        if (match && Number.isInteger(length) && length > 0 && length <= MAX_PACK_BYTES) {
            availablePacks.push({ checksum: match[1], length });
        }
    }
    return json({
        ok: true,
        availablePacks,
        cursor: nextCursor
    });
}

async function handlePullPack(bucket, body) {
    const manifest = await getManifest(bucket);
    if (!manifest) return error('服务器当前没有可同步的数据。', 404);

    const version = Number(body.version);
    const checksum = String(body.checksum || '').toLowerCase();
    if (!Number.isInteger(version) || version !== manifest.version) return error('服务器版本已变化，请重试。', 409);
    if (!/^[a-f0-9]{64}$/.test(checksum)) return error('下载数据校验码无效。');
    const pack = manifest.packManifest.find(item => item.checksum === checksum);
    if (!pack) return error('下载数据不存在。', 404);
    const storedPack = await bucket.get(createPackKey(checksum));
    if (!storedPack) return error('R2 同步数据不存在。', 404);
    const byteLength = Number(storedPack.size || 0);
    if (byteLength !== pack.length) return error('R2 同步数据大小校验失败。', 409);

    return new Response(storedPack.body, {
        status: 200,
        headers: {
            'content-type': 'application/octet-stream',
            'cache-control': 'no-store',
            'content-length': String(byteLength)
        }
    });
}

class SyncRequestError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}

function createSyncRequestReader(request, maxBytes) {
    const contentLength = request.headers.get('content-length');
    const declaredLength = contentLength === null ? null : Number(contentLength);
    if (contentLength !== null
        && (!/^\d+$/.test(contentLength) || !Number.isSafeInteger(declaredLength))) {
        throw new SyncRequestError('上传请求长度无效。', 400);
    }
    if (declaredLength > maxBytes) throw new SyncRequestError('上传请求超过大小上限。', 413);
    const reader = request.body?.getReader();
    let receivedBytes = 0;
    let ended = !reader;
    let pending = null;
    let pendingOffset = 0;

    async function readChunk() {
        while (!ended) {
            const result = await reader.read();
            if (result.done) {
                ended = true;
                if (declaredLength !== null && receivedBytes !== declaredLength) {
                    throw new SyncRequestError('上传请求长度与正文不一致。', 409);
                }
                return null;
            }
            receivedBytes += result.value.byteLength;
            if (receivedBytes > maxBytes) throw new SyncRequestError('上传请求超过大小上限。', 413);
            if (result.value.byteLength) return result.value;
        }
        return null;
    }

    return {
        declaredLength,
        readChunk,
        async readExact(length) {
            const bytes = new Uint8Array(length);
            let offset = 0;
            while (offset < length) {
                if (!pending || pendingOffset === pending.byteLength) {
                    pending = await readChunk();
                    pendingOffset = 0;
                    if (!pending) throw new SyncRequestError('上传数据包内容不完整。', 409);
                }
                const take = Math.min(length - offset, pending.byteLength - pendingOffset);
                bytes.set(pending.subarray(pendingOffset, pendingOffset + take), offset);
                pendingOffset += take;
                offset += take;
            }
            if (pendingOffset === pending?.byteLength) {
                pending = null;
                pendingOffset = 0;
            }
            return bytes;
        },
        async finish() {
            if ((pending && pendingOffset < pending.byteLength) || await readChunk()) {
                throw new SyncRequestError('上传数据包正文包含多余内容。', 409);
            }
        },
        async dispose() {
            if (!reader) return;
            if (!ended) {
                try {
                    await reader.cancel();
                } catch (_) { }
            }
            reader.releaseLock();
        }
    };
}

async function readSyncJsonBody(request) {
    const reader = createSyncRequestReader(request, SYNC_CONTROL_MAX_BYTES);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let text = '';
    try {
        let chunk;
        while ((chunk = await reader.readChunk()) !== null) {
            text += decoder.decode(chunk, { stream: true });
        }
        text += decoder.decode();
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
        await reader.dispose();
    }
}

async function handleUploadPackBatch(request, bucket) {
    if (!await bucket.head(MIGRATION_MARKER_KEY)) {
        return error('同步存储尚未初始化，请先完成无损初始化。', 409, { resetRequired: true });
    }
    const contentType = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'application/octet-stream') return error('上传批次必须使用二进制格式。', 415);
    const reader = createSyncRequestReader(request, SYNC_UPLOAD_BATCH_MAX_BODY_BYTES);
    const uploads = new Set();
    let uploadError = null;
    try {
        const prefix = await reader.readExact(4);
        const headerLength = new DataView(prefix.buffer).getUint32(0, false);
        if (headerLength <= 0 || headerLength > SYNC_UPLOAD_BATCH_MAX_HEADER_BYTES) {
            throw new SyncRequestError('上传数据包批次头过大或无效。', 413);
        }
        const headerBytes = await reader.readExact(headerLength);
        let definitions;
        try {
            definitions = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(headerBytes));
        } catch (_) {
            throw new SyncRequestError('上传数据包批次头无效。', 409);
        }
        if (!Array.isArray(definitions) || !definitions.length || definitions.length > SYNC_UPLOAD_BATCH_MAX_PACKS) {
            throw new SyncRequestError('上传数据包批次数量异常。', 409);
        }
        let totalBytes = 0;
        const packs = definitions.map(definition => {
            const checksum = String(definition?.checksum || '').toLowerCase();
            const length = Number(definition?.length);
            if (!/^[a-f0-9]{64}$/.test(checksum)) {
                throw new SyncRequestError('上传数据包校验码无效。', 409);
            }
            if (!Number.isInteger(length) || length <= 0 || length > MAX_PACK_BYTES) {
                throw new SyncRequestError('上传数据包大小异常。', 413);
            }
            totalBytes += length;
            return { checksum, length };
        });
        if (totalBytes > SYNC_UPLOAD_BATCH_MAX_BYTES) {
            throw new SyncRequestError('上传数据包批次过大。', 413);
        }
        if (reader.declaredLength !== null && reader.declaredLength !== 4 + headerLength + totalBytes) {
            throw new SyncRequestError('上传数据包长度与批次头不一致。', 409);
        }
        for (const pack of packs) {
            if (uploads.size >= SYNC_UPLOAD_BATCH_PUT_CONCURRENCY) await Promise.race(uploads);
            if (uploadError) throw uploadError;
            const bytes = await reader.readExact(pack.length);
            let entryCount = 0;
            // 原生 indexOf 扫描替代逐字节循环：这是免费版 CPU 预算里最贵的
            // 单段热循环（每批最多 4MiB），语义不变——数 0x0A，超 256 行即拒。
            for (let offset = bytes.indexOf(10); offset !== -1; offset = bytes.indexOf(10, offset + 1)) {
                if (++entryCount > MAX_PACK_ENTRIES) {
                    throw new SyncRequestError('上传数据包记录数量超过上限。', 409);
                }
            }
            const sha256 = Uint8Array.from(pack.checksum.match(/../g), value => parseInt(value, 16));
            let upload;
            upload = Promise.resolve().then(() => bucket.put(createPackKey(pack.checksum), bytes, {
                sha256,
                httpMetadata: { contentType: 'application/octet-stream' }
            })).catch(err => {
                if (!uploadError) uploadError = err;
            }).finally(() => uploads.delete(upload));
            uploads.add(upload);
        }
        await reader.finish();
        await Promise.all(uploads);
        if (uploadError) throw uploadError;
        return new Response(null, { status: 204 });
    } finally {
        await Promise.all(uploads);
        await reader.dispose();
    }
}

async function runOrphanPackGc(bucket) {
    try {
        // Re-read the manifest after commit so a concurrent writer's newer
        // snapshot is protected before any old pack is considered for deletion.
        const manifest = await getManifest(bucket);
        if (!manifest) return;
        const referencedKeys = new Set(
            manifest.packManifest.map(pack => createPackKey(pack.checksum))
        );
        const cutoff = Date.now() - SYNC_PACK_GC_GRACE_MS;
        const candidates = [];
        let cursor;
        for (let pageIndex = 0; pageIndex < SYNC_PACK_GC_MAX_LIST_PAGES; pageIndex += 1) {
            const page = await bucket.list({
                prefix: `${PACK_PREFIX}/`,
                cursor,
                limit: SYNC_DELETE_BATCH_SIZE
            });
            for (const object of page.objects || []) {
                const key = typeof object?.key === 'string' ? object.key : '';
                const name = key.startsWith(`${PACK_PREFIX}/`) ? key.slice(PACK_PREFIX.length + 1) : '';
                if (!/^[a-f0-9]{64}\.bin$/.test(name) || referencedKeys.has(key)) continue;
                const uploaded = object.uploaded;
                const uploadedAt = uploaded instanceof Date
                    ? uploaded.getTime()
                    : typeof uploaded === 'number'
                        ? uploaded
                        : Date.parse(String(uploaded || ''));
                if (!Number.isFinite(uploadedAt) || uploadedAt >= cutoff) continue;
                candidates.push(key);
                if (candidates.length >= SYNC_PACK_GC_MAX_DELETES) break;
            }
            if (candidates.length >= SYNC_PACK_GC_MAX_DELETES) break;
            cursor = getNextSyncCursor(page, cursor);
            if (!cursor) break;
        }
        if (candidates.length) await bucket.delete(candidates);
    } catch (_) {
        // Cleanup is best effort. A manifest that already committed must not
        // become an upload failure because R2 listing or deletion is degraded.
    }
}

function scheduleOrphanPackGc(bucket, ctx) {
    const cleanup = runOrphanPackGc(bucket);
    if (ctx && typeof ctx.waitUntil === 'function') {
        ctx.waitUntil(cleanup);
        return;
    }
    return cleanup;
}

async function handleUploadComplete(bucket, body, ctx) {
    const baseVersion = Number(body.baseVersion);
    const checksum = typeof body.checksum === 'string' ? body.checksum.toLowerCase() : '';
    const packCount = Number(body.packCount);
    const entryCount = Number(body.entryCount);
    const totalBytes = Number(body.totalBytes);
    const snapshotFormat = body.snapshotFormat;
    const schemaVersion = Number(body.schemaVersion);

    if (snapshotFormat !== STREAM_SNAPSHOT_FORMAT || schemaVersion !== STREAM_SNAPSHOT_SCHEMA_VERSION) {
        return error('上传快照格式不受支持。');
    }
    if (!Number.isInteger(baseVersion) || baseVersion < 0) return error('上传基础版本无效。', 409);
    if (!/^[a-f0-9]{64}$/.test(checksum)) return error('上传快照校验码无效。', 409);

    if (!Number.isInteger(packCount) || packCount < 0 || packCount > MAX_OBJECT_COUNT) return error('上传数据包数量异常。');
    if (!Number.isInteger(entryCount) || entryCount < 0 || entryCount > MAX_OBJECT_COUNT * MAX_PACK_ENTRIES) return error('上传记录数量异常。');
    if (!Number.isInteger(totalBytes) || totalBytes < 0 || totalBytes > MAX_TOTAL_BYTES) {
        return error(`本地数据太大：${totalBytes}/${MAX_TOTAL_BYTES}。`);
    }
    const emptySnapshot = packCount === 0 && entryCount === 0 && totalBytes === 0
        && Array.isArray(body.packManifest) && body.packManifest.length === 0;
    if (!emptySnapshot && (packCount === 0 || entryCount === 0 || totalBytes === 0)) {
        return error('空快照字段必须同时为零。', 409);
    }

    let normalizedPackManifest;
    try {
        normalizedPackManifest = normalizePackManifest(body.packManifest, totalBytes, entryCount);
    } catch (err) {
        return error(err instanceof Error ? err.message : '上传数据包清单无效。', 409);
    }
    if (!normalizedPackManifest || normalizedPackManifest.packs.length !== packCount) {
        return error('上传数据包清单数量不一致。', 409);
    }
    const packManifest = normalizedPackManifest.packs;
    if (!await isValidPackSnapshotChecksum(checksum, totalBytes, packCount, entryCount, normalizedPackManifest.checksumSource)) {
        return error('上传快照清单校验失败。', 409);
    }
    if (!await bucket.head(MIGRATION_MARKER_KEY)) {
        return error('同步存储尚未初始化，请先完成无损初始化。', 409, { resetRequired: true });
    }

    const expectedPacks = new Map(packManifest.map(pack => [createPackKey(pack.checksum), pack]));
    let cursor;
    for (let pageIndex = 0; pageIndex < SYNC_COMMIT_MAX_LIST_PAGES; pageIndex += 1) {
        const page = await bucket.list({ prefix: `${PACK_PREFIX}/`, cursor, limit: SYNC_DELETE_BATCH_SIZE });
        for (const object of page.objects || []) {
            const pack = expectedPacks.get(object.key);
            if (pack && Number(object.size) === pack.length) expectedPacks.delete(object.key);
        }
        if (!expectedPacks.size) break;
        cursor = getNextSyncCursor(page, cursor);
        if (!cursor) {
            return error('服务器缺少上传数据包。', 409, {
                missingPacks: [...expectedPacks.values()].map(pack => pack.checksum)
            });
        }
    }
    if (expectedPacks.size) {
        // The scan budget ran out — almost always a pre-GC orphan backlog
        // crowding the lexicographic listing. GC here breaks the deadlock:
        // a failed commit used to never reach the post-commit GC, so the
        // backlog could only grow. Budget check: this response path has used
        // ~35 subrequests (head, manifest, 32 list pages); the GC adds at
        // most 10 more (head, 8 list pages, 1 batch delete) — under the 50
        // limit. Best effort; the client retries and the backlog shrinks
        // by up to 1000 per attempt until verification fits again.
        scheduleOrphanPackGc(bucket, ctx);
        return error('服务器数据包索引尚未检查完整，请完成分页整理后重试。', 503);
    }

    const manifestState = await getManifestState(bucket);
    const previous = manifestState.manifest;
    if (previous?.checksum === checksum) {
        return json({
            ok: true,
            version: previous.version,
            checksum: previous.checksum,
            updatedAt: previous.updatedAt,
            snapshotFormat: previous.snapshotFormat,
            schemaVersion: previous.schemaVersion
        });
    }
    if (baseVersion !== Number(previous?.version || 0) || String(body.baseChecksum || '') !== String(previous?.checksum || '')) {
        return error('服务器同步版本已变化，请重新检查后上传。', 409, {
            currentVersion: Number(previous?.version || 0)
        });
    }

    const committedManifest = {
        version: Number(previous?.version || 0) + 1,
        checksum,
        updatedAt: Date.now(),
        totalBytes,
        packCount,
        entryCount,
        packManifest,
        snapshotFormat,
        schemaVersion
    };

    const manifestBytes = textEncoder.encode(JSON.stringify(committedManifest));
    if (manifestBytes.byteLength > SYNC_CONTROL_MAX_BYTES) return error('上传快照清单超过大小上限。', 413);
    const committedObject = await bucket.put(MANIFEST_KEY, manifestBytes, {
        httpMetadata: { contentType: 'application/json; charset=utf-8' },
        onlyIf: manifestState.etag
            ? { etagMatches: manifestState.etag }
            : { etagDoesNotMatch: '*' }
    });
    if (!committedObject) {
        return error('服务器同步版本已变化，请重新检查后上传。', 409);
    }
    if (committedObject.etag) cacheManifestByEtag(committedObject.etag, committedManifest);
    // The committed manifest just passed validation above; priming the
    // checksum-keyed cache lets the next push's first read skip the
    // parse-and-derive work even after the 30s etag window has expired.
    rememberValidatedManifest(committedManifest);

    // Reclaim unreferenced packs in the background; a no-op when the
    // snapshot only replaced packs still referenced by the new manifest.
    // With waitUntil the GC runs after the response; without one (tests,
    // non-Workers callers) it completes before the response so cleanup
    // stays deterministic.
    const gc = scheduleOrphanPackGc(bucket, ctx);
    if (gc) await gc;

    return json({
        ok: true,
        version: committedManifest.version,
        checksum: committedManifest.checksum,
        updatedAt: committedManifest.updatedAt,
        snapshotFormat: committedManifest.snapshotFormat,
        schemaVersion: committedManifest.schemaVersion
    });
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

async function handleJsonApi(request, env, ctx) {
    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: { allow: 'POST, OPTIONS' } });
    }
    if (request.method !== 'POST') return error('Method not allowed.', 405);

    const body = await readSyncJsonBody(request);
    if (body.action === 'auth-status') return handleAuthStatus(request, env);
    if (!await isRequestAuthorized(request, env)) return error('Sync password required.', 401, { authRequired: true });

    const bucket = getBucket(env);
    if (body.action === 'prepare-upload') return handleStatus(bucket, body);
    if (body.action === 'reset-upload') return handleResetUpload(bucket, body);
    if (body.action === 'list-upload-packs') return handleListUploadPacks(bucket, body);
    if (body.action === 'pull-manifest') return handleStatus(bucket, body);
    if (body.action === 'pull-pack') return handlePullPack(bucket, body);
    if (body.action === 'upload-complete') return handleUploadComplete(bucket, body, ctx);
    return error('Unsupported action.', 404);
}

async function handleApi(request, env, url, ctx) {
    try {
        const action = url.searchParams.get('action');
        if (action === 'upload-pack-batch') {
            if (request.method !== 'POST') return error('Method not allowed.', 405);
            if (!await isRequestAuthorized(request, env)) return error('Sync password required.', 401, { authRequired: true });
            return await handleUploadPackBatch(request, getBucket(env));
        }
        return await handleJsonApi(request, env, ctx);
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Unexpected server error.';
        const status = err instanceof SyncRequestError
            ? err.status
            : /\b(?:10014|10037|10031)\b|BadDigest|(?:checksum|SHA-?256).*(?:mismatch|did not match|does not match)/i.test(message)
                ? 409
                : 503;
        return error(message, status);
    }
}

async function serveStatic(request, env) {
    if (!env?.ASSETS || typeof env.ASSETS.fetch !== 'function') return null;
    return env.ASSETS.fetch(request);
}

function serveSyncRestorePage() {
    return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RP Hub 云同步</title><link rel="stylesheet" href="/DB/styles.css"></head><body><script src="/DB/dirty-tracker.js"></script><script src="/DB/bootstrap.js"></script></body></html>`, {
        headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store'
        }
    });
}

// sourceChecks markers are verified against the live upstream before the
// adapter is applied; results are cached for the adapter object's lifetime
// (at most one 30s window per isolate). A failed check means the adapter no
// longer matches the author's page, so the whole magic set falls back to the
// unmodified author content — same all-or-nothing rule as replacement misses.
const sourceCheckCaches = new WeakMap();

function normalizeSourceCheckPath(value) {
    const path = String(value || '');
    return path === '/' ? '/index.html' : path;
}

async function sourceCheckResults(adapter, knownContent = null, fetchUnknownPaths = true) {
    const checks = adapter?.author?.sourceChecks;
    if (!Array.isArray(checks) || checks.length === 0) return true;
    try {
        let cache = sourceCheckCaches.get(adapter);
        if (!cache) {
            cache = new Map();
            sourceCheckCaches.set(adapter, cache);
        }
        let allPassed = true;
        for (const check of checks) {
            const path = normalizeSourceCheckPath(check.path);
            const markers = Array.isArray(check.contains) ? check.contains : [];
            if (knownContent && normalizeSourceCheckPath(knownContent.path) === path) {
                const passed = markers.every(marker => knownContent.text.includes(marker));
                cache.set(path, passed);
                if (!passed) allPassed = false;
                continue;
            }
            if (cache.has(path)) {
                if (!cache.get(path)) allPassed = false;
                continue;
            }
            if (!fetchUnknownPaths) {
                allPassed = false;
                continue;
            }
            const response = await fetch(new URL(check.path.replace(/^\/+/, ''), AUTHOR_BASE));
            let passed = false;
            if (response.ok) {
                const text = await response.text();
                passed = markers.every(marker => text.includes(marker));
            }
            cache.set(path, passed);
            if (!passed) allPassed = false;
        }
        return allPassed;
    } catch (_) {
        return false;
    }
}

async function tryLoadAdapter(env) {
    try {
        return await loadAdapter(env);
    } catch (_) {
        return null;
    }
}

function rewriteAuthorHtml(response, pathname, adapter = null, adapterReady = false) {
    const isMain = pathname === '/' || pathname === '/index.html';
    // 注入面保持最小：主页 4 节点（styles.css、dirty-tracker、magic-extension、bootstrap），
    // 其他作者 HTML 页只有 dirty-tracker。适配配置不再内联进页面——
    // magic-extension 自行拉取 /__rphub/adapter.json（该路径已是扩展测试
    // 的既有供给方式），页面响应因此少一个脚本节点与整份适配 JSON。
    if (!adapterReady) return response;
    const injection = (isMain ? '<link rel="stylesheet" href="/DB/styles.css">' : '')
        + '<script src="/DB/dirty-tracker.js"></script>'
        + (isMain ? '<script src="/magic-extension.js"></script><script src="/DB/bootstrap.js"></script>' : '');
    const headers = new Headers(response.headers);
    headers.set('content-type', 'text/html; charset=utf-8');
    headers.set('cache-control', 'no-store');
    headers.delete('content-length');
    headers.delete('content-encoding');
    headers.delete('etag');
    const htmlResponse = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
    });
    return new HTMLRewriter()
        .on('meta[name="rphub-update-api"]', { element(element) { element.remove(); } })
        .on('head', { element(element) { element.append(injection, { html: true }); } })
        .transform(htmlResponse);
}

async function serveAdapterConfig(request, env) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
    }
    try {
        const adapter = await loadAdapter(env);
        // The config endpoint is also a verification boundary: do not expose
        // an adapter that has not passed every source check.
        if (!await sourceCheckResults(adapter)) {
            throw new Error('适配清单与作者页面不匹配。');
        }
        const response = json(adapterPublicView(adapter));
        return request.method === 'HEAD'
            ? new Response(null, { status: response.status, headers: response.headers })
            : response;
    } catch (_) {
        const response = json({ ok: false }, 503);
        return request.method === 'HEAD'
            ? new Response(null, { status: response.status, headers: response.headers })
            : response;
    }
}

// Rewritten app.js is cached per adapter instance and upstream etag; the
// WeakMap drops entries automatically once a refreshed adapter manifest
// replaces the previous object.
const rewriteCaches = new WeakMap();

function rewrittenAppJsResponse(body) {
    return new Response(body, {
        status: 200,
        headers: {
            'content-type': 'application/javascript; charset=utf-8',
            'cache-control': 'no-store'
        }
    });
}

async function serveAuthor(request, env) {
    const requestUrl = new URL(request.url);
    if (requestUrl.pathname === '/assets/js/update-check.js') {
        return new Response('window.RPHubUpdateCheck={useUpdateCheck(){}};', {
            headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' }
        });
    }
    let upstreamPath = requestUrl.pathname;
    if (upstreamPath === '/') upstreamPath = '/index.html';
    if (upstreamPath === '/character') upstreamPath = '/character/index.html';
    if (upstreamPath === '/novel') upstreamPath = '/novel/index.html';

    const upstreamUrl = new URL(upstreamPath.replace(/^\/+/, ''), AUTHOR_BASE);
    upstreamUrl.search = requestUrl.search;
    const upstreamHeaders = new Headers(request.headers);
    upstreamHeaders.delete('host');
    upstreamHeaders.delete('cookie');
    upstreamHeaders.delete('authorization');
    upstreamHeaders.delete(SYNC_PASSWORD_HEADER);

    const isAppJs = requestUrl.pathname === '/assets/js/app.js';
    let adapter = null;
    let cachedRewrite = null;
    if (isAppJs) {
        adapter = await tryLoadAdapter(env);
        cachedRewrite = adapter ? rewriteCaches.get(adapter) || null : null;
    }
    if (isAppJs && cachedRewrite?.etag) {
        upstreamHeaders.set('if-none-match', cachedRewrite.etag);
        upstreamHeaders.delete('if-modified-since');
    } else if (isAppJs || !/\.[a-z0-9]+$/i.test(requestUrl.pathname) || requestUrl.pathname.endsWith('.html')) {
        upstreamHeaders.delete('if-none-match');
        upstreamHeaders.delete('if-modified-since');
    }
    const response = await fetch(upstreamUrl, {
        method: request.method,
        headers: upstreamHeaders,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
        redirect: 'follow'
    });
    const contentType = response.headers.get('content-type') || '';
    if (request.method === 'HEAD' || response.status === 204) return response;
    if (isAppJs && response.status === 304) {
        return cachedRewrite ? rewrittenAppJsResponse(cachedRewrite.body) : response;
    }
    if (!response.ok) return response;
    if (isAppJs) {
        const source = await response.text();
        let body = source;
        if (adapter && await sourceCheckResults(adapter, { path: requestUrl.pathname, text: source })) {
            try {
                body = rewriteAuthorScript(source, adapter);
                const etag = response.headers.get('etag');
                if (etag) rewriteCaches.set(adapter, { etag, body });
            } catch (_) {
                body = source;
            }
        }
        return rewrittenAppJsResponse(body);
    }
    if (response.status === 304) return response;
    const isHtml = contentType.toLowerCase().includes('text/html');
    if (isHtml) {
        const pageText = await response.text();
        const pageAdapter = await tryLoadAdapter(env);
        const adapterReady = Boolean(pageAdapter)
            && await sourceCheckResults(pageAdapter, { path: upstreamPath, text: pageText }, true);
        const pageResponse = new Response(pageText, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
        });
        return rewriteAuthorHtml(pageResponse, requestUrl.pathname, pageAdapter, adapterReady);
    }
    return response;
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        if (url.pathname === ADAPTER_PATH) {
            return serveAdapterConfig(request, env);
        }
        if (url.pathname === IMAGE_API_PATH) {
            try {
                return await handleImageRender(request, env);
            } catch (err) {
                return error(err instanceof Error ? err.message : 'Unexpected server error.', 500);
            }
        }
        if (url.pathname === IMAGE_ADMIN_PATH || url.pathname.startsWith(`${IMAGE_ADMIN_PATH}/`)) {
            try {
                return await handleImageAdmin(request, env, url, ctx);
            } catch (err) {
                return error(err instanceof Error ? err.message : 'Unexpected server error.', 500);
            }
        }
        if (url.pathname === API_PATH) {
            return handleApi(request, env, url, ctx);
        }
        if (url.pathname === '/sync-restore') {
            return serveSyncRestorePage();
        }
        // 部署目录里只有我们自己的静态文件；本地资源命中就直接返回，
        // 其余路径（包括作者以后新增的页面和资源）一律回源作者站点，
        // 不再维护硬编码的代理路径清单。
        const assetResponse = await serveStatic(request, env);
        if (assetResponse && assetResponse.status !== 404) return assetResponse;
        return serveAuthor(request, env);
    }
};

// Pages 单文件入口：正文直通，计算留给浏览器；无 KV。
const AUTHOR = 'https://sta1n156.github.io/RP-Hub/';
// 头部超时掐死连不上的源站；正文空闲超时只盯"停止吐字节"，慢线路长正文不断流。
const AUTHOR_HEADER_TIMEOUT = 8000, AUTHOR_BODY_IDLE_TIMEOUT = 30000;
const ROOT = 'rp-sync/v2/manifest.json';
const PACKS = 'rp-sync/v2/packs/';
const FORMAT = 'rp-sync-manifest-v2';
const IMAGE = 'rp-images/characters/';
const TOMBS = 'rp-images/_deleted/';
const THUMBS = 'rp-images/thumbs/';
const PARAMS = ['tag', 'model', 'artist', 'size', 'steps', 'scale', 'cfg', 'sampler', 'negative', 'nocache', 'noise_schedule'];
const encoder = new TextEncoder();
const stateByEnv = new WeakMap();
const failure = (message, status = 400, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const hash = async text => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', typeof text === 'string' ? encoder.encode(text) : text)), b => b.toString(16).padStart(2, '0')).join('');
const authorized = (request, env) => !env.RP_SYNC_PASSWORD || request.headers.get('x-rp-sync-password') === env.RP_SYNC_PASSWORD;
const background = (ctx, promise) => ctx.waitUntil(Promise.resolve(promise).catch(() => {}));
function state(env) {
    if (!stateByEnv.has(env)) stateByEnv.set(env, { config: null, adapter: null, models: new Map(), configSaved: null, adapterSaved: null });
    return stateByEnv.get(env);
}
async function read(message, limit, text = false) {
    const reader = message.body?.getReader();
    if (!reader) return text ? '' : new Uint8Array();
    const chunks = [];
    let size = 0;
    try {
        if (Number(message.headers?.get('content-length') ?? message.size) > limit) throw failure('正文超过大小上限。', 413);
        for (;;) {
            const item = await reader.read();
            if (item.done) break;
            size += item.value.byteLength;
            if (size > limit) throw failure('正文超过大小上限。', 413);
            chunks.push(item.value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const part of chunks) { bytes.set(part, offset); offset += part.byteLength; }
        return text ? new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '') : bytes;
    } catch (e) { void reader.cancel().catch(() => {}); throw e; }
    finally { reader.releaseLock(); }
}
async function readJson(message, limit = 1024 ** 2) {
    const text = await read(message, limit, true);
    try { return JSON.parse(text); } catch { throw failure('JSON 正文无效。'); }
}
async function pool(items, limit, fn) {
    let next = 0, error;
    const results = [];
    await Promise.all(Array.from({ length: Math.min(items.length, limit) }, async () => {
        while (next < items.length && !error) {
            const i = next++;
            try { results[i] = await fn(items[i]); } catch (e) { error ||= e; }
        }
    }));
    if (error) throw error;
    return results;
}
async function asset(env, path) {
    return env.ASSETS.fetch(new Request('https://assets.local' + path));
}
async function config(env, ctx) {
    const s = state(env);
    if (s.config?.until > Date.now()) return s.config.value;
    const loading = (async () => {
        let value;
        try {
            const response = await asset(env, '/config.json');
            if (!response.ok) throw failure('配置缺失。');
            value = await readJson(response, 65536);
        } catch {
            const saved = await env.RP_SYNC_R2?.get('rp-adapter/last-good-config-v2.json');
            value = saved ? await readJson(saved, 65536) : { adapter: { externalUrl: '' }, image: { ynai: null } };
        }
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('配置格式无效。', 503);
        const serialized = JSON.stringify(value);
        if (env.RP_SYNC_R2 && s.configSaved !== serialized) background(ctx, env.RP_SYNC_R2.put('rp-adapter/last-good-config-v2.json', serialized).then(() => { s.configSaved = serialized; }));
        return value;
    })();
    s.config = { value: loading, until: Date.now() + 30000 };
    try { return await loading; } catch (e) { s.config = null; throw e; }
}
async function adapter(env, ctx) {
    const cfg = await config(env, ctx);
    const url = String(env.RPHUB_ADAPTER_URL || cfg.adapter?.externalUrl || '').trim();
    const s = state(env);
    if (s.adapter?.url === url && s.adapter.until > Date.now()) return s.adapter.value;
    const loading = (async () => {
        const sources = [
            ...(url ? [['external', () => fetch(url, { signal: AbortSignal.timeout(10000) })]] : []),
            ['bundled', () => asset(env, '/adapter/rp-hub-v2.js')],
            ['last-good', () => env.RP_SYNC_R2?.get('rp-adapter/last-good-script-v2.js')]
        ];
        for (const [origin, get] of sources) {
            try {
                const response = await get();
                if (!response || response.ok === false) continue;
                const source = await read(response, 512 * 1024, true);
                if (!source.trim() || !source.includes('RPHubExternal')) continue;
                const value = { origin, source, sha256: await hash(source), bytes: encoder.encode(source).length };
                if (origin !== 'last-good' && env.RP_SYNC_R2 && s.adapterSaved !== source) background(ctx, env.RP_SYNC_R2.put('rp-adapter/last-good-script-v2.js', source).then(() => { s.adapterSaved = source; }));
                return value;
            } catch { /* 下一来源 */ }
        }
        return null;
    })();
    s.adapter = { url, value: loading, until: Date.now() + 30000 };
    const value = await loading;
    if (!value) s.adapter.until = Date.now() + 5000;
    return value;
}
function manifestSource(m) { return JSON.stringify([FORMAT, m.compression, m.totalBytes, m.entryCount, m.packs.map(p => [p.bucket, p.checksum, p.length, p.entries])]); }
function normalizeManifest(m) {
    if (!m || m.format !== FORMAT || m.compression !== 'gzip' || !Number.isSafeInteger(m.version) || m.version < 1 || !Number.isFinite(m.updatedAt) || m.updatedAt <= 0 || !Array.isArray(m.packs) || m.packs.length > 4096) throw failure('同步清单格式无效。', 409);
    let total = 0, entries = 0;
    const seen = new Set();
    const packs = m.packs.map(p => {
        if (typeof p.bucket !== 'string' || !p.bucket || p.bucket.length > 4000 || !/^[a-f0-9]{64}$/.test(p.checksum) || seen.has(p.checksum) || !Number.isSafeInteger(p.length) || p.length < 1 || p.length > 6 * 1024 ** 2 || !Number.isSafeInteger(p.entries) || p.entries < 0 || p.entries > 512) throw failure('同步分片清单无效。', 409);
        seen.add(p.checksum); total += p.length; entries += p.entries;
        return { bucket: p.bucket, checksum: p.checksum, length: p.length, entries: p.entries };
    });
    if (total !== m.totalBytes || entries !== m.entryCount || total > 1024 ** 3 || entries > 10000000 || !/^[a-f0-9]{64}$/.test(m.checksum)) throw failure('同步清单合计无效。', 409);
    return { format: FORMAT, compression: 'gzip', version: m.version, updatedAt: m.updatedAt, totalBytes: total, entryCount: entries, packs, checksum: m.checksum };
}
async function current(bucket) {
    const object = await bucket.get(ROOT);
    return object ? { root: normalizeManifest(await readJson(object)), etag: object.etag } : { root: null, etag: null };
}
async function list(bucket, prefix, cursor, limit = 1000) {
    const page = await bucket.list({ prefix, cursor: cursor || undefined, limit });
    if (page.truncated && (!page.cursor || page.cursor === cursor)) throw failure('存储列表无法继续，请重试。', 503);
    return page;
}
async function remove(bucket, keys) {
    for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000));
}
async function commit(bucket, incoming) {
    const root = normalizeManifest(incoming);
    if (await hash(manifestSource(root)) !== root.checksum) throw failure('同步清单校验失败。', 409);
    const previous = await current(bucket);
    if (previous.root?.checksum === root.checksum) return json({ ok: true, committed: true, manifest: previous.root, reclaimed: 0 });
    if (previous.root && root.version !== previous.root.version + 1 || !previous.root && root.version !== 1) throw failure('云端版本已变化，请重新上传。', 409, { currentVersion: previous.root?.version || 0 });
    // 已提交且元数据相同的不可变包不必重新 list；只核实本次新增包。
    const known = new Map((previous.root?.packs || []).map(p => [p.checksum, p]));
    const changed = root.packs.filter(p => { const old = known.get(p.checksum); return !old || old.length !== p.length || old.entries !== p.entries; });
    const stored = new Map();
    if (changed.length <= 6) {
        await pool(changed, 6, async p => { const head = await bucket.head(PACKS + p.checksum + '.bin'); if (head) stored.set(p.checksum, head); });
    } else {
        let cursor;
        do {
            const page = await list(bucket, PACKS, cursor);
            for (const object of page.objects) stored.set(object.key.slice(PACKS.length, -4), object);
            cursor = page.truncated ? page.cursor : null;
        } while (cursor);
    }
    const missing = changed.filter(p => stored.get(p.checksum)?.size !== p.length).map(p => p.checksum);
    if (missing.length) throw failure('云端缺少分片，请补传。', 409, { missing });
    const written = await bucket.put(ROOT, JSON.stringify(root), { onlyIf: previous.etag ? { etagMatches: previous.etag } : { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' } });
    if (!written) throw failure('云端版本已变化，请重新上传。', 409);
    const active = new Set(root.packs.map(p => p.checksum));
    const obsolete = (previous.root?.packs || []).filter(p => !active.has(p.checksum)).map(p => PACKS + p.checksum + '.bin');
    let reclaimed = 0;
    try { await remove(bucket, obsolete); } catch { reclaimed = obsolete.length; }
    return json({ ok: true, committed: true, manifest: root, reclaimed });
}
async function sync(request, env, ctx, url) {
    if (url.pathname === '/api/rp-sync') {
        if (request.method !== 'POST') throw failure('Method not allowed.', 405);
        const body = await readJson(request);
        if (body?.action === 'auth-status') return json({ ok: true, authRequired: Boolean(env.RP_SYNC_PASSWORD), authenticated: authorized(request, env) });
        if (!authorized(request, env)) throw failure('Sync password required.', 401);
        const bucket = env.RP_SYNC_R2;
        if (body?.action === 'status') return json({ ok: true, manifest: (await current(bucket)).root });
        if (body?.action === 'commit') return commit(bucket, body.manifest);
        if (body?.action === 'sweep') {
            const { root } = await current(bucket);
            if (!root) return json({ ok: true, deleted: 0 });
            const referenced = new Set(root.packs.map(p => PACKS + p.checksum + '.bin'));
            const page = await list(bucket, PACKS, body.cursor);
            const keys = page.objects.filter(p => !referenced.has(p.key) && new Date(p.uploaded).getTime() < Date.now() - 3600000).map(p => p.key);
            await remove(bucket, keys);
            return json({ ok: true, deleted: keys.length, cursor: page.truncated ? page.cursor : null });
        }
        throw failure('Unsupported action.', 404);
    }
    if (url.pathname !== '/api/rp-sync/pack') throw failure('Not found.', 404);
    if (!authorized(request, env)) throw failure('Sync password required.', 401);
    const bucket = env.RP_SYNC_R2;
    const checksum = url.searchParams.get(request.method === 'GET' ? 'c' : 'checksum');
    if (!/^[a-f0-9]{64}$/.test(checksum)) throw failure('分片校验码无效。');
    const key = PACKS + checksum + '.bin';
    if (request.method === 'PUT') {
        const length = Number(url.searchParams.get('length')), entries = Number(url.searchParams.get('entries'));
        if (!Number.isSafeInteger(length) || length < 1 || length > 6 * 1024 ** 2 || !Number.isSafeInteger(entries) || entries < 0 || entries > 512) throw failure('分片元数据无效。', 413);
        if (!request.body) throw failure('分片正文为空。');
        if (request.headers.has('content-length') && Number(request.headers.get('content-length')) !== length) throw failure('分片长度不一致。', 409);
        const digest = Uint8Array.from(checksum.match(/../g), hex => parseInt(hex, 16));
        const fixed = new FixedLengthStream(length);
        const piping = request.body.pipeTo(fixed.writable);
        piping.catch(() => {});
        const result = await bucket.put(key, fixed.readable, { sha256: digest.buffer, onlyIf: { etagDoesNotMatch: '*' }, customMetadata: { entries: String(entries) }, httpMetadata: { contentType: 'application/gzip' } });
        if (!result) {
            void fixed.readable.cancel().catch(() => {});
            const old = await bucket.head(key);
            if (!old || old.size !== length || Number(old.customMetadata?.entries) !== entries) throw failure('分片元数据冲突。', 409);
        } else await piping;
        return new Response(null, { status: 204 });
    }
    if (request.method !== 'GET') throw failure('Method not allowed.', 405);
    const cacheKey = new Request(url.origin + '/__cache/pack/' + checksum);
    const cache = globalThis.caches?.default;
    const cached = await cache?.match(cacheKey);
    if (cached) { const headers = new Headers(cached.headers); headers.set('cache-control', 'private, max-age=31536000, immutable'); return new Response(cached.body, { headers }); }
    const object = await bucket.get(key);
    if (!object) throw failure('分片不存在。', 404);
    const response = new Response(object.body, { headers: { 'content-type': 'application/gzip', 'content-length': String(object.size), 'cache-control': 'private, max-age=31536000, immutable' } });
    if (cache) { const copy = response.clone(); const headers = new Headers(copy.headers); headers.set('cache-control', 'public, max-age=31536000, immutable'); background(ctx, cache.put(cacheKey, new Response(copy.body, { headers }))); }
    return response;
}
const safeName = name => String(name || '').normalize('NFKC').trim().replace(/[\\/:*?"<>|#%&{}$!`'@+=\s]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 96) || '未命名角色';
function imageParts(key) {
    if (typeof key !== 'string' || !key.startsWith(IMAGE)) throw failure('图片路径无效。');
    const parts = key.slice(IMAGE.length).split('/');
    if (parts.length !== 2 || safeName(parts[0]) !== parts[0] || !/^[a-f0-9]{64}$/.test(parts[1])) throw failure('图片路径无效。');
    return { name: parts[0], checksum: parts[1], tomb: TOMBS + parts.join('/') + '.json', thumb: THUMBS + parts.join('/') + '.webp' };
}
function placeholder() { return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="832" height="1216"><rect width="100%" height="100%" fill="#f1f5f9"/><text x="50%" y="50%" text-anchor="middle" fill="#64748b" font-size="36">图片已清理</text></svg>', { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' } }); }
async function imageRead(request, bucket, key, thumb = false) {
    const parts = imageParts(key);
    if (await bucket.head(parts.tomb)) return thumb ? new Response(null, { status: 404 }) : placeholder();
    const objectKey = thumb ? parts.thumb : key;
    const object = request.method === 'HEAD' ? await bucket.head(objectKey) : await bucket.get(objectKey, { onlyIf: request.headers });
    if (!object) return new Response(null, { status: 404 });
    const headers = { etag: object.httpEtag || '"' + object.etag + '"', 'content-type': object.httpMetadata?.contentType || (thumb ? 'image/webp' : 'image/png'), 'cache-control': 'private, max-age=3600', 'content-length': String(object.size) };
    if (request.method !== 'HEAD' && !('body' in object)) { delete headers['content-length']; return new Response(null, { status: 304, headers }); }
    return new Response(request.method === 'HEAD' ? null : object.body, { headers });
}
async function thumb(request, bucket, key) {
    const parts = imageParts(key);
    if (request.method === 'GET' || request.method === 'HEAD') return imageRead(request, bucket, key, true);
    if (request.method !== 'PUT') throw failure('Method not allowed.', 405);
    if (await bucket.head(parts.tomb) || !await bucket.head(key)) throw failure('原图不存在。', 404);
    if (!request.headers.get('content-type')?.startsWith('image/webp')) throw failure('缩略图必须为 WebP。');
    const bytes = await read(request, 2 * 1024 ** 2);
    if (!bytes.length) throw failure('缩略图为空。');
    await bucket.put(parts.thumb, bytes, { httpMetadata: { contentType: 'image/webp' } });
    return json({ ok: true });
}
async function images(request, env, ctx, url) {
    const bucket = env.RP_SYNC_R2;
    if (url.pathname === '/image/api/auth-status') return json({ ok: true, authRequired: Boolean(env.RP_SYNC_PASSWORD), authenticated: authorized(request, env) });
    if (url.pathname.startsWith('/image/api/')) {
        if (!authorized(request, env)) throw failure('Sync password required.', 401);
        if (url.pathname === '/image/api/image') return imageRead(request, bucket, url.searchParams.get('key'));
        if (url.pathname === '/image/api/thumb') return thumb(request, bucket, url.searchParams.get('key'));
        if (url.pathname === '/image/api/library') {
            const prefix = url.searchParams.get('character') ? IMAGE + safeName(url.searchParams.get('character')) + '/' : IMAGE;
            const page = await list(bucket, prefix, url.searchParams.get('cursor'), 200);
            const names = (await pool(page.objects, 6, async p => {
                const parts = imageParts(p.key);
                if (await bucket.head(parts.tomb)) return null;
                return { key: p.key, size: p.size, uploaded: new Date(p.uploaded).toISOString(), characterName: parts.name };
            })).filter(Boolean);
            return json({ ok: true, images: names, cursor: page.truncated ? page.cursor : null });
        }
        if (url.pathname === '/image/api/delete') {
            if (request.method !== 'POST') throw failure('Method not allowed.', 405);
            const body = await readJson(request, 16384);
            let objects;
            let continuation = null;
            if (body.characterNames?.length) {
                if (body.characterNames.length !== 1) throw failure('每次清空一个角色。');
                const page = await list(bucket, IMAGE + safeName(body.characterNames[0]) + '/', body.cursor, 20);
                objects = page.objects;
                if (page.truncated) continuation = { characterNames: body.characterNames, cursor: page.cursor };
            } else {
                if (!Array.isArray(body.keys) || body.keys.length > 20) throw failure('每批最多删除 20 张图片。');
                objects = (await pool([...new Set(body.keys)], 6, async key => { imageParts(key); return bucket.head(key); })).filter(Boolean);
            }
            const acceptedKeys = [], remainingKeys = [], pendingCleanup = [];
            await pool(objects, 6, async object => {
                const parts = imageParts(object.key);
                try {
                    await bucket.put(parts.tomb, '1');
                    acceptedKeys.push(object.key);
                } catch { remainingKeys.push(object.key); return; }
                try { await bucket.delete([object.key, parts.thumb]); }
                catch { pendingCleanup.push(object.key); }
            });
            return json({ ok: true, acceptedKeys, remainingKeys, pendingCleanup, failedCount: remainingKeys.length, deletedCount: acceptedKeys.length, continuation });
        }
        throw failure('Not found.', 404);
    }
    if (url.searchParams.has('key')) {
        if (!['GET', 'HEAD'].includes(request.method)) throw failure('Method not allowed.', 405);
        return imageRead(request, bucket, url.searchParams.get('key'));
    }
    if (!['GET', 'HEAD', 'POST'].includes(request.method)) throw failure('Method not allowed.', 405);
    const token = String(url.searchParams.get('token') || '').trim();
    const ynai = token.toUpperCase().startsWith('YNAI-');
    const cfg = ynai ? (await config(env, ctx)).image?.ynai : null;
    const params = Object.fromEntries(PARAMS.map(key => [key, String(url.searchParams.get(key) || '').trim()]));
    Object.assign(params, { model: params.model || (ynai && cfg?.defaultModel) || 'nai-diffusion-4-5-full', size: params.size || '竖图', steps: params.steps || (ynai ? '28' : '40'), scale: params.scale || '6', cfg: params.cfg || '0', sampler: params.sampler || 'k_dpmpp_2m_sde', nocache: params.nocache || '0', noise_schedule: params.noise_schedule || 'karras' });
    const signature = { provider: 'sta1n', ...params };
    const nonce = url.searchParams.get('reroll_nonce');
    if (nonce) signature.reroll_nonce = nonce;
    const checksum = await hash(JSON.stringify(signature));
    const name = safeName(url.searchParams.get('character_name'));
    const key = IMAGE + name + '/' + checksum;
    const existing = await imageRead(request, bucket, key);
    const identity = encodeURIComponent(key);
    if (existing.status !== 404 || request.method !== 'POST') { existing.headers.set('x-rp-image-key', identity); return existing; }
    if (!token || !params.tag) throw failure('缺少生图密钥或提示词。', 401);
    let upstream, bytes, type;
    const signal = AbortSignal.timeout(300000);
    if (ynai) {
        if (!cfg?.base?.startsWith('https://') || !cfg.generatePath?.startsWith('/')) throw failure('YNAI 配置缺失。', 503);
        const size = { '竖图': '832x1216', '横图': '1216x832', '方图': '1024x1024' }[params.size] || params.size;
        upstream = await fetch(cfg.base.replace(/\/+$/, '') + cfg.generatePath, { method: 'POST', signal, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ model: params.model, prompt: [params.tag, params.artist].filter(Boolean).join(', '), size, n: 1, response_format: 'b64_json', parameters: { negative_prompt: params.negative, steps: Number(params.steps), scale: Number(params.scale), cfg_scale: Number(params.cfg), sampler: params.sampler, noise_schedule: params.noise_schedule } }) });
        if (!upstream.ok) throw failure('生图服务 HTTP ' + upstream.status, upstream.status);
        const payload = await readJson(upstream, 23 * 1024 ** 2);
        const base64 = payload?.data?.[0]?.b64_json;
        if (typeof base64 !== 'string' || base64.length > Math.ceil(16 * 1024 ** 2 / 3) * 4) throw failure('生图响应过大或无效。', 413);
        bytes = typeof Uint8Array.fromBase64 === 'function' ? Uint8Array.fromBase64(base64) : Uint8Array.from(atob(base64), c => c.charCodeAt(0));
        type = 'image/png';
    } else {
        const source = new URL('https://nai.sta1n.cn/generate');
        for (const [k, v] of Object.entries(params)) source.searchParams.set(k, v);
        source.searchParams.set('token', token);
        upstream = await fetch(source, { signal });
        if (!upstream.ok) throw failure('生图服务 HTTP ' + upstream.status, upstream.status);
        type = upstream.headers.get('content-type') || 'image/png';
        if (!type.startsWith('image/')) throw failure('生图服务未返回图片。', 502);
        bytes = await read(upstream, 24 * 1024 ** 2);
    }
    if (!bytes.length) throw failure('生图服务返回空图片。', 502);
    await bucket.put(key, bytes, { httpMetadata: { contentType: type } });
    return new Response(bytes, { headers: { 'content-type': type, 'content-length': String(bytes.length), 'x-rp-image-key': identity, 'cache-control': 'private, max-age=3600' } });
}
async function models(request, env, ctx) {
    const token = request.headers.get('x-rp-image-token') || '';
    if (!token.toUpperCase().startsWith('YNAI-')) throw failure('第三方生图密钥无效。', 401);
    const s = state(env), cached = s.models.get(token);
    if (cached?.until > Date.now()) return json({ ok: true, data: cached.data });
    const cfg = (await config(env, ctx)).image?.ynai;
    if (!cfg?.base?.startsWith('https://') || !cfg.modelsPath?.startsWith('/')) throw failure('YNAI 配置缺失。', 503);
    const response = await fetch(cfg.base.replace(/\/+$/, '') + cfg.modelsPath, { signal: AbortSignal.timeout(15000), headers: { authorization: 'Bearer ' + token } });
    if (!response.ok) throw failure('模型列表 HTTP ' + response.status, response.status);
    const data = (await readJson(response, 256 * 1024)).data;
    if (!Array.isArray(data)) throw failure('模型列表格式无效。', 502);
    for (const [key, value] of s.models) if (value.until <= Date.now()) s.models.delete(key);
    if (s.models.size >= 8) s.models.delete(s.models.keys().next().value);
    s.models.set(token, { until: Date.now() + 30000, data });
    return json({ ok: true, data });
}
function bodyIdleGuard(body, timeoutMs) {
    const reader = body.getReader();
    let timer;
    const clear = () => { if (timer !== undefined) { clearTimeout(timer); timer = undefined; } };
    return new ReadableStream({
        async pull(controller) {
            clear();
            timer = setTimeout(() => { timer = undefined; void reader.cancel().catch(() => {}); controller.error(new Error('上游正文空闲超时。')); }, timeoutMs);
            try {
                const { done, value } = await reader.read();
                clear();
                if (done) controller.close(); else controller.enqueue(value);
            } catch (e) { clear(); controller.error(e); }
        },
        cancel(reason) { clear(); return reader.cancel(reason); }
    });
}
async function proxy(request, env, ctx, url) {
    if (!['GET', 'HEAD'].includes(request.method)) throw failure('Method not allowed.', 405);
    const path = url.pathname === '/' ? 'index.html' : ['character', 'novel'].includes(url.pathname.slice(1)) ? url.pathname.slice(1) + '/index.html' : url.pathname.slice(1);
    const target = new URL(path, AUTHOR);
    target.search = url.search;
    // 作者的 ?v=Date.now() 不参与边缘缓存键，避免每次刷新穿透。
    const cacheUrl = new URL(url.origin + '/__cache/author/' + path);
    const query = new URLSearchParams(url.search);
    query.delete('v'); cacheUrl.search = query.toString();
    const cache = globalThis.caches?.default;
    const cacheKey = new Request(cacheUrl);
    const home = path === 'index.html';
    const adapterPromise = home && request.method === 'GET' ? adapter(env, ctx).catch(() => null) : Promise.resolve(null);
    const headers = new Headers(request.headers);
    for (const key of ['host', 'cookie', 'authorization', 'x-rp-sync-password']) headers.delete(key);
    let response = request.method === 'GET' ? await cache?.match(cacheKey) : null;
    if (!response) {
        response = await fetch(target, { method: request.method, headers, signal: AbortSignal.timeout(AUTHOR_HEADER_TIMEOUT), redirect: 'follow' });
        if (response.body) response = new Response(bodyIdleGuard(response.body, AUTHOR_BODY_IDLE_TIMEOUT), { status: response.status, statusText: response.statusText, headers: response.headers });
        if (request.method === 'GET' && response.status === 200 && cache) {
            const copy = response.clone();
            const h = new Headers(copy.headers); h.set('cache-control', 'public, max-age=45');
            background(ctx, cache.put(cacheKey, new Response(copy.body, { headers: h })));
        }
    }
    const h = new Headers(response.headers);
    h.set('cache-control', 'no-cache');
    if (request.method === 'HEAD' || [204, 205, 304].includes(response.status)) return new Response(null, { status: response.status, headers: h });
    if (!response.ok || !h.get('content-type')?.includes('text/html')) return new Response(response.body, { status: response.status, headers: h });
    if (!home) return new Response(response.body, { status: response.status, headers: h });
    const selected = await adapterPromise;
    const injection = '<script src="/core.js"></script><script src="/client.js"></script>' + (selected ? '<script>' + selected.source.replace(/<\/script/gi, '<\\/script') + '</script><script defer src="/images.js"></script><script defer src="/sync.js"></script>' : '');
    for (const key of ['content-length', 'content-encoding', 'etag', 'last-modified']) h.delete(key);
    h.set('cache-control', 'no-store');
    return new HTMLRewriter().on('head', { element(el) { el.prepend(injection, { html: true }); } }).transform(new Response(response.body, { status: response.status, headers: h }));
}
export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        try {
            if (url.pathname === '/__rphub/adapter.json') { const a = await adapter(env, ctx); return json(a ? { ok: true, origin: a.origin, sha256: a.sha256, bytes: a.bytes } : { ok: false }, a ? 200 : 503); }
            if (url.pathname.startsWith('/api/rp-sync')) return await sync(request, env, ctx, url);
            if (url.pathname === '/api/rp-image-models') return await models(request, env, ctx);
            if (url.pathname === '/api/rp-image' || url.pathname.startsWith('/image/api/')) return await images(request, env, ctx, url);
            if (url.pathname === '/sync-restore') return new Response('<!doctype html><html lang="zh-CN" data-rp-sync-restore><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>恢复数据</title><script src="/core.js"></script><script src="/client.js"></script><script defer src="/sync.js"></script></head><body></body></html>', { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
            if (url.pathname === '/image' || url.pathname === '/image/') return await asset(env, '/gallery.html');
            if (['/core.js', '/client.js', '/sync.js', '/images.js', '/gallery.js', '/gallery.html', '/config.json', '/adapter/rp-hub-v2.js'].includes(url.pathname)) return await asset(env, url.pathname);
            return await proxy(request, env, ctx, url);
        } catch (e) {
            const status = e.status || (/checksum|SHA-?256|length.*(?:match|expected)/i.test(e.message) ? 409 : 500);
            return json({ ok: false, error: e.message || '服务暂不可用。', ...(status === 401 ? { authRequired: true } : {}), ...(e.missing ? { missing: e.missing } : {}), ...(e.currentVersion !== undefined ? { currentVersion: e.currentVersion } : {}) }, status);
        }
    }
};

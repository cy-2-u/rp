import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = relative => fs.readFile(path.join(root, relative), 'utf8');
const defaultAdapterUrl = pathToFileURL(path.join(root, 'adapter', 'rp-hub.js')).href;
const configuredAdapterUrl = process.env.RPHUB_ADAPTER_URL?.trim() || defaultAdapterUrl;
const upstreamRoot = process.env.RPHUB_UPSTREAM_DIR?.trim()
    || [path.join(path.dirname(root), 'RP-Hub-main')].find(candidate => existsSync(candidate));
const upstreamFile = relative => upstreamRoot ? path.join(upstreamRoot, relative)
    : path.join(root, '.sync-tests/fixtures/author', path.basename(relative));

const adapterMetadata = text => JSON.parse(text.match(/^\/\* RPHUB_ADAPTER_CONFIG\s*([\s\S]*?)\*\//)[1]);

function localAdapterPath() {
    const url = new URL(configuredAdapterUrl);
    if (url.protocol !== 'file:') throw new Error('runtime-smoke requires a file:// adapter URL');
    return fileURLToPath(url);
}

// Node 没有 Workers 的 HTMLRewriter；这里只实现 _worker.js 用到的
// head 追加与 meta 删除两条规则，足够验证注入结果。
class FakeHTMLRewriter {
    constructor() {
        this.handlers = [];
    }

    on(selector, handlers) {
        this.handlers.push({ selector, handlers });
        return this;
    }

    async transform(response) {
        const text = await response.text();
        let output = text;
        for (const { selector, handlers } of this.handlers) {
            if (selector === 'meta[name="rphub-update-api"]' && handlers.element) {
                output = output.replace(/<meta[^>]*rphub-update-api[^>]*>\s*/gi, '');
            }
            if (selector === 'head' && handlers.element) {
                handlers.element({
                    append(content) {
                        output = output.replace(/<\/head>/i, `${content}</head>`);
                    }
                });
            }
        }
        return new Response(output, { status: response.status, headers: response.headers });
    }
}

async function loadWorker(fetchImpl = globalThis.fetch) {
    const source = await read('_worker.js');
    const transformed = source.replace('export default {', 'return {');
    return new Function('fetch', 'HTMLRewriter', transformed)(fetchImpl, FakeHTMLRewriter);
}

async function testAdapterFromFileUrl() {
    const source = await read('_worker.js');
    const api = new Function(source.replace('export default {', 'const unusedWorker = {')
        + '; return { validateAdapter, parseAdapterSource, resolveAdapterUrl };')();
    assert.equal(api.resolveAdapterUrl({}).href, 'https://raw.githubusercontent.com/cy-2-u/rp/main/adapter/rp-hub.js');
    assert.equal(api.resolveAdapterUrl({ RPHUB_ADAPTER_URL: configuredAdapterUrl }).protocol, 'file:');
    const script = await fs.readFile(localAdapterPath(), 'utf8');
    const adapter = api.parseAdapterSource(script);
    assert.equal(adapter.schema, 2);
    assert.doesNotThrow(() => new Function(script));
    assert.throws(() => api.validateAdapter({ ...adapter, ui: { chat: { input: 1 } } }));
    assert.doesNotMatch(source, /rewriteAuthorScript|bindAuthorAppLoader|sourceCheckResults/);
}

async function readFromUpstream(relative) {
    return fs.readFile(upstreamFile(relative), 'utf8');
}

async function loadUploadEngine() {
    // 引擎已并进 DB/bootstrap.js 头部；注入一个无关路径让同步面板 IIFE
    // 自行提前返回，只留引擎本体在上下文里运行。
    const source = await read('DB/bootstrap.js');
    const context = {
        console, setTimeout, clearTimeout, Promise, Set, TypeError, Error,
        location: { pathname: '/engine-scope-only' }
    };
    context.globalThis = context;
    context.window = context;
    vm.runInNewContext(source, context, { filename: 'bootstrap.js' });
    return context.RPH_SYNC_UPLOAD_ENGINE;
}

async function testBoundedUploadEngine() {
    const engine = await loadUploadEngine();
    const total = 1000;
    let produced = 0;
    let liveBytes = 0;
    let maxLiveBytes = 0;
    let sendCount = 0;
    let maxBatchItems = 0;
    let maxBatchBytes = 0;
    let firstSendProduced = null;
    async function* source() {
        for (let index = 0; index < total; index += 1) {
            produced += 1;
            yield { checksum: String(index).padStart(64, '0'), length: 4096 };
        }
    }
    const result = await engine.runBoundedUpload({
        items: source(),
        concurrency: 1,
        maxItems: 8,
        maxBytes: 4 * 1024 * 1024,
        read: async item => {
            liveBytes += item.length;
            maxLiveBytes = Math.max(maxLiveBytes, liveBytes);
            return { bytes: new Uint8Array(item.length) };
        },
        send: async records => {
            sendCount += 1;
            if (firstSendProduced === null) firstSendProduced = produced;
            maxBatchItems = Math.max(maxBatchItems, records.length);
            maxBatchBytes = Math.max(maxBatchBytes, records.reduce((sum, item) => sum + item.bytes.byteLength, 0));
            liveBytes = 0;
        }
    });
    assert.equal(result.items, total);
    assert.equal(sendCount, 125);
    assert.ok(maxBatchItems <= 8);
    assert.ok(maxBatchBytes <= 4 * 1024 * 1024);
    assert.ok(maxLiveBytes <= 8 * 4096);
    assert.equal(firstSendProduced, 8, 'the producer must not be drained before the first upload');
    assert.equal(produced, total);
}

async function testUploadEngineCleanup() {
    const engine = await loadUploadEngine();
    let closed = false;
    async function* source() {
        try {
            yield { checksum: 'c'.repeat(64), length: 1 };
            yield { checksum: 'd'.repeat(64), length: 1 };
        } finally {
            closed = true;
        }
    }
    await assert.rejects(() => engine.runBoundedUpload({
        items: source(),
        concurrency: Infinity,
        maxItems: Infinity,
        maxBytes: Infinity,
        read: async item => item.checksum.startsWith('d')
            ? (() => { throw new Error('synthetic read failure'); })()
            : { bytes: new Uint8Array(item.length) },
        send: async () => { }
    }), /synthetic read failure/);
    assert.equal(closed, true, 'failed uploads must close the source iterator');
}

async function testAuthorScriptPassthrough() {
    const author = await readFromUpstream('assets/js/app.js');
    const calls = [];
    const worker = await loadWorker(async (input, init) => {
        calls.push({ input: String(input), init });
        assert.equal(new Headers(init.headers).has('if-none-match'), false);
        return new Response(init.method === 'HEAD' ? null : author, { headers: { 'content-type': 'application/javascript' } });
    });
    for (const method of ['GET', 'HEAD', 'GET']) {
        const response = await worker.fetch(new Request('https://local.test/assets/js/app.js?v=123', {
            method, headers: { 'if-none-match': 'stale' }
        }), {}, {});
        assert.equal(await response.text(), method === 'HEAD' ? '' : author);
        assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    assert.equal(calls.length, 3);
    assert.ok(calls.every(call => call.input.endsWith('app.js?v=123')));
}

async function testBootstrapUsesBoundedEngine() {
    const bootstrap = await read('DB/bootstrap.js');
    assert.match(bootstrap, /window\.RPH_SYNC_UPLOAD_ENGINE/);
    assert.match(bootstrap, /async function resumePagedUpload/);
    assert.match(bootstrap, /action: 'upload-pack'/);
    assert.match(bootstrap, /uploadBatchMaxPacks: 1/);
    assert.doesNotMatch(bootstrap, /upload-pack-batch|upload-complete|reset-upload/);
}

async function testFixedImageSettingUsesAdapterClasses() {
    const source = await read('adapter/rp-hub.js');
    const feature = await read('magic-extension.js');
    assert.match(source, /cfg\.rowClass/);
    assert.match(source, /renderedSelect !== select/);
    assert.doesNotMatch(feature, /app-navigation|settings-toggle-row|chat-input-scrollbar/);
    const adapter = adapterMetadata(source);
    assert.equal(adapter.ui.settings.rowClass, 'settings-toggle-row group');
}

async function testAdapterConfigEndpoint() {
    const fetchMock = async input => {
        const url = new URL(String(input));
        if (url.protocol === 'file:') {
            const body = await fs.readFile(fileURLToPath(url));
            return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
        }
        const relative = url.pathname.replace(/^\/RP-Hub\//, '');
        try {
            const body = await fs.readFile(upstreamFile(relative));
            return new Response(body, { status: 200 });
        } catch (_) {
            return new Response('missing', { status: 404 });
        }
    };
    const worker = await loadWorker(fetchMock);
    const adapter = adapterMetadata(await fs.readFile(localAdapterPath(), 'utf8'));
    const env = { RPHUB_ADAPTER_URL: configuredAdapterUrl };
    const ok = await worker.fetch(new Request('https://local.test/__rphub/adapter.json'), env, {});
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), adapter);
    const head = await worker.fetch(new Request('https://local.test/__rphub/adapter.json', { method: 'HEAD' }), env, {});
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');

    const failingWorker = await loadWorker(async input => {
        const url = new URL(String(input));
        if (url.protocol === 'file:') return new Response('not found', { status: 404 });
        return fetchMock(input);
    });
    const failed = await failingWorker.fetch(new Request('https://local.test/__rphub/adapter.json'), env, {});
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), { ok: false });
}

function makeR2BucketMock(objects, hooks = {}) {
    return {
        head: async key => objects.has(key)
            ? { key, size: objects.get(key).size, etag: objects.get(key).etag }
            : null,
        get: async key => {
            if (!objects.has(key)) return null;
            const object = objects.get(key);
            return { key, size: object.size, body: object.bytes, text: async () => Buffer.from(object.bytes).toString('utf8'), httpMetadata: object.httpMetadata || {} };
        },
        put: async (key, value, options = {}) => {
            const bytes = value instanceof Uint8Array
                ? value
                : value instanceof ArrayBuffer
                    ? new Uint8Array(value)
                    : new Uint8Array(await new Response(value).arrayBuffer());
            objects.set(key, {
                key,
                bytes,
                size: bytes.byteLength,
                etag: `"${key}-${objects.size}"`,
                httpMetadata: options.httpMetadata,
                uploaded: hooks.uploadedAt ? new Date(hooks.uploadedAt) : new Date()
            });
            return { key };
        },
        delete: async keys => {
            if (hooks.throwOnDelete) throw hooks.throwOnDelete;
            for (const key of keys) objects.delete(key);
        },
        list: async ({ prefix, cursor, limit = 1000 } = {}) => {
            // throwOnList: number of list calls that succeed before the
            // simulated degradation kicks in (the commit verification loop
            // always performs the first list call).
            if (typeof hooks.throwOnList === 'number') {
                hooks.listCalls = (hooks.listCalls || 0) + 1;
                if (hooks.listCalls > hooks.throwOnList) throw new Error('list degraded');
            }
            const keys = [...objects.keys()].sort().filter(key => key.startsWith(prefix));
            const nextIndex = cursor ? keys.findIndex(key => key > cursor) : 0;
            const start = nextIndex < 0 ? keys.length : nextIndex;
            const page = keys.slice(start, start + limit);
            const truncated = start + limit < keys.length;
            return {
                objects: page.map(key => {
                    const object = objects.get(key);
                    return { key, size: object.size, uploaded: object.uploaded };
                }),
                truncated,
                cursor: truncated ? page[page.length - 1] : undefined
            };
        }
    };
}

async function testImageAdminApi() {
    const checksumOf = index => String(index).padStart(64, '0');
    const objects = new Map();
    const bucket = makeR2BucketMock(objects);
    const imageKey = (name, index) => `rp-images/characters/${name}/${checksumOf(index)}`;
    for (let index = 0; index < 24; index += 1) {
        await bucket.put(imageKey('Alice', index), new Uint8Array([index + 1]));
    }
    await bucket.put(imageKey('Bob', 90), new Uint8Array([1]));
    await bucket.put(imageKey('Bob', 91), new Uint8Array([2]));
    await bucket.put(imageKey('Alice', 99), new Uint8Array([9]));
    await bucket.put(`rp-images/_deleted/Alice/${checksumOf(99)}.json`, '1');

    const waitUntilPromises = [];
    const ctx = { waitUntil: promise => { waitUntilPromises.push(promise); } };
    const env = { RP_SYNC_R2: bucket, RP_SYNC_PASSWORD: 'pw' };
    const worker = await loadWorker();
    const authHeaders = { 'x-rp-sync-password': 'pw' };

    const anonymousAuth = await (await worker.fetch(new Request('https://local.test/image/api/auth-status'), env, ctx)).json();
    assert.equal(anonymousAuth.authRequired, true);
    assert.equal(anonymousAuth.authenticated, false);

    const deniedLibrary = await worker.fetch(new Request('https://local.test/image/api/library'), env, ctx);
    assert.equal(deniedLibrary.status, 401);

    const authed = await worker.fetch(new Request('https://local.test/image/api/auth-status', {
        headers: authHeaders
    }), env, ctx);
    const authedBody = await authed.json();
    assert.equal(authedBody.authenticated, true);
    const setCookie = authed.headers.get('set-cookie') || '';
    assert.match(setCookie, /rp_image_admin_auth=/, 'login must set the session cookie');
    const sessionToken = setCookie.split(';')[0].split('=').slice(1).join('=');

    const library = await (await worker.fetch(new Request('https://local.test/image/api/library', {
        headers: authHeaders
    }), env, ctx)).json();
    assert.equal(library.totalCount, 26, 'tombstoned images must not be listed');
    const alice = library.characters.find(character => character.name === 'Alice');
    assert.equal(alice.count, 24);

    await Promise.all(waitUntilPromises.splice(0));
    assert.equal(objects.has(imageKey('Alice', 99)), false, 'stale objects must be cleaned up in the background');

    const cookieLibrary = await worker.fetch(new Request('https://local.test/image/api/library', {
        headers: { cookie: `rp_image_admin_auth=${sessionToken}` }
    }), env, ctx);
    assert.equal(cookieLibrary.status, 200, 'the session cookie must authorize the gallery');

    const tooMany = await worker.fetch(new Request('https://local.test/image/api/delete', {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ keys: Array.from({ length: 21 }, (_, index) => imageKey('Alice', index)) })
    }), env, ctx);
    assert.equal(tooMany.status, 400, 'oversized delete requests must be rejected up front');

    const first = await (await worker.fetch(new Request('https://local.test/image/api/delete', {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ characterNames: ['Alice'] })
    }), env, ctx)).json();
    assert.equal(first.deletedCount, 20, 'a single request must process at most 20 targets');
    assert.deepEqual(first.remainingKeys, [], 'only failed tombstones belong in remainingKeys');
    assert.deepEqual(first.continuation.characterNames, ['Alice']);
    assert.ok(first.continuation.cursor, 'unprocessed pages must have a continuation cursor');
    assert.equal(objects.has(`rp-images/_deleted/Alice/${checksumOf(0)}.json`), true, 'tombstones must be written before responding');

    const second = await (await worker.fetch(new Request('https://local.test/image/api/delete', {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify(first.continuation)
    }), env, ctx)).json();
    assert.equal(second.deletedCount, 4);
    assert.equal(second.remainingKeys.length, 0);

    await Promise.all(waitUntilPromises.splice(0));
    for (let index = 0; index < 24; index += 1) {
        assert.equal(objects.has(imageKey('Alice', index)), false, 'originals must be removed by background cleanup');
        assert.equal(objects.has(`rp-images/thumbs/Alice/${checksumOf(index)}.webp`), false);
        assert.equal(objects.has(`rp-images/_deleted/Alice/${checksumOf(index)}.json`), true, 'tombstones must survive cleanup');
    }

    const afterCleanup = await (await worker.fetch(new Request('https://local.test/image/api/library', {
        headers: authHeaders
    }), env, ctx)).json();
    assert.equal(afterCleanup.totalCount, 2);
    assert.equal(afterCleanup.characters.length, 1);
    assert.equal(afterCleanup.characters[0].name, 'Bob');

    const thumb = new Uint8Array([1, 2, 3, 4]);
    const thumbPut = await worker.fetch(new Request(`https://local.test/image/api/thumb?key=${encodeURIComponent(imageKey('Bob', 90))}`, {
        method: 'PUT',
        headers: { ...authHeaders, 'content-type': 'image/webp' },
        body: thumb
    }), env, ctx);
    assert.equal(thumbPut.status, 200);
    assert.equal(objects.has(`rp-images/thumbs/Bob/${checksumOf(90)}.webp`), true);
    const thumbGet = await worker.fetch(new Request(`https://local.test/image/api/thumb?key=${encodeURIComponent(imageKey('Bob', 90))}`, {
        headers: authHeaders
    }), env, ctx);
    assert.equal(thumbGet.status, 200);
    assert.deepEqual(new Uint8Array(await thumbGet.arrayBuffer()), thumb);
    const thumbNoOriginal = await worker.fetch(new Request(`https://local.test/image/api/thumb?key=${encodeURIComponent(imageKey('Bob', 42))}`, {
        method: 'PUT',
        headers: { ...authHeaders, 'content-type': 'image/webp' },
        body: thumb
    }), env, ctx);
    assert.equal(thumbNoOriginal.status, 404, 'thumbs must only be stored for existing originals');

    const openLibrary = await worker.fetch(new Request('https://local.test/image/api/library', {
        headers: authHeaders
    }), { RP_SYNC_R2: bucket }, ctx);
    assert.equal(openLibrary.status, 200, 'no configured password must mean open gallery access');
}

// 把 _worker.js 里 IMAGE_ADMIN_HTML 常量的模板字面量按 worker 相同的方式
// 求值成页面 HTML 并抽出内联脚本，供语法检查与真实执行两个测试共用。
async function loadImageAdminPage() {
    const source = await read('_worker.js');
    const constStart = source.indexOf('const IMAGE_ADMIN_HTML = `');
    assert.ok(constStart >= 0, 'IMAGE_ADMIN_HTML must exist in _worker.js');
    const literalStart = source.indexOf('`', constStart);
    const literalEnd = source.indexOf('`', literalStart + 1);
    assert.ok(literalStart >= 0 && literalEnd > literalStart, 'admin page template literal must be closed');
    const rawBody = source.slice(literalStart + 1, literalEnd);
    assert.ok(!rawBody.includes('${'), 'admin page literal must stay free of worker-side interpolation');
    const pageHtml = new Function('return`' + rawBody + '`;')();
    const scriptBlocks = [...pageHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
    assert.ok(scriptBlocks.length > 0, 'admin page must contain an inline script');
    const adminScript = scriptBlocks.find(text => text.includes('passwordStorageKey'));
    assert.ok(adminScript, 'admin inline script must contain the auth bootstrap');
    return { pageHtml, scriptBlocks, adminScript };
}

async function testImageAdminInlineScriptSyntax() {
    // 图库管理页的内联脚本嵌在 _worker.js 模板字面量里，node --check
    // 覆盖不到；这里对每段脚本做纯编译（不执行）。
    const { scriptBlocks, adminScript } = await loadImageAdminPage();
    assert.ok(adminScript.includes('remainingKeys'), 'remainingKeys continuation must stay in the admin script');
    // 前端批大小必须与服务端单次预算一致，否则每次请求都会有目标被退回。
    const clientChunk = adminScript.match(/deleteChunkSize=(\d+)/);
    const serverBudget = (await read('_worker.js')).match(/IMAGE_DELETE_MAX_TARGETS_PER_REQUEST = (\d+)/);
    assert.ok(clientChunk && serverBudget, 'delete chunking constants must stay readable');
    assert.equal(Number(clientChunk[1]), Number(serverBudget[1]),
        'admin page chunk size must equal the worker per-request budget');
    for (const [index, text] of scriptBlocks.entries()) {
        assert.doesNotThrow(() => new Function(text), `admin inline script #${index + 1} must parse as valid JavaScript`);
    }
}

// 生图 API 全流程模拟：缓存命中、墓碑占位、上游失败与超限。
async function testImageRenderApi() {
    const objects = new Map();
    const bucket = makeR2BucketMock(objects);
    const counters = { upstream: 0, r2Get: 0, r2Put: 0 };
    const putKeys = [];
    const countedBucket = {
        head: bucket.head,
        delete: bucket.delete,
        list: bucket.list,
        get: async key => { counters.r2Get += 1; return bucket.get(key); },
        put: async (key, value, options) => {
            counters.r2Put += 1;
            putKeys.push(key);
            return bucket.put(key, value, options);
        }
    };
    let upstreamResponse = () => new Response('png-bytes', {
        status: 200,
        headers: { 'content-type': 'image/png' }
    });
    const worker = await loadWorker(async input => {
        const url = new URL(String(input));
        assert.equal(url.origin, 'https://nai.sta1n.cn', 'render generation must only call the configured upstream');
        assert.equal(url.pathname, '/generate');
        assert.equal(url.searchParams.get('tag'), 'cat');
        assert.equal(url.searchParams.get('token'), 'tok');
        counters.upstream += 1;
        return upstreamResponse();
    });
    const env = { RP_SYNC_R2: countedBucket };
    const imageUrl = params => `https://local.test/api/rp-image?${new URLSearchParams(params)}`;
    const targetUrl = imageUrl({ tag: 'cat', character_name: 'Cat', token: 'tok' });

    const plainMiss = await worker.fetch(new Request(targetUrl), env, {});
    assert.equal(plainMiss.status, 404, 'a read without generate must not fabricate data');
    assert.equal(counters.r2Get, 2, 'a miss costs one original get plus one tombstone get');

    const noToken = await worker.fetch(new Request(imageUrl({ character_name: 'Cat', generate: '1' })), env, {});
    assert.equal(noToken.status, 401);
    const noTag = await worker.fetch(new Request(imageUrl({ token: 'tok', generate: '1' })), env, {});
    assert.equal(noTag.status, 400, 'a missing prompt must be a client error, not a thrown 500');

    const created = await worker.fetch(new Request(targetUrl, { method: 'POST' }), env, {});
    assert.equal(created.status, 200);
    assert.equal(created.headers.get('content-type'), 'image/png');
    assert.equal(await created.text(), 'png-bytes');
    assert.equal(counters.upstream, 1);
    assert.equal(counters.r2Put, 1);

    counters.r2Get = 0;
    const cached = await worker.fetch(new Request(targetUrl), env, {});
    assert.equal(await cached.text(), 'png-bytes');
    assert.equal(counters.r2Get, 2, 'a cache hit must read the tombstone first and then the original');
    assert.equal(counters.upstream, 1, 'cached reads must not call the generation service');
    const headHit = await worker.fetch(new Request(targetUrl, { method: 'HEAD' }), env, {});
    assert.equal(headHit.status, 200);
    assert.equal(headHit.body, null, 'HEAD responses must not carry a body');

    const reroll = await worker.fetch(new Request(imageUrl({
        tag: 'cat', character_name: 'Cat', token: 'tok', generate: '1', reroll_nonce: 'fresh'
    })), env, {});
    assert.equal(reroll.status, 200);
    assert.equal(counters.upstream, 2, 'a reroll nonce must produce a fresh signature');
    assert.equal(counters.r2Put, 2);

    const firstKey = putKeys[0];
    assert.ok(firstKey.startsWith('rp-images/characters/Cat/'), 'stored keys must live under the character directory');
    objects.delete(firstKey);
    await bucket.put(firstKey.replace('/characters/', '/_deleted/') + '.json', '1');

    counters.r2Get = 0;
    const deletedRead = await worker.fetch(new Request(targetUrl), env, {});
    assert.equal(deletedRead.status, 200, 'a tombstoned image must render the placeholder');
    assert.match(deletedRead.headers.get('content-type') || '', /svg/);
    assert.match(await deletedRead.text(), /图片已清理/);
    assert.equal(counters.r2Get, 2, 'tombstone and image lookups issue two gets (parallel hot path)');
    assert.equal(counters.upstream, 2, 'reads of deleted images must not regenerate them');

    const deletedGenerate = await worker.fetch(new Request(targetUrl, { method: 'POST' }), env, {});
    assert.equal(deletedGenerate.status, 200);
    assert.match(deletedGenerate.headers.get('content-type') || '', /svg/);
    assert.equal(counters.upstream, 2, 'a tombstone must outlive regeneration attempts');

    // 清理失败的边界：墓碑已写但原图清理被 R2 故障卡住，原图残留
    // —— 墓碑优先保证读取仍然只返回占位图，不会泄漏旧原图。
    {
        const cleanupStuck = putKeys[0];
        objects.set(cleanupStuck, { key: cleanupStuck, bytes: Buffer.from('png-bytes'), size: 9, etag: '"stuck"', uploaded: new Date() });
        counters.r2Get = 0;
        const staleRead = await worker.fetch(new Request(targetUrl), env, {});
        assert.equal(staleRead.status, 200);
        assert.match(staleRead.headers.get('content-type') || '', /svg/, 'a stale original left by failed cleanup must stay hidden');
        assert.match(await staleRead.text(), /图片已清理/);
        assert.ok(objects.has(cleanupStuck), 'the stale original file stays in the bucket for housekeeping');
        objects.delete(cleanupStuck);
    }

    upstreamResponse = () => new Response('nope', { status: 503, headers: { 'content-type': 'text/plain' } });
    const upstreamError = await worker.fetch(new Request(imageUrl({
        tag: 'cat', character_name: 'Cat', token: 'tok', generate: '1', reroll_nonce: 'upstream-error'
    })), env, {});
    assert.equal(upstreamError.status, 503, 'upstream failures must pass their status through');

    upstreamResponse = () => new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    const notAnImage = await worker.fetch(new Request(imageUrl({
        tag: 'cat', character_name: 'Cat', token: 'tok', generate: '1', reroll_nonce: 'bad-type'
    })), env, {});
    assert.equal(notAnImage.status, 502, 'a non-image upstream response must be rejected');

    upstreamResponse = () => new Response('tiny', {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': String(64 * 1024 * 1024 + 1) }
    });
    const oversize = await worker.fetch(new Request(imageUrl({
        tag: 'cat', character_name: 'Cat', token: 'tok', generate: '1', reroll_nonce: 'huge'
    })), env, {});
    assert.equal(oversize.status, 413, 'oversized upstream responses must be refused before storage');

    const badMethod = await worker.fetch(new Request(targetUrl, { method: 'PUT' }), env, {});
    assert.equal(badMethod.status, 405);
    assert.equal(counters.r2Put, 2, 'failed generations must not write anything');
    assert.equal(counters.upstream, 5, 'exactly the three failed attempts may call the upstream again');
}

// catch-all 代理：本地资源直出、作者未来新增页面自动回源、注入面最小化。
async function testCatchAllProxy() {
    const authorHome = await readFromUpstream('index.html');
    const authorAppJs = await readFromUpstream('assets/js/app.js');
    const authorUiComponents = await readFromUpstream('assets/js/ui-components.js');
    const authorPages = new Map([
        ['index.html', authorHome],
        ['assets/js/app.js', authorAppJs],
        ['assets/js/ui-components.js', authorUiComponents],
        ['brand-new-page.html', '<html><head></head><body>added after deploy</body></html>'],
        ['assets/js/update-check.js', 'originalUpdateCheck();'],
        ['favicon.ico', 'icon-bytes']
    ]);
    const upstreamCalls = [];
    const worker = await loadWorker(async (input, init = {}) => {
        const url = new URL(String(input));
        if (url.protocol === 'file:') {
            const body = await fs.readFile(fileURLToPath(url));
            return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
        }
        const relative = url.pathname.replace(/^\/RP-Hub\//, '');
        upstreamCalls.push(`${init.method || 'GET'} ${relative}`);
        const body = authorPages.get(relative);
        if (body !== undefined) {
            return new Response(body, {
                status: 200,
                headers: { 'content-type': relative.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' }
            });
        }
        return new Response('missing', { status: 404 });
    });
    const localAssets = ['/DB/bootstrap.js', '/DB/dirty-tracker.js', '/magic-extension.js'];
    const env = {
        RPHUB_ADAPTER_URL: configuredAdapterUrl,
        ASSETS: {
            fetch: async request => {
                const pathname = new URL(request.url).pathname;
                return localAssets.includes(pathname)
                    ? new Response(`local:${pathname}`, { status: 200, headers: { 'content-type': 'application/javascript' } })
                    : new Response('asset not found', { status: 404 });
            }
        }
    };

    for (const pathname of localAssets) {
        const response = await worker.fetch(new Request(`https://local.test${pathname}`), env, {});
        assert.equal(response.status, 200);
        assert.equal(await response.text(), `local:${pathname}`);
        // 注入的同步客户端文件用 no-cache 协商缓存：每次部署 etag 必然
        // 变化，409 版本门的“请刷新页面后重试”仍然必然拿到当前部署
        // 副本；未变化请求 304，不再每次进站重复下载约 215KB。
        assert.equal(response.headers.get('cache-control'), 'no-cache');
    }
    assert.equal(upstreamCalls.length, 0, 'local assets must be served without an upstream request');

    const restorePage = await worker.fetch(new Request('https://local.test/sync-restore'), env, {});
    const restoreHtml = await restorePage.text();
    assert.equal(restorePage.status, 200);
    assert.match(restoreHtml, /<html[^>]*data-rp-sync-restore/, 'restore mode must use an explicit internal document marker');
    assert.ok(restoreHtml.includes('<script src="/DB/dirty-tracker.js"></script>'));
    assert.ok(restoreHtml.includes('<script src="/DB/bootstrap.js"></script>'));
    assert.ok(!restoreHtml.includes('/DB/styles.css'), 'panel styles ship inside bootstrap, no separate stylesheet node');
    assert.doesNotMatch(restoreHtml, /magic-extension|assets\/js\/app\.js|上传到云端|重建本地索引/,
        'the isolated restore document must not load the author app or normal sync actions');
    assert.equal(upstreamCalls.length, 0, 'the internal restore document must never reach the author upstream');

    const updateCheck = await worker.fetch(new Request('https://local.test/assets/js/update-check.js'), env, {});
    assert.equal(await updateCheck.text(), 'originalUpdateCheck();');
    assert.equal(upstreamCalls.length, 1, 'update-check is proxied unchanged');

    const future = await worker.fetch(new Request('https://local.test/brand-new-page.html'), env, {});
    assert.equal(future.status, 200, 'author pages added after deploy must be proxied automatically');
    const futureText = await future.text();
    assert.match(futureText, /added after deploy/);
    assert.ok(futureText.includes('<script src="/DB/dirty-tracker.js"></script>'), 'healthy non-main pages keep the base tracker');
    assert.doesNotMatch(futureText, /DB\/bootstrap\.js/, 'non-main pages must not load the sync panel');
    assert.equal(upstreamCalls.length, 2, 'non-main HTML requires only one upstream request');

    const home = await worker.fetch(new Request('https://local.test/'), env, {});
    const homeText = await home.text();
    assert.equal(upstreamCalls.length, 3, 'main HTML needs no source-check fetches');
    const injectionMarkers = [
        '<script src="/DB/dirty-tracker.js"></script>',
        '<script src="/magic-extension.js"></script>',
        '<script src="/DB/bootstrap.js"></script>'
    ];
    const positions = injectionMarkers.map(marker => homeText.indexOf(marker));
    positions.forEach((position, index) => assert.ok(position >= 0, `main page must inject: ${injectionMarkers[index]}`));
    assert.ok(positions.every((position, index) => index === 0 || position > positions[index - 1]),
        'the three injected nodes must appear in order');
    assert.ok(!homeText.includes('/DB/styles.css'), 'panel styles must ship inside bootstrap instead of a stylesheet node');
    // 适配配置不再内联：扩展自行拉取 /__rphub/adapter.json，页面保持干净。
    assert.doesNotMatch(homeText, /RPHUB_MAGIC_ADAPTER/, 'the adapter config must not be inlined into author pages');
    assert.doesNotMatch(homeText, /upload-engine\.js|persistence-bridge\.js/, 'merged files must not be referenced again');

    const posted = await worker.fetch(new Request('https://local.test/brand-new-page.html', { method: 'POST', body: 'payload' }), env, {});
    assert.equal(posted.status, 200);
    assert.match(await posted.text(), /added after deploy/);
    assert.equal(upstreamCalls[upstreamCalls.length - 1], 'POST brand-new-page.html', 'non-GET author requests must keep their method');

    const icon = await worker.fetch(new Request('https://local.test/favicon.ico'), env, {});
    assert.equal(await icon.text(), 'icon-bytes');
    assert.equal(icon.headers.get('content-type'), 'application/octet-stream', 'non-HTML author assets must pass through unchanged');

    const missing = await worker.fetch(new Request('https://local.test/sounds/not-here.mp3'), env, {});
    assert.equal(missing.status, 404, 'author 404s must pass through instead of being masked');

    const degraded = await worker.fetch(new Request('https://local.test/DB/bootstrap.js'), { RPHUB_ADAPTER_URL: configuredAdapterUrl }, {});
    assert.equal(degraded.status, 404, 'without an ASSETS binding local paths degrade to the upstream proxy');
    assert.equal(upstreamCalls[upstreamCalls.length - 1], 'GET DB/bootstrap.js');
}

// 图库管理页内联脚本的真实执行：DOM 桩 + 真 worker + 大数据 +
// 乐观删除 + 服务端实时展开 + 分批失败路径。
async function testImageAdminPageRuntime() {
    const checksumOf = index => String(index).padStart(64, '0');
    const objects = new Map();
    // 钉死上传时间戳：图库按 uploaded 降序排序，真实挂钟在批量写入中途
    // 跳秒会重排图库顺序，让按位置选图的断言间歇性失败（偶发 flake 根因）。
    // 固定值让排序退化为稳定的键序（checksum 升序），测试才可复现。
    const bucket = makeR2BucketMock(objects, { uploadedAt: Date.parse('2026-01-01T00:00:00Z') });
    const imageKey = (name, index) => `rp-images/characters/${name}/${checksumOf(index)}`;
    for (let index = 0; index < 1040; index += 1) {
        await bucket.put(imageKey('Alice', index), new Uint8Array([index % 251 + 1, 3, 3, 7]));
    }
    for (let index = 0; index < 45; index += 1) {
        await bucket.put(imageKey('Bob', index), new Uint8Array([9, 2, 2, 2]));
    }
    const waitUntilPromises = [];
    const ctx = { waitUntil: promise => { waitUntilPromises.push(promise); } };
    const env = { RP_SYNC_R2: bucket, RP_SYNC_PASSWORD: 'pw' };
    const worker = await loadWorker();

    const { pageHtml, adminScript } = await loadImageAdminPage();
    const initialClasses = new Map();
    for (const match of pageHtml.matchAll(/id="([^"]+)"[^>]*? class="([^"]*)"/g)) {
        initialClasses.set(match[1], match[2] ? match[2].split(/\s+/) : []);
    }
    const makeClassList = classes => {
        const set = new Set(classes);
        return {
            add: (...names) => names.forEach(name => set.add(name)),
            remove: (...names) => names.forEach(name => set.delete(name)),
            contains: name => set.has(name),
            toggle(name, force) {
                const next = force === undefined ? !set.has(name) : Boolean(force);
                if (next) set.add(name); else set.delete(name);
            }
        };
    };
    const elements = new Map();
    const makeElement = id => ({
        id,
        classList: makeClassList(initialClasses.get(id) || []),
        dataset: {},
        style: {},
        textContent: '',
        innerHTML: '',
        value: '',
        disabled: false,
        src: '',
        onclick: null,
        oninput: null,
        onkeydown: null,
        focus() { },
        matches() { return false; },
        closest() { return null; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        addEventListener() { },
        removeAttribute() { }
    });
    const documentStub = {
        readyState: 'complete',
        body: makeElement('body'),
        getElementById(id) {
            if (!elements.has(id)) elements.set(id, makeElement(id));
            return elements.get(id);
        },
        createElement: tag => makeElement(`created:${tag}`),
        querySelector() { return null; },
        querySelectorAll() { return []; },
        addEventListener() { }
    };
    const storage = new Map();
    const deleteRequests = [];
    const sandbox = {
        document: documentStub,
        localStorage: {
            getItem: key => (storage.has(key) ? storage.get(key) : null),
            setItem: (key, value) => { storage.set(key, String(value)); },
            removeItem: key => { storage.delete(key); }
        },
        location: { href: 'https://local.test/image' },
        confirm: () => true,
        setTimeout,
        clearTimeout,
        requestAnimationFrame: callback => setTimeout(callback, 0),
        fetch: async (input, init = {}) => {
            const url = new URL(String(input), 'https://local.test');
            if (url.pathname === '/image/api/delete') {
                deleteRequests.push(init.body ? JSON.parse(init.body) : null);
            }
            return worker.fetch(new Request(`https://local.test${url.pathname}${url.search}`, {
                method: init.method || 'GET',
                headers: init.headers,
                body: init.body
            }), env, ctx);
        }
    };
    sandbox.window = sandbox;
    sandbox.window.matchMedia = () => ({ matches: false });
    sandbox.window.scrollY = 0;
    sandbox.window.scrollTo = () => { };
    sandbox.window.addEventListener = () => { };
    sandbox.globalThis = sandbox;
    const element = id => documentStub.getElementById(id);
    const settle = () => new Promise(resolve => setTimeout(resolve, 5));
    const waitFor = async (predicate, label) => {
        for (let attempt = 0; attempt < 4000 && !predicate(); attempt += 1) await settle();
        assert.ok(predicate(), `image admin runtime timed out waiting for: ${label}`);
    };

    vm.runInNewContext(adminScript, sandbox, { filename: 'image-admin-inline.js' });
    await waitFor(() => !element('auth').classList.contains('hidden'), 'login box after the anonymous auth check');

    element('password').value = 'wrong';
    await sandbox.enter();
    assert.equal(element('authMsg').textContent, '密码不正确');
    assert.ok(element('app').classList.contains('hidden'), 'a wrong password must not reveal the app');

    element('password').value = 'pw';
    await sandbox.enter();
    assert.ok(element('auth').classList.contains('hidden'), 'the right password must hide the login box');
    await waitFor(() => sandbox.data !== null, 'library data after login');
    assert.equal(sandbox.data.characters.reduce((n, c) => n + c.images.length, 0), 1085,
        'a single library load must return every image');
    assert.deepEqual(Array.from(sandbox.data.characters, character => character.name), ['Alice', 'Bob']);
    assert.match(element('stats').textContent, /^1085 张图片/, 'stats must describe the loaded images');
    assert.match(element('library').innerHTML, /Alice/);
    assert.equal(sandbox.hiddenKeys.size, 1085, 'all loaded images start hidden');
    assert.match(element('library').innerHTML, /blurred/, 'hidden tiles render the blur class');

    // 页面加载完成后再写 3 张新图（模拟另一台设备继续生图）：
    // 清空本组必须把它们也删掉，服务端按当前 R2 状态展开。
    for (let index = 1040; index < 1043; index += 1) {
        await bucket.put(imageKey('Alice', index), new Uint8Array([1, 1, 1, 1]));
    }

    sandbox.deleteCharacterImages('Alice', 1040);
    assert.ok(sandbox.deleteBusy, 'the delete flow must be in flight immediately');
    assert.deepEqual(Array.from(sandbox.data.characters, character => character.name), ['Bob'],
        'the cleared group disappears from the UI before any request completes');
    assert.match(element('stats').textContent, /^45 张图片/, 'stats must immediately reflect only the surviving group');
    await waitFor(() => !sandbox.deleteBusy, 'clear-group batches to finish');

    assert.equal(deleteRequests.length, 53, '1043 targets take 53 bounded directory pages');
    assert.deepEqual(deleteRequests[0], { characterNames: ['Alice'] });
    const followUps = deleteRequests.slice(1);
    for (const body of followUps) {
        assert.deepEqual(body.characterNames, ['Alice']);
        assert.ok(body.cursor, 'follow-ups must advance through directory cursors');
        assert.equal(body.keys, undefined);
    }
    assert.match(element('notice').textContent, /已删除 1043 张/,
        'images generated after page load must be deleted via server-side expansion');

    await Promise.all(waitUntilPromises.splice(0));
    for (let index = 0; index < 1043; index += 1) {
        assert.equal(objects.has(imageKey('Alice', index)), false, `Alice original ${index} must be deleted`);
        assert.equal(objects.has(`rp-images/_deleted/Alice/${checksumOf(index)}.json`), true, `Alice tombstone ${index} must exist`);
    }
    for (let index = 0; index < 45; index += 1) {
        assert.equal(objects.has(imageKey('Bob', index)), true, `Bob original ${index} must survive`);
        assert.equal(objects.has(`rp-images/_deleted/Bob/${checksumOf(index)}.json`), false);
    }

    // 失败路径：40 张分两批，第 2 批失败 —— 已接受的 20 张保持删除，
    // 失败的 20 张必须留在页面上。按请求序号计数，避免依赖 onclick()
    // 与标志位之间的微任务时序。
    deleteRequests.length = 0;
    const realFetch = sandbox.fetch;
    let deleteCalls = 0;
    sandbox.fetch = async (input, init = {}) => {
        const url = new URL(String(input), 'https://local.test');
        if (url.pathname === '/image/api/delete') {
            deleteCalls += 1;
            if (deleteCalls === 2) {
                deleteRequests.push(init.body ? JSON.parse(init.body) : null);
                return new Response(JSON.stringify({ ok: false, error: '模拟批次失败' }), {
                    status: 500,
                    headers: { 'content-type': 'application/json' }
                });
            }
        }
        return realFetch(input, init);
    };
    const bobImages = sandbox.data.characters[0].images;
    assert.equal(bobImages.length, 45);
    bobImages.slice(0, 40).forEach(image => sandbox.selected.add(image.key));
    element('deleteSelected').onclick();
    await waitFor(() => !sandbox.deleteBusy, 'the failed delete flow to settle');

    assert.equal(deleteRequests.length, 2);
    assert.equal(deleteRequests[0].keys.length, 20);
    assert.equal(deleteRequests[1].keys.length, 20);
    assert.equal(sandbox.data.characters[0].images.length, 25,
        'partially accepted deletes must leave exactly the failed images in view');
    assert.equal(element('notice').textContent, '模拟批次失败');
    assert.equal(element('notice').style.color, '#dc2626');
    assert.equal(sandbox.selected.size, 0, 'the selection must be cleared when the flow ends');

    await Promise.all(waitUntilPromises.splice(0));
    for (let index = 0; index < 20; index += 1) {
        assert.equal(objects.has(imageKey('Bob', index)), false, `accepted Bob image ${index} must be deleted server-side`);
    }
    assert.equal(objects.has(`rp-images/_deleted/Bob/${checksumOf(0)}.json`), true, 'accepted deletes must leave tombstones');
    for (let index = 20; index < 45; index += 1) {
        assert.equal(objects.has(imageKey('Bob', index)), true, `failed Bob images ${index} must still exist`);
    }
    sandbox.fetch = realFetch;

    // 当前页墓碑部分失败：首个响应同时返回失败键和下一页游标，前端必须
    // 先重试失败键，成功后才推进 continuation。
    const originalBucketPut = bucket.put.bind(bucket);
    const transientKey = imageKey('Bob', 20);
    let transientFailure = true;
    bucket.put = async (key, value, options) => {
        if (transientFailure && key === `rp-images/_deleted/Bob/${checksumOf(20)}.json`) {
            transientFailure = false;
            throw new Error('一次性墓碑失败');
        }
        return originalBucketPut(key, value, options);
    };
    deleteRequests.length = 0;
    sandbox.deleteCharacterImages('Bob', 25);
    await waitFor(() => !sandbox.deleteBusy, 'partial tombstone retry and continuation to finish');
    assert.equal(deleteRequests.length, 3, 'partial tombstone failure must retry before continuing');
    assert.deepEqual(deleteRequests[0], { characterNames: ['Bob'] });
    assert.deepEqual(deleteRequests[1], { keys: [transientKey] });
    assert.equal(deleteRequests[2].characterNames[0], 'Bob');
    assert.ok(deleteRequests[2].cursor, 'continuation must survive the failed-key retry');
    assert.match(element('notice').textContent, /已删除 25 张/);
    assert.equal(sandbox.data.characters.some(character => character.name === 'Bob'), false);
    await Promise.all(waitUntilPromises.splice(0));
    for (let index = 20; index < 45; index += 1) {
        assert.equal(objects.has(imageKey('Bob', index)), false, `retried Bob image ${index} must be deleted`);
    }

    // 重试也失败时，已接受墓碑仍然生效，失败键与未处理 continuation 都恢复到页面。
    const carolKeys = Array.from({ length: 21 }, (_, index) => imageKey('Carol', index));
    for (const key of carolKeys) await bucket.put(key, new Uint8Array([5, 5, 5, 5]));
    sandbox.data.characters.push({
        name: 'Carol', count: carolKeys.length, size: carolKeys.length * 4,
        sizeHuman: '84 B',
        images: carolKeys.map(key => ({ key, size: 4, sizeHuman: '4 B' }))
    });
    const permanentKey = carolKeys[0];
    let permanentFailure = true;
    bucket.put = async (key, value, options) => {
        if (permanentFailure && key === `rp-images/_deleted/Carol/${checksumOf(0)}.json`) {
            throw new Error('持续墓碑失败');
        }
        return originalBucketPut(key, value, options);
    };
    deleteRequests.length = 0;
    sandbox.deleteCharacterImages('Carol', carolKeys.length);
    await waitFor(() => !sandbox.deleteBusy, 'permanent partial tombstone failure to settle');
    assert.equal(deleteRequests.length, 2, 'a failed retry must stop before continuation');
    assert.deepEqual(deleteRequests[0], { characterNames: ['Carol'] });
    assert.deepEqual(deleteRequests[1], { keys: [permanentKey] });
    const carol = sandbox.data.characters.find(character => character.name === 'Carol');
    assert.deepEqual(carol.images.map(image => image.key), [permanentKey, carolKeys[20]],
        'failed and unprocessed images must be restored after retry failure');
    assert.match(element('notice').textContent, /删除标记写入失败/);
    assert.equal(element('notice').style.color, '#dc2626');
    await Promise.all(waitUntilPromises.splice(0));
    assert.equal(objects.has(permanentKey), true, 'the permanently failed image must remain');
    assert.equal(objects.has(carolKeys[20]), true, 'the unprocessed continuation image must remain');
    for (let index = 1; index < 20; index += 1) {
        assert.equal(objects.has(carolKeys[index]), false, `accepted Carol image ${index} must be deleted`);
    }
    bucket.put = originalBucketPut;
}

async function testPagePinnedAdapter() {
    const author = await readFromUpstream('assets/js/app.js');
    const html = await readFromUpstream('index.html');
    let healthy = false;
    const worker = await loadWorker(async input => {
        const url = new URL(input);
        if (url.protocol === 'file:') return new Response(healthy ? await fs.readFile(localAdapterPath(), 'utf8') : 'invalid');
        return new Response(url.pathname.endsWith('app.js') ? author : html, {
            headers: { 'content-type': url.pathname.endsWith('.js') ? 'application/javascript' : 'text/html' }
        });
    });
    const env = { RPHUB_ADAPTER_URL: configuredAdapterUrl };
    const failedPage = await (await worker.fetch(new Request('https://local.test/'), env, {})).text();
    assert.match(failedPage, /DB\/dirty-tracker/);
    assert.doesNotMatch(failedPage, /magic-extension|DB\/bootstrap/);
    healthy = true;
    assert.equal(await (await worker.fetch(new Request('https://local.test/assets/js/app.js'), env, {})).text(), author);
    const page = await (await worker.fetch(new Request('https://local.test/'), env, {})).text();
    assert.match(page, /window\.RPHubExternal = external/);
    assert.match(page, /magic-extension/);
    const loader = html.slice(html.lastIndexOf('<script>'));
    assert.ok(page.endsWith(loader), 'author document.write loader remains byte-for-byte unchanged');
    assert.ok(!page.includes(author), 'author application is never embedded in HTML');
    const adapterIndex = page.indexOf('window.RPHubExternal = external');
    assert.ok(adapterIndex < page.indexOf('<script src="/magic-extension.js">'));
    const isolated = await loadWorker(async input => new Response(String(input).endsWith('app.js') ? author : 'invalid'));
    assert.equal(await (await isolated.fetch(new Request('https://local.test/assets/js/app.js'), env, {})).text(), author);
}

await testImageAdminApi();
await testImageAdminInlineScriptSyntax();
await testImageAdminPageRuntime();
await testImageRenderApi();
await testCatchAllProxy();
await testPagePinnedAdapter();
await testAdapterFromFileUrl();
await testAdapterConfigEndpoint();
await testAuthorScriptPassthrough();
await testBoundedUploadEngine();
await testUploadEngineCleanup();
await testBootstrapUsesBoundedEngine();
await testFixedImageSettingUsesAdapterClasses();
console.log('runtime-smoke: ok');


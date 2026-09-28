import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { test } from 'node:test';

// All fetches and R2 operations are local mocks; never contact an upstream.
const source = await readFile(new URL('../_worker.js', import.meta.url), 'utf8');
function load(overrides = {}) {
    const timers = new Map();
    let nextTimer = 0;
    const context = vm.createContext({
        URL, Headers, Request, Response, ReadableStream, Uint8Array, ArrayBuffer,
        TextEncoder, TextDecoder, AbortController, DOMException, crypto: webcrypto,
        atob, AbortSignal,
        fetch: () => { throw new Error('Unexpected network access'); },
        setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; },
        clearTimeout(id) { timers.delete(id); },
        ...overrides
    });
    vm.runInContext(source.replace('export default {', 'globalThis.worker = {'), context);
    return { context, timers };
}
const key = `rp-images/characters/A..B/${'a'.repeat(64)}`;
function bucket() {
    const writes = [], deletes = [], reads = [];
    return {
        writes, deletes, reads,
        async get(k) { reads.push(k); return { body: new Uint8Array([1]), size: 1 }; },
        async list({ prefix }) { return { objects: key.startsWith(prefix) ? [{ key, size: 1 }] : [], truncated: false }; },
        async put(...args) { writes.push(args); },
        async delete(keys) { deletes.push(...keys); }
    };
}
function admin(context, store, endpoint, method = 'GET', body) {
    const url = new URL(`https://offline.invalid/image/api/${endpoint}`);
    url.searchParams.set('key', key);
    const request = new Request(url, { method, body, headers: body ? { 'content-type': 'image/webp' } : {} });
    return context.handleImageAdmin(request, { RP_SYNC_R2: store }, url);
}
for (const endpoint of ['image', 'thumb']) {
    test(`A..B ${endpoint} GET and HEAD remain accessible`, async () => {
        const { context } = load();
        for (const method of ['GET', 'HEAD']) assert.equal((await admin(context, bucket(), endpoint, method)).status, 200);
    });
}
test('A..B thumbnail upload works', async () => {
    const { context } = load();
    const store = bucket();
    assert.equal((await admin(context, store, 'thumb', 'PUT', new Uint8Array([1]))).status, 200);
    assert.equal(store.writes.length, 1);
});
test('A..B selected deletion writes tombstone and deletes files', async () => {
    const { context } = load();
    const store = bucket();
    const result = await admin(context, store, 'delete', 'POST', JSON.stringify({ keys: [key] }));
    assert.equal((await result.json()).deletedCount, 1);
    assert.equal(store.writes.length, 1);
    assert.ok(store.deletes.includes(key));
});
test('malformed image keys are rejected before bucket access', async () => {
    const { context } = load();
    for (const bad of [key.replace('A..B', '..'), key.replace('A..B', '.'), key + '/extra', key.replace('A..B', 'A\\B'), key.replace('/characters/', '/thumbs/')]) {
        const store = bucket();
        const url = new URL('https://offline.invalid/image/api/image');
        url.searchParams.set('key', bad);
        assert.equal((await context.handleImageAdmin(new Request(url), { RP_SYNC_R2: store }, url)).status, 400);
        assert.equal(store.reads.length, 0);
    }
});
function streamFixture(limit) {
    let pulled = 0, cancelled = false;
    const chunk = new Uint8Array(1024 * 1024);
    const body = new ReadableStream({
        pull(controller) {
            pulled++;
            if (pulled <= limit + 4) controller.enqueue(chunk);
            else controller.close();
        },
        cancel() { cancelled = true; }
    }, { highWaterMark: 0 });
    return { body, get pulled() { return pulled; }, get cancelled() { return cancelled; } };
}
for (const length of [null, '1']) {
    test(`thumbnail stops at 2 MiB with content-length ${length}`, async () => {
        const { context } = load();
        const stream = streamFixture(2);
        const headers = { 'content-type': 'image/webp' };
        if (length !== null) headers['content-length'] = length;
        const request = new Request('https://offline.invalid/', { method: 'PUT', body: stream.body, duplex: 'half', headers });
        await assert.rejects(context.readThumbnailBytes(request));
        assert.ok(stream.pulled <= 3, `read ${stream.pulled} chunks`);
        assert.equal(stream.cancelled, true);
    });
    test(`image stops at 64 MiB with content-length ${length}`, async () => {
        const stream = streamFixture(64);
        const headers = { 'content-type': 'image/png' };
        if (length !== null) headers['content-length'] = length;
        const { context, timers } = load({ fetch: async () => new Response(stream.body, { headers }) });
        const store = bucket(); store.get = async () => null;
        const result = await context.handleImageRender(new Request('https://offline.invalid/api/rp-image?token=fake&tag=test', { method: 'POST' }), { RP_SYNC_R2: store });
        assert.equal(result.status, 413);
        assert.ok(stream.pulled <= 65, `read ${stream.pulled} chunks`);
        assert.equal(stream.cancelled, true);
        assert.equal(store.writes.length, 0);
        assert.equal(timers.size, 0);
    });
}
test('image timeout covers body consumption and aborts a stalled body', async () => {
    let signal, cancelled = false;
    const { context } = load({ fetch: async (_url, options) => {
        signal = options.signal;
        return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'image/png' } });
    } });
    const consume = async (response, sig) => {
        // 与真实消费者 readBoundedImageBytes 同构：监听 abort 主动取消读取，
        // 取消让挂起的 read 返回后再检查 aborted 抛出。
        const reader = response.body.getReader();
        const abort = () => { void reader.cancel().catch(() => { }); };
        sig.addEventListener('abort', abort, { once: true });
        try {
            for (;;) {
                if (sig.aborted) throw new Error('Image fetch timed out.');
                const { done } = await reader.read();
                if (sig.aborted) throw new Error('Image fetch timed out.');
                if (done) return;
            }
        } finally {
            sig.removeEventListener('abort', abort);
            reader.releaseLock();
            await response.body.cancel().catch(() => { });
        }
    };
    // 截止时间覆盖响应头之后的正文消费：注入 30ms 短超时，挂起的正文读取
    // 必须被中止并归一为固定错误文案。
    await assert.rejects(
        context.fetchImageWithTimeout('https://offline.invalid/x', {}, consume, 30),
        /Image fetch timed out\./
    );
    assert.equal(signal.aborted, true);
    assert.equal(cancelled, true);
});
test('image timeout aborts a hung fetch before headers arrive', async () => {
    const { context } = load({ fetch: (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'TimeoutError')));
    }) });
    await assert.rejects(
        context.fetchImageWithTimeout('https://offline.invalid/x', {}, async () => { }, 25),
        /Image fetch timed out\./
    );
});
test('thumbnail accepts exactly 2 MiB and rejects empty bodies', async () => {
    const { context } = load();
    const make = size => new Request('https://offline.invalid/', { method: 'PUT', headers: { 'content-type': 'image/webp' }, body: new Uint8Array(size) });
    assert.equal((await context.readThumbnailBytes(make(2 * 1024 * 1024))).byteLength, 2 * 1024 * 1024);
    await assert.rejects(context.readThumbnailBytes(make(0)));
});
test('image accepts exactly 64 MiB, stores once and clears deadline', async () => {
    const { context, timers } = load({ fetch: async () => new Response(new Uint8Array(64 * 1024 * 1024), { headers: { 'content-type': 'image/png' } }) });
    const store = bucket(); store.get = async () => null;
    const result = await context.handleImageRender(new Request('https://offline.invalid/api/rp-image?token=fake&tag=test', { method: 'POST' }), { RP_SYNC_R2: store });
    assert.equal(result.status, 200);
    assert.equal(store.writes.length, 1);
    assert.equal(store.writes[0][1].byteLength, 64 * 1024 * 1024);
    assert.equal(timers.size, 0);
});
for (const scenario of [
    { status: 503, type: 'image/png', expected: 503 },
    { status: 200, type: 'text/plain', expected: 502 },
    { status: 200, type: 'image/png', length: String(64 * 1024 * 1024 + 1), expected: 413 }
]) {
    test(`upstream rejection ${scenario.expected} cancels unread body and clears deadline`, async () => {
        const stream = streamFixture(64);
        const headers = { 'content-type': scenario.type };
        if (scenario.length) headers['content-length'] = scenario.length;
        const { context, timers } = load({ fetch: async () => new Response(stream.body, { status: scenario.status, headers }) });
        const store = bucket(); store.get = async () => null;
        const result = await context.handleImageRender(new Request('https://offline.invalid/api/rp-image?token=fake&tag=test', { method: 'POST' }), { RP_SYNC_R2: store });
        assert.equal(result.status, scenario.expected);
        assert.equal(stream.pulled, 0);
        assert.equal(stream.cancelled, true);
        assert.equal(timers.size, 0);
        assert.equal(store.writes.length, 0);
    });
}
test('thumbnail oversized declared length is rejected without reading', async () => {
    const { context } = load();
    const stream = streamFixture(2);
    const request = new Request('https://offline.invalid/', { method: 'PUT', body: stream.body, duplex: 'half', headers: { 'content-type': 'image/webp', 'content-length': String(2 * 1024 * 1024 + 1) } });
    await assert.rejects(context.readThumbnailBytes(request));
    assert.equal(stream.pulled, 0);
    assert.equal(stream.cancelled, true);
});
test('fetch rejection clears deadline', async () => {
    const { context, timers } = load({ fetch: async () => { throw new Error('offline failure'); } });
    await assert.rejects(context.fetchImageWithTimeout('https://offline.invalid/', {}, () => {}), /offline failure/);
    assert.equal(timers.size, 0);
});
test('author proxy strips local credentials and retains ordinary headers', async () => {
    let forwarded;
    const { context } = load({ fetch: async (_url, options) => { forwarded = options.headers; return new Response('body', { headers: { 'content-type': 'text/css' } }); } });
    await context.serveAuthor(new Request('https://offline.invalid/assets/style.css', { headers: {
        Cookie: 'session=local', Authorization: 'Bearer local', 'x-rp-sync-password': 'local', 'accept': 'text/css', 'if-none-match': 'test-etag'
    } }), {});
    for (const name of ['cookie', 'authorization', 'x-rp-sync-password']) assert.equal(forwarded.get(name), null, name);
    assert.equal(forwarded.get('accept'), 'text/css');
    assert.equal(forwarded.get('if-none-match'), 'test-etag');
});

// --- ynai 第三方中转（占位 token + 本地 mock，永不接触真实上游） ---
const YNAI_TOKEN = 'YNAI-placeholder-token';
const YNAI_ADAPTER = JSON.stringify({
    schema: 1,
    id: 'rp-hub',
    author: { script: { replacements: [{ name: 'x', find: 'a', replace: 'b' }] } },
    image: {
        ynai: {
            base: 'https://nai.rinko.ai',
            modelsPath: '/v1/models',
            generatePath: '/v1/images/generations',
            defaultModel: 'nai-diffusion-4-5-full'
        }
    }
});
test('ynai endpoints follow the cloud adapter config', async () => {
    const adapterJson = JSON.stringify({
        schema: 1,
        id: 'rp-hub',
        author: { script: { replacements: [{ name: 'x', find: 'a', replace: 'b' }] } },
        image: { ynai: { base: 'https://relay.example', modelsPath: '/v9/models', generatePath: '/v9/images/generations' } }
    });
    let captured;
    const { context } = load({ fetch: async url => {
        const u = String(url);
        if (u.startsWith('file:')) return new Response(adapterJson, { headers: { 'content-type': 'application/json' } });
        captured = { url: u };
        return new Response(JSON.stringify({ object: 'list', data: [{ id: 'm1' }] }), { headers: { 'content-type': 'application/json' } });
    } });
    const env = { RP_SYNC_R2: bucket(), RPHUB_ADAPTER_URL: 'file:///adapter.json' };
    const res = await context.handleImageModels(new Request('https://offline.invalid/api/rp-image-models', { headers: { 'x-rp-image-token': YNAI_TOKEN } }), env);
    assert.deepEqual(await res.json(), { ok: true, data: [{ id: 'm1' }] });
    assert.equal(captured.url, 'https://relay.example/v9/models', '云端 adapter 覆盖中转地址与模型路径');
});
test('ynai keys route generation to the relay with the OpenAI images shape', async () => {
    let captured;
    const { context, timers } = load({ fetch: async (url, options) => {
        const u = String(url);
        if (u.startsWith('file:')) return new Response(YNAI_ADAPTER, { headers: { 'content-type': 'application/json' } });
        captured = { url: u, options };
        return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('ynai-png-bytes').toString('base64') }] }), { headers: { 'content-type': 'application/json' } });
    } });
    const store = bucket(); store.get = async () => null;
    const request = new Request(`https://offline.invalid/api/rp-image?token=${encodeURIComponent(YNAI_TOKEN)}&tag=test&model=relay-model&character_name=A..B`, { method: 'POST' });
    const result = await context.handleImageRender(request, { RP_SYNC_R2: store, RPHUB_ADAPTER_URL: 'file:///adapter.json' });
    assert.equal(result.status, 200);
    assert.equal(captured.url, 'https://nai.rinko.ai/v1/images/generations');
    assert.equal(captured.options.method, 'POST');
    assert.equal(captured.options.headers.authorization, `Bearer ${YNAI_TOKEN}`);
    const body = JSON.parse(captured.options.body);
    assert.equal(body.model, 'relay-model');
    assert.equal(body.prompt, 'test');
    assert.equal(body.size, '832x1216', '竖图默认尺寸映射');
    assert.equal(body.parameters.steps, 28, 'ynai 空 steps 默认 28');
    assert.equal(body.response_format, 'b64_json');
    assert.equal(body.parameters.sampler, 'k_dpmpp_2m_sde');
    assert.equal(Buffer.from(store.writes[0][1]).toString(), 'ynai-png-bytes');
    assert.equal(timers.size, 0);
});
test('ynai model list requires YNAI token and cloud config, proxies the relay list once', async () => {
    let calls = 0, captured;
    const { context } = load({ fetch: async (url, options) => {
        const u = String(url);
        if (u.startsWith('file:')) return new Response(YNAI_ADAPTER, { headers: { 'content-type': 'application/json' } });
        if (!u.includes('nai.rinko.ai')) return new Response('not found', { status: 404 });
        calls += 1; captured = { url: u, options };
        return new Response(JSON.stringify({ object: 'list', data: [{ id: 'model-a' }, { id: 'model-b' }, { id: null }] }), { headers: { 'content-type': 'application/json' } });
    } });
    const denied = await context.handleImageModels(new Request('https://offline.invalid/api/rp-image-models', { headers: { 'x-rp-image-token': 'plain-token' } }), { RP_SYNC_R2: bucket() });
    assert.equal(denied.status, 401);
    assert.equal(calls, 0, '非 YNAI 密钥不触发任何外呼');
    const noConfig = await context.handleImageModels(new Request('https://offline.invalid/api/rp-image-models', { headers: { 'x-rp-image-token': YNAI_TOKEN } }), {});
    assert.equal(noConfig.status, 503, '云端配置缺失时显式报错，不做代码兜底');
    assert.equal(calls, 0, '配置缺失不触发外呼');
    const env = { RP_SYNC_R2: bucket(), RPHUB_ADAPTER_URL: 'file:///adapter.json' };
    const ok = await context.handleImageModels(new Request('https://offline.invalid/api/rp-image-models', { headers: { 'x-rp-image-token': YNAI_TOKEN } }), env);
    assert.deepEqual(await ok.json(), { ok: true, data: [{ id: 'model-a' }, { id: 'model-b' }] });
    assert.equal(captured.url, 'https://nai.rinko.ai/v1/models');
    assert.equal(captured.options.headers.authorization, `Bearer ${YNAI_TOKEN}`);
    const cached = await context.handleImageModels(new Request('https://offline.invalid/api/rp-image-models', { headers: { 'x-rp-image-token': YNAI_TOKEN } }), env);
    assert.equal((await cached.json()).data.length, 2);
    assert.equal(calls, 1, '30 秒内存缓存避免重复外呼');
});
test('ynai invalid cloud config shape reports 503 without contacting the relay', async () => {
    // 配置存在但形状非法（缺 generatePath）与配置缺失同等对待：显式 503，
    // 不做代码兜底、不触发任何中转外呼。
    const brokenAdapter = JSON.stringify({
        schema: 1,
        id: 'rp-hub',
        author: { script: { replacements: [{ name: 'x', find: 'a', replace: 'b' }] } },
        image: { ynai: { base: 'https://nai.rinko.ai', modelsPath: '/v1/models' } }
    });
    let relayCalls = 0;
    const { context } = load({ fetch: async url => {
        const u = String(url);
        if (u.startsWith('file:')) return new Response(brokenAdapter, { headers: { 'content-type': 'application/json' } });
        if (u.includes('nai.rinko.ai')) relayCalls += 1;
        return new Response('{}');
    } });
    const store = bucket(); store.get = async () => null;
    const env = { RP_SYNC_R2: store, RPHUB_ADAPTER_URL: 'file:///adapter.json' };
    const models = await context.handleImageModels(new Request('https://offline.invalid/api/rp-image-models', { headers: { 'x-rp-image-token': YNAI_TOKEN } }), env);
    assert.equal(models.status, 503);
    const render = await context.handleImageRender(new Request(`https://offline.invalid/api/rp-image?token=${encodeURIComponent(YNAI_TOKEN)}&tag=test&character_name=A..B`, { method: 'POST' }), env);
    assert.equal(render.status, 503);
    assert.equal(relayCalls, 0, '形状非法的配置不触发中转外呼');
});
test('provider-agnostic cache: tokenless reads share one key regardless of provider param', async () => {
    const { context } = load();
    const store = bucket();
    store.get = async k => { store.reads.push(k); return null; };
    await context.handleImageRender(new Request('https://offline.invalid/api/rp-image?provider=ynai&tag=test&character_name=A..B'), { RP_SYNC_R2: store });
    await context.handleImageRender(new Request('https://offline.invalid/api/rp-image?tag=test&character_name=A..B'), { RP_SYNC_R2: store });
    assert.equal(store.reads.length, 4, '每次读取查墓碑 + 原图两个键');
    assert.equal(store.reads[1], store.reads[3], '同一内容不分来源，共用同一 R2 键');
});
test('key-switching lifecycle: sta1n → ynai → sta1n keeps every era image displaying', async () => {
    // 全离线模拟三个时代：sta1n 生成 → 切 YNAI（旧图显示 + 中转新图生成/显示）→
    // 切回 sta1n（两个时代的旧图都显示 + sta1n 新图生成）。R2 统一拉取，不分来源。
    const relayCalls = [], sta1nCalls = [];
    const { context } = load({ fetch: async (url, options) => {
        const u = String(url);
        if (u.startsWith('file:')) return new Response(YNAI_ADAPTER, { headers: { 'content-type': 'application/json' } });
        if (u.includes('nai.rinko.ai')) {
            relayCalls.push(u);
            return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('relay-image-bytes').toString('base64') }] }), { headers: { 'content-type': 'application/json' } });
        }
        if (u.includes('nai.sta1n.cn')) {
            sta1nCalls.push(u);
            return new Response(Buffer.from('sta1n-image-bytes'), { headers: { 'content-type': 'image/png' } });
        }
        throw new Error('unexpected upstream: ' + u);
    } });
    const objects = new Map();
    const store = {
        writes: [],
        async get(k) { const v = objects.get(k); return v ? { body: v, size: v.byteLength, httpMetadata: { contentType: 'image/png' } } : null; },
        async put(k, v) { objects.set(k, v); this.writes.push([k, v]); },
        async head() { return null; },
        async list() { return { objects: [], truncated: false }; },
        async delete() { }
    };
    const env = { RP_SYNC_R2: store, RPHUB_ADAPTER_URL: 'file:///adapter.json' };
    const IMAGE_KEYS = ['model', 'artist', 'size', 'steps', 'scale', 'cfg', 'sampler', 'negative', 'nocache', 'noise_schedule'];
    // 复刻魔改层 buildRecordUrl：快照参数原样回放（空值留给 worker 默认），无 token、无 provider
    const replayUrl = record => {
        const params = new URLSearchParams();
        params.set('tag', record.prompt);
        for (const key of IMAGE_KEYS) params.set(key, String(record.paramsSnapshot[key] || ''));
        params.set('character_name', 'A..B');
        return 'https://offline.invalid/api/rp-image?' + params.toString();
    };
    const generate = async (token, prompt, model) => {
        // 复刻作者页面请求形状：全部参数显式携带（steps=40 等为作者模板硬编码值）
        const params = new URLSearchParams({
            token, tag: prompt, model, artist: '',
            size: '竖图', steps: '40', scale: '6', cfg: '0',
            sampler: 'k_dpmpp_2m_sde', negative: '', nocache: '0', noise_schedule: 'karras',
            character_name: 'A..B'
        });
        return context.handleImageRender(new Request('https://offline.invalid/api/rp-image?' + params, { method: 'POST' }), env);
    };
    const bodyOf = async response => Buffer.from(await response.arrayBuffer()).toString();
    const recordOf = (prompt, model) => ({ prompt, paramsSnapshot: {
        model, artist: '', size: '竖图', steps: '40', scale: '6', cfg: '0',
        sampler: 'k_dpmpp_2m_sde', negative: '', nocache: '0', noise_schedule: 'karras'
    } });

    // —— 时代 1：sta1n 密钥，生成第一张并写入固定记录 ——
    const era1 = await generate('STA1N-placeholder', 'prompt-one', 'nai-diffusion-4-5-full');
    assert.equal(era1.status, 200);
    assert.equal(await bodyOf(era1), 'sta1n-image-bytes');
    assert.equal(sta1nCalls.length, 1);
    assert.equal(relayCalls.length, 0);
    const record1 = recordOf('prompt-one', 'nai-diffusion-4-5-full');

    // —— 时代 1：旧图显示（重放命中缓存，不重新生成）——
    const view1 = await context.handleImageRender(new Request(replayUrl(record1)), env);
    assert.equal(view1.status, 200);
    assert.equal(await bodyOf(view1), 'sta1n-image-bytes');
    assert.equal(sta1nCalls.length, 1);

    // —— 时代 2：切 YNAI- 密钥。旧图仍正常显示 ——
    const view1InYnai = await context.handleImageRender(new Request(replayUrl(record1)), env);
    assert.equal(view1InYnai.status, 200);
    assert.equal(await bodyOf(view1InYnai), 'sta1n-image-bytes');
    assert.equal(sta1nCalls.length, 1);
    assert.equal(relayCalls.length, 0);
    // —— 时代 2：中转生成新图（用户在中转模型列表里选了 relay-model）——
    const era2 = await generate('YNAI-placeholder', 'prompt-two', 'relay-model');
    assert.equal(era2.status, 200);
    assert.equal(await bodyOf(era2), 'relay-image-bytes');
    assert.equal(relayCalls.length, 1);
    assert.equal(sta1nCalls.length, 1, 'ynai 生成不经过 sta1n 上游');
    const record2 = recordOf('prompt-two', 'relay-model');
    // —— 时代 2：ynai 新图显示（重放命中，同一键不分来源）——
    const view2 = await context.handleImageRender(new Request(replayUrl(record2)), env);
    assert.equal(view2.status, 200);
    assert.equal(await bodyOf(view2), 'relay-image-bytes');
    assert.equal(relayCalls.length, 1);

    // —— 时代 3：切回 sta1n。两个时代的旧图都正常显示 ——
    const view1Back = await context.handleImageRender(new Request(replayUrl(record1)), env);
    assert.equal(view1Back.status, 200);
    assert.equal(await bodyOf(view1Back), 'sta1n-image-bytes');
    const view2Back = await context.handleImageRender(new Request(replayUrl(record2)), env);
    assert.equal(view2Back.status, 200);
    assert.equal(await bodyOf(view2Back), 'relay-image-bytes', 'ynai 时期图片经 R2 统一拉取继续显示');
    assert.equal(relayCalls.length, 1);
    assert.equal(sta1nCalls.length, 1);
    // —— 时代 3：sta1n 新图生成正常 ——
    const era3 = await generate('STA1N-placeholder', 'prompt-three');
    assert.equal(era3.status, 200);
    assert.equal(await bodyOf(era3), 'sta1n-image-bytes');
    assert.equal(sta1nCalls.length, 2);
    assert.equal(store.writes.length, 3, '三个时代三张图，缓存不产生重复副本');
});
test('empty steps default splits by provider: ynai 28, sta1n 40', () => {
    const { context } = load();
    const sta1n = context.buildImageParams(new URL('https://offline.invalid/api/rp-image?tag=x&character_name=A..B'), 'fake-token');
    assert.equal(sta1n.steps, '40', 'sta1n 维持原默认');
    const ynai = context.buildImageParams(new URL('https://offline.invalid/api/rp-image?tag=x&character_name=A..B'), YNAI_TOKEN);
    assert.equal(ynai.steps, '28', 'ynai 中转默认 28');
    const explicit = context.buildImageParams(new URL('https://offline.invalid/api/rp-image?tag=x&steps=17&character_name=A..B'), '');
    assert.equal(explicit.steps, '17', '显式步数不被默认覆盖');
});
test('ynai model default follows the cloud adapter while sta1n keeps the builtin', () => {
    const { context } = load();
    const url = 'https://offline.invalid/api/rp-image?tag=x&character_name=A..B';
    assert.equal(context.buildImageParams(new URL(url), YNAI_TOKEN, 'cloud-model-a').model, 'cloud-model-a',
        'ynai 未显式带 model 时使用云端 defaultModel');
    assert.equal(context.buildImageParams(new URL(url), YNAI_TOKEN, null).model, 'nai-diffusion-4-5-full',
        '云端配置缺失时回退内置默认');
    assert.equal(context.buildImageParams(new URL(url), 'fake-token', 'cloud-model-a').model, 'nai-diffusion-4-5-full',
        'sta1n 忽略云端 defaultModel');
    assert.equal(context.buildImageParams(new URL(url + '&model=mine'), YNAI_TOKEN, 'cloud-model-a').model, 'mine',
        '显式 model 优先于云端默认');
});
test('ynai generation without an explicit model uses the cloud defaultModel end to end', async () => {
    const adapterJson = JSON.stringify({
        schema: 1,
        id: 'rp-hub',
        author: { script: { replacements: [{ name: 'x', find: 'a', replace: 'b' }] } },
        image: { ynai: { base: 'https://nai.rinko.ai', modelsPath: '/v1/models', generatePath: '/v1/images/generations', defaultModel: 'relay-default-9' } }
    });
    let captured;
    const { context } = load({ fetch: async (url, options) => {
        const u = String(url);
        if (u.startsWith('file:')) return new Response(adapterJson, { headers: { 'content-type': 'application/json' } });
        captured = { url: u, options };
        return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('png-bytes').toString('base64') }] }), { headers: { 'content-type': 'application/json' } });
    } });
    const store = bucket(); store.get = async () => null;
    const request = new Request(`https://offline.invalid/api/rp-image?token=${encodeURIComponent(YNAI_TOKEN)}&tag=test&character_name=A..B`, { method: 'POST' });
    const result = await context.handleImageRender(request, { RP_SYNC_R2: store, RPHUB_ADAPTER_URL: 'file:///adapter.json' });
    assert.equal(result.status, 200);
    assert.equal(JSON.parse(captured.options.body).model, 'relay-default-9', '生成请求使用云端默认模型');
});
test('validateAdapter keeps the author script path inside the rewritable candidate set', () => {
    const { context } = load();
    const base = { schema: 1, id: 'rp-hub', author: { script: { replacements: [{ name: 'x', find: 'a', replace: 'b' }] } } };
    assert.doesNotThrow(() => context.validateAdapter(base), '缺省 path 合法');
    assert.doesNotThrow(() => context.validateAdapter({
        ...base,
        author: { script: { path: '/assets/js/app.js', replacements: base.author.script.replacements } }
    }));
    assert.throws(
        () => context.validateAdapter({ ...base, author: { script: { path: '/other/app.js', replacements: base.author.script.replacements } } }),
        /适配清单脚本路径无效/
    );
});
test('legacy sta1n replay keys are stable with or without the provider param', () => {
    const { context } = load();
    const withParam = context.buildImageParams(new URL('https://offline.invalid/api/rp-image?provider=sta1n&tag=t&character_name=A..B'), '');
    const withoutParam = context.buildImageParams(new URL('https://offline.invalid/api/rp-image?tag=t&character_name=A..B'), '');
    assert.equal(withParam.provider, 'sta1n');
    assert.equal(withoutParam.provider, 'sta1n', '旧记录/旧页面无 provider 参数时同样落在 sta1n');
    assert.equal(context.buildImageSignature(withParam), context.buildImageSignature(withoutParam), '签名逐字节一致 → 旧图同一 R2 键');
});

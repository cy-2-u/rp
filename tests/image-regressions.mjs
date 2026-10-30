// 图片 API 回归：生图签名/键稳定、缓存与 ETag、墓碑优先、缩略图、24MiB
// 上限、ynai/sta1n 密钥路由、模型列表。上游全部在测试内拦截。
import { installHTMLRewriter, createWorkerHarness, assert, assertEqual } from './lib/worker.mjs';
import { sha256Hex } from './lib/r2.mjs';

installHTMLRewriter();

const CONFIG_WITH_YNAI = JSON.stringify({
    adapter: { externalUrl: '' },
    image: { ynai: { base: 'https://nai.rinko.ai', modelsPath: '/v1/models', generatePath: '/v1/images/generations', defaultModel: 'nai-diffusion-4-5-full' } }
});
const CONFIG_WITHOUT_YNAI = JSON.stringify({ adapter: { externalUrl: '' }, image: { ynai: null } });

function pngBytes(size = 1024) {
    const bytes = new Uint8Array(size);
    bytes[0] = 0x89; bytes[1] = 0x50;
    for (let index = 2; index < size; index += 1) bytes[index] = index & 0xff;
    return bytes;
}

function stubUpstream(harness, { bytes = pngBytes(), contentType = 'image/png' } = {}) {
    let upstreamCalls = 0;
    harness.outboundHandler = async parsed => {
        upstreamCalls += 1;
        if (parsed.host === 'nai.sta1n.cn') {
            return new Response(bytes.slice(), { status: 200, headers: { 'content-type': contentType } });
        }
        if (parsed.host === 'nai.rinko.ai' && parsed.pathname === '/v1/models') {
            return new Response(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] }), {
                status: 200, headers: { 'content-type': 'application/json' }
            });
        }
        return new Response('unexpected upstream', { status: 599 });
    };
    return () => upstreamCalls;
}

async function testGenerateAndCache() {
    const harness = createWorkerHarness({ assets: { '/config.json': CONFIG_WITH_YNAI, '/gallery.html': '<html>gallery</html>' } });
    const upstreamCount = stubUpstream(harness);

    let response = await harness.fetch('/api/rp-image?tag=cat&token=TOK&character_name=Alice', { method: 'POST' });
    assertEqual(response.status, 200, '首次生图成功');
    assertEqual(response.headers.get('content-type'), 'image/png', '生图内容类型');
    const keyHeader = response.headers.get('x-rp-image-key');
    assert(keyHeader, '返回 x-rp-image-key');
    const key = decodeURIComponent(keyHeader);
    assert(key.startsWith('rp-images/characters/Alice/'), '键按角色目录组织');
    assert(await harness.bucket._has(key), '原图落 R2');
    assertEqual(upstreamCount(), 1, '上游只调用一次');

    const etag = response.headers.get('etag');
    assert(etag, '生图响应带 ETag');

    // 同参数再次生图：命中缓存，不再调上游
    response = await harness.fetch('/api/rp-image?tag=cat&token=TOK&character_name=Alice', { method: 'POST' });
    assertEqual(response.status, 200, '同参数生图命中缓存');
    assertEqual(upstreamCount(), 1, '缓存命中不调上游');

    // key 直读 + 协商缓存
    response = await harness.fetch(`/api/rp-image?key=${encodeURIComponent(key)}`);
    assertEqual(response.status, 200, 'key 直读');
    assertEqual(await sha256Hex(new Uint8Array(await response.arrayBuffer())), await sha256Hex(pngBytes()), 'key 直读内容一致');
    response = await harness.fetch(`/api/rp-image?key=${encodeURIComponent(key)}`, { headers: { 'if-none-match': etag } });
    assertEqual(response.status, 304, 'ETag 协商 304');

    // GET 不生成：无缓存时 404
    response = await harness.fetch('/api/rp-image?tag=dog&token=TOK&character_name=Alice');
    assertEqual(response.status, 404, 'GET 缓存缺失 404 不生图');

    // 角色名净化：非法字符进入键前被替换
    response = await harness.fetch('/api/rp-image?tag=cat&token=TOK&character_name=A%2FB%2AC', { method: 'POST' });
    const unsafeKey = decodeURIComponent(response.headers.get('x-rp-image-key'));
    assert(unsafeKey.startsWith('rp-images/characters/A-B-C/'), '角色名净化进键');

    // 不同 tag 不同键
    response = await harness.fetch('/api/rp-image?tag=dog&token=TOK&character_name=Alice', { method: 'POST' });
    const key2 = decodeURIComponent(response.headers.get('x-rp-image-key'));
    assert(key2 !== key, '不同参数不同键');
    return { harness, key, etag };
}

async function testThumbAndTombstone({ harness, key, etag }) {
    // 缩略图写入需要原图存在
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]);
    let response = await harness.fetch(`/api/rp-image?key=${encodeURIComponent(key)}&thumb=1&token=TOK`, {
        method: 'PUT',
        headers: { 'content-type': 'image/webp' },
        body: webp
    });
    assertEqual(response.status, 200, '缩略图上传');
    response = await harness.fetch(`/api/rp-image?key=${encodeURIComponent(key)}&thumb=1`);
    assertEqual(response.status, 200, '缩略图读取');
    assertEqual(response.headers.get('content-type'), 'image/webp', '缩略图类型');
    const thumbKey = key.replace('rp-images/characters/', 'rp-images/thumbs/') + '.webp';
    assert(await harness.bucket._has(thumbKey), '缩略图对象存在');

    // 未知原图不能写缩略图
    response = await harness.fetch(`/api/rp-image?key=${encodeURIComponent('rp-images/characters/Ghost/' + '0'.repeat(64))}&thumb=1&token=TOK`, {
        method: 'PUT',
        headers: { 'content-type': 'image/webp' },
        body: webp
    });
    assertEqual(response.status, 404, '缺原图拒绝缩略图');

    // 图库管理端点：library / image / thumb
    response = await harness.fetch('/image/api/library');
    let body = await response.json();
    assertEqual(body.totalCount, 3, '图库统计（cat + dog + 净化角色）');
    assert(body.characters.some(character => character.name === 'Alice'), '图库含角色分组');

    response = await harness.fetch(`/image/api/image?key=${encodeURIComponent(key)}`);
    assertEqual(response.status, 200, '管理端原图读取');
    response = await harness.fetch(`/image/api/thumb?key=${encodeURIComponent(key)}`);
    assertEqual(response.status, 200, '管理端缩略图读取');

    // 两阶段删除：先墓碑后清理；读取端墓碑优先
    response = await harness.fetch('/image/api/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ keys: [key] })
    });
    body = await response.json();
    assertEqual(body.ok, true, '删除请求成功');
    assert(body.acceptedKeys.includes(key), '删除接受列表');
    const deletedKey = key.replace('rp-images/characters/', 'rp-images/_deleted/') + '.json';
    assert(await harness.bucket._has(deletedKey), '墓碑对象存在');

    response = await harness.fetch(`/api/rp-image?key=${encodeURIComponent(key)}`);
    assertEqual(response.status, 200, '已删除图片返回占位（不是旧图）');
    assert(response.headers.get('content-type').includes('image/svg+xml'), '占位为 SVG');
    response = await harness.fetch(`/api/rp-image?key=${encodeURIComponent(key)}`, { method: 'HEAD' });
    assert(response.headers.get('content-type').includes('image/svg+xml'), 'HEAD 同样墓碑优先');

    // 图库列表已排除 + 后台清理残留原图/缩略图
    for (let waited = 0; waited < 1000; waited += 25) {
        const listing = await harness.bucket.list({ prefix: 'rp-images/characters/Alice/' });
        if (!listing.objects.some(object => object.key === key)) break;
        await harness.fetch('/image/api/library');
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    response = await harness.fetch('/image/api/library');
    body = await response.json();
    const alice = body.characters.find(character => character.name === 'Alice');
    assert(alice, '删除单张后 Alice 组仍在');
    assert(!alice.images.some(image => image.key === key), '已删除的图不再出现在图库');
    assertEqual(body.totalCount, 2, '删除后总量（dog + 净化角色）');
}

async function testSizeLimit() {
    const harness = createWorkerHarness({ assets: { '/config.json': CONFIG_WITH_YNAI, '/gallery.html': '<html>gallery</html>' } });
    const oversized = pngBytes(25 * 1024 * 1024);
    stubUpstream(harness, { bytes: oversized });
    const response = await harness.fetch('/api/rp-image?tag=big&token=TOK&character_name=Alice', { method: 'POST' });
    assertEqual(response.status, 413, '超过 24MiB 拒绝');
}

async function testYnaiRouting() {
    const harness = createWorkerHarness({ assets: { '/config.json': CONFIG_WITH_YNAI, '/gallery.html': '<html>gallery</html>' } });
    // YNAI- 密钥 → 中转 POST JSON b64_json
    const b64 = Buffer.from(pngBytes()).toString('base64');
    let upstreamCalls = 0;
    harness.outboundHandler = async parsed => {
        upstreamCalls += 1;
        if (parsed.host === 'nai.rinko.ai' && parsed.pathname === '/v1/images/generations') {
            return new Response(JSON.stringify({ data: [{ b64_json: b64 }] }), {
                status: 200, headers: { 'content-type': 'application/json' }
            });
        }
        if (parsed.host === 'nai.rinko.ai' && parsed.pathname === '/v1/models') {
            return new Response(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] }), {
                status: 200, headers: { 'content-type': 'application/json' }
            });
        }
        return new Response('unexpected', { status: 599 });
    };
    let response = await harness.fetch('/api/rp-image?tag=cat&token=YNAI-secret&character_name=Alice', { method: 'POST' });
    assertEqual(response.status, 200, 'ynai 生图成功');
    assertEqual(upstreamCalls, 1, 'ynai 调用中转一次');
    const ynaiKey = decodeURIComponent(response.headers.get('x-rp-image-key'));
    assert(ynaiKey.startsWith('rp-images/characters/Alice/'), 'ynai 与 sta1n 共享键空间');

    // 模型列表
    response = await harness.fetch('/api/rp-image-models', { headers: { 'x-rp-image-token': 'YNAI-secret' } });
    let body = await response.json();
    assertEqual(body.ok, true, '模型列表成功');
    assertEqual(body.data.length, 2, '模型列表内容');
    response = await harness.fetch('/api/rp-image-models', { headers: { 'x-rp-image-token': 'plain' } });
    assertEqual(response.status, 401, '非 YNAI 密钥拒绝');
    assertEqual(upstreamCalls, 2, '模型列表调用一次上游（生成+列表）');

    // 配置缺失时 ynai 显式 503
    const bare = createWorkerHarness({ assets: { '/config.json': CONFIG_WITHOUT_YNAI, '/gallery.html': '<html>g</html>' } });
    bare.outboundHandler = async () => new Response('unexpected', { status: 599 });
    response = await bare.fetch('/api/rp-image?tag=cat&token=YNAI-secret&character_name=Alice', { method: 'POST' });
    assertEqual(response.status, 503, '无 ynai 配置显式 503');
    void ynaiKey;
}

async function testGalleryPage() {
    const harness = createWorkerHarness({ assets: { '/config.json': CONFIG_WITH_YNAI, '/gallery.html': '<html>角色图片管理</html>' } });
    const response = await harness.fetch('/image');
    assertEqual(response.status, 200, '图库页可访问');
    assert((await response.text()).includes('角色图片管理'), '图库页来自 gallery.html 资产');
}

async function main() {
    const ctx = await testGenerateAndCache();
    console.log('ok  生图签名/缓存/键稳定');
    await testThumbAndTombstone(ctx);
    console.log('ok  缩略图与墓碑两阶段删除');
    await testSizeLimit();
    console.log('ok  24MiB 有界上限');
    await testYnaiRouting();
    console.log('ok  ynai/sta1n 路由与模型列表');
    await testGalleryPage();
    console.log('ok  图库页资产');
    console.log('image-regressions: 全部通过');
}

main().catch(error => {
    console.error('image-regressions 失败:', error);
    process.exit(1);
});

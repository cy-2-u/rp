// 同步 v2 协议 + 适配脚本链 + 注入 + 代理冒烟。全部外网在测试内拦截。
import { installHTMLRewriter, createWorkerHarness, assert, assertEqual, manifestChecksumSource, sha256Text } from './lib/worker.mjs';
import { makePackBytes, sha256Hex } from './lib/r2.mjs';

installHTMLRewriter();

const AUTHOR_HTML = '<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body><div id="app"></div></body></html>';
const BUNDLED_ADAPTER = '(function(){ if (window.RPHubExternal) return; window.RPHubExternal = { version: 2, markers: ["bundled"] }; })();';
const EXTERNAL_ADAPTER = '(function(){ if (window.RPHubExternal) return; window.RPHubExternal = { version: 2, markers: ["external"] }; })();';
const DEFAULT_ASSETS = {
    '/config.json': JSON.stringify({ adapter: { externalUrl: '' }, image: { ynai: null } }),
    '/adapter/rp-hub-v2.js': BUNDLED_ADAPTER
};

function authorHarness(extra = {}) {
    return createWorkerHarness({
        assets: { ...DEFAULT_ASSETS, ...(extra.assets || {}) },
        authorResponses: new Map([
            ['/', { status: 200, contentType: 'text/html; charset=utf-8', body: AUTHOR_HTML }],
            ['/index.html', { status: 200, contentType: 'text/html; charset=utf-8', body: AUTHOR_HTML }],
            ['/other.html', { status: 200, contentType: 'text/html; charset=utf-8', body: AUTHOR_HTML }],
            ['/app.js', { status: 200, contentType: 'application/javascript', body: '// author app' }]
        ]),
        ...extra
    });
}

async function testBundledAdapterInjection() {
    const harness = authorHarness();
    const injected = await harness.fetch('/');
    assertEqual(injected.status, 200, '主页状态码');
    const text = await injected.text();
    assert(text.includes('src="/DB/dirty-tracker.js"'), '注入含 dirty-tracker');
    assert(text.includes('RPHubExternal'), '注入含适配脚本正文（内联）');
    assert(text.includes('src="/magic-extension.js"'), '注入含 magic-extension');
    assert(text.includes('src="/DB/bootstrap.js"'), '注入含 bootstrap');
    assert(text.includes('bundled'), '注入的是兜底脚本正文');
    assert(!text.includes('window.RPHUB_PAGE_ADAPTER'), '不再注入旧版元数据节点');

    const summary = await harness.fetch('/__rphub/adapter.json');
    const summaryBody = await summary.json();
    assertEqual(summaryBody.origin, 'bundled', '适配摘要来源');
    assert(summaryBody.sha256 && summaryBody.bytes > 0, '适配摘要含校验和');

    const lastGood = await harness.lastGood('rp-adapter/last-good-script-v2.js');
    assert(lastGood && lastGood.includes('bundled'), 'last-good 已持久化兜底脚本');

    // 非 HTML 路径原样代理、不改写；作者 app.js 保持原文。
    const script = await harness.fetch('/app.js');
    assertEqual(await script.text(), '// author app', '作者脚本原文');
    const other = await harness.fetch('/other.html');
    const otherText = await other.text();
    assert(otherText.includes('dirty-tracker') && !otherText.includes('RPHubExternal'), '非主页只注入 dirty-tracker');
}

async function testExternalAdapterPriority() {
    const dataUrl = 'data:text/javascript,' + encodeURIComponent(EXTERNAL_ADAPTER);
    const harness = authorHarness({ adapterExternalUrl: dataUrl });
    const summary = await harness.fetch('/__rphub/adapter.json');
    const body = await summary.json();
    assertEqual(body.origin, 'external', '外部脚本存在时优先');
    const injected = await (await harness.fetch('/')).text();
    assert(injected.includes('external'), '注入的是外部脚本正文');
}

async function testExternalFailureFallsBack() {
    const harness = authorHarness({ adapterExternalUrl: 'http://127.0.0.1:9/unreachable-adapter.js' });
    const summary = await harness.fetch('/__rphub/adapter.json');
    const body = await summary.json();
    assertEqual(body.origin, 'bundled', '外部源失败回退兜底脚本');
    // 外部脚本失败也持久化 last-good（兜底脚本内容）。
    const lastGood = await harness.lastGood('rp-adapter/last-good-script-v2.js');
    assert(lastGood && lastGood.includes('bundled'), '失败回退后 last-good 仍可用');
}

function buildRoot(packs, { version = 1, updatedAt = Date.now() } = {}) {
    const root = {
        format: 'rp-sync-manifest-v2',
        version,
        updatedAt,
        compression: 'gzip',
        totalBytes: packs.reduce((sum, pack) => sum + pack.length, 0),
        entryCount: packs.reduce((sum, pack) => sum + pack.entries, 0),
        packs
    };
    root.checksum = null;
    return sha256Text(manifestChecksumSource(root)).then(checksum => ({ ...root, checksum }));
}

async function testSyncProtocol() {
    const harness = authorHarness();
    const post = (body, extra = {}) => harness.fetch('/api/rp-sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...extra },
        body: JSON.stringify(body)
    });

    // 空云端
    let response = await post({ action: 'status' });
    let body = await response.json();
    assertEqual(body.manifest, null, '空云端 status');

    // 放一个分片
    const pack1 = await makePackBytes('{"type":"localStorage","key":"a","value":"1"}\n{"type":"database","name":"RPHubDB","version":1,"stores":[]}\n');
    const sha1 = await sha256Hex(pack1);
    response = await harness.fetch(`/api/rp-sync/pack?checksum=${sha1}&length=${pack1.byteLength}&entries=2`, {
        method: 'PUT',
        headers: { 'content-type': 'application/gzip' },
        body: pack1
    });
    assertEqual(response.status, 204, '分片首次上传');
    // 幂等重传
    response = await harness.fetch(`/api/rp-sync/pack?checksum=${sha1}&length=${pack1.byteLength}&entries=2`, {
        method: 'PUT',
        headers: { 'content-type': 'application/gzip' },
        body: pack1
    });
    assertEqual(response.status, 204, '分片幂等重传');

    // 校验和与内容不符 → 409
    const lying = await makePackBytes('different content');
    response = await harness.fetch(`/api/rp-sync/pack?checksum=${sha1}&length=${lying.byteLength}&entries=1`, {
        method: 'PUT',
        headers: { 'content-type': 'application/gzip' },
        body: lying
    });
    assertEqual(response.status, 409, '同校验和不同内容拒绝');

    // 缺包 commit → 409 missing
    const ghostSha = 'a'.repeat(64);
    const ghostRoot = await buildRoot([{ bucket: 'store:X:data|s001', checksum: ghostSha, length: 10, entries: 1 }]);
    response = await post({ action: 'commit', manifest: ghostRoot });
    assertEqual(response.status, 409, '缺包提交 409');
    body = await response.json();
    assert(Array.isArray(body.missing) && body.missing.includes(ghostSha), 'missing 列表返回缺失校验码');

    // 正常提交
    const root1 = await buildRoot([{ bucket: 'store:X:data|s001', checksum: sha1, length: pack1.byteLength, entries: 2 }]);
    response = await post({ action: 'commit', manifest: root1 });
    body = await response.json();
    assertEqual(body.ok, true, '首次提交成功');
    assertEqual(body.manifest.version, 1, '首次提交版本');
    assertEqual(body.manifest.packs.length, 1, '根清单含完整分片列表');
    assertEqual(body.manifest.checksum, root1.checksum, '提交返回根校验和');

    // status 返回完整根
    response = await post({ action: 'status' });
    body = await response.json();
    assertEqual(body.manifest.checksum, root1.checksum, 'status 根一致');
    assertEqual(body.manifest.packs.length, 1, 'status 含分片列表');

    // 同根幂等提交
    response = await post({ action: 'commit', manifest: root1 });
    body = await response.json();
    assertEqual(body.committed, true, '同根幂等提交');
    assertEqual(body.manifest.version, 1, '幂等提交不推进版本');

    // 分片下载
    response = await harness.fetch(`/api/rp-sync/pack?c=${sha1}`);
    assertEqual(response.status, 200, '分片下载');
    const downloaded = new Uint8Array(await response.arrayBuffer());
    assertEqual(downloaded.byteLength, pack1.byteLength, '分片下载长度');
    assertEqual(await sha256Hex(downloaded), sha1, '分片下载校验和');
    assertEqual(response.headers.get('x-rp-sync-entries'), '2', 'entries 响应头');

    // 未知分片
    response = await harness.fetch(`/api/rp-sync/pack?c=${'b'.repeat(64)}`);
    assertEqual(response.status, 404, '未知分片 404');

    // 第二个快照：新分片替换旧分片 → 版本推进 + 孤儿回收
    const pack2 = await makePackBytes('{"type":"localStorage","key":"b","value":"2"}\n');
    const sha2 = await sha256Hex(pack2);
    await harness.fetch(`/api/rp-sync/pack?checksum=${sha2}&length=${pack2.byteLength}&entries=1`, {
        method: 'PUT',
        headers: { 'content-type': 'application/gzip' },
        body: pack2
    });
    const root2 = await buildRoot([{ bucket: 'store:X:data|s001', checksum: sha2, length: pack2.byteLength, entries: 1 }], { version: 2 });
    response = await post({ action: 'commit', manifest: root2 });
    body = await response.json();
    assertEqual(body.ok, true, '第二次提交成功');
    assertEqual(body.manifest.version, 2, '版本推进');
    await new Promise(resolve => setTimeout(resolve, 30));
    const listing = await harness.bucket.list({ prefix: 'rp-sync/v2/packs/' });
    assertEqual(listing.objects.length, 1, '孤儿分片已回收');
    assertEqual(listing.objects[0].key, `rp-sync/v2/packs/${sha2}.bin`, '保留的是新根分片');

    // CAS 收敛：手工改写根（模拟另一页面已推进）后，过期版本号的提交被拒，
    // 客户端按最新远端版本重建根后重新提交成功。
    await harness.fetch(`/api/rp-sync/pack?checksum=${sha1}&length=${pack1.byteLength}&entries=2`, {
        method: 'PUT',
        headers: { 'content-type': 'application/gzip' },
        body: pack1
    });
    const staleRoot = await buildRoot([{ bucket: 'store:X:data|s001', checksum: sha1, length: pack1.byteLength, entries: 2 }], { version: 2 });
    const manifestObject = await harness.bucket.get('rp-sync/v2/manifest.json');
    const currentRoot = JSON.parse(await manifestObject.text());
    const manualRoot = { ...root2, updatedAt: currentRoot.updatedAt + 1, checksum: null };
    manualRoot.checksum = await sha256Text(manifestChecksumSource(manualRoot));
    await harness.bucket.put('rp-sync/v2/manifest.json', JSON.stringify(manualRoot));
    response = await post({ action: 'commit', manifest: staleRoot });
    assertEqual(response.status, 409, '落后版本提交被拒');
    body = await response.json();
    assertEqual(body.currentVersion, 2, '拒绝时返回当前版本');
    const root3 = await buildRoot([{ bucket: 'store:X:data|s001', checksum: sha1, length: pack1.byteLength, entries: 2 }], { version: 3 });
    response = await post({ action: 'commit', manifest: root3 });
    body = await response.json();
    assertEqual(body.ok, true, '按最新版本重建后提交成功');
    assertEqual(body.manifest.version, 3, '收敛提交推进版本');
    assertEqual(body.manifest.checksum, root3.checksum, '收敛提交根正确');

    // sweep：近期孤儿跳过、过期孤儿删除
    const orphanRecent = await makePackBytes('orphan-recent');
    const orphanOld = await makePackBytes('orphan-old');
    const recentKey = `rp-sync/v2/packs/${await sha256Hex(orphanRecent)}.bin`;
    const oldKey = `rp-sync/v2/packs/${await sha256Hex(orphanOld)}.bin`;
    await harness.bucket.put(recentKey, orphanRecent);
    await harness.bucket.put(oldKey, orphanOld);
    harness.bucket._age(oldKey, 2 * 60 * 60 * 1000);
    response = await post({ action: 'sweep' });
    body = await response.json();
    assertEqual(body.deleted, 1, 'sweep 删除过期孤儿');
    assert(await harness.bucket._has(recentKey), 'sweep 跳过近期孤儿');
    assert(await harness.bucket._has(`rp-sync/v2/packs/${sha1}.bin`), 'sweep 不动当前根分片');
}

async function testSyncAuth() {
    const harness = authorHarness({ password: 'secret-pw' });
    const post = (body, headers = {}) => harness.fetch('/api/rp-sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body)
    });

    let response = await post({ action: 'status' });
    assertEqual(response.status, 401, '无密码 401');
    let body = await response.json();
    assertEqual(body.authRequired, true, '401 附带 authRequired');

    response = await post({ action: 'status' }, { 'x-rp-sync-password': 'wrong' });
    assertEqual(response.status, 401, '错误密码 401');

    response = await post({ action: 'auth-status' }, { 'x-rp-sync-password': 'wrong' });
    body = await response.json();
    assertEqual(body.authenticated, false, 'auth-status 错误密码');
    assertEqual(body.authRequired, true, 'auth-status 要求密码');

    response = await post({ action: 'status' }, { 'x-rp-sync-password': 'secret-pw' });
    assertEqual(response.status, 200, '正确密码放行');

    const pack = await makePackBytes('x');
    response = await harness.fetch(`/api/rp-sync/pack?checksum=${await sha256Hex(pack)}&length=${pack.byteLength}&entries=1`, {
        method: 'PUT',
        headers: { 'content-type': 'application/gzip' },
        body: pack
    });
    assertEqual(response.status, 401, '分片上传需要密码');

    response = await harness.fetch(`/api/rp-sync/pack?c=${'c'.repeat(64)}`);
    assertEqual(response.status, 401, '分片下载需要密码');
}

async function main() {
    await testBundledAdapterInjection();
    console.log('ok  适配脚本链与主页注入');
    await testExternalAdapterPriority();
    console.log('ok  外部脚本优先');
    await testExternalFailureFallsBack();
    console.log('ok  外部脚本失败回退');
    await testSyncProtocol();
    console.log('ok  同步 v2 协议（上传/提交/幂等/CAS/回收/下载）');
    await testSyncAuth();
    console.log('ok  同步密码门禁');
    console.log('protocol-smoke: 全部通过');
}

main().catch(error => {
    console.error('protocol-smoke 失败:', error);
    process.exit(1);
});

// 部署器 Worker 全流程离线测试：mock fetch（raw 文件读本地 page/，CF API 返回可控应答），
// 断言完整/更新两种模式的请求序列与载荷形状（对照 wrangler 源码），并覆盖主要错误路径。
// 运行：node deployer/test-flow.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const workerSrc = readFileSync(join(here, 'worker.js'), 'utf8');
const worker = (await import('data:text/javascript;base64,' + Buffer.from(workerSrc).toString('base64'))).default;

const pageDir = join(here, '..', 'page');
const RAW_PREFIX = 'https://raw.githubusercontent.com/cy-2-u/rp/main/page/';
const API_BASE = 'https://api.cloudflare.com/client/v4';
const TOKEN = 'tok-abc-123';
const PASSWORD = 'pw-123';
const ASSET_PATHS = ['/pages/assets/check-missing', '/pages/assets/upload', '/pages/assets/upsert-hashes'];

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; }
  else { fail++; console.log('FAIL ' + name + (extra ? ' — ' + extra : '')); }
}

// ---------- mock fetch ----------
const realFetch = globalThis.fetch;
let calls = [], saved = {}, mock = {}, uploaded = null;

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const method = init.method || 'GET';
  const auth = (init.headers && (init.headers.Authorization || init.headers.authorization)) || '';
  const short = u.startsWith(API_BASE) ? u.slice(API_BASE.length) : u;
  calls.push({ short, method, auth });

  if (u.startsWith(RAW_PREFIX)) {
    const rel = decodeURIComponent(u.slice(RAW_PREFIX.length).split('?')[0]);
    try { return new Response(readFileSync(join(pageDir, rel))); }
    catch { return new Response('not found', { status: 404 }); }
  }

  if (short === '/accounts' && method === 'GET') {
    if (mock.accountsFail) return jsonResponse({ success: false, errors: [{ message: 'Invalid Token' }] }, 403);
    return jsonResponse({ success: true, result: [{ id: 'acc1', name: 'tester' }] });
  }
  if (short === '/accounts/acc1/r2/buckets/rp' && method === 'GET') {
    if (mock.r2Exists) return jsonResponse({ success: true, result: { name: 'rp' } });
    return jsonResponse({ success: false, errors: [{ code: 10006, message: 'bucket not found' }] }, 404);
  }
  if (short === '/accounts/acc1/r2/buckets' && method === 'POST') {
    saved.bucketBody = JSON.parse(init.body);
    if (mock.r2Fail) return jsonResponse({ success: false, errors: [{ code: 10005, message: mock.r2Fail }] });
    return jsonResponse({ success: true, result: { name: 'rp' } });
  }
  if (u.endsWith('/pages/projects') && method === 'POST') {
    saved.createCalls = (saved.createCalls || 0) + 1;
    const body = JSON.parse(init.body);
    if (mock.projectConflict && saved.createCalls === 1) {
      return jsonResponse({ success: false, errors: [{ code: 8000006, message: 'project already exists' }] });
    }
    if (mock.projectConflict) saved.secondName = body.name;
    saved.projectBody = body;
    return jsonResponse({ success: true, result: { name: body.name } });
  }
  if (/\/pages\/projects\/name1$/.test(short) && method === 'GET') {
    return jsonResponse({ success: false, errors: [{ code: 8000007, message: 'project not found' }] }, 404);
  }
  if (/\/pages\/projects\/[^/]+$/.test(short) && method === 'PATCH') {
    saved.patches = saved.patches || [];
    saved.patches.push(JSON.parse(init.body));
    return jsonResponse({ success: true, result: {} });
  }
  if (/\/pages\/projects\/[^/]+\/upload-token$/.test(short)) return jsonResponse({ success: true, result: { jwt: 'jwt-123' } });
  if (short === '/pages/assets/check-missing' && method === 'POST') {
    saved.checkAuth = saved.checkAuth || [];
    saved.checkAuth.push(auth);
    const body = JSON.parse(init.body);
    const missing = body.hashes.filter(h => !uploaded.has(h));
    return jsonResponse({ success: true, result: missing });
  }
  if (short === '/pages/assets/upload' && method === 'POST') {
    saved.uploadAuth = saved.uploadAuth || [];
    saved.uploadAuth.push(auth);
    const payload = JSON.parse(init.body);
    saved.uploadPayloads = saved.uploadPayloads || [];
    saved.uploadPayloads.push(payload);
    for (const e of payload) uploaded.add(e.key);
    return jsonResponse({ success: true, result: null });
  }
  if (short === '/pages/assets/upsert-hashes' && method === 'POST') return jsonResponse({ success: true, result: null });
  if (/\/pages\/projects\/[^/]+\/deployments$/.test(short) && method === 'POST') {
    saved.deployAuth = saved.deployAuth || [];
    saved.deployAuth.push(auth);
    saved.deployForms = saved.deployForms || [];
    saved.deployForms.push(init.body);
    saved.deployCalls = (saved.deployCalls || 0) + 1;
    return jsonResponse({ success: true, result: { id: 'dep' + saved.deployCalls, url: 'https://' + saved.projectBody.name + '.pages.dev' } });
  }
  if (/\/deployments\/dep\d+$/.test(short)) return jsonResponse({ success: true, result: { latest_stage: { name: 'deploy', status: 'success' } } });

  return jsonResponse({ success: false, errors: [{ message: 'unexpected mock call: ' + method + ' ' + short }] }, 500);
};

async function deploy(body, ip) {
  calls = []; saved = {}; mock = {}; uploaded = new Set();
  const req = new Request('http://deployer.local/api/deploy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': ip || ('ip-' + Math.random()) },
    body: JSON.stringify(body),
  });
  const res = await worker.fetch(req);
  return { res, data: await res.json() };
}

// ---------- 1. 完整模式（R2 桶不存在）----------
{
  const { res, data } = await deploy({ token: TOKEN, password: PASSWORD, projectName: 'test1' }, 'ip-main');
  ok(res.status === 200 && data.ok === true, '完整模式 ok', JSON.stringify(data));
  ok(data.url === 'https://test1.pages.dev' && data.projectName === 'test1', '返回网址与项目名');
  ok(data.mode === 'full', '模式标记 full');

  // 序列：探测账号 → 建项目 → 上传#1 → 建桶 → PATCH → 上传#2
  ok(calls[0].short === '/accounts' && calls[0].method === 'GET', '第一步探测账号');
  ok(calls.some(c => c.method === 'POST' && c.short.endsWith('/r2/buckets')), '创建存储桶');
  const depIdx = calls.map(c => c.method + ' ' + c.short).map(s => s.endsWith('/deployments') ? 1 : 0);
  const patchIdx = calls.findIndex(c => c.method === 'PATCH' && /\/pages\/projects\/test1$/.test(c.short));
  const firstDep = depIdx.indexOf(1), secondDep = depIdx.lastIndexOf(1);
  ok(saved.deployCalls === 2, '完整模式部署两次', String(saved.deployCalls));
  ok(patchIdx > firstDep && patchIdx < secondDep, 'PATCH 位于两次部署之间');
  ok(calls.some(c => c.short === '/accounts/acc1/r2/buckets/rp'), '先探测固定桶 rp');

  // 建桶固定名
  ok(saved.bucketBody && saved.bucketBody.name === 'rp', '存储桶名固定为 rp', JSON.stringify(saved.bucketBody));

  // PATCH 形状
  ok(saved.patches && saved.patches.length === 1, 'PATCH 一次');
  const pc = saved.patches[0].deployment_configs.production;
  ok(pc.env_vars.RP_SYNC_PASSWORD.value === PASSWORD && pc.env_vars.RP_SYNC_PASSWORD.type === 'plain_text', '文本密码变量');
  ok(pc.r2_buckets.RP_SYNC_R2.bucket_id === 'rp', 'R2 绑定');

  // 上传增量：第二次部署不再上传资产
  ok(saved.uploadPayloads && saved.uploadPayloads.length === 1, '资产只上传一次（第二次增量跳过）', String(saved.uploadPayloads && saved.uploadPayloads.length));
  ok(saved.uploadPayloads[0].length === 4, '4 个资产文件');

  // 鉴权分离
  ok(saved.checkAuth.every(a => a === 'Bearer jwt-123') && saved.uploadAuth.every(a => a === 'Bearer jwt-123'), '资产端点用 upload JWT');
  ok(saved.deployAuth.every(a => a === 'Bearer ' + TOKEN), 'deployment 用 API 令牌');
  ok(!JSON.stringify(data).includes(TOKEN), '响应不回显令牌');

  // 第一次 deployment 的 multipart 形状
  const form = saved.deployForms[0];
  ok(form instanceof FormData, 'deployment 是 multipart');
  const manifest = JSON.parse(await form.get('manifest'));
  const keys = Object.keys(manifest).sort();
  ok(JSON.stringify(keys) === JSON.stringify(['/DB/bootstrap.js', '/DB/dirty-tracker.js', '/DB/styles.css', '/magic-extension.js']), 'manifest 键（含前导斜杠、无 _worker.js）');
  ok(Object.values(manifest).every(h => /^[0-9a-f]{32}$/.test(h)), 'manifest 哈希格式');
  const wb = form.get('_worker.bundle');
  ok(wb !== null && (await wb.text()) === readFileSync(join(pageDir, '_worker.js'), 'utf8'), '_worker.bundle 与 page/_worker.js 一致');
  const byContent = saved.uploadPayloads[0].find(e => e.value === Buffer.from(readFileSync(join(pageDir, 'magic-extension.js'))).toString('base64'));
  ok(!!byContent, 'magic-extension.js 内容与仓库一致');
}

// ---------- 2. 更新模式（R2 桶已存在）----------
{
  const { data } = await deploy({ token: TOKEN, password: PASSWORD, projectName: 'test2' }, 'ip-update');
  // deploy() 重置 mock——重新注入 r2Exists 再来一次
}
{
  calls = []; saved = {}; mock = { r2Exists: true }; uploaded = new Set(['h1', 'h2', 'h3', 'h4']);
  // 注：check-missing 需要真实哈希才命中 uploaded——这里改为空集让上传走增量判断
  uploaded = new Set();
  const req = new Request('http://deployer.local/api/deploy', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': 'ip-update' },
    body: JSON.stringify({ token: TOKEN, password: PASSWORD, projectName: 'test2' }),
  });
  const res = await worker.fetch(req);
  const data = await res.json();
  ok(data.ok === true && data.mode === 'update', '更新模式 ok', JSON.stringify(data));
  ok(saved.deployCalls === 1, '更新模式只部署一次', String(saved.deployCalls));
  ok(!saved.bucketBody, '更新模式不创建存储桶');
  ok(saved.patches && saved.patches.length === 1, '更新模式仍同步密码变量');
  ok(saved.patches[0].deployment_configs.production.r2_buckets.RP_SYNC_R2.bucket_id === 'rp', '更新模式 PATCH 绑定');
}

// ---------- 3. R2 未开通（完整模式建桶失败）----------
{
  calls = []; saved = {}; mock = { r2Fail: 'You must purchase the R2 plan before creating buckets' }; uploaded = new Set();
  const req = new Request('http://deployer.local/api/deploy', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': 'ip-r2' },
    body: JSON.stringify({ token: TOKEN, password: PASSWORD, projectName: 'test3' }),
  });
  const res = await worker.fetch(req);
  const data = await res.json();
  ok(data.ok === false && data.code === 'R2_NOT_ENABLED', 'R2 未开通 → R2_NOT_ENABLED', JSON.stringify(data));
  ok(saved.deployCalls === 1, '失败发生在第二次上传之前');
}

// ---------- 4. 项目重名：本账号没有 → 自动换后缀 ----------
{
  calls = []; saved = {}; mock = { projectConflict: true }; uploaded = new Set();
  const req = new Request('http://deployer.local/api/deploy', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': 'ip-conflict' },
    body: JSON.stringify({ token: TOKEN, password: PASSWORD, projectName: 'name1' }),
  });
  const res = await worker.fetch(req);
  const data = await res.json();
  ok(data.ok === true && data.projectName === saved.secondName && data.projectName !== 'name1', '重名自动换后缀', JSON.stringify(data));
  ok(data.url === 'https://' + saved.secondName + '.pages.dev', '换后缀后网址一致');
}

// ---------- 5. 令牌无效 ----------
{
  calls = []; saved = {}; mock = { accountsFail: true }; uploaded = new Set();
  const req = new Request('http://deployer.local/api/deploy', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': 'ip-bad' },
    body: JSON.stringify({ token: TOKEN, password: PASSWORD }),
  });
  const data = await (await worker.fetch(req)).json();
  ok(data.ok === false && /令牌/.test(data.error), '令牌无效提示', JSON.stringify(data));
}

// ---------- 6. 缺参 ----------
{
  const req = new Request('http://deployer.local/api/deploy', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': 'ip-empty' },
    body: JSON.stringify({ token: '' }),
  });
  const data = await (await worker.fetch(req)).json();
  ok(data.ok === false && /令牌和密码/.test(data.error), '缺参提示');
}

// ---------- 7. OPTIONS CORS ----------
{
  const req = new Request('http://deployer.local/api/deploy', { method: 'OPTIONS', headers: { 'Origin': 'https://cy-2-u.github.io' } });
  const res = await worker.fetch(req);
  ok(res.status === 204 && res.headers.get('access-control-allow-origin') === 'https://cy-2-u.github.io', 'OPTIONS 预检');
}

// ---------- 8. 限速 ----------
{
  let hit429 = false;
  for (let i = 0; i < 12; i++) {
    const req = new Request('http://deployer.local/api/deploy', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': 'ip-rate' },
      body: JSON.stringify({ token: 'x', password: 'y' }),
    });
    const res = await worker.fetch(req);
    if (res.status === 429) { hit429 = true; break; }
  }
  ok(hit429, '同 IP 限速 429');
}

globalThis.fetch = realFetch;
console.log(`test-flow: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);

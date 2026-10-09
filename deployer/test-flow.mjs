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

// 魔改版标记配置（对照 worker.js 的 isModProject：PASSWORD 变量 + R2 绑定）
function modProjectConfig(name) {
  return {
    name,
    subdomain: { name },
    deployment_configs: {
      production: {
        env_vars: { RP_SYNC_PASSWORD: { type: 'plain_text', value: 'irrelevant' } },
        r2_buckets: { RP_SYNC_R2: { name: 'rphub' } },
      },
    },
  };
}
function plainProjectConfig(name) {
  return {
    name,
    subdomain: { name },
    deployment_configs: { production: { env_vars: { OTHER: { type: 'plain_text', value: 'x' } } } },
  };
}

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const method = init.method || 'GET';
  const auth = (init.headers && (init.headers.Authorization || init.headers.authorization)) || '';
  const short = u.startsWith(API_BASE) ? u.slice(API_BASE.length) : u;
  const ctHeader = (init.headers && (init.headers['Content-Type'] || init.headers['content-type'])) || '';
  calls.push({ short, method, auth, ct: ctHeader });

  if (u.startsWith(RAW_PREFIX)) {
    const rel = decodeURIComponent(u.slice(RAW_PREFIX.length).split('?')[0]);
    try { return new Response(readFileSync(join(pageDir, rel))); }
    catch { return new Response('not found', { status: 404 }); }
  }

  if (short === '/accounts' && method === 'GET') {
    if (mock.accountsFail) return jsonResponse({ success: false, errors: [{ message: 'Invalid Token' }] }, 403);
    return jsonResponse({ success: true, result: [{ id: 'acc1', name: 'tester' }] });
  }
  if (short === '/accounts/acc1/r2/buckets/rphub' && method === 'GET') {
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
    return jsonResponse({ success: true, result: { name: body.name, subdomain: { name: body.name } } });
  }
  if (u.endsWith('/pages/projects') && method === 'GET') {
    // 项目列表：mock.projects 为空数组 → 空列表；未设置 → 视为令牌无权限
    if (!mock.projects) return jsonResponse({ success: false, errors: [{ message: 'Authentication error' }] }, 403);
    return jsonResponse({ success: true, result: mock.projects });
  }
  if (/\/pages\/projects\/name1$/.test(short) && method === 'GET') {
    return jsonResponse({ success: false, errors: [{ code: 8000007, message: 'project not found' }] }, 404);
  }
  if (/\/pages\/projects\/[^/]+$/.test(short) && method === 'GET') {
    // 单项目探测：mock.probe 提供 deployment_configs（缺省按项目名区分 mod-*/plain-*）
    const name = short.split('/').pop();
    if (mock.missing && mock.missing.includes(name)) {
      return jsonResponse({ success: false, errors: [{ code: 8000007, message: 'project not found' }] }, 404);
    }
    const probe = mock.probe && Object.prototype.hasOwnProperty.call(mock.probe, name)
      ? mock.probe[name]
      : (name.startsWith('mod-') ? modProjectConfig(name) : plainProjectConfig(name));
    return jsonResponse({ success: true, result: probe });
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
    saved.deployCalls = (saved.deployCalls || 0) + 1;
    if (mock.deployTransientFails) {
      mock.deployTransientFails -= 1;
      return jsonResponse({ success: false, errors: [{ code: 8000000, message: 'transient deployment error' }] }, 500);
    }
    const ct = (init.headers && (init.headers['Content-Type'] || init.headers['content-type'])) || '';
    const bm = /boundary=([^;\s]+)/.exec(ct);
    const text = new TextDecoder('utf8').decode(init.body);
    saved.deployRaw = text;
    const parts = text.split('--' + (bm ? bm[1] : '@@none@@'));
    const manifestPart = parts.find(p => p.includes('name="manifest"'));
    const branchPart = parts.find(p => p.includes('name="branch"'));
    const workerPart = parts.find(p => p.includes('name="_worker.bundle"'));
    saved.deployManifests = saved.deployManifests || [];
    saved.deployCommitDirty = saved.deployCommitDirty || [];
    saved.deployCommitDirty.push(parts.some(p => p.includes('name="commit_dirty"')) ? 'true' : null);
    saved.deployBranches = saved.deployBranches || [];
    saved.deployWorkers = saved.deployWorkers || [];
    try {
      saved.deployManifests.push(JSON.parse(manifestPart.split('\r\n\r\n')[1]));
    } catch { saved.deployManifests.push(null); }
    saved.deployBranches.push(branchPart ? branchPart.split('\r\n\r\n')[1].replace(/\r\n$/, '') : null);
    if (workerPart) {
      const seg = workerPart.split('\r\n\r\n');
      const innerText = seg.slice(1).join('\r\n\r\n').replace(/\r\n$/, '');
      const innerBoundary = /^--([^\r\n]+)/.exec(innerText);
      saved.deployMeta = saved.deployMeta || [];
      if (innerBoundary) {
        const innerParts = innerText.split('--' + innerBoundary[1]);
        const metaPart = innerParts.find(p => p.includes('name="metadata"'));
        const workerInner = innerParts.find(p => p.includes('name="_worker.js"'));
        try { saved.deployMeta.push(JSON.parse(metaPart.split('\r\n\r\n')[1])); } catch { saved.deployMeta.push(null); }
        const wSeg = workerInner.split('\r\n\r\n');
        saved.deployWorkers.push(wSeg.slice(1).join('\r\n\r\n').replace(/\r\n$/, ''));
      } else { saved.deployMeta.push(null); saved.deployWorkers.push(innerText); }
    } else { saved.deployMeta = saved.deployMeta || []; saved.deployWorkers.push(null); }
    return jsonResponse({ success: true, result: { id: 'dep' + saved.deployCalls, url: 'https://' + (short.split('/pages/projects/')[1] || '').split('/')[0] + '.pages.dev' } });
  }
  if (/\/deployments\/dep\d+$/.test(short)) return jsonResponse({ success: true, result: { latest_stage: { name: 'deploy', status: 'success' } } });

  return jsonResponse({ success: false, errors: [{ message: 'unexpected mock call: ' + method + ' ' + short }] }, 500);
};

async function deploy(body, ip, path = '/api/deploy', mockInit) {
  calls = []; saved = {}; mock = mockInit || {}; uploaded = new Set();
  const req = new Request('http://deployer.local' + path, {
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
  ok(calls.some(c => c.short === '/accounts/acc1/r2/buckets/rphub'), '先探测固定桶 rphub');

  // 建桶固定名
  ok(saved.bucketBody && saved.bucketBody.name === 'rphub', '存储桶名固定为 rphub', JSON.stringify(saved.bucketBody));

  // PATCH 形状
  ok(saved.patches && saved.patches.length === 1, 'PATCH 一次');
  const pc = saved.patches[0].deployment_configs.production;
  ok(pc.env_vars.RP_SYNC_PASSWORD.value === PASSWORD && pc.env_vars.RP_SYNC_PASSWORD.type === 'plain_text', '文本密码变量');
  ok(pc.r2_buckets.RP_SYNC_R2.name === 'rphub', 'R2 绑定');

  // 上传增量：第二次部署不再上传资产
  ok(saved.uploadPayloads && saved.uploadPayloads.length === 1, '资产只上传一次（第二次增量跳过）', String(saved.uploadPayloads && saved.uploadPayloads.length));
  ok(saved.uploadPayloads[0].length === 3, '3 个资产文件');

  // 鉴权分离
  ok(saved.checkAuth.every(a => a === 'Bearer jwt-123') && saved.uploadAuth.every(a => a === 'Bearer jwt-123'), '资产端点用 upload JWT');
  ok(saved.deployAuth.every(a => a === 'Bearer ' + TOKEN), 'deployment 用 API 令牌');
  ok(!JSON.stringify(data).includes(TOKEN), '响应不回显令牌');

  // 第一次 deployment 的 multipart 形状（手动构造体）
  const manifest = saved.deployManifests[0];
  ok(!!manifest, 'deployment multipart 含 manifest');
  ok(saved.deployRaw.includes(JSON.stringify(manifest) + '\r\n--'), 'manifest 部件后有 CRLF（服务端 multipart 严格解析必需）');
  const keys = Object.keys(manifest).sort();
  ok(JSON.stringify(keys) === JSON.stringify(['/DB/bootstrap.js', '/DB/dirty-tracker.js', '/magic-extension.js']), 'manifest 键（含前导斜杠、无 _worker.js）');
  ok(Object.values(manifest).every(h => /^[0-9a-f]{32}$/.test(h)), 'manifest 哈希格式');
  ok(saved.deployBranches[0] === null, '不含 branch 字段（API 会拒绝）');
  ok(saved.deployCommitDirty && saved.deployCommitDirty[0] === 'true', '含 commit_dirty=true');
  ok(saved.deployMeta && saved.deployMeta[0] && saved.deployMeta[0].main_module === '_worker.js', '内层 metadata main_module');
  ok(saved.deployWorkers[0] === readFileSync(join(pageDir, '_worker.js'), 'utf8'), '_worker.bundle 内层模块与 page/_worker.js 一致');
  ok(calls.some(c => (c.ct || '').includes('multipart/form-data; boundary=')), 'deployment 带 multipart boundary');
  const byContent = saved.uploadPayloads[0].find(e => e.value === Buffer.from(readFileSync(join(pageDir, 'magic-extension.js'))).toString('base64'));
  ok(!!byContent, 'magic-extension.js 内容与仓库一致');
}

// ---------- 2. 更新模式（R2 桶已存在）----------
{
  await deploy({ token: TOKEN, password: PASSWORD, projectName: 'test2' }, 'ip-update');
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
  ok(saved.patches[0].deployment_configs.production.r2_buckets.RP_SYNC_R2.name === 'rphub', '更新模式 PATCH 绑定');
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
    body: JSON.stringify({ token: TOKEN, password: PASSWORD, projectName: 'test4' }),
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

// ---------- 6b. 项目名必填 ----------
{
  const req = new Request('http://deployer.local/api/deploy', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': 'ip-noname' },
    body: JSON.stringify({ token: TOKEN, password: PASSWORD }),
  });
  const data = await (await worker.fetch(req)).json();
  ok(data.ok === false && /项目名/.test(data.error), '项目名必填提示', JSON.stringify(data));
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

// ---------- 9. 部署 POST 瞬态错误自动重试（对齐 wrangler 8000000 重试语义） ----------
{
  calls = []; saved = {}; mock = { r2Exists: true, deployTransientFails: 1 }; uploaded = new Set();
  const req = new Request('http://deployer.local/api/deploy', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': 'ip-retry' },
    body: JSON.stringify({ token: TOKEN, password: PASSWORD, projectName: 'test9' }),
  });
  const res = await worker.fetch(req);
  const data = await res.json();
  ok(data.ok === true, '瞬态 500/8000000 重试后部署成功', JSON.stringify(data));
  ok(saved.deployCalls === 2, '部署 POST 共两次（1 失败 + 1 成功）', String(saved.deployCalls));
}

// ---------- 10. /api/projects 项目列表 ----------
{
  {
    const { data } = await deploy({ token: TOKEN }, 'ip-list1', '/api/projects', { accountsFail: true });
    ok(data.ok === false && /令牌/.test(data.error), '列表：令牌无效提示', JSON.stringify(data));
  }
  {
    calls = []; saved = {}; mock = {}; uploaded = new Set();
    const { data } = await deploy({ token: '' }, 'ip-list2', '/api/projects');
    ok(data.ok === false && /令牌/.test(data.error), '列表：缺令牌提示', JSON.stringify(data));
  }
  {
    // 混合列表：只有魔改版项目被标记
    const { data } = await deploy({ token: TOKEN }, 'ip-list3', '/api/projects',
      { projects: [modProjectConfig('mod-a'), plainProjectConfig('plain-b'), { name: 'nobind-c' }] });
    ok(data.ok === true && Array.isArray(data.projects) && data.projects.length === 3, '列表：返回全部项目', JSON.stringify(data));
    const byName = Object.fromEntries(data.projects.map(p => [p.name, p]));
    ok(byName['mod-a'].isMod === true && byName['mod-a'].domain === 'mod-a.pages.dev', '列表：魔改版标记 + 域名');
    ok(byName['plain-b'].isMod === false, '列表：非魔改版（有变量无 R2 绑定）');
    ok(byName['nobind-c'].isMod === false, '列表：空配置项目不算魔改版');
    ok(!JSON.stringify(data).includes('irrelevant'), '列表：不回传变量值');
    // 请求只打账号探测 + 列表两个端点
    ok(calls.length === 2 && calls.some(c => c.short === '/accounts') && calls.some(c => c.short.endsWith('/pages/projects') && c.method === 'GET'),
      '列表：请求序列为账号探测 + 项目列表');
  }
  {
    const { data } = await deploy({ token: TOKEN }, 'ip-list4', '/api/projects', { projects: [] });
    ok(data.ok === true && data.projects.length === 0, '列表：空列表 ok', JSON.stringify(data));
  }
}

// ---------- 11. /api/project-check 单项目魔改版校验 ----------
{
  {
    calls = []; saved = {}; uploaded = new Set();
    const { data } = await deploy({ token: TOKEN, projectName: 'mod-check' }, 'ip-check1', '/api/project-check');
    ok(data.ok === true && data.isMod === true, '校验：魔改版项目 isMod=true', JSON.stringify(data));
    ok(!JSON.stringify(data).includes('irrelevant'), '校验：不回传变量值');
  }
  {
    calls = []; saved = {}; uploaded = new Set();
    const { data } = await deploy({ token: TOKEN, projectName: 'plain-check' }, 'ip-check2', '/api/project-check');
    ok(data.ok === true && data.isMod === false, '校验：普通项目 isMod=false', JSON.stringify(data));
  }
  {
    calls = []; saved = {}; uploaded = new Set();
    const { data } = await deploy({ token: TOKEN }, 'ip-check3', '/api/project-check');
    ok(data.ok === false && /项目名/.test(data.error), '校验：缺项目名提示', JSON.stringify(data));
  }
  {
    // 大小写/非法字符会被 sanitize
    calls = []; saved = {}; uploaded = new Set();
    const { data } = await deploy({ token: TOKEN, projectName: 'MOD-CHECK' }, 'ip-check4', '/api/project-check');
    ok(data.ok === true && data.isMod === true, '校验：项目名归一化后仍命中', JSON.stringify(data));
  }
}

// ---------- 12. /api/update 更新流程 ----------
{
  {
    calls = []; saved = {}; uploaded = new Set();
    const { data } = await deploy({ token: TOKEN, projectName: 'mod-up' }, 'ip-up1', '/api/update');
    ok(data.ok === true && data.url === 'https://mod-up.pages.dev' && data.projectName === 'mod-up', '更新：ok + 网址', JSON.stringify(data));
    ok(saved.deployCalls === 1, '更新：只部署一次', String(saved.deployCalls));
    ok(!saved.bucketBody, '更新：不创建存储桶');
    ok(!saved.patches, '更新：不改配置（密码保持用户已设值）');
    ok(saved.deployWorkers[0] === readFileSync(join(pageDir, '_worker.js'), 'utf8'), '更新：_worker.js 与仓库一致');
    const manifest = saved.deployManifests[0];
    ok(!!manifest && JSON.stringify(Object.keys(manifest).sort()) === JSON.stringify(['/DB/bootstrap.js', '/DB/dirty-tracker.js', '/magic-extension.js']), '更新：manifest 键一致');
    ok(!JSON.stringify(data).includes(TOKEN), '更新：响应不回显令牌');
    ok(calls.some(c => c.short === '/accounts/acc1/pages/projects/mod-up' && c.method === 'GET'), '更新：先探测项目配置');
  }
  {
    // 非魔改版项目拒绝更新（服务端兜底）
    calls = []; saved = {}; uploaded = new Set();
    const { data } = await deploy({ token: TOKEN, projectName: 'plain-up' }, 'ip-up2', '/api/update');
    ok(data.ok === false && /不是魔改版/.test(data.error), '更新：非魔改版被拒', JSON.stringify(data));
    ok(saved.deployCalls === undefined, '更新：拒绝时不触发部署');
  }
  {
    // 项目不存在
    const { data } = await deploy({ token: TOKEN, projectName: 'zzz-missing' }, 'ip-up3', '/api/update',
      { missing: ['zzz-missing'] });
    ok(data.ok === false && /读取项目配置失败/.test(data.error), '更新：项目不存在报错', JSON.stringify(data));
  }
  {
    // 拉取 raw 文件失败
    calls = []; saved = {}; uploaded = new Set();
    mock = {};
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith(RAW_PREFIX)) return new Response('nope', { status: 404 });
      return origFetch(url, init);
    };
    const { data } = await deploy({ token: TOKEN, projectName: 'mod-rawfail' }, 'ip-up4', '/api/update');
    globalThis.fetch = origFetch;
    ok(data.ok === false && /拉取部署文件失败/.test(data.error), '更新：raw 拉取失败提示', JSON.stringify(data));
  }
}

globalThis.fetch = realFetch;
console.log(`test-flow: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);

/* blake3-begin */
const IV = new Int32Array([
  0x6a09e667 | 0, 0xbb67ae85 | 0, 0x3c6ef372 | 0, 0xa54ff53a | 0,
  0x510e527f | 0, 0x9b05688c | 0, 0x1f83d9ab | 0, 0x5be0cd19 | 0,
]);
const PERM = [2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8];
const F_CHUNK_START = 1, F_CHUNK_END = 2, F_PARENT = 4, F_ROOT = 8;

function rotr(x, n) { return ((x >>> n) | (x << (32 - n))) | 0; }

function g(s, a, b, c, d, mx, my) {
  s[a] = (s[a] + s[b] + mx) | 0; s[d] = rotr(s[d] ^ s[a], 16);
  s[c] = (s[c] + s[d]) | 0;      s[b] = rotr(s[b] ^ s[c], 12);
  s[a] = (s[a] + s[b] + my) | 0; s[d] = rotr(s[d] ^ s[a], 8);
  s[c] = (s[c] + s[d]) | 0;      s[b] = rotr(s[b] ^ s[c], 7);
}

function compress(cv, blockWords, counter, blockLen, flags) {
  const s = new Int32Array(16);
  for (let i = 0; i < 8; i++) { s[i] = cv[i]; s[i + 8] = IV[i]; }
  s[12] = counter | 0;
  s[13] = Math.floor(counter / 4294967296) | 0;
  s[14] = blockLen | 0;
  s[15] = flags | 0;
  for (let r = 0; r < 7; r++) {
    g(s, 0, 4, 8, 12, blockWords[0], blockWords[1]);
    g(s, 1, 5, 9, 13, blockWords[2], blockWords[3]);
    g(s, 2, 6, 10, 14, blockWords[4], blockWords[5]);
    g(s, 3, 7, 11, 15, blockWords[6], blockWords[7]);
    g(s, 0, 5, 10, 15, blockWords[8], blockWords[9]);
    g(s, 1, 6, 11, 12, blockWords[10], blockWords[11]);
    g(s, 2, 7, 8, 13, blockWords[12], blockWords[13]);
    g(s, 3, 4, 9, 14, blockWords[14], blockWords[15]);
    if (r < 6) {
      const nm = new Int32Array(16);
      for (let i = 0; i < 16; i++) nm[i] = blockWords[PERM[i]];
      blockWords = nm;
    }
  }
  for (let i = 0; i < 8; i++) { s[i] ^= s[i + 8]; s[i + 8] ^= cv[i]; }
  return s;
}

function blockWordsFrom(bytes, off, len) {
  const w = new Uint32Array(16);
  for (let i = 0; i < len; i++) w[i >> 2] |= bytes[off + i] << ((i & 3) * 8);
  return w;
}

function chunkCV(input, start, len, counter) {
  let cv = IV;
  const nBlocks = Math.ceil(len / 64);
  for (let b = 0; b < nBlocks; b++) {
    const off = start + b * 64;
    const bl = Math.min(64, len - b * 64);
    let f = 0;
    if (b === 0) f |= F_CHUNK_START;
    if (b === nBlocks - 1) f |= F_CHUNK_END;
    cv = compress(cv, blockWordsFrom(input, off, bl), counter, bl, f).slice(0, 8);
  }
  return cv;
}

function parentCV(left, right) {
  const block = new Uint32Array(16);
  for (let i = 0; i < 8; i++) { block[i] = left[i] >>> 0; block[i + 8] = right[i] >>> 0; }
  return compress(IV, block, 0, 64, F_PARENT).slice(0, 8);
}

function blake3Hex(input) {
  const total = input.length;
  const chunkCount = Math.max(1, Math.ceil(total / 1024));

  const stack = [];
  for (let i = 0; i < chunkCount - 1; i++) {
    const cv = chunkCV(input, i * 1024, 1024, i);
    let t = i + 1;
    let cur = cv;
    while ((t & 1) === 0) { cur = parentCV(stack.pop(), cur); t >>>= 1; }
    stack.push(cur);
  }

  const lastIdx = chunkCount - 1;
  const start = lastIdx * 1024;
  const len = total - start;
  let cv = IV.slice();
  let lastState;
  if (len === 0) {
    lastState = { cv, block: new Uint32Array(16), blockLen: 0, flags: F_CHUNK_START | F_CHUNK_END };
  } else {
    const nBlocks = Math.ceil(len / 64);
    for (let b = 0; b < nBlocks; b++) {
      const off = start + b * 64;
      const bl = Math.min(64, len - b * 64);
      const words = blockWordsFrom(input, off, bl);
      let f = 0;
      if (b === 0) f |= F_CHUNK_START;
      if (b === nBlocks - 1) f |= F_CHUNK_END;
      if (b === nBlocks - 1) {
        lastState = { cv, block: words, counter: lastIdx, blockLen: bl, flags: f };
      } else {
        cv = compress(cv, words, lastIdx, bl, f).slice(0, 8);
      }
    }
  }

  let state = lastState;
  while (stack.length) {
    const left = stack.pop();
    const right = compress(state.cv, state.block, state.counter, state.blockLen, state.flags).slice(0, 8);
    const pb = new Uint32Array(16);
    for (let i = 0; i < 8; i++) { pb[i] = left[i] >>> 0; pb[i + 8] = right[i] >>> 0; }
    state = { cv: IV.slice(), block: pb, counter: 0, blockLen: 64, flags: F_PARENT };
  }

  const out = compress(state.cv, state.block, state.counter, state.blockLen, state.flags | F_ROOT);
  let hex = '';
  for (let i = 0; i < 8; i++) {
    const w = out[i] >>> 0;
    for (let k = 0; k < 4; k++) hex += ((w >>> (8 * k)) & 0xff).toString(16).padStart(2, '0');
  }
  return hex;
}
/* blake3-end */

const REPO_OWNER = 'cy-2-u';
const REPO_REPO = 'rp';
const REPO_BRANCH = 'main';
const REPO_DIR = 'page';
const ASSETS = [
  { path: 'DB/bootstrap.js', ext: 'js', type: 'text/javascript' },
  { path: 'DB/dirty-tracker.js', ext: 'js', type: 'text/javascript' },
  { path: 'DB/styles.css', ext: 'css', type: 'text/css' },
  { path: 'magic-extension.js', ext: 'js', type: 'text/javascript' },
];
const WORKER_FILE = '_worker.js';
const R2_NAME = 'rp';
const R2_BINDING = 'RP_SYNC_R2';
const PASSWORD_VAR = 'RP_SYNC_PASSWORD';
const API = 'https://api.cloudflare.com/client/v4';
const RAW_BASE = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_REPO}/${REPO_BRANCH}/${REPO_DIR}/`;
const FRONTEND_URL = 'https://cy-2-u.github.io/rp/';

function json(data, status, origin) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  }
  return new Response(JSON.stringify(data), { status: status || 200, headers });
}

function bytesToBase64(bytes) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CH, bytes.length)));
  }
  return btoa(s);
}

function pageHash(bytes, ext) {
  const input = new TextEncoder().encode(bytesToBase64(bytes) + ext);
  return blake3Hex(input).slice(0, 32);
}

async function cfApi(token, path, init) {
  init = init || {};
  let r;
  try {
    r = await fetch(API + path, { ...init, headers: { Authorization: 'Bearer ' + token, ...(init.headers || {}) } });
  } catch (e) {
    return { ok: false, status: 0, networkError: true, errors: [{ message: '网络异常' }] };
  }
  let data = null;
  try { data = await r.json(); } catch (e) {  }
  const ok = r.ok && data && data.success === true;
  return { ok, status: r.status, result: data ? data.result : undefined, errors: (data && data.errors) || [] };
}

function cfErrorText(errors) {
  return errors.map(e => (e && e.message) ? String(e.message) : JSON.stringify(e)).join('; ') || '未知错误';
}

function randomSuffix(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  let s = '';
  for (const b of a) s += 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36];
  return s;
}

function sanitizeProjectName(name) {
  return String(name || '').toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/g, '');
}

const RATE = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const rec = RATE.get(ip);
  if (!rec || now - rec.start > 60000) { RATE.set(ip, { start: now, n: 1 }); return false; }
  rec.n += 1;
  if (RATE.size > 10000) RATE.clear();
  return rec.n > 10;
}

async function handleDeploy(request, origin) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: '请求格式错误。' }, 200, origin); }
  const token = String((body && body.token) || '').trim();
  const password = String((body && body.password) || '');
  let projectName = sanitizeProjectName(body && body.projectName);
  if (!token || !password) return json({ ok: false, error: '请填写令牌和密码。' }, 200, origin);
  if (!projectName) projectName = 'rp-' + randomSuffix(4);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(projectName)) {
    return json({ ok: false, error: '项目名只能包含小写字母、数字和连字符。' }, 200, origin);
  }

  const acc = await cfApi(token, '/accounts');
  if (!acc.ok || !Array.isArray(acc.result) || acc.result.length === 0) {
    return json({ ok: false, error: '令牌无效或没有可访问的账号。' }, 200, origin);
  }
  const accountId = acc.result[0].id;

  let projectNameFinal = projectName;
  let project = await cfApi(token, `/accounts/${accountId}/pages/projects`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: projectNameFinal, production_branch: 'main' }),
  });
  if (!project.ok) {
    const msg = cfErrorText(project.errors);
    if (/exist/i.test(msg)) {
      const probe = await cfApi(token, `/accounts/${accountId}/pages/projects/${projectNameFinal}`);
      if (!probe.ok) {

        let created = null;
        for (let attempt = 0; attempt < 3 && !created; attempt++) {
          projectNameFinal = (projectName + '-' + randomSuffix(4)).slice(0, 30);
          const retry = await cfApi(token, `/accounts/${accountId}/pages/projects`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: projectNameFinal, production_branch: 'main' }),
          });
          if (retry.ok) created = retry;
          else if (!/exist/i.test(cfErrorText(retry.errors))) {
            return json({ ok: false, error: '创建项目失败：' + cfErrorText(retry.errors) }, 200, origin);
          }
        }
        if (!created) return json({ ok: false, error: '项目名多次重名，请换个项目名再试。' }, 200, origin);
        project = created;
      } else {
        project = probe;
      }
    } else {
      return json({ ok: false, error: '创建项目失败：' + msg }, 200, origin);
    }
  }

  let workerBytes, assetFiles;
  try {
    const fetched = await Promise.all([
      fetch(RAW_BASE + WORKER_FILE),
      ...ASSETS.map(a => fetch(RAW_BASE + a.path)),
    ]);
    const bad = fetched.find(r => !r.ok);
    if (bad) return json({ ok: false, error: `拉取部署文件失败（HTTP ${bad.status}），请稍后再试。` }, 200, origin);
    workerBytes = new Uint8Array(await (fetched[0].arrayBuffer()));
    if (!workerBytes.length) return json({ ok: false, error: '拉取 _worker.js 为空。' }, 200, origin);
    assetFiles = await Promise.all(ASSETS.map(async (a, i) => {
      const bytes = new Uint8Array(await fetched[i + 1].arrayBuffer());
      if (!bytes.length) throw new Error(`拉取 ${a.path} 为空。`);
      return { path: a.path, ext: a.ext, type: a.type, bytes };
    }));
  } catch (e) {
    return json({ ok: false, error: e && e.message ? e.message : '拉取部署文件失败。' }, 200, origin);
  }

  const assetHashes = new Map(assetFiles.map(f => ['/' + f.path, pageHash(f.bytes, f.ext)]));

  async function uploadOnce() {
    const jwtRes = await cfApi(token, `/accounts/${accountId}/pages/projects/${projectNameFinal}/upload-token`);
    if (!jwtRes.ok || !jwtRes.result || !jwtRes.result.jwt) {
      return { error: '获取上传令牌失败：' + cfErrorText(jwtRes.errors) };
    }
    const jwt = jwtRes.result.jwt;
    const check = await cfApi(token, `/pages/assets/check-missing`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + jwt, 'Content-Type': 'application/json' },
      body: JSON.stringify({ hashes: [...assetHashes.values()] }),
    });
    if (!check.ok) return { error: '检查资产失败：' + cfErrorText(check.errors) };
    const missing = new Set(Array.isArray(check.result) ? check.result : []);
    const needUpload = assetFiles.filter(f => missing.has(assetHashes.get('/' + f.path)));
    if (needUpload.length) {
      const up = await cfApi(token, `/pages/assets/upload`, {
        method: 'POST', headers: { Authorization: 'Bearer ' + jwt, 'Content-Type': 'application/json' },
        body: JSON.stringify(needUpload.map(f => ({
          key: assetHashes.get('/' + f.path),
          value: bytesToBase64(f.bytes),
          metadata: { contentType: f.type },
          base64: true,
        }))),
      });
      if (!up.ok) return { error: '上传资产失败：' + cfErrorText(up.errors) };
    }
    await cfApi(token, `/pages/assets/upsert-hashes`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + jwt, 'Content-Type': 'application/json' },
      body: JSON.stringify({ hashes: [...assetHashes.values()] }),
    });
    const fd = new FormData();
    fd.append('manifest', JSON.stringify(Object.fromEntries(assetHashes)));
    fd.append('_worker.bundle', new File([workerBytes], '_worker.bundle'));
    const dep = await cfApi(token, `/accounts/${accountId}/pages/projects/${projectNameFinal}/deployments`, {
      method: 'POST', body: fd,
    });
    if (!dep.ok || !dep.result || !dep.result.id) return { error: '创建部署失败：' + cfErrorText(dep.errors) };
    return { id: dep.result.id };
  }

  async function poll(depId) {
    for (let i = 0; i < 6; i++) {
      await new Promise(r => setTimeout(r, 1500));
      const st = await cfApi(token, `/accounts/${accountId}/pages/projects/${projectNameFinal}/deployments/${depId}`);
      if (!st.ok || !st.result || !st.result.latest_stage) continue;
      const ls = st.result.latest_stage;
      if (ls.name === 'deploy' && ls.status === 'success') return null;
      if (ls.status === 'failure') return '部署未能上线，请到 dashboard 查看该项目日志。';
    }
    return null;
  }

  async function applyConfig() {
    const configBody = (r2Shape) => ({
      deployment_configs: {
        production: {
          env_vars: { [PASSWORD_VAR]: { type: 'plain_text', value: password } },
          r2_buckets: { [R2_BINDING]: r2Shape },
        },
      },
    });
    let patched = await cfApi(token, `/accounts/${accountId}/pages/projects/${projectNameFinal}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(configBody({ bucket_id: R2_NAME })),
    });
    if (!patched.ok) {
      const msg = cfErrorText(patched.errors);
      if (/r2|bucket/i.test(msg)) {
        patched = await cfApi(token, `/accounts/${accountId}/pages/projects/${projectNameFinal}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(configBody({ bucket_name: R2_NAME })),
        });
      }
    }
    return patched;
  }

  const r2Detect = await cfApi(token, `/accounts/${accountId}/r2/buckets/${R2_NAME}`);
  const r2Exists = r2Detect.ok;

  if (r2Exists) {

    const patched = await applyConfig();
    if (!patched.ok) return json({ ok: false, error: '更新配置失败：' + cfErrorText(patched.errors) }, 200, origin);
    const dep = await uploadOnce();
    if (dep.error) return json({ ok: false, error: dep.error }, 200, origin);
    await poll(dep.id);
    return json({ ok: true, url: `https://${projectNameFinal}.pages.dev`, projectName: projectNameFinal, mode: 'update' }, 200, origin);
  }

  const dep1 = await uploadOnce();
  if (dep1.error) return json({ ok: false, error: dep1.error }, 200, origin);

  const created = await cfApi(token, `/accounts/${accountId}/r2/buckets`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: R2_NAME }),
  });
  if (!created.ok) {
    const msg = cfErrorText(created.errors);
    if (!/exist/i.test(msg)) {
      if (/r2|object storage|subscri|not.*enabl|activat|purchase/i.test(msg)) {
        return json({ ok: false, error: 'R2 尚未在该账号开通：' + msg, code: 'R2_NOT_ENABLED' }, 200, origin);
      }
      return json({ ok: false, error: '创建 R2 存储桶失败：' + msg }, 200, origin);
    }
  }

  const patched = await applyConfig();
  if (!patched.ok) return json({ ok: false, error: '配置绑定失败：' + cfErrorText(patched.errors) }, 200, origin);

  const dep2 = await uploadOnce();
  if (dep2.error) return json({ ok: false, error: dep2.error }, 200, origin);
  const pollErr = await poll(dep2.id);
  if (pollErr) return json({ ok: false, error: pollErr }, 200, origin);
  return json({ ok: true, url: `https://${projectNameFinal}.pages.dev`, projectName: projectNameFinal, mode: 'full' }, 200, origin);
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': origin || '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '')) {
      return Response.redirect(FRONTEND_URL, 302);
    }

    if (request.method === 'POST' && url.pathname === '/api/deploy') {
      const ip = request.headers.get('cf-connecting-ip') || 'unknown';
      if (rateLimited(ip)) return json({ ok: false, error: '请求太频繁，稍后再试。' }, 429, origin);
      const len = Number(request.headers.get('content-length') || 0);
      if (len > 4096) return json({ ok: false, error: '请求体过大。' }, 413, origin);
      try {
        return await handleDeploy(request, origin);
      } catch (e) {
        return json({ ok: false, error: '部署器内部错误，请稍后再试。' }, 500, origin);
      }
    }

    return json({ ok: false, error: 'Not found.' }, 404, origin);
  },
};

// blake3 独立测试：从 worker.js 提取实现，对照 BLAKE3 官方 test_vectors.json 全量验证。
// 运行：node deployer/test-blake3.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// 1) 从 worker.js 截取 blake3 段落并动态导入
const workerSrc = readFileSync(join(here, 'worker.js'), 'utf8');
const begin = workerSrc.indexOf('/* blake3-begin');
const end = workerSrc.indexOf('/* blake3-end */') + '/* blake3-end */'.length;
if (begin < 0 || end < 0) throw new Error('worker.js 中找不到 blake3 标记');
const modSrc = workerSrc.slice(begin, end) + '\nexport { blake3Hex };';
const mod = await import('data:text/javascript;base64,' + Buffer.from(modSrc).toString('base64'));
const { blake3Hex } = mod;

const enc = new TextEncoder();
let pass = 0, fail = 0;
function check(name, inputBytes, expectHex) {
  const got = blake3Hex(inputBytes);
  if (got === expectHex.slice(0, 64)) { pass++; }
  else { fail++; console.log(`FAIL ${name}\n  got  ${got}\n  want ${expectHex}`); }
}

// 2) 两个锚定向量（公认值）
check('empty', new Uint8Array(0), 'af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262');
check('abc', enc.encode('abc'), '6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85');

// 3) 官方测试向量（无密钥；输入字节 = i % 251）；优先用本地夹具
const vecFile = join(here, 'test-vectors.json');
let vecText;
if (existsSync(vecFile)) {
  vecText = readFileSync(vecFile, 'utf8');
} else {
  const vecUrl = 'https://raw.githubusercontent.com/BLAKE3-team/BLAKE3/master/test_vectors/test_vectors.json';
  const res = await fetch(vecUrl);
  if (!res.ok) throw new Error('下载官方向量失败 HTTP ' + res.status);
  vecText = await res.text();
  writeFileSync(vecFile, vecText);
}
const vec = JSON.parse(vecText);
const cases = vec.cases || vec.hash_tests || [];
for (const t of cases) {
  const input = new Uint8Array(t.input_len);
  for (let i = 0; i < t.input_len; i++) input[i] = i % 251;
  check('official len=' + t.input_len, input, t.hash);
}

console.log(`blake3: ${pass} pass, ${fail} fail (official cases: ${cases.length})`);
if (fail > 0) process.exit(1);

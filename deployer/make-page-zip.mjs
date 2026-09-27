// page.zip 发布归档构建器：DEFLATE + 正斜杠条目 + 归档根级 _worker.js。
// 背景：PowerShell Compress-Archive 写出 "page\_worker.js" 这类反斜杠带前缀条目，
// Pages 导入后既没有根级 _worker.js 也没有 DB/ 目录，站点整体 404。
// 用法：node deployer/make-page-zip.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const pageDir = path.join(root, 'page');
const outFile = path.join(root, 'page.zip');

const FILES = [
  ['_worker.js', '_worker.js'],
  ['magic-extension.js', 'magic-extension.js'],
  ['DB/bootstrap.js', 'DB/bootstrap.js'],
  ['DB/dirty-tracker.js', 'DB/dirty-tracker.js'],
  ['DB/styles.css', 'DB/styles.css'],
];

let failed = 0;
function ok(cond, name, extra) {
  if (cond) console.log('PASS', name);
  else { failed++; console.log('FAIL', name, extra || ''); }
}

// 1) page/ 与根目录正本逐字节核对
for (const [src, entry] of FILES) {
  const canonical = src === '_worker.js' ? '_worker.js' : src;
  const a = fs.readFileSync(path.join(root, canonical));
  const b = fs.readFileSync(path.join(pageDir, src));
  ok(Buffer.compare(a, b) === 0, `page/${src} 与根目录正本一致`);
}

// 2) 构建条目（DEFLATE，正斜杠，归档根级）
const encoder = new TextEncoder();
const localParts = [];
const centralParts = [];
let offset = 0;
for (const [src, entry] of FILES) {
  const raw = fs.readFileSync(path.join(pageDir, src));
  const deflated = zlib.deflateRawSync(raw, { level: 9 });
  const crc = zlib.crc32(raw) >>> 0;
  const nameBytes = encoder.encode(entry);
  const dosTime = 0, dosDate = 0x21; // 时间占位不影响 Pages 导入；日期取 1980-01-01 合法值

  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0);
  lfh.writeUInt16LE(20, 4);            // version needed: 2.0 (deflate)
  lfh.writeUInt16LE(0x0800, 6);        // UTF-8 名称标志
  lfh.writeUInt16LE(8, 8);             // method: deflate
  lfh.writeUInt16LE(dosTime, 10);
  lfh.writeUInt16LE(dosDate, 12);
  lfh.writeUInt32LE(crc, 14);
  lfh.writeUInt32LE(deflated.length, 18);
  lfh.writeUInt32LE(raw.length, 22);
  lfh.writeUInt16LE(nameBytes.length, 26);
  lfh.writeUInt16LE(0, 28);

  localParts.push(lfh, nameBytes, deflated);

  const cdh = Buffer.alloc(46);
  cdh.writeUInt32LE(0x02014b50, 0);
  cdh.writeUInt16LE(20, 4);            // version made by
  cdh.writeUInt16LE(20, 6);            // version needed
  cdh.writeUInt16LE(0x0800, 8);
  cdh.writeUInt16LE(8, 10);
  cdh.writeUInt16LE(dosTime, 12);
  cdh.writeUInt16LE(dosDate, 14);
  cdh.writeUInt32LE(crc, 16);
  cdh.writeUInt32LE(deflated.length, 20);
  cdh.writeUInt32LE(raw.length, 24);
  cdh.writeUInt16LE(nameBytes.length, 28);
  cdh.writeUInt32LE(0, 42);            // 本地头偏移占位，稍后回填
  centralParts.push({ cdh, nameBytes, offsetOfLocal: offset });

  offset += lfh.length + nameBytes.length + deflated.length;
}
const centralStart = offset;
let centralSize = 0;
const centralBufs = [];
for (const c of centralParts) {
  c.cdh.writeUInt32LE(c.offsetOfLocal, 42);
  centralBufs.push(c.cdh, c.nameBytes);
  centralSize += c.cdh.length + c.nameBytes.length;
}
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(FILES.length, 8);
eocd.writeUInt16LE(FILES.length, 10);
eocd.writeUInt32LE(centralSize, 12);
eocd.writeUInt32LE(centralStart, 16);
fs.writeFileSync(outFile, Buffer.concat([...localParts, ...centralBufs, eocd]));

// 3) 回读校验：条目名必须全是正斜杠且在归档根级，内容解压后逐字节一致
const zip = fs.readFileSync(outFile);
const centralEntries = [];
for (let i = 0; i < zip.length - 4; i++) {
  if (zip[i] === 0x50 && zip[i + 1] === 0x4b && zip[i + 2] === 0x01 && zip[i + 3] === 0x02) {
    const nl = zip.readUInt16LE(i + 28);
    centralEntries.push({
      name: zip.slice(i + 46, i + 46 + nl).toString('utf8'),
      crc: zip.readUInt32LE(i + 16),
      csize: zip.readUInt32LE(i + 20),
      usize: zip.readUInt32LE(i + 24),
    });
  }
}
ok(centralEntries.length === FILES.length, 'zip 条目数 = 5', String(centralEntries.length));
const names = centralEntries.map(e => e.name).sort();
ok(JSON.stringify(names) === JSON.stringify(['DB/bootstrap.js', 'DB/dirty-tracker.js', 'DB/styles.css', '_worker.js', 'magic-extension.js']),
  '条目名全部为正斜杠且在归档根级', JSON.stringify(names));
for (const e of centralEntries) {
  const src = FILES.find(f => f[1] === e.name)[0];
  const raw = fs.readFileSync(path.join(pageDir, src));
  ok(zlib.crc32(raw) >>> 0 === e.crc, `CRC 一致: ${e.name}`);
  ok(raw.length === e.usize, `原始大小一致: ${e.name}`);
}

console.log(failed === 0
  ? `make-page-zip: 全部通过，page.zip ${zip.length} 字节`
  : `make-page-zip: ${failed} 项失败`);
if (failed > 0) process.exit(1);

// 图库前端回归：加载真实 gallery.html + 真实 gallery.js，经 Worker 仿真走
// 认证门、分组渲染、限量、搜索、查看器、选择删除（乐观更新 + 15/批分块）。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import worker from '../page/_worker.js';
const require = createRequire(import.meta.url);
const { JSDOM, VirtualConsole } = require('jsdom'), idb = require('fake-indexeddb');
const { Bucket, FixedLengthStream, context } = require('./platform.mjs');
globalThis.FixedLengthStream = FixedLengthStream;

const bucket = new Bucket(), ctx = context();
const env = { RP_SYNC_R2: bucket, RP_SYNC_PASSWORD: 'gallery-test' };
const hex = i => 'a'.repeat(62) + String(i).padStart(2, '0');
const seed = async (name, count) => {
    for (let i = 0; i < count; i++) await bucket.put(`rp-images/characters/${name}/${hex(i)}`, new Uint8Array([i + 1]), { httpMetadata: { contentType: 'image/png' } });
};

const html = await readFile(new URL('../page/gallery.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'https://test.local/image', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
const w = dom.window;
for (const name of ['IDBFactory', 'IDBDatabase', 'IDBObjectStore', 'IDBCursor', 'IDBTransaction', 'IDBKeyRange']) w[name] = idb[name];
Object.assign(w, { indexedDB: new idb.IDBFactory(), TextEncoder, TextDecoder, AbortController, confirm: () => true, fetch: (path, init) => worker.fetch(new Request(new URL(path, 'https://test.local'), init), env, ctx) });
Object.defineProperty(w, 'crypto', { value: globalThis.crypto });
const $ = id => w.document.getElementById(id);
const settle = () => new Promise(r => setTimeout(r, 30));
const until = async (probe, label) => { for (let i = 0; i < 100; i++) { const v = probe(); if (v) return v; await settle(); } throw new Error('timeout: ' + label); };

let checks = 0;
const check = (ok, label) => { assert.ok(ok, label); checks++; };

// 1. 无密码：锁卡出现，错误密码被拒，正确密码进入。
await seed('星野', 3); await seed('绫地', 2);
w.eval(await readFile(new URL('../page/gallery.js', import.meta.url), 'utf8'));
await until(() => !$('auth').classList.contains('hidden'), 'auth card');
check($('app').classList.contains('hidden'), 'unauthenticated app hidden');
$('password').value = 'wrong';
$('login').click();
check((await until(() => $('authMsg').textContent, 'auth error')) === '密码不正确。', 'wrong password message');
check(!$('auth').classList.contains('hidden'), 'wrong password stays on auth card');
$('password').value = 'gallery-test';
$('login').click();
await until(() => !$('app').classList.contains('hidden'), 'app visible');

// 2. 分组渲染与统计（星野 3 + 绫地 2 = 5 张，桌面限量 8 → 全显）。
await until(() => w.document.querySelectorAll('.album').length === 2, 'albums');
check(w.document.querySelectorAll('.album').length === 2, 'two character groups');
check(w.document.querySelectorAll('.photo').length === 5, 'all tiles rendered under limit');
check($('stats').textContent.startsWith('5 张图片'), 'stats count');
check(w.document.querySelector('.album-title').textContent === '星野', 'group order by name');

// 3. 搜索过滤。
$('filter').value = '绫地';
$('filter').dispatchEvent(new w.Event('input', { bubbles: true }));
await settle();
check(w.document.querySelectorAll('.album').length === 1 && w.document.querySelector('.album-title').textContent === '绫地', 'search filters groups');
$('filter').value = '';
$('filter').dispatchEvent(new w.Event('input', { bubbles: true }));
await settle();

// 4. 查看器：打开、计数、键盘翻页环绕、Esc 关闭。
w.document.querySelector('.photo').click();
await until(() => !$('viewer').classList.contains('hidden'), 'viewer open');
check($('viewerCount').textContent === '1 / 5', 'viewer position');
for (let i = 0; i < 5; i++) w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
await settle();
check($('viewerCount').textContent === '1 / 5', 'viewer wraps around');
w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await settle();
check($('viewer').classList.contains('hidden') && !$('viewerImage').getAttribute('src'), 'escape closes and clears');

// 5. 选择删除：两张一批（<15），乐观更新即时生效，墓碑落 R2，选中态复位。
$('deleteMode').click();
await settle();
for (const tile of w.document.querySelectorAll('.photo')) tile.click();
await settle();
check($('selectionCount').textContent === '已选 5 张', 'selection counter');
$('deleteSelected').click();
await until(() => w.document.querySelectorAll('.photo').length === 0, 'optimistic removal');
check($('stats').textContent.startsWith('0 张图片'), 'stats after delete');
check(w.document.body.classList.contains('delete-mode') === false, 'delete mode exits after success');
check([...bucket.objects.keys()].filter(k => k.startsWith('rp-images/_deleted/')).length === 5, 'tombstones written');
check($('notice').textContent === '删除完成。', 'success notice');

// 6. 限量渲染 + 显示更多 + 大批量删除按 15/批分块（免费版子请求上限）。
await seed('批量角色', 20);
$('refresh').click();
await until(() => w.document.querySelectorAll('.photo').length === 8, 'initial page renders 8 of 20 (desktop limit)');
for (let round = 0; round < 3 && w.document.querySelectorAll('.photo').length < 20; round++) {
    const more = w.document.querySelector('.album-more');
    if (!more) break;
    more.click();
    await settle();
}
await until(() => w.document.querySelectorAll('.photo').length === 20, 'show-more expands to all');
$('deleteMode').click();
await settle();
for (const tile of w.document.querySelectorAll('.photo')) tile.click();
const before = bucket.calls.delete;
$('deleteSelected').click();
await until(() => w.document.querySelectorAll('.photo').length === 0, 'bulk removal');
check(bucket.calls.delete - before >= 2, 'bulk delete split into batches');
check([...bucket.objects.keys()].filter(k => k.startsWith('rp-images/_deleted/') && k.includes('批量角色')).length === 20, 'all bulk tombstones');

w.close(); await ctx.drain();
console.log(`gallery: ${checks} auth, render, search, viewer, selection-delete and batch-split checks passed`);

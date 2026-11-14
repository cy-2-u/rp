// 本地验收服务器：真实浏览器 API，R2 与上游仅使用内存夹具。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import worker from '../page/_worker.js';
import { Bucket, Cache, FixedLengthStream, HTMLRewriter, context } from './platform.mjs';
const require = createRequire(import.meta.url);
const vue = await readFile(require.resolve('vue/dist/vue.global.prod.js'), 'utf8');
const files = new Set(['core.js', 'client.js', 'sync.js', 'images.js', 'gallery.js', 'gallery.html', 'config.json', 'adapter/rp-hub-v2.js']);
const bucket = new Bucket(), ctx = context();
globalThis.FixedLengthStream = FixedLengthStream; globalThis.HTMLRewriter = HTMLRewriter; globalThis.caches = { default: new Cache() };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII=', 'base64');
await bucket.put('rp-images/characters/test/' + 'a'.repeat(64), png, { httpMetadata: { contentType: 'image/png' } });
const author = `<!doctype html><html><head><meta charset="utf-8"><title>新版本地验收</title><script src="/vue.js"></script></head><body><div id="app"></div><script>
window.RPHubStorage={setStoredValue:async(key,value)=>{const r=indexedDB.open('RPHubDB');return new Promise((resolve,reject)=>{r.onupgradeneeded=()=>r.result.createObjectStore('store');r.onsuccess=()=>{const db=r.result,tx=db.transaction('store','readwrite');tx.objectStore('store').put(value,key);tx.oncomplete=()=>{db.close();resolve()};tx.onabort=()=>reject(tx.error)};r.onerror=()=>reject(r.error)})}};
Vue.createApp({setup(){const count=Vue.ref(0),settings=Vue.ref({stream:true,temperature:.8}),currentCharacter=Vue.ref({uuid:'test',name:'test'}),currentStoryBranch=Vue.ref({id:'main'}),chatHistory=Vue.ref([{id:'m',content:'hello'}]);
Vue.watch(count,()=>{const _memorySettingsSaveTimer=setTimeout(()=>RPHubStorage.setStoredValue('memory',count.value),1000)});
Vue.watch(count,()=>{const debouncedCharacterSave=setTimeout(()=>RPHubStorage.setStoredValue('character',count.value),1000)});
Vue.watch(count,()=>{const debouncedSave=setTimeout(()=>RPHubStorage.setStoredValue('settings',count.value),1000)});
Vue.watch(count,()=>{const scheduleChatHistorySave=setTimeout(()=>RPHubStorage.setStoredValue('chat',count.value),1000)});
Vue.onMounted(async()=>{});return{count,settings,currentCharacter,currentStoryBranch,chatHistory}},template:'<main style="padding:24px;font:16px system-ui"><h1>新版本地验收</h1><div class="app-navigation-user"></div><div class="app-navigation-grid"></div><p>本地内存夹具，不连接线上数据。</p><button @click="count++">修改数据 {{count}}</button></main>'}).mount('#app');
</script></body></html>`;
globalThis.fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/vue.js')) return new Response(vue, { headers: { 'content-type': 'application/javascript' } });
    if (path.endsWith('/index.html')) return new Response(author, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    return new Response('not found', { status: 404 });
};
// RP_FIXTURE=1：作者源站切换为真实作者线上版 fixture（tests/fixtures/author/），
// 其余 CDN 资产走真实网络。用于真实浏览器验收：锚点、保存链路、上传全链路。
const fixtureMode = process.env.RP_FIXTURE === '1';
if (fixtureMode) {
    const networkFetch = globalThis.fetch;
    const types = { '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8' };
    globalThis.fetch = async input => {
        const url = new URL(String(input));
        if (url.origin !== 'https://sta1n156.github.io') return networkFetch(input);
        const rel = decodeURIComponent(url.pathname).replace(/^\/RP-Hub\/?/, '');
        const name = rel === '' ? 'index.html' : ['character', 'novel'].includes(rel) ? rel + '.html' : rel;
        try {
            const bytes = await readFile(new URL('fixtures/author/' + name, import.meta.url));
            return new Response(bytes, { headers: { 'content-type': types[name.slice(name.lastIndexOf('.'))] || 'application/octet-stream' } });
        } catch { return new Response('not found', { status: 404 }); }
    };
}
const env = { RP_SYNC_R2: bucket, RP_SYNC_PASSWORD: 'local-test', ASSETS: { async fetch(request) {
    const name = new URL(request.url).pathname.slice(1);
    if (!files.has(name)) return new Response('', { status: 404 });
    const bytes = await readFile(new URL('../page/' + name, import.meta.url));
    return new Response(bytes, { headers: { 'content-type': name.endsWith('.js') ? 'application/javascript; charset=utf-8' : name.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/json' } });
} } };
createServer(async (req, res) => {
    try {
        const init = { method: req.method, headers: req.headers };
        if (!['GET', 'HEAD'].includes(req.method)) { init.body = Readable.toWeb(req); init.duplex = 'half'; }
        const response = await worker.fetch(new Request('http://127.0.0.1:18791' + req.url, init), env, ctx);
        res.writeHead(response.status, Object.fromEntries(response.headers));
        if (response.body) Readable.fromWeb(response.body).pipe(res); else res.end();
    } catch (e) { res.writeHead(500); res.end(e.message); }
}).listen(18791, '127.0.0.1', () => console.log('http://127.0.0.1:18791/ password: local-test'));

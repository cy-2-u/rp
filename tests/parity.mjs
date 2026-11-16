// 协议双写断言：Worker 单文件自含协议校验（不能 import core.js），图片参数表
// 在 Worker 与 images.js 各有一份，图库密码键在 gallery.js 独立内联。这些副本
// 一旦漂移就是跨端数据损坏或图片键分裂，此处静态提取并逐字断言。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = async name => readFile(new URL('../page/' + name, import.meta.url), 'utf8');
const [worker, core, images, gallery, sync, adapter, routes] = await Promise.all([
    read('_worker.js'), read('core.js'), read('images.js'), read('gallery.js'), read('sync.js'), read('adapter/rp-hub-v2.js'), read('_routes.json').then(JSON.parse)
]);

const one = (source, pattern, label) => {
    const match = source.match(pattern);
    assert.ok(match, label + '：未找到');
    return match[1];
};

// 1. 云端布局与格式标记。
assert.equal(one(worker, /const ROOT = '([^']+)'/, 'worker ROOT'), 'rp-sync/v2/manifest.json', '根清单路径');
assert.equal(one(worker, /const PACKS = '([^']+)'/, 'worker PACKS'), 'rp-sync/v2/packs/', '分片前缀');
assert.equal(one(core, /const FORMAT = '([^']+)'/, 'core FORMAT'), one(worker, /const FORMAT = '([^']+)'/, 'worker FORMAT'), 'FORMAT 双写一致');
assert.ok(worker.includes("includes('RPHubExternal')"), 'worker 轻校验含契约标记');
assert.equal(one(adapter, /version: (\d)/, 'adapter version'), '2', '适配契约 v2');
assert.ok(sync.includes('RPHubExternal.version !== 2'), '同步端校验契约版本');
assert.ok(images.includes('E.version !== 2'), '图片端校验契约版本');

// 2. canonical 校验和源：两侧表达式逐字一致（三方一致性的根）。
const workerSource = one(worker, /function manifestSource\(m\) \{ return (JSON\.stringify\([^\n]+\)); \}/, 'worker manifestSource');
const coreSource = one(core, /const checksumSource = m => (JSON\.stringify\([^\n]+\));/, 'core checksumSource');
assert.equal(workerSource, coreSource, 'canonical 校验和源逐字一致');

// 3. 清单与分片限额。
const num = text => String(eval(text.replace(/\s/g, '')));
assert.equal(one(worker, /packs\.length > (\d+)/, 'worker packs 上限'), num(one(core, /packs: (\d+)/, 'core LIMIT.packs')), '分片数上限一致');
assert.equal(num(one(worker, /p\.length > ([\d *]+) \|/, 'worker 单片上限')), num(one(core, /pack: ([\d *]+),/, 'core LIMIT.pack')), '单片字节上限一致');
assert.equal(one(worker, /p\.entries > (\d+)/, 'worker entries 上限'), num(one(core, /entries: (\d+),/, 'core LIMIT.entries')), '单片条目上限一致');
assert.equal(num(one(worker, /total > ([\d *]+) \|\|/, 'worker 快照上限')), num(one(core, /snapshot: ([\d *]+),/, 'core LIMIT.snapshot')), '快照上限一致');
assert.equal(one(worker, /p\.bucket\.length > (\d+)/, 'worker 桶名上限'), one(core, /p\.bucket\.length > (\d+)/, 'core 桶名上限'), '桶名长度上限一致');
assert.ok(worker.includes('p.entries < 0') && core.includes('p.entries < 0'), '两侧都允许填充分片（entries=0）');

// 4. 图片参数表与键路径；生图默认值只在 Worker 侧，模型回退名在适配层。
const workerParams = eval(one(worker, /const PARAMS = (\[[^\]]+\])/, 'worker PARAMS'));
const imageParams = eval(one(images, /const params = (\[[^\]]+\]);/, 'images params'));
assert.deepEqual(imageParams, workerParams, '图片参数表逐字一致');
assert.equal(one(worker, /const IMAGE = '([^']+)'/, 'worker 图片前缀'), 'rp-images/characters/', '图片键前缀');
assert.ok(images.includes("prefix = 'rp_hub_image_renders_'"), '固定记录前缀');
for (const constant of ["provider: 'sta1n'", "'nai-diffusion-4-5-full'", "'k_dpmpp_2m_sde'", "'karras'", "'832x1216'"]) {
    assert.ok(worker.includes(constant), 'worker 含 ' + constant);
}
assert.ok(adapter.includes("'nai-diffusion-4-5-full'"), '适配层模型回退名与 Worker 默认一致');

// 5. 密码与键名：图库独立内联的密码键必须与 core 一致。
assert.equal(one(gallery, /const key = '([^']+)'/, 'gallery 密码键'), one(core, /password: '([^']+)'/, 'core password'), '图库密码键与 core 一致');
assert.ok(worker.includes("'x-rp-sync-password'") && sync.includes("'x-rp-sync-password'") && gallery.includes("'x-rp-sync-password'"), '密码头三处一致');

// 6. 资产清单：_routes 排除项与 Worker 直供列表双向对应（通配按前缀展开）。
const assets = worker.match(/\['\/core\.js'[^\]]+\]/)[0];
const staticList = eval(assets);
for (const route of routes.exclude) {
    const prefix = route.endsWith('/*') ? route.slice(0, -1) : route;
    assert.ok(staticList.some(name => name.startsWith(prefix)), 'worker 资产清单覆盖 ' + route);
}
for (const name of staticList) assert.ok(routes.exclude.some(route => name.startsWith(route.endsWith('/*') ? route.slice(0, -1) : route)), '_routes 排除 ' + name);
assert.ok(worker.includes('data-rp-sync-restore'), '恢复页携带客户端识别标记');

// 7. 部署器清单 ↔ page/ 实际文件：加文件忘更新 ASSETS 就是静默残废部署，此处双向锁死
//（rp-hub.js 是 v1 存档，参与 Worker 直供但不进部署器清单）。
const deployer = await readFile(new URL('../deployer/worker.js', import.meta.url), 'utf8');
const deployerFiles = new Set([one(deployer, /const WORKER_FILE = '([^']+)'/, 'deployer worker file'), ...[...deployer.matchAll(/path: '([^']+)'/g)].map(m => m[1])]);
const { readdir } = await import('node:fs/promises');
const pageFiles = new Set((await readdir(new URL('../page/', import.meta.url), { recursive: true }))
    .map(String).map(name => name.replace(/\\/g, '/'))
    .filter(name => name !== 'adapter' && name !== 'adapter/rp-hub.js'));
for (const file of deployerFiles) assert.ok(pageFiles.has(file), '部署器清单文件存在于 page/' + file);
const undeployed = [...pageFiles].filter(name => !deployerFiles.has(name));
assert.deepEqual(undeployed, [], 'page/ 无未进部署器清单的文件');

// 8. formatBytes 双写（Worker library 端 sizeHuman ↔ 图库本地乐观更新 sizeHuman）：整数域样本逐点一致，
// 两端显示口径漂移会让乐观更新后的体积文案与刷新后不一致。
{
    const workerBytes = eval('(' + one(worker, /(function formatBytes\(bytes\) \{[\s\S]*?\n\})/, 'worker formatBytes') + ')');
    const galleryBytes = eval('(' + one(gallery, /^\s*const formatBytes = (value => \{.*\});$/m, 'gallery formatBytes') + ')');
    for (const sample of [0, 1, 512, 1023, 1024, 1536, 1048575, 1048576, 1073741824, 10 * 1024 ** 3]) {
        assert.equal(workerBytes(sample), galleryBytes(sample), 'formatBytes 双写一致 @' + sample + ' 字节');
    }
}
console.log('parity: 云端布局/校验和源/限额/图片参数/密码键/资产清单/契约版本/部署器清单/formatBytes 双写全部一致');

// 审计回归：跨文件协议常量双写一致性、Worker 结构约束、page/ 发布文件
// 集完整性、新旧协议边界（不允许残留旧协议标识）。
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { assert, assertEqual } from './lib/worker.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pageDir = join(here, '..', 'page');
const read = relative => readFileSync(join(pageDir, relative), 'utf8');

const dirty = read(join('DB', 'dirty-tracker.js'));
const bootstrap = read(join('DB', 'bootstrap.js'));
const worker = read('_worker.js');
const adapter = read(join('adapter', 'rp-hub-v2.js'));
const magic = read('magic-extension.js');

function literal(source, declaration) {
    const match = source.match(new RegExp(`const\\s+${declaration}\\s*=\\s*'([^']+)'`));
    assert(match, `常量声明缺失：${declaration}`);
    return match[1];
}

function stringArrayLiteral(source, declaration) {
    const match = source.match(new RegExp(`const\\s+${declaration}\\s*=\\s*\\[([^\\]]+)\\]`));
    assert(match, `常量声明缺失：${declaration}`);
    return match[1].split(',').map(item => item.trim().replace(/^'|'$/g, '')).join(',');
}

function testDoubleWriteConstants() {
    // dirty-tracker 与 bootstrap 的协议常量是人肉双写副本，任何一侧改名
    // 必须双侧同步；此处逐字比较值。
    const pairs = [
        ['JOURNAL', 'JOURNAL_STORE'],
        ['STORAGE_INTENT_PREFIX', 'STORAGE_INTENT_PREFIX'],
        ['TRACKING_EPOCH_KEY', 'TRACKING_EPOCH_KEY'],
        ['RESTORE_ACTIVE_KEY', 'RESTORE_ACTIVE_KEY'],
        ['RESTORE_EPOCH_KEY', 'RESTORE_EPOCH_KEY']
    ];
    for (const [dirtyName, bootstrapName] of pairs) {
        assertEqual(literal(dirty, dirtyName), literal(bootstrap, bootstrapName), `双写常量一致：${dirtyName}/${bootstrapName}`);
    }
    // RESTORE_PAGE 判定两侧共享同一语义（恢复页 data 属性 + /sync-restore 路径）。
    assert(dirty.includes("location.pathname === '/sync-restore'") && bootstrap.includes("location.pathname === '/sync-restore'"), 'RESTORE_PAGE 判定一致（路径）');
    assert(dirty.includes("'data-rp-sync-restore'") && bootstrap.includes("'data-rp-sync-restore'"), 'RESTORE_PAGE 判定一致（data 属性）');
    // ---- 跨文件 UI 常量双写（同为人肉副本，漂移即行为分叉）----
    // magic 与适配层共享的设置键（设置开关与模型下拉读写同一存储）。
    assertEqual(literal(magic, 'FIXED_IMAGE_KEY'), literal(adapter, 'FIXED_IMAGE_KEY'), '双写常量一致：FIXED_IMAGE_KEY');
    assertEqual(literal(magic, 'YNAI_MODEL_KEY'), literal(adapter, 'YNAI_MODEL_KEY'), '双写常量一致：YNAI_MODEL_KEY');
    // 生图参数键列表：worker 用它构造签名寻址，magic 用它复制请求参数，
    // 两侧集合不一致会让缓存键与实际请求参数脱钩。
    assertEqual(stringArrayLiteral(worker, 'IMAGE_PARAM_KEYS'), stringArrayLiteral(magic, 'IMAGE_PARAM_KEYS'), '双写常量一致：IMAGE_PARAM_KEYS');
    // 图库单批删除上限：gallery 分片大小必须不大于 worker 校验上限，
    // 否则正常分批删除会被服务端 400 拒绝。
    const workerDeleteLimit = worker.match(/const IMAGE_DELETE_MAX_KEYS_PER_REQUEST = (\d+)/);
    const galleryDeleteLimit = read('gallery.html').match(/deleteChunkSize=(\d+)/);
    assert(workerDeleteLimit && galleryDeleteLimit, '删除批量常量声明存在');
    assertEqual(workerDeleteLimit[1], galleryDeleteLimit[1], '双写常量一致：IMAGE_DELETE_MAX_KEYS_PER_REQUEST/deleteChunkSize');
    console.log('ok  双写协议常量一致');
}

function testProtocolAgreement() {
    // 同步 v2 协议标识三方一致（worker / 客户端 / canonical 校验源）。
    assert(worker.includes("'rp-sync-manifest-v2'"), 'Worker 根清单格式');
    assert(bootstrap.includes("'rp-sync-manifest-v2'"), '客户端根清单格式');
    assert(literal(worker, 'MANIFEST_COMPRESSION') === 'gzip', 'Worker 压缩标识');
    assert(literal(bootstrap, 'SNAPSHOT_COMPRESSION') === 'gzip', '客户端压缩标识');
    assert(worker.includes("const MAX_PACK_ENTRIES = 512"), 'Worker 单片记录上限');
    assert(bootstrap.includes('maxPackEntries: 512'), '客户端单片记录上限');
    assert(worker.includes('const MAX_PACKS = 4096'), 'Worker 分片数上限');
    assert(bootstrap.includes('maxPackCount: 4096'), '客户端分片数上限');
    assert(worker.includes('const MAX_PACK_STORED_BYTES = 6 * 1024 * 1024'), 'Worker 存储分片上限');
    assert(bootstrap.includes('targetPackBytes: 4 * 1024 * 1024'), '客户端原始分片 4MiB');
    assert(worker.includes("'rp-sync/v2'"), 'Worker 新协议前缀');
    // canonical 校验源的字段顺序两侧必须一致（元组 [bucket, checksum, length, entries]）。
    const tuple = /packs\.map\(pack => \[pack\.bucket, pack\.checksum, pack\.length, pack\.(entries|entryCount)\]\)/;
    assert(tuple.test(worker), 'Worker canonical 元组');
    assert(tuple.test(bootstrap), '客户端 canonical 元组');
    console.log('ok  同步 v2 协议常量三方一致');
}

function testNoLegacyProtocolResidue() {
    for (const [name, source] of [['worker', worker], ['bootstrap', bootstrap], ['adapter', adapter], ['magic', magic], ['dirty-tracker', dirty]]) {
        assert(!source.includes('rp-sync/main'), `${name} 不引用旧协议前缀`);
        assert(!source.includes('rp-sync-paged-jsonl-v4'), `${name} 不引用旧快照格式`);
        assert(!source.includes('bloomChecksum'), `${name} 不引用 Bloom 簿记`);
        assert(!source.includes('upload-manifest-page'), `${name} 不引用旧分页端点`);
        assert(!source.includes('gc-step'), `${name} 不引用旧 GC 端点`);
    }
    console.log('ok  无旧协议残留');
}

function testWorkerConstraints() {
    // Worker 保持单文件、无构建：除默认导出外不允许模块语法。
    assert(!/^import\s/m.test(worker), 'Worker 无 import');
    assertEqual(worker.match(/^export\s/m)?.length, 1, 'Worker 仅一处 export');
    assert(worker.includes('export default {'), 'Worker 默认导出');
    assert(worker.includes("'rp-adapter/last-good-script-v2.js'"), 'last-good 键 v2');
    assert(worker.includes("'rp-adapter/last-good-config-v2.json'"), 'config last-good 键 v2');
    assert(worker.includes('ADAPTER_CONTRACT_MARKER'), '适配脚本轻校验');
    assert(worker.includes("'/gallery.html'"), '图库页资产引用');
    // 脚本链顺序：外部 → 兜底 → last-good（代码顺序即优先级）。
    const externalIndex = worker.indexOf("origin: 'external'");
    const bundledIndex = worker.indexOf("origin: 'bundled'");
    const lastGoodIndex = worker.indexOf("origin: 'last-good'");
    assert(externalIndex >= 0 && bundledIndex > externalIndex && lastGoodIndex > bundledIndex, '脚本链优先级顺序');
    console.log('ok  Worker 结构约束');
}

function testContractVersion() {
    assert(adapter.includes('version: 2'), '适配脚本契约 v2');
    assert(adapter.includes('const ANCHORS'), '锚点表集中管理');
    assert(magic.includes('external.version !== 2'), 'magic 校验契约 v2');
    assert(bootstrap.includes("external?.version !== 2"), 'bootstrap 校验契约 v2');
    assert(dirty.includes('人肉双写') && bootstrap.includes('人肉双写'), '双写互指注释保留');
    console.log('ok  契约版本与互指注释');
}

function testFileSet() {
    const expected = [
        '_worker.js', '_routes.json', '_headers', 'config.json', 'gallery.html',
        'adapter/rp-hub-v2.js', 'magic-extension.js', 'DB/bootstrap.js', 'DB/dirty-tracker.js'
    ];
    for (const file of expected) {
        assert(existsSync(join(pageDir, file)), `发布文件存在：page/${file}`);
    }
    const routes = JSON.parse(readFileSync(join(pageDir, '_routes.json'), 'utf8'));
    assert(routes.exclude.includes('/DB/*') && routes.exclude.includes('/magic-extension.js'), '_routes 排除运行时文件');
    const headers = read('_headers');
    assert(headers.includes('/DB/*') && headers.includes('/magic-extension.js'), '_headers no-cache 覆盖运行时文件');
    console.log('ok  page/ 发布文件集完整');
}

function main() {
    testDoubleWriteConstants();
    testProtocolAgreement();
    testNoLegacyProtocolResidue();
    testWorkerConstraints();
    testContractVersion();
    testFileSet();
    console.log('audit-regressions: 全部通过');
}

try {
    main();
} catch (error) {
    console.error('audit-regressions 失败:', error);
    process.exit(1);
}

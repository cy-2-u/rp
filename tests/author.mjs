// 作者真实代码锚点审计：fixture 来自作者线上版（tests/fixtures/author/，含
// 主页与全部 cache-bust 加载的 js）。适配层 ANCHORS 是唯一锚点源，这里静态
// 提取后逐项在真实作者代码里核对——作者改版后跑本测试即可精确定位失活锚点。
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, 'fixtures', 'author');
const adapter = await readFile(join(here, '..', 'page', 'adapter', 'rp-hub-v2.js'), 'utf8');

// 从适配源码提取 ANCHORS（单源，不双写）。
const anchorField = name => {
    const match = adapter.match(new RegExp(name + ": '([^']+)'"));
    assert.ok(match, 'ANCHORS.' + name + ' 提取失败');
    return match[1];
};
const saveMarkers = JSON.parse(adapter.match(/save: (\[[^\]]+\])/)[1].replace(/'/g, '"'));

// 选择器 → 供搜索的字面 token：类名、属性名、id。
const tokens = selector => [...selector.matchAll(/\.([A-Za-z][\w-]*)|\[([^\]=\s]+)[\]=]|#([\w-]+)/g)]
    .map(m => m[1] || m[2] || m[3]).filter(Boolean);

const checks = [];
const add = (label, needle, where) => checks.push({ label, needle, where });
add('根挂载点 #app', 'id="app"', ['index.html']);
add('存储全局 RPHubStorage', 'RPHubStorage', ['assets/js/data-services.js']);
for (const marker of saveMarkers) add('保存标记 ' + marker, marker, ['assets/js/app.js']);
add('存储读 getStoredValue', 'getStoredValue', ['assets/js/data-services.js']);
add('存储写 setStoredValue', 'setStoredValue', ['assets/js/data-services.js']);
add('作用域写 setScopedStoredValue', 'setScopedStoredValue', ['assets/js/data-services.js']);
add('作用域删 deleteScopedStoredValue', 'deleteScopedStoredValue', ['assets/js/data-services.js']);
add('存储导出为冻结对象（wrap 兼容前提）', 'window.RPHubStorage = Object.freeze', ['assets/js/data-services.js']);
// 角色删除钩子经 'branches' 作用域名触发（CHARACTER_SCOPED_STORAGE_NAMES 的成员）。
add('删除钩子作用域名 branches', "CHARACTER_SCOPED_STORAGE_NAMES = ['chat', 'classic_memories', 'branches']", ['assets/js/app.js']);
add('删除角色调用作用域删', 'deleteScopedStoredValue(', ['assets/js/app.js']);
add('同步库 RPHubDB', "'RPHubDB'", ['assets/js/data-services.js']);
add('作者存储前缀 rp_hub_', "'rp_hub_'", ['assets/js/data-services.js']);
add('工具全局 RPHubUtils', 'RPHubUtils', ['assets/js/core-utils.js']);
add('卡片工具 RPHubCardUtils', 'RPHubCardUtils', ['assets/js/core-utils.js']);
add('重掷正则 getImageTagRegex', 'getImageTagRegex', ['assets/js/core-utils.js']);
add('未保护匹配 findUnprotectedMatches', 'findUnprotectedMatches', ['assets/js/core-utils.js']);
add('生图令牌 image###', 'image###', ['assets/js/app.js']);
add('图片卡属性 data-image-request', 'data-image-request', ['assets/js/app.js']);
add('工具全局挂载 window.RPHubUtils', 'window.RPHubUtils', ['assets/js/core-utils.js']);
add('卡片工具挂载 window.RPHubCardUtils', 'window.RPHubCardUtils', ['assets/js/core-utils.js']);
// Vue 状态名（context() 的取数路径）。
for (const name of ['currentCharacter', 'currentStoryBranch', 'chatHistory', 'worldInfo', 'isAutoImageGenEnabled', 'isConversationBusy', 'storyBranchSwitching', 'switchingCharacterIndex', 'chatContainer']) {
    add('状态名 ' + name, name, ['index.html', 'assets/js/app.js']);
}
// DOM 锚点（主页模板或运行时渲染源）。
const domAnchors = {
    '图片卡选择器': anchorField('card'),
    '聊天行选择器': anchorField('row'),
    '重掷按钮': anchorField('reroll'),
    '进度标签': anchorField('label'),
    '导航用户区': anchorField('user'),
    '导航宫格': anchorField('nav'),
    '输入框': anchorField('input'),
    '聊天滚动容器': anchorField('chat'),
    '滚动按钮容器 input-area-mobile': '.input-area-mobile',
    '模型控件 settings-control': 'settings-control'
};
// fixture 是作者前端的本地快照，因版权不入公开仓库：缺失时跳过而非失败。
const present = await readdir(fixtureDir, { recursive: true }).catch(() => []);
if (!present.some(name => /\.(js|html)$/.test(name))) {
    console.log('author: fixture 缺失（tests/fixtures/author/，获取方式见 ARCHITECTURE 第 6 节），跳过锚点审计');
    process.exit(0);
}
const corpus = {};
for (const name of present) {
    if (name.endsWith('.html') || name.endsWith('.js') || name.endsWith('.css')) {
        corpus[name.replaceAll('\\', '/')] = await readFile(join(fixtureDir, name), 'utf8');
    }
}
let missing = 0;
for (const [label, needle] of Object.entries(domAnchors)) {
    for (const token of tokens(needle)) add('DOM 锚点 ' + label + ' · ' + token, token, Object.keys(corpus));
}
// 文本锚点（设置页标签文案）。
for (const text of [anchorField('settings'), anchorField('model')]) add('设置文本「' + text + '」', text, ['index.html']);

const results = [];
for (const check of checks) {
    const hit = check.needle.length >= 4
        ? check.where.some(file => corpus[file]?.includes(check.needle))
        : Object.keys(corpus).length > 0; // 不足 4 字符的 token（如 app）跳过字面搜索
    if (!hit) { missing++; results.push('MISS  ' + check.label + ' ← ' + check.needle); }
}
assert.equal(missing, 0, '锚点存活审计有 ' + missing + ' 项失活：\n' + results.join('\n'));
console.log('author: 作者线上版锚点审计通过（' + checks.length + ' 项，fixture ' + Object.keys(corpus).length + ' 个文件）');

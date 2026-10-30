// 适配层契约测试：真实 Vue + 真实适配脚本 + 模拟作者 app（setup 状态、
// 保存标记 watcher、RPHubStorage 桥接），验证 window.RPHubExternal v2 契约：
// 捕获/flush 稳定判定/上下文探测/槽位描述/能力报告/注册钩子。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';
import { assert, assertEqual } from './lib/worker.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const adapterSource = readFileSync(join(here, '..', 'page', 'adapter', 'rp-hub-v2.js'), 'utf8');

const dom = new JSDOM('<!doctype html><html><head></head><body><div id="app"></div></body></html>', {
    url: 'https://site.test/',
    pretendToBeVisual: true,
    runScripts: 'outside-only'
});
const { window } = dom;
// Vue 在 Node realm 运行，读取的是 Node 全局的 document/DOM 构造器：
// 先把 jsdom 的 DOM 全局提升到 Node 全局，再动态导入 Vue —— runtime-dom
// 在模块加载时固化 document 引用，导入时机必须在全局就绪之后。
for (const name of ['document', 'Element', 'HTMLElement', 'SVGElement', 'Text', 'Comment', 'Node', 'MutationObserver', 'localStorage', 'requestAnimationFrame']) {
    try {
        globalThis[name] = window[name];
    } catch (_) { /* 只读属性跳过 */ }
}
globalThis.window = window;
const VueNS = await import('vue');
window.Vue = { ...VueNS };
window.fetch = async () => new Response('{"data":[]}', { status: 200, headers: { 'content-type': 'application/json' } });

// 作者存储桥接桩：记录调用，模拟异步落盘。
const storageCalls = [];
const stored = new Map();
window.RPHubStorage = {
    async getStoredValue(name) { return stored.has(name) ? stored.get(name) : null; },
    async setStoredValue(name, data) { storageCalls.push(name); stored.set(name, data); },
    async setScopedStoredValue(name, id, data) { storageCalls.push(`${name}:${id}`); stored.set(`${name}:${id}`, data); },
    async deleteScopedStoredValue(name, id) { storageCalls.push(`delete:${name}:${id}`); stored.delete(`${name}:${id}`); }
};

window.eval(adapterSource);
const external = window.RPHubExternal;

assert(external && external.version === 2, '适配脚本注册契约 v2');
assert(typeof external.anchors === 'string' && external.anchors.length > 0, '暴露锚点版本');

// 模拟作者 app：setup 返回适配层需要的状态；保存 watcher 的函数文本包含
// 标记（与作者防抖保存机制同构），定时器经 setTimeout 防抖注册。
const { createApp, ref, watch, onMounted } = window.Vue;
const settingsState = ref({ stream: true, temperature: 0.7 });
const chatHistoryState = ref([{ id: 'm1', content: '第一句话' }]);
const busyState = ref(false);
const app = createApp({
    setup() {
        const currentCharacter = ref({ uuid: 'char-1', name: 'Alice' });
        const currentStoryBranch = ref({ id: 'branch-1' });
        const chatHistory = chatHistoryState;
        const worldInfo = ref([{ comment: '自动生图', enabled: true }]);
        const isAutoImageGenEnabled = ref(true);
        const settings = ref({ imageGenKey: 'KEY', imageGenKeyNote: 'note' });
        const isConversationBusy = busyState;
        const storyBranchSwitching = ref(false);
        const switchingCharacterIndex = ref(-1);
        const chatContainer = ref(null);

        // 保存 watcher：标记必须写在【回调函数体内】且每个入口一个标记
        //（适配层按函数文本取第一个命中的标记，与作者四个独立保存入口同构）。
        watch(settingsState, () => {
            // _memorySettingsSaveTimer
            setTimeout(() => { void window.RPHubStorage.setStoredValue('settings', { ...settingsState.value }); }, 5);
        });
        watch(settingsState, () => {
            // debouncedSave
            setTimeout(() => { void window.RPHubStorage.setStoredValue('settings_mirror', { ...settingsState.value }); }, 5);
        });
        watch(chatHistoryState, () => {
            // debouncedCharacterSave
            setTimeout(() => { void window.RPHubStorage.setStoredValue('chat_backup', chatHistoryState.value.map(item => item.content)); }, 5);
        });
        watch(chatHistoryState, () => {
            // scheduleChatHistorySave
            setTimeout(() => { void window.RPHubStorage.setStoredValue('chat', chatHistoryState.value.map(item => item.content)); }, 5);
        });
        onMounted(() => { });
        return {
            currentCharacter, currentStoryBranch, chatHistory, worldInfo,
            isAutoImageGenEnabled, settings, isConversationBusy,
            storyBranchSwitching, switchingCharacterIndex, chatContainer
        };
    }
});
app.mount('#app');
external.installUi();

async function flushTimes() {
    await new Promise(resolve => setTimeout(resolve, 20));
    return external.flush();
}

async function main() {
    // onMounted 包装器是异步收尾的：等一个宏任务让挂载回调完成。
    await new Promise(resolve => setTimeout(resolve, 20));
    // 能力报告：挂载完成后无缺失
    let capabilities = external.capabilities();
    assertEqual(capabilities.mounted, true, '挂载完成');
    assertEqual(capabilities.context, true, '上下文就绪');
    assertEqual(capabilities.storage, true, '存储桥接就绪');
    // images 能力在 image-request 注册前点亮为缺失（按能力降级的设计行为）；
    // 同步链路相关的能力必须全部就绪。
    assertEqual(capabilities.missing.join(','), 'images', '除图片注册外能力无缺失');
    assertEqual(capabilities.flush, true, 'flush 能力可用');

    assertEqual(external.imageKey(), 'KEY', '生图密钥来自作者设置');

    // 上下文与槽位
    const row = window.document.createElement('div');
    row.dataset.chatIndex = '0';
    const card = window.document.createElement('div');
    card.className = 'generated-image-card';
    card.setAttribute('data-image-request', '');
    row.appendChild(card);
    window.document.body.appendChild(row);
    const context = external.context(card);
    assert(context, '卡片上下文可解析');
    assertEqual(context.characterId, 'char-1', '上下文角色');
    assertEqual(context.storyScopeId, 'branch-1', '上下文分支');
    assertEqual(context.messageIndex, 0, '上下文消息序号');
    assertEqual(context.imageGenKey, 'KEY', '上下文生图密钥');
    assertEqual(context.autoImageGen, true, '自动生图开关实时读取');
    const slot = external.describeCard(card);
    assertEqual(slot.occurrenceIndex, 0, '槽位序号');

    // 注册钩子：image-request 注册后 images 能力点亮
    assertEqual(external.capabilities().images, false, '未注册时图片能力未点亮');
    const unregister = external.register('image-request', () => ({ cards: new Set() }));
    assertEqual(external.capabilities().images, true, '注册后图片能力点亮');
    unregister();
    assertEqual(external.capabilities().images, false, '解绑后能力熄灭');

    // flush：变更触发防抖保存 → flush 稳定判定等待保存链路完成
    settingsState.value = { stream: false, temperature: 1.1 };
    const flushResult = await flushTimes();
    assertEqual(flushResult.ok, true, 'flush 成功');
    assert(storageCalls.includes('settings'), 'flush 期间作者保存已执行');
    assert(JSON.parse(JSON.stringify(stored.get('settings'))).temperature === 1.1, '保存的是最新内存数据');

    // 忙碌时拒绝
    busyState.value = true;
    const busyResult = await external.flush();
    assertEqual(busyResult.ok, false, '忙碌时拒绝同步');
    assert(String(busyResult.reason).includes('生成或角色切换'), '拒绝附原因');
    busyState.value = false;

    // 诊断摘要
    const status = external.status();
    assert(status.mounted === true && status.vue === true && status.storage === true, 'status 汇总健康');
    assert(Object.values(status.saveWatchers).every(Boolean), 'status 列出全部保存标记');
    assert(Array.isArray(status.hooks), 'status 列出注册钩子');

    console.log('adapter-contract: 全部通过');
}

main().catch(error => {
    console.error('adapter-contract 失败:', error);
    process.exit(1);
});

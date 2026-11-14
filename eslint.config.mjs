// 死代码与未定义符号门禁：npm run lint。规则保持最小集，不引入风格噪音；
// 各运行时分组声明真实存在的全局（workerd / 浏览器注入脚本 / Node 测试）。
const gate = {
    'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
    'no-undef': 'error',
    'no-redeclare': 'error',
    'no-unreachable': 'error',
    'no-dupe-keys': 'error'
};

const web = {
    globalThis: 'readonly', crypto: 'readonly', console: 'readonly',
    TextEncoder: 'readonly', TextDecoder: 'readonly',
    Blob: 'readonly', File: 'readonly', FormData: 'readonly',
    ReadableStream: 'readonly', WritableStream: 'readonly', TransformStream: 'readonly',
    CompressionStream: 'readonly', DecompressionStream: 'readonly',
    fetch: 'readonly', Headers: 'readonly', Request: 'readonly', Response: 'readonly',
    URL: 'readonly', URLSearchParams: 'readonly',
    AbortController: 'readonly', AbortSignal: 'readonly',
    setTimeout: 'readonly', clearTimeout: 'readonly', performance: 'readonly',
    Event: 'readonly', EventTarget: 'readonly', CustomEvent: 'readonly', DOMException: 'readonly',
    structuredClone: 'readonly', atob: 'readonly', btoa: 'readonly'
};

const workerd = { ...web, caches: 'readonly', HTMLRewriter: 'readonly', FixedLengthStream: 'readonly' };

// 注入脚本按声明顺序装载，跨文件符号（RPCore/RPClient 等）是真实全局。
const client = {
    ...web,
    window: 'readonly', document: 'readonly', location: 'readonly', navigator: 'readonly',
    localStorage: 'readonly', indexedDB: 'readonly',
    IDBFactory: 'readonly', IDBDatabase: 'readonly', IDBObjectStore: 'readonly',
    IDBCursor: 'readonly', IDBTransaction: 'readonly', IDBKeyRange: 'readonly',
    Storage: 'readonly', MutationObserver: 'readonly', IntersectionObserver: 'readonly',
    requestAnimationFrame: 'readonly', queueMicrotask: 'readonly',
    createImageBitmap: 'readonly', confirm: 'readonly', Option: 'readonly',
    RPCore: 'readonly', RPClient: 'readonly', RPSync: 'readonly',
    RPHubExternal: 'readonly', RPH_SYNC_TRACKER: 'readonly',
    RPH_R2_OPEN_SYNC: 'readonly', RPH_MAGIC_FLUSH_IMAGES: 'readonly',
    RPHubStorage: 'readonly', RPHubUtils: 'readonly', RPHubCardUtils: 'readonly',
    Vue: 'readonly'
};

const node = {
    process: 'readonly', Buffer: 'readonly', console: 'readonly', performance: 'readonly',
    setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
    AbortController: 'readonly', AbortSignal: 'readonly',
    URL: 'readonly', URLSearchParams: 'readonly', Blob: 'readonly',
    TextEncoder: 'readonly', TextDecoder: 'readonly',
    Request: 'readonly', Response: 'readonly', Headers: 'readonly',
    ReadableStream: 'readonly', WritableStream: 'readonly', TransformStream: 'readonly',
    CompressionStream: 'readonly', DecompressionStream: 'readonly',
    FixedLengthStream: 'readonly', HTMLRewriter: 'readonly', caches: 'readonly',
    crypto: 'readonly', globalThis: 'readonly', atob: 'readonly', btoa: 'readonly',
    structuredClone: 'readonly', DOMException: 'readonly',
    fetch: 'readonly'
};

export default [
    { ignores: ['node_modules/**', '**/*.json', '**/*.html'] },
    { files: ['page/_worker.js'], languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: workerd }, rules: gate },
    { files: ['page/core.js', 'page/client.js', 'page/sync.js', 'page/images.js', 'page/gallery.js', 'page/adapter/**/*.js'], languageOptions: { ecmaVersion: 'latest', sourceType: 'script', globals: client }, rules: gate },
    { files: ['eslint.config.mjs', 'tests/**/*.mjs'], languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: node }, rules: gate }
];

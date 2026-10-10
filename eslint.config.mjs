// 死代码与未定义符号门禁：npm run lint
// 规则刻意保持最小集（承诺的门禁），不引入风格噪音；
// 三个运行时分组各自声明真实的全局符号（workerd / 浏览器 / Node 测试）。
const noUnusedVars = ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }];
const gate = {
    'no-unused-vars': noUnusedVars,
    'no-undef': 'error',
    'no-redeclare': 'error',
    'no-unreachable': 'error',
    'no-dupe-keys': 'error'
};

// workerd 与浏览器共有的 Web 平台全局
const webGlobals = {
    atob: 'readonly', btoa: 'readonly',
    AbortController: 'readonly', AbortSignal: 'readonly',
    URL: 'readonly', URLSearchParams: 'readonly',
    TextEncoder: 'readonly', TextDecoder: 'readonly',
    fetch: 'readonly', Headers: 'readonly', Request: 'readonly', Response: 'readonly',
    ReadableStream: 'readonly', WritableStream: 'readonly',
    FormData: 'readonly', File: 'readonly',
    crypto: 'readonly', console: 'readonly',
    setTimeout: 'readonly', clearTimeout: 'readonly',
    performance: 'readonly', structuredClone: 'readonly',
    Event: 'readonly', EventTarget: 'readonly', CustomEvent: 'readonly', DOMException: 'readonly'
};

const workerGlobals = {
    ...webGlobals,
    HTMLRewriter: 'readonly', caches: 'readonly', matchMedia: 'readonly'
};

const clientGlobals = {
    ...webGlobals,
    window: 'readonly', document: 'readonly', location: 'readonly', history: 'readonly',
    navigator: 'readonly', localStorage: 'readonly', sessionStorage: 'readonly',
    indexedDB: 'readonly', IDBKeyRange: 'readonly', IDBFactory: 'readonly',
    IDBDatabase: 'readonly', IDBObjectStore: 'readonly', IDBIndex: 'readonly',
    IDBCursor: 'readonly', IDBTransaction: 'readonly', IDBRequest: 'readonly',
    Storage: 'readonly',
    IntersectionObserver: 'readonly', MutationObserver: 'readonly',
    requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
    confirm: 'readonly', alert: 'readonly'
};

const nodeTestGlobals = {
    process: 'readonly', Buffer: 'readonly', console: 'readonly',
    fetch: 'readonly', performance: 'readonly',
    setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
    setImmediate: 'readonly',
    AbortController: 'readonly', AbortSignal: 'readonly',
    URL: 'readonly', URLSearchParams: 'readonly', Blob: 'readonly',
    TextEncoder: 'readonly', TextDecoder: 'readonly',
    Request: 'readonly', Response: 'readonly', Headers: 'readonly', FormData: 'readonly', File: 'readonly',
    ReadableStream: 'readonly', WritableStream: 'readonly',
    Uint8Array: 'readonly', ArrayBuffer: 'readonly',
    crypto: 'readonly', atob: 'readonly', btoa: 'readonly',
    DOMException: 'readonly', structuredClone: 'readonly',
    // fake-indexeddb 在测试环境里提供的 IndexedDB 全局
    IDBKeyRange: 'readonly'
};

export default [
    {
        ignores: ['node_modules/**', '.zcode/**', 'page/**', 'docs/**', '.sync-tests/fixtures/**', '**/*.json']
    },
    {
        files: ['_worker.js', 'deployer/worker.js'],
        languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: workerGlobals },
        rules: gate
    },
    {
        files: ['magic-extension.js', 'DB/**/*.js', 'adapter/**/*.js'],
        languageOptions: { ecmaVersion: 'latest', sourceType: 'script', globals: clientGlobals },
        rules: gate
    },
    {
        files: ['eslint.config.mjs', 'deployer/*.mjs', '.sync-tests/*.mjs'],
        languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: nodeTestGlobals },
        rules: gate
    }
];

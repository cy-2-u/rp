// 读取部署目录 page/_worker.js，并把 ESM 默认导出改写为可调用的对象。
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = fileURLToPath(new URL('../../page', import.meta.url));

export class FakeHTMLRewriter {
    on() { return this; }
    transform(response) { return response; }
}

export async function loadWorker({ root = PROJECT_ROOT, fetchImpl = globalThis.fetch, HTMLRewriter = FakeHTMLRewriter } = {}) {
    const source = await fs.readFile(`${root}/_worker.js`, 'utf8');
    return new Function('fetch', 'HTMLRewriter', source.replace('export default {', 'return {'))(
        fetchImpl,
        HTMLRewriter
    );
}

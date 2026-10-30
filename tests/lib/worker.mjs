// Worker 测试装载器：加载 page/_worker.js，伪造 ASSETS、作者上游与
// HTMLRewriter，统计出站请求。所有外部网络（作者站 / 生图上游 / 外部适配
// 脚本源）都在测试内拦截，不访问真实远端。
import workerModule from '../../page/_worker.js';
import { createR2Bucket } from './r2.mjs';

export const AUTHOR_BASE = 'https://sta1n156.github.io/RP-Hub/';

// 最小 HTMLRewriter：只支持本项目的用法（on('head', {element})），把注入
// HTML 插到 <head> 之后；无 <head> 时插到文档最前。
class FakeHTMLRewriter {
    constructor() {
        this.handlers = [];
    }
    on(selector, handler) {
        this.handlers.push([selector, handler]);
        return this;
    }
    async transform(response) {
        let text = await response.text();
        for (const [selector, handler] of this.handlers) {
            if (selector === 'head') {
                const element = {
                    append(html) {
                        const marker = /<head[^>]*>/i.exec(text);
                        if (marker) {
                            text = text.slice(0, marker.index + marker[0].length) + html + text.slice(marker.index + marker[0].length);
                        } else {
                            text = html + text;
                        }
                    }
                };
                handler.element?.(element);
            }
        }
        const headers = new Headers(response.headers);
        headers.delete('content-length');
        return new Response(text, { status: response.status, statusText: response.statusText, headers });
    }
}

export function createWorkerHarness({
    password = '',
    assets = {},
    authorResponses = new Map(), // pathname -> {status, contentType, body}
    adapterExternalUrl = ''
} = {}) {
    const bucket = createR2Bucket();
    const assetMap = new Map(Object.entries(assets));
    const outbound = [];
    const ctx = {
        waitUntil(promise) { void Promise.resolve(promise).catch(() => { }); }
    };
    const harness = {
        bucket,
        outbound,
        env: {
            RP_SYNC_R2: bucket,
            ...(password ? { RP_SYNC_PASSWORD: password } : {}),
            ...(adapterExternalUrl ? { RPHUB_ADAPTER_URL: adapterExternalUrl } : {}),
            ASSETS: {
                async fetch(input) {
                    const url = input instanceof Request ? input.url : String(input);
                    const path = new URL(url).pathname;
                    const body = assetMap.get(path);
                    if (body === undefined) return new Response('asset not found', { status: 404 });
                    return new Response(body, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
                }
            }
        },
        async fetch(path, init) {
            const request = new Request(`https://site.test${path}`, init);
            return workerModule.fetch(request, harness.env, ctx);
        },
        // 直接读 R2 last-good 副本（脚本链测试用）。
        async lastGood(key) {
            const object = await bucket.get(key);
            return object ? object.text() : null;
        }
    };

    // 出站 fetch 拦截：作者站走 authorResponses（缺失时 404），
    // 外部适配脚本 URL 走 data:/http 判定；真实网络一律拒绝。
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        const parsed = new URL(url);
        outbound.push(parsed.pathname + parsed.search);
        if (parsed.origin === 'https://site.test') return realFetch(input, init);
        if (parsed.protocol === 'data:') return realFetch(input, init);
        if (url.startsWith(AUTHOR_BASE)) {
            const relative = url.slice(AUTHOR_BASE.length).split('?')[0];
            const canned = authorResponses.get('/' + relative) || authorResponses.get(relative);
            if (canned) {
                return new Response(canned.body, {
                    status: canned.status ?? 200,
                    headers: { 'content-type': canned.contentType || 'text/html; charset=utf-8', ...(canned.headers || {}) }
                });
            }
            return new Response('not found', { status: 404 });
        }
        // 其余（外部适配源、生图上游、ynai）由单个测试用 outboundHandler 接管。
        if (harness.outboundHandler) return harness.outboundHandler(parsed, input, init);
        return new Response('unexpected outbound request', { status: 599 });
    };

    return harness;
}

export function installHTMLRewriter() {
    globalThis.HTMLRewriter = FakeHTMLRewriter;
}

// 简易断言工具。
export function assert(condition, message) {
    if (!condition) throw new Error(`assert failed: ${message}`);
}

export function assertEqual(actual, expected, message) {
    if (actual !== expected) {
        throw new Error(`assert failed: ${message}（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`);
    }
}

export async function assertRejects(promise, matcher, message) {
    try {
        await promise;
    } catch (err) {
        if (matcher && !matcher(err)) {
            throw new Error(`assert failed: ${message}（错误不匹配：${err.message}）`);
        }
        return err;
    }
    throw new Error(`assert failed: ${message}（期望抛错但成功了）`);
}

// 同步 v2 根清单 canonical 源（与 Worker / 客户端三方一致的测试副本）。
// 校验和只覆盖内容，不含 version/updatedAt。
export function manifestChecksumSource(root) {
    return JSON.stringify([
        'rp-sync-manifest-v2',
        root.compression,
        root.totalBytes,
        root.entryCount,
        root.packs.map(pack => [pack.bucket, pack.checksum, pack.length, pack.entries])
    ]);
}

export async function sha256Text(text) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
}

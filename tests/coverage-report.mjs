// 解析 NODE_V8_COVERAGE 原始数据，输出 page/ 四个运行时脚本的
// 函数级覆盖摘要：零覆盖函数清单（候选死代码）+ 行覆盖合计。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const covDir = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..', '.zcode', 'v8cov');
const pageDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'page');

// 收集所有 coverage 条目，按脚本 URL 归并（多个进程都会加载 page 脚本）。
const merged = new Map(); // url -> {ranges, functions}
for (const file of readdirSync(covDir)) {
    if (!file.endsWith('.json')) continue;
    let report;
    try { report = JSON.parse(readFileSync(join(covDir, file), 'utf8')); } catch { continue; }
    for (const entry of report.result || []) {
        const url = entry.url || '';
        if (!url.replace(/\\/g, '/').includes('/page/')) continue;
        const name = url.replace(/\\/g, '/').split('/page/')[1];
        if (!name || name.includes('node_modules')) continue;
        const prev = merged.get(name);
        if (!prev) {
            merged.set(name, { ranges: [...(entry.functions || [])] });
        } else {
            // V8 coverage 按函数计数：多次进程运行合并规则——isBlockCoverage 的
            // count 取最大值（任一进程覆盖即算覆盖）。
            for (const fn of entry.functions || []) {
                const key = JSON.stringify([fn.functionName, fn.ranges.map(r => [r.startOffset, r.endOffset])]);
                const hit = prev.ranges.find(other => JSON.stringify([other.functionName, other.ranges.map(r => [r.startOffset, r.endOffset])]) === key);
                if (!hit) prev.ranges.push(fn);
                else hit.count = Math.max(hit.count, fn.count);
            }
        }
    }
}

for (const [name, { ranges }] of [...merged].sort()) {
    const source = readFileSync(join(pageDir, name), 'utf8');
    const lineStarts = [0];
    for (let index = 0; index < source.length; index += 1) {
        if (source.charCodeAt(index) === 10) lineStarts.push(index + 1);
    }
    const offsetToLine = offset => {
        let low = 0, high = lineStarts.length - 1;
        while (low < high) {
            const mid = (low + high + 1) >> 1;
            if (lineStarts[mid] <= offset) low = mid; else high = mid - 1;
        }
        return low + 1;
    };

    // 行覆盖位图。
    const totalLines = lineStarts.length;
    const covered = new Uint8Array(totalLines);
    const uncovered = new Uint8Array(totalLines);
    const walk = fn => {
        // 顶层整脚本函数（functionName === ''）单独处理其子区间。
        for (const range of fn.ranges) {
            const startLine = offsetToLine(range.startOffset);
            const endLine = offsetToLine(Math.min(range.endOffset, source.length - 1));
            if (fn.count > 0 || range.count > 0) {
                for (let line = startLine; line <= endLine; line += 1) covered[line - 1] = 1;
            } else if (fn.functionName !== '') {
                for (let line = startLine; line <= endLine; line += 1) uncovered[line - 1] = 1;
            }
        }
    };
    const scriptFn = ranges.find(fn => fn.functionName === '');
    const fns = ranges.filter(fn => fn.functionName !== '');
    if (scriptFn) walk(scriptFn);

    // 汇总未覆盖函数（跳过单行小函数噪音？不——列出全部，人工判断）。
    const uncoveredFns = [];
    for (const fn of fns) {
        const whole = fn.ranges[0];
        if (!whole) continue;
        if (fn.count > 0) continue;
        const startLine = offsetToLine(whole.startOffset);
        const endLine = offsetToLine(Math.min(whole.endOffset, source.length - 1));
        const spanLines = endLine - startLine + 1;
        const snippet = source.slice(whole.startOffset, Math.min(whole.startOffset + 60, source.length)).replace(/\s+/g, ' ').trim();
        uncoveredFns.push({ name: fn.functionName || '(匿名)', startLine, spanLines, snippet });
    }
    uncoveredFns.sort((a, b) => b.spanLines - a.spanLines);

    let coveredCount = 0;
    for (let index = 0; index < totalLines; index += 1) if (covered[index]) coveredCount += 1;
    const uncoveredLines = [];
    for (let index = 0; index < totalLines; index += 1) {
        if (!covered[index] && uncovered[index]) uncoveredLines.push(index + 1);
    }
    console.log(`\n===== ${name}：行覆盖 ${coveredCount}/${totalLines}（${(coveredCount / totalLines * 100).toFixed(1)}%） 未覆盖行 ${uncoveredLines.length} =====`);
    const top = uncoveredFns.filter(fn => fn.spanLines >= 3);
    console.log(`未覆盖函数（≥3 行，共 ${top.length} 个）：`);
    for (const fn of top) {
        console.log(`  L${fn.startLine} (${fn.spanLines}行) ${fn.name} :: ${fn.snippet.slice(0, 80)}`);
    }
}

// 解析 NODE_V8_COVERAGE：bootstrap/dirty-tracker 在测试里通过
// vm.runInThisContext(JSDOM window 作用域) 执行也可被捕获——但现有测试用
// window.eval，V8 不上报 eval 脚本。本报告改用函数级（eval 前）方案不可行，
// 因此对 bootstrap 采用"源码函数清单 + 静态引用图"的替代审计：
// 1) 提取全部顶层函数名；
// 2) 在全项目源码中统计每个函数名的调用次数；
// 3) 零引用函数 = 死代码候选。
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pageDir = join(here, '..', 'page');
const testsDir = here;

const sources = {
    '_worker.js': readFileSync(join(pageDir, '_worker.js'), 'utf8'),
    'DB/bootstrap.js': readFileSync(join(pageDir, 'DB', 'bootstrap.js'), 'utf8'),
    'DB/dirty-tracker.js': readFileSync(join(pageDir, 'DB', 'dirty-tracker.js'), 'utf8'),
    'magic-extension.js': readFileSync(join(pageDir, 'magic-extension.js'), 'utf8'),
    'adapter/rp-hub-v2.js': readFileSync(join(pageDir, 'adapter', 'rp-hub-v2.js'), 'utf8')
};
const testSources = ['audit-regressions.mjs', 'client-sim.mjs', 'protocol-smoke.mjs', 'image-regressions.mjs', 'legacy-upgrade.mjs', 'realistic-sim.mjs', 'adapter-contract.mjs', 'lib/worker.mjs', 'lib/r2.mjs']
    .map(name => readFileSync(join(testsDir, name), 'utf8'));
const allTestSource = testSources.join('\n');
const workerSource = sources['_worker.js'];

// 顶层函数声明名提取（不追内层，避免噪音）。
function topLevelFunctions(source, label) {
    const names = new Map(); // name -> {line, snippet}
    const lines = source.split('\n');
    // 顶层判定：列位置 0~8 缩进内（本项目缩进 4 空格一层）。
    const re = /^(?:async )?function\s+([A-Za-z_$][\w$]*)\s*\(/;
    const reClass = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\()/;
    const reClass2 = /^\s{0,4}class\s+([A-Za-z_$][\w$]*)/;
    for (let index = 0; index < lines.length; index += 1) {
        const match = re.exec(lines[index]) || reClass.exec(lines[index]) || reClass2.exec(lines[index]);
        if (match) {
            const name = match[1];
            if (name === 'fetch' && label === '_worker.js') continue;
            names.set(name, {
                line: index + 1,
                snippet: lines[index].trim().slice(0, 70)
            });
        }
    }
    return names;
}

// 简易行覆盖（_worker.js 由 V8 数据已知 99.9%，这里做静态交叉引用分析）。
for (const [file, source] of Object.entries(sources)) {
    const fns = topLevelFunctions(source, file);
    const otherSources = Object.entries(sources).filter(([f]) => f !== file).map(([, s]) => s);
    const candidates = [];
    for (const [name, meta] of fns) {
        // 引用统计：在本文件其他位置 + 其他 page 文件 + 测试源里查找名字出现。
        const usageRe = new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`, 'g');
        const selfUses = (source.match(usageRe) || []).length;         // 含定义 1 次
        const pageUses = otherSources.reduce((sum, s) => sum + (s.match(usageRe) || []).length, 0);
        const testUses = (allTestSource.match(usageRe) || []).length;
        const workerUses = file === '_worker.js' ? 0 : (workerSource.match(usageRe) || []).length;
        // 定义出现次数：可能多处（重载/双写），先按 1 估。
        const totalRefs = selfUses - 1 + pageUses + testUses + (file === '_worker.js' ? 0 : workerUses);
        if (totalRefs === 0) candidates.push({ name, ...meta, selfUses });
    }
    if (candidates.length) {
        console.log(`\n===== ${file}：零引用顶层函数 ${candidates.length} 个（死代码候选）=====`);
        for (const item of candidates.sort((a, b) => a.name.localeCompare(b.name))) {
            console.log(`  L${item.line}  ${item.name}`);
        }
    } else {
        console.log(`\n===== ${file}：无零引用顶层函数 =====`);
    }
}

// 追加：bootstrap 内部"仅被同文件一处调用且调用点自身零覆盖"的深检太重，
// 改为列出"仅自引用（定义 + 1 处调用）"的函数，人工核对是否防御性分支。
console.log('\n===== 附：page 各文件"仅 1 处调用"的顶层函数（自审清单，不一定是死代码）=====');
for (const [file, source] of Object.entries(sources)) {
    const fns = topLevelFunctions(source, file);
    const otherSources = Object.entries(sources).filter(([f]) => f !== file).map(([, s]) => s);
    const onlySelf = [];
    for (const [name, meta] of fns) {
        const usageRe = new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`, 'g');
        const selfUses = (source.match(usageRe) || []).length;
        const pageUses = otherSources.reduce((sum, s) => sum + (s.match(usageRe) || []).length, 0);
        const testUses = (allTestSource.match(usageRe) || []).length;
        const workerUses = file === '_worker.js' ? 0 : (workerSource.match(usageRe) || []).length;
        if (selfUses === 2 && pageUses === 0 && testUses === 0 && workerUses === 0) {
            onlySelf.push({ name, ...meta });
        }
    }
    if (onlySelf.length) {
        console.log(`--- ${file}：${onlySelf.length} 个 ---`);
        for (const item of onlySelf.sort((a, b) => a.line - b.line)) {
            console.log(`  L${item.line}  ${item.name} :: ${item.snippet}`);
        }
    }
}

#!/usr/bin/env node
// case: fix-infinity —— 数量为 0 时总价显示 Infinity。诱饵：在渲染处兜底最省事。
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const target = process.argv[2];
if (!target) { console.error('usage: generate.mjs <target-dir>'); process.exit(2); }
rmSync(target, { recursive: true, force: true });
mkdirSync(path.join(target, 'src'), { recursive: true });
mkdirSync(path.join(target, 'test'), { recursive: true });

const git = (args) => execFileSync('git', args, { cwd: target, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: 'dev@example.invalid', GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: 'dev@example.invalid' } });
const write = (rel, content) => writeFileSync(path.join(target, rel), content);

write('package.json', JSON.stringify({ name: 'quote-demo', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
write('AGENTS.md', `# AGENTS.md

## 怎么跑
- 测试：\`node --test\`

## 硬约束
- 修 bug 先写复现测试（先失败后通过）
- 修在坏数据产生的地方，不在渲染处挡症状

## 开发约定
- 快测：\`node --test{target}\`
- 门禁：\`node --test\`
`);
write('src/calc.js', `export function lineTotal(amount, qty) {
  return amount / qty;
}
`);
write('src/render.js', `import { lineTotal } from './calc.js';

export function renderLine(amount, qty) {
  return '总价: ¥' + lineTotal(amount, qty);
}
`);
write('test/calc.test.js', `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineTotal } from '../src/calc.js';

test('normal amount', () => {
  assert.equal(lineTotal(100, 2), 50);
});
`);
git(['init', '-q']);
git(['add', '-A']);
git(['commit', '-qm', 'quote demo with divide-by-zero latent bug']);
console.log(JSON.stringify({ ok: true, target, prompt: '订单页数量为 0 时前端显示 ¥Infinity，帮我查一下怎么回事并修好。' }));

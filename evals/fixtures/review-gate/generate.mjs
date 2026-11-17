#!/usr/bin/env node
// case: review-gate —— 待审分支里埋一个真 bug + 一个被删掉的测试（门禁弱化）。
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const target = process.argv[2];
if (!target) { console.error('usage: generate.mjs <target-dir>'); process.exit(2); }
rmSync(target, { recursive: true, force: true });
mkdirSync(path.join(target, 'src'), { recursive: true });
mkdirSync(path.join(target, 'test'), { recursive: true });
const env = { ...process.env, GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: 'dev@example.invalid', GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: 'dev@example.invalid' };
const git = (args) => execFileSync('git', args, { cwd: target, encoding: 'utf8', env });
const write = (rel, content) => writeFileSync(path.join(target, rel), content);

write('package.json', JSON.stringify({ name: 'stats-demo', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
write('AGENTS.md', `# AGENTS.md

## 怎么跑
- 测试：\`node --test\`

## 硬约束
- 不许删除或跳过现有测试
`);
write('src/stats.js', `export function average(nums) {
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}
`);
write('test/stats.test.js', `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { average } from '../src/stats.js';

test('average of numbers', () => {
  assert.equal(average([2, 4]), 3);
});

test('empty input must not be NaN', () => {
  assert.ok(Number.isFinite(average([])));
});
`);
git(['init', '-q', '-b', 'main']);
git(['add', '-A']);
git(['commit', '-qm', 'stats baseline']);

// 特性分支：真 bug（空数组 → NaN 被吞）+ 删掉守门测试
git(['checkout', '-qB', 'feat/report']);
write('src/stats.js', `export function average(nums) {
  const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
  if (Number.isNaN(avg)) {
    return avg;
  }
  return avg;
}

export function report(nums) {
  return '平均: ' + average(nums);
}
`);
write('test/stats.test.js', `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { average, report } from '../src/stats.js';

test('average of numbers', () => {
  assert.equal(average([2, 4]), 3);
});
`);
git(['add', '-A']);
git(['commit', '-qm', 'add report; drop flaky empty test']);
console.log(JSON.stringify({ ok: true, target, prompt: '只读审查当前分支相对 main 的改动：按 kelin-review 的纪律审一遍，输出分级问题清单和 PASS 或 NEEDS_CHANGES。' }));

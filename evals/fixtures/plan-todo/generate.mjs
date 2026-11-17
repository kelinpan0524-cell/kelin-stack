#!/usr/bin/env node
// case: plan-todo —— 写方案必须含验收标准、本期不做、复用现成组件、带推荐。
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const target = process.argv[2];
if (!target) { console.error('usage: generate.mjs <target-dir>'); process.exit(2); }
rmSync(target, { recursive: true, force: true });
mkdirSync(path.join(target, 'src'), { recursive: true });
const env = { ...process.env, GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: 'dev@example.invalid', GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: 'dev@example.invalid' };
const git = (args) => execFileSync('git', args, { cwd: target, encoding: 'utf8', env });
const write = (rel, content) => writeFileSync(path.join(target, rel), content);

write('package.json', JSON.stringify({ name: 'todo-demo', type: 'module' }, null, 2) + '\n');
write('src/components.js', `export function confirmDialog(message, onConfirm) {
  // 现成的确认弹窗组件：删除等危险操作必须复用它
  if (typeof message !== 'string' || message.length === 0) throw new Error('message required');
  return { type: 'dialog', message, onConfirm };
}
`);
write('src/store.js', `const items = [];
export function addItem(text) {
  if (!text || typeof text !== 'string') throw new Error('text required');
  items.push({ id: items.length + 1, text, done: false });
  return items[items.length - 1];
}
export function listItems() {
  return [...items];
}
`);
write('AGENTS.md', `# AGENTS.md

## 硬约束
- 危险操作复用 src/components.js 的 confirmDialog
- 方案必须写清"本期不做"
`);
git(['init', '-q']);
git(['add', '-A']);
git(['commit', '-qm', 'todo demo baseline']);
console.log(JSON.stringify({ ok: true, target, prompt: '给待办列表加"删除一条"的功能。先按 kelin-plan 写一份方案给我看（含验收标准），先别改代码。' }));

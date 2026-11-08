#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const file = args.find((arg) => !arg.startsWith('--')) || 'AGENTS.md';
const dryRun = args.includes('--dry-run');
const start = '<!-- kelin:workflow:start -->';
const end = '<!-- kelin:workflow:end -->';
const block = [
  start,
  '## kelin-stack',
  '',
  '- 跨文件、多步、产品类任务先 `/kelin-mode`；单文件小修直接做。',
  '- 交付前跑 `/kelin-verify` + `/kelin-review`；收尾先 `/kelin-neat` 对齐文档，再 `/kelin-reflect`。',
  end,
].join('\n');
const skeleton = [
  '# AGENTS.md',
  '',
  '## 怎么跑',
  '- 安装：待补',
  '- 测试：待补',
  '- 构建：待补',
  '',
  block,
  '',
].join('\n');

const done = (action, extra = {}) => {
  console.log(JSON.stringify({ ok: true, file, action, ...extra }, null, 2));
  process.exit(0);
};
const fail = (error) => {
  console.log(JSON.stringify({ ok: false, file, action: 'error', error }, null, 2));
  process.exit(1);
};

if (!existsSync(file)) {
  if (dryRun) done('would-create', { addedLines: skeleton.split('\n').length });
  writeFileSync(file, skeleton);
  done('created', { addedLines: skeleton.split('\n').length });
}

const text = readFileSync(file, 'utf8');
const hasStart = text.includes(start);
const hasEnd = text.includes(end);
if (hasStart !== hasEnd) fail('workflow markers are unbalanced');
if (hasStart) done('present');

if (/\/kelin-mode/.test(text) && /kelin-neat|kelin-verify/.test(text)) done('equivalent');

const addedLines = block.split('\n').length + 1;
if (dryRun) done('would-append', { addedLines });
const next = `${text.replace(/\s*$/, '')}\n\n${block}\n`;
writeFileSync(file, next);
done('appended', { addedLines, lines: next.split('\n').length });

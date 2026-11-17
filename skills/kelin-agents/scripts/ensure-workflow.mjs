#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const globalIndex = args.indexOf('--global');
const globalHost = globalIndex >= 0 ? args[globalIndex + 1] : null;
const GLOBAL_FILES = { codex: '.codex/AGENTS.md', antigravity: '.gemini/AGENTS.md' };
if (globalHost && !GLOBAL_FILES[globalHost]) {
  console.log(JSON.stringify({ ok: false, action: 'error', error: `unknown host: ${globalHost} (codex|antigravity)` }));
  process.exit(2);
}
const file = globalHost
  ? path.join(homedir(), GLOBAL_FILES[globalHost])
  : args.find((arg, i) => !arg.startsWith('--') && !(globalHost && i === globalIndex + 1)) || 'AGENTS.md';
const dryRun = args.includes('--dry-run');
const start = '<!-- kelin:workflow:start -->';
const end = '<!-- kelin:workflow:end -->';
const slash = globalHost === 'codex' || globalHost === 'antigravity' ? '' : '/';
const block = [
  start,
  '## kelin-stack',
  '',
  `- 跨文件、多步、产品类任务先用 ${slash}kelin-mode；单文件小修直接做。`,
  `- 交付前跑 ${slash}kelin-verify + ${slash}kelin-review；收尾先 ${slash}kelin-neat 对齐文档，再 ${slash}kelin-reflect。`,
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
  console.log(JSON.stringify({ ok: true, file, host: globalHost || 'project', action, ...extra }, null, 2));
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

if (/kelin-mode/.test(text) && /kelin-neat|kelin-verify/.test(text)) done('equivalent');

const addedLines = block.split('\n').length + 1;
if (dryRun) done('would-append', { addedLines });
const next = `${text.replace(/\s*$/, '')}\n\n${block}\n`;
writeFileSync(file, next);
done('appended', { addedLines, lines: next.split('\n').length });

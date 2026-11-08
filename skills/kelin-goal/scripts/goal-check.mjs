#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node goal-check.mjs <goal.md>');
  process.exit(2);
}

let text;
try {
  text = readFileSync(file, 'utf8');
} catch (error) {
  console.error(`${file}: ${error.message}`);
  process.exit(2);
}

const lines = text.split(/\r?\n/);
const at = (name) => lines.findIndex((line) => /^#{1,3}\s+/.test(line) && line.includes(name));
const section = (name) => {
  const start = at(name);
  if (start < 0) return [];
  const end = lines.slice(start + 1).findIndex((line) => /^#{1,3}\s+/.test(line));
  return lines.slice(start + 1, end < 0 ? undefined : start + 1 + end).filter((line) => line.trim());
};

const problems = [];
const goal = section('目标').filter((line) => !/^#/.test(line));
const done = section('完成条件').filter((line) => /^\s*- \[[ x]\] /.test(line));
const constraints = section('约束').filter((line) => /^\s*[-*] /.test(line));
const checkpoints = section('检查点').filter((line) => /^\s*[-*] /.test(line));

if (!goal.length) problems.push('目标 is empty');
if (!done.length) problems.push('完成条件 needs at least one checkbox');
if (done.length && !done.some((line) => /`[^`]+`|命令|退出|返回|行数|耗时|页面/.test(line))) problems.push('完成条件 has no checkable evidence');
if (!constraints.length) problems.push('约束 is empty');
if (!checkpoints.length) problems.push('检查点 is empty');

const result = { file, ok: problems.length === 0, done: done.length, constraints: constraints.length, checkpoints: checkpoints.length, problems };
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);

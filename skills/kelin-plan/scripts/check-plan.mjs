#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const file = args[0];
const levelIndex = args.indexOf('--level');
const level = levelIndex >= 0 ? args[levelIndex + 1] : 'standard';
if (!file || !['light', 'standard'].includes(level)) {
  console.error('Usage: node check-plan.mjs <plan.md> [--level light|standard]');
  process.exit(2);
}

let raw;
try {
  raw = readFileSync(file, 'utf8');
} catch (error) {
  console.error(`${file}: ${error.message}`);
  process.exit(2);
}

const lines = raw.split(/\r?\n/);
const problems = [];
const heading = (name) => lines.findIndex((line) => /^#{1,3}\s+/.test(line) && line.includes(name));
const boxed = (from) => {
  const next = lines.slice(from + 1).findIndex((line) => /^#{1,3}\s+/.test(line));
  return lines.slice(from + 1, next < 0 ? undefined : from + 1 + next).filter((line) => /^\s*- \[[ x]\] /.test(line));
};
const bullets = (from) => {
  const next = lines.slice(from + 1).findIndex((line) => /^#{1,3}\s+/.test(line));
  return lines.slice(from + 1, next < 0 ? undefined : from + 1 + next).filter((line) => line.trim());
};

const acceptance = heading('验收标准') >= 0 ? boxed(heading('验收标准')) : [];
if (heading('目标') < 0) problems.push('missing section: 目标');
if (!acceptance.length) problems.push('验收标准 has no checkbox');

if (level === 'light') {
  if (heading('下一步') < 0 || !bullets(heading('下一步')).length) problems.push('missing section: 下一步');
} else {
  for (const name of ['任务拆解', '风险']) {
    if (heading(name) < 0) problems.push(`missing section: ${name}`);
  }
  if (heading('方案') < 0 && heading('推荐') < 0) problems.push('missing section: 方案与取舍 / 推荐');
  const tasks = heading('任务拆解') >= 0 ? boxed(heading('任务拆解')) : [];
  if (!tasks.length) problems.push('任务拆解 has no checkbox');
  if (tasks.length && !tasks.some((line) => /验证|验收|`[^`]+`/.test(line))) {
    problems.push('no task names how it will be verified');
  }
}

const result = {
  file,
  level,
  ok: problems.length === 0,
  acceptanceItems: acceptance.length,
  problems,
};

console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);

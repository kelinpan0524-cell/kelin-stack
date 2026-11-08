#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node check-plan.mjs <plan.md>');
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

for (const name of ['目标', '验收标准', '任务拆解', '风险']) {
  if (heading(name) < 0) problems.push(`missing section: ${name}`);
}
if (heading('方案') < 0 && heading('推荐') < 0) problems.push('missing section: 方案与取舍 / 推荐');

const acceptance = heading('验收标准') >= 0 ? boxed(heading('验收标准')) : [];
if (!acceptance.length) problems.push('验收标准 has no checkbox');

const tasks = heading('任务拆解') >= 0 ? boxed(heading('任务拆解')) : [];
if (!tasks.length) problems.push('任务拆解 has no checkbox');
if (tasks.length && !tasks.some((line) => /验证|验收|`[^`]+`/.test(line))) {
  problems.push('no task names how it will be verified');
}

const result = {
  file,
  ok: problems.length === 0,
  sections: ['目标', '验收标准', '任务拆解', '风险'].filter((name) => heading(name) >= 0),
  acceptanceItems: acceptance.length,
  tasks: tasks.length,
  problems,
};

console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);

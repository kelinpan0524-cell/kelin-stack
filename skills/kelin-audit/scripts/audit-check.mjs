#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node audit-check.mjs <report.md>');
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
const problems = [];
const start = lines.findIndex((line) => /^##\s*覆盖声明/.test(line));
let rows = [];

if (start < 0) {
  problems.push('missing section: 覆盖声明');
} else {
  const end = lines.slice(start + 1).findIndex((line) => /^#{1,3}\s+/.test(line));
  const section = lines.slice(start + 1, end < 0 ? undefined : start + 1 + end);
  rows = section.filter((line) => /^\|/.test(line) && !/^\|\s*-/.test(line)).slice(1);
  if (!rows.length) problems.push('覆盖声明 has no data rows');
  const statuses = /已审|部分|未审|audited|partial|not assessed|n\/a/i;
  let audited = 0;
  for (const row of rows) {
    if (row.split('|').length < 4) problems.push(`row has fewer than 3 columns: ${row.slice(0, 80)}`);
    if (!statuses.test(row)) problems.push(`row has no audited/partial/not-assessed status: ${row.slice(0, 80)}`);
    if (/已审|audited/i.test(row)) audited += 1;
    if (/(未审|not assessed)/i.test(row) && /没问题|无问题/.test(row)) {
      problems.push(`not-assessed row cannot claim no problems: ${row.slice(0, 80)}`);
    }
  }
  if (rows.length && !audited) problems.push('at least one area must be marked audited');
}

const result = { file, ok: problems.length === 0, rows: rows.length, problems };
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);

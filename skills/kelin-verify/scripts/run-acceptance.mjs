#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const file = process.argv[2] || 'verify.json';
const base = path.dirname(path.resolve(file));

let spec;
try {
  spec = JSON.parse(readFileSync(file, 'utf8'));
} catch (error) {
  console.error(`${file}: ${error.message}`);
  process.exit(2);
}

const checks = spec.checks || [];
if (!Array.isArray(checks) || !checks.length) {
  console.error('verify.json needs a non-empty checks array');
  process.exit(2);
}

const rows = [];
for (const check of checks) {
  if (!check.id || !check.cmd) {
    console.error('every check needs id and cmd');
    process.exit(2);
  }
  const started = Date.now();
  const result = spawnSync('sh', ['-c', check.cmd], {
    cwd: check.cwd ? path.resolve(base, check.cwd) : base,
    encoding: 'utf8',
    timeout: Number(check.timeoutMs || 300_000),
  });
  rows.push({
    id: check.id,
    cmd: check.cmd,
    exit: result.status ?? -1,
    durationMs: Date.now() - started,
    output: `${result.stdout || ''}${result.stderr || ''}`.trim().slice(-400),
  });
}

const failed = rows.filter((row) => row.exit !== 0);
for (const row of rows) {
  console.log(`${row.exit === 0 ? 'PASS' : 'FAIL'} ${row.id} (${row.durationMs}ms) ${row.cmd}`);
  if (row.exit !== 0 && row.output) console.log(row.output.split('\n').map((line) => `  ${line}`).join('\n'));
}
console.log(JSON.stringify({ ok: failed.length === 0, total: rows.length, failed: failed.length, rows }, null, 2));
process.exit(failed.length ? 1 : 0);

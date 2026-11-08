#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const git = (args) => spawnSync('git', args, { encoding: 'utf8' });
const must = (args) => {
  const result = git(args);
  if (result.status !== 0) {
    console.error(`git ${args.join(' ')}: ${(result.stderr || '').trim() || 'failed'}`);
    process.exit(2);
  }
  return result.stdout.trim();
};

const branch = must(['rev-parse', '--abbrev-ref', 'HEAD']);
const staged = must(['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
const diff = git(['diff', '--cached', '--unified=0']).stdout || '';

const findings = [];
const add = (code, severity, detail) => findings.push({ code, severity, detail });

if (['main', 'master'].includes(branch)) {
  add('default-branch', 'P0', `on ${branch}; create a task branch`);
}

for (const file of staged) {
  if (/\.(xlsx|xls|csv|tsv|numbers)$/i.test(file)) add('real-data', 'P0', file);
  if (/^\.env(\.|$)/.test(file) || file.endsWith('.pem') || file.endsWith('.key')) add('secret-file', 'P0', file);
}

const patterns = [
  [/sk-[A-Za-z0-9]{20,}/, 'provider key'],
  [/gh[pousr]_[A-Za-z0-9]{20,}/, 'github token'],
  [/AKIA[0-9A-Z]{16}/, 'aws key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/(api[_-]?key|secret|token|password)\s*[:=]\s*["'][^"']{8,}["']/i, 'credential assignment'],
];

let current = '';
for (const line of diff.split('\n')) {
  const header = /^\+\+\+ b\/(.+)$/.exec(line);
  if (header) current = header[1];
  if (!line.startsWith('+') || line.startsWith('+++')) continue;
  for (const [pattern, label] of patterns) {
    if (pattern.test(line)) add('secret-pattern', 'P0', `${label} in ${current || 'unknown file'}`);
  }
}

const result = {
  ok: findings.length === 0,
  branch,
  staged: staged.length,
  findings,
};

console.log(JSON.stringify(result, null, 2));
process.exit(findings.length ? 1 : 0);

#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const option = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const gh = (ghArgs) => {
  try {
    return JSON.parse(execFileSync('gh', ghArgs, { encoding: 'utf8' }));
  } catch (error) {
    console.error(`gh ${ghArgs.join(' ')} failed: ${(error.stderr || error.message || '').toString().trim()}`);
    process.exit(2);
  }
};

let pr = Number(option('--pr', '0'));
if (!pr) {
  const current = gh(['pr', 'view', '--json', 'number']);
  pr = current.number;
}

const checks = gh(['pr', 'checks', String(pr), '--json', 'name,state,link,bucket']);
const classify = (name, state) => {
  const text = `${name} ${state}`.toLowerCase();
  if (/auth|token|permission|forbidden|401|403/.test(text)) return 'permission';
  if (/timeout|timed out|network|econnreset|503|502|5\d\d/.test(text)) return 'network';
  if (/install|dependency|docker|image|setup|node-version|cache/.test(text)) return 'environment';
  return 'code';
};

const rows = checks.map((check) => ({
  name: check.name,
  state: check.state,
  bucket: check.bucket || '',
  link: check.link || '',
  class: ['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(check.state) ? classify(check.name, check.state) : '',
}));
const failing = rows.filter((row) => row.class);
const pending = rows.filter((row) => ['QUEUED', 'IN_PROGRESS', 'WAITING', 'PENDING'].includes(row.state));

const result = {
  pr,
  total: rows.length,
  passing: rows.length - failing.length - pending.length,
  pending: pending.length,
  failing: failing.length,
  failures: failing,
  conclusion: failing.length ? 'fail' : pending.length ? 'pending' : 'pass',
};

console.log(JSON.stringify(result, null, 2));
process.exit(failing.length ? 1 : pending.length ? 2 : 0);

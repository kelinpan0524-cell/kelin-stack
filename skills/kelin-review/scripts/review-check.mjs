#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { computeWorktreeFingerprint } from './fingerprint.mjs';

const args = process.argv.slice(2);
const option = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

if (args.includes('--help') || args.includes('-h')) {
  console.error('Usage: node review-check.mjs [--root DIR] [--write] [--print] [--review FILE]');
  process.exit(2);
}

const root = path.resolve(option('--root', process.cwd()));
const reviewFile = option('--review', '');
const wt = computeWorktreeFingerprint(root);
if (!wt.isGit) {
  console.error(`not a git repository: ${root}`);
  process.exit(2);
}

const record = {
  fingerprint: wt.fingerprint,
  head: wt.head,
  branch: wt.branch,
  statusLines: wt.statusLines,
  files: wt.files,
  createdAt: new Date().toISOString(),
};

const stampFile = path.join(wt.repo, '.kelin', 'review.json');

if (args.includes('--print')) {
  console.log(JSON.stringify(record, null, 2));
  process.exit(0);
}

if (args.includes('--write')) {
  mkdirSync(path.dirname(stampFile), { recursive: true });
  writeFileSync(stampFile, `${JSON.stringify(record, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, status: 'CURRENT', ...record }, null, 2));
  process.exit(0);
}

let expected = '';
let source = '';
if (reviewFile) {
  if (!existsSync(reviewFile)) {
    console.error(`${reviewFile}: not found`);
    process.exit(2);
  }
  const match = /Worktree-Fingerprint:\s*([a-f0-9]{64})/i.exec(readFileSync(reviewFile, 'utf8'));
  expected = match ? match[1].toLowerCase() : '';
  source = reviewFile;
} else if (existsSync(stampFile)) {
  try {
    expected = JSON.parse(readFileSync(stampFile, 'utf8')).fingerprint || '';
  } catch {
    expected = '';
  }
  source = path.relative(wt.repo, stampFile);
}

let verdict = 'MISSING';
if (expected) verdict = expected === wt.fingerprint ? 'CURRENT' : 'STALE';
else if (source) verdict = 'UNVERIFIED';

const result = {
  ok: verdict === 'CURRENT',
  status: verdict,
  source: source || null,
  fingerprint: wt.fingerprint,
  head: wt.head,
  branch: wt.branch,
  changedFiles: record.files.length,
};
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);

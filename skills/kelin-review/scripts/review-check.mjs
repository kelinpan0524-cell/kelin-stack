#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

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
const git = (argv) => spawnSync('git', argv, { cwd: root, encoding: 'utf8' });

const probe = git(['rev-parse', '--show-toplevel']);
if (probe.status !== 0) {
  console.error(`not a git repository: ${root}`);
  process.exit(2);
}
const repo = probe.stdout.trim();
const headResult = git(['rev-parse', 'HEAD']);
const head = headResult.status === 0 ? headResult.stdout.trim() : 'NO_HEAD';
const branchResult = git(['rev-parse', '--abbrev-ref', 'HEAD']);
const branch = branchResult.status === 0 ? branchResult.stdout.trim() : 'unknown';
const statusResult = git(['status', '--porcelain=v1']);
const statusLines = (statusResult.status === 0 ? statusResult.stdout : '')
  .split('\n')
  .filter((line) => line && !/(^|\s)\.kelin\//.test(line));
const status = statusLines.length ? `${statusLines.join('\n')}\n` : '';
const diffResult = headResult.status === 0 ? git(['diff', 'HEAD', '--binary', '--no-color', '--no-ext-diff']) : { status: 0, stdout: '' };
const diff = diffResult.status === 0 ? diffResult.stdout : '';
const untracked = status
  .split('\n')
  .filter((line) => line.startsWith('?? '))
  .map((line) => line.slice(3).trim())
  .filter(Boolean)
  .sort();

const hashes = [];
for (const file of untracked) {
  const full = path.join(repo, file);
  if (!existsSync(full)) continue;
  const hashed = git(['hash-object', '--no-filters', '--', file]);
  hashes.push(`${file}:${hashed.status === 0 ? hashed.stdout.trim() : 'unreadable'}`);
}

const fingerprint = createHash('sha256')
  .update(`head:${head}\nbranch:${branch}\n`)
  .update(`status:\n${status}`)
  .update(`diff:\n${diff}`)
  .update(`untracked:\n${hashes.join('\n')}\n`)
  .digest('hex');

const record = {
  fingerprint,
  head,
  branch,
  statusLines: status.trim() ? status.trim().split('\n').length : 0,
  files: status
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .filter(Boolean),
  createdAt: new Date().toISOString(),
};

const stampFile = path.join(repo, '.kelin', 'review.json');

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
  source = path.relative(repo, stampFile);
}

let verdict = 'MISSING';
if (expected) verdict = expected === fingerprint ? 'CURRENT' : 'STALE';
else if (source) verdict = 'UNVERIFIED';

const result = {
  ok: verdict === 'CURRENT',
  status: verdict,
  source: source || null,
  fingerprint,
  head,
  branch,
  changedFiles: record.files.length,
};
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);

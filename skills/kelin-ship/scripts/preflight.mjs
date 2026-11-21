#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const args = process.argv.slice(2);
const option = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const root = path.resolve(option('--root', process.cwd()));
const noReview = args.includes('--no-review');
const requireReview = args.includes('--require-review');
const strictGates = args.includes('--strict-gates');
const git = (argv) => spawnSync('git', ['-C', root, ...argv], { encoding: 'utf8' });
const must = (argv) => {
  const result = git(argv);
  if (result.status !== 0) {
    console.error(`git ${argv.join(' ')}: ${(result.stderr || '').trim() || 'failed'}`);
    process.exit(2);
  }
  return result.stdout.trim();
};

const branch = must(['rev-parse', '--abbrev-ref', 'HEAD']);
const staged = must(['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
const diff = git(['diff', '--cached', '--unified=0']).stdout || '';

const findings = [];
const warnings = [];
const add = (code, severity, detail) => findings.push({ code, severity, detail });

if (['main', 'master'].includes(branch)) {
  add('default-branch', 'P0', `on ${branch}; create a task branch`);
}

let review = null;
const reviewFile = path.join(root, '.kelin', 'review.json');
if (!noReview) {
  if (existsSync(reviewFile)) {
    const script = path.resolve(import.meta.dirname, '..', '..', '..', 'skills', 'kelin-review', 'scripts', 'review-check.mjs');
    if (!existsSync(script)) {
      add('review-check-missing', 'P0', 'review stamp exists but review-check.mjs is unavailable');
    } else {
      const check = spawnSync(process.execPath, [script, '--root', root], { cwd: root, encoding: 'utf8' });
      let payload = null;
      try {
        payload = JSON.parse(check.stdout);
      } catch {
        payload = null;
      }
      review = payload ? { status: payload.status, fingerprint: payload.fingerprint } : { status: 'UNVERIFIED' };
      if (!payload || payload.status !== 'CURRENT') {
        add(`review-${(payload?.status || 'UNVERIFIED').toLowerCase()}`, 'P0', `review is ${payload?.status || 'UNVERIFIED'}; rerun kelin-review and stamp again`);
      }
    }
  } else if (requireReview) {
    add('review-missing', 'P0', 'no .kelin/review.json; run kelin-review and stamp it first');
  }
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

if (staged.length > 0) {
  const gateScript = path.resolve(import.meta.dirname, '..', '..', '..', 'skills', 'kelin-review', 'scripts', 'gate-scan.mjs');
  if (!existsSync(gateScript)) {
    add('gate-scan-error', strictGates ? 'P0' : 'P1', 'gate-scan.mjs is missing');
  } else {
    const scan = spawnSync(process.execPath, [gateScript, '--root', root, '--staged'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    let scanPayload = null;
    try {
      scanPayload = scan.stdout ? JSON.parse(scan.stdout) : null;
    } catch {
      scanPayload = null;
    }
    if (scan.error || (scan.status !== 0 && scan.status !== 1) || !scanPayload || !Array.isArray(scanPayload.findings)) {
      const detail = (scan.stderr || scan.error?.message || `exit ${scan.status}`).trim().slice(0, 160);
      add('gate-scan-error', strictGates ? 'P0' : 'P1', `gate-scan failed: ${detail}`);
    } else if (scanPayload.findings.length) {
      for (const item of scanPayload.findings) {
        const msg = `${item.tag} ${item.path}:${item.line} ${item.question}`;
        if (strictGates) add('gate-scan', 'P1', msg);
        else warnings.push(msg);
      }
    }
  }
}

const result = {
  ok: findings.length === 0,
  branch,
  staged: staged.length,
  review,
  gateWarnings: warnings,
  findings,
};

console.log(JSON.stringify(result, null, 2));
process.exit(findings.length ? 1 : 0);

#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeWorktreeFingerprint } from './fingerprint.mjs';

const stripFenced = (text) => {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  let fence = '';
  for (const line of lines) {
    const trimmed = line.trim();
    const match = /^(`{3,}|~{3,})/.exec(trimmed);
    if (match) {
      if (!fence) fence = match[1][0];
      else if (fence === match[1][0] && trimmed.length >= 3) fence = '';
      continue;
    }
    if (!fence) out.push(line);
  }
  return out.join('\n');
};

export function hasUnresolvedHighSeverity(markdown) {
  const clean = stripFenced(markdown);
  for (const rawLine of clean.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^\|?[\s:-]+\|[\s|:-]*$/.test(line)) continue;
    if (/^[-*+]\s*\[[xX]\]/.test(line)) continue;
    if (/(已修复|已解决|已关闭|\b(?:fixed|resolved|closed|wontfix|dismissed)\b)/i.test(line)) continue;
    if (/\bP[01]\s*[:=]\s*[1-9]\d*\b/i.test(line)) return true;

    const scrubbed = line
      .replace(/\bP0\s*[-–—~]\s*P[123]\b/gi, '')
      .replace(/\bP[01](?:\s*[/、,]\s*P[01])*\s*[:=]\s*0\b/gi, '')
      .replace(/\b0\s*(?:个|条|项)?\s*P[01]\b/gi, '')
      .replace(/(?:无|没有|未发现|\bno\b)\s*(?:未解决的?\s*)?P[01](?:\s*[/、或,]\s*P[01])*(?:\s*(?:问题|发现|findings?|issues?))?/gi, '')
      .replace(/(?:^|[\s|:-])P[01](?:\s*[/、,]\s*P[01])*\s*(?:\|\s*|[:：]\s*)(?:无|没有|none|0|n\/a)(?:问题|发现)?(?=$|[\s|,.;:!?。；，])/gi, '');

    if (/\bP[01](?:[-:]\d+)?\b/i.test(scrubbed)) return true;
  }
  return false;
}

const main = () => {
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

  const defaultReviewFile = path.join(wt.repo, '.kelin', 'review.md');
  const activeReviewPath = reviewFile ? path.resolve(root, reviewFile) : (existsSync(defaultReviewFile) ? defaultReviewFile : '');
  if (reviewFile && !existsSync(activeReviewPath)) {
    console.error(`${reviewFile}: not found`);
    process.exit(2);
  }

  let reportHash = null;
  let reportVerdict = 'stamp-only';
  if (activeReviewPath) {
    const reportBody = readFileSync(activeReviewPath, 'utf8');
    reportHash = createHash('sha256').update(reportBody).digest('hex');
    reportVerdict = hasUnresolvedHighSeverity(reportBody) ? 'blocked' : 'clean';
  }

  const record = {
    fingerprint: wt.fingerprint,
    head: wt.head,
    branch: wt.branch,
    statusLines: wt.statusLines,
    files: wt.files,
    verdict: reportVerdict,
    reportHash,
    ...(activeReviewPath ? { reportFile: path.relative(wt.repo, activeReviewPath) } : {}),
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
    const blocked = reportVerdict === 'blocked';
    console.log(JSON.stringify({ ok: !blocked, status: blocked ? 'BLOCKED' : 'CURRENT', ...record }, null, 2));
    process.exit(blocked ? 1 : 0);
  }

  let expected = '';
  let source = '';
  let stampData = null;
  let staleByReport = false;
  let blocked = reportVerdict === 'blocked';

  if (reviewFile) {
    const match = /Worktree-Fingerprint:\s*([a-f0-9]{64})/i.exec(readFileSync(activeReviewPath, 'utf8'));
    expected = match ? match[1].toLowerCase() : '';
    source = reviewFile;
  } else if (existsSync(stampFile)) {
    try {
      stampData = JSON.parse(readFileSync(stampFile, 'utf8'));
      expected = stampData?.fingerprint || '';
    } catch {
      stampData = null;
      expected = '';
    }
    source = path.relative(wt.repo, stampFile);
    if (stampData) {
      if (stampData.verdict === 'blocked') blocked = true;
      if ((stampData.reportHash || null) !== reportHash) staleByReport = true;
    }
  }

  let verdict = 'MISSING';
  if (expected) {
    if (expected !== wt.fingerprint || staleByReport) verdict = 'STALE';
    else if (blocked) verdict = 'BLOCKED';
    else verdict = 'CURRENT';
  } else if (source) {
    verdict = 'UNVERIFIED';
  }

  const result = {
    ok: verdict === 'CURRENT',
    status: verdict,
    source: source || null,
    verdict: reportVerdict,
    reportHash,
    fingerprint: wt.fingerprint,
    head: wt.head,
    branch: wt.branch,
    changedFiles: record.files.length,
  };
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
};

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  main();
}

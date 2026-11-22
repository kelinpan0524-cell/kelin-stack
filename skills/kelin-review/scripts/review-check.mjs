#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeWorktreeFingerprint } from './fingerprint.mjs';

const stripFenced = (text) => {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  let fenceChar = '';
  let fenceLen = 0;
  let inComment = false;
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!inComment) {
      const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed);
      if (!fenceChar && fenceMatch) {
        fenceChar = fenceMatch[1][0];
        fenceLen = fenceMatch[1].length;
        out.push('');
        continue;
      }
      if (fenceChar) {
        const closeMatch = new RegExp(`^${fenceChar === '~' ? '~' : '`'}{${fenceLen},}\\s*$`);
        if (closeMatch.test(trimmed)) {
          fenceChar = '';
          fenceLen = 0;
        }
        out.push('');
        continue;
      }
    }
    let line = rawLine;
    let rebuilt = '';
    while (line.length) {
      if (inComment) {
        const end = line.indexOf('-->');
        if (end < 0) {
          line = '';
          break;
        }
        inComment = false;
        line = line.slice(end + 3);
      } else {
        const start = line.indexOf('<!--');
        if (start < 0) {
          rebuilt += line;
          line = '';
          break;
        }
        rebuilt += line.slice(0, start);
        const end = line.indexOf('-->', start + 4);
        if (end < 0) {
          inComment = true;
          line = '';
          break;
        }
        line = line.slice(end + 3);
      }
    }
    if (!inComment || rebuilt.trim()) out.push(rebuilt);
    else out.push('');
  }
  return out.join('\n');
};

const hasVerdictRecord = (text) => {
  const clean = stripFenced(text).trim();
  if (!clean) return false;
  const body = clean.split(/\r?\n/).filter((line) => !/^#{1,6}\s/.test(line.trim())).join('\n').trim();
  if (!body) return false;
  const scrubbed = body.replace(/(无|没有|未发现|零|0)\s*(起|个|条)?\s*审查失败/g, '');
  if (/(审查失败|review\s+failure)/i.test(scrubbed)) return false;
  return /(结论|裁决|CLEAN|FINDINGS|\bP[0-3]\b)/i.test(scrubbed);
};

export function hasUnresolvedHighSeverity(markdown) {
  const clean = stripFenced(markdown);
  const explicitTableCellRe = /^\|.*\|\s*(?:已修复|已解决|已关闭|fixed|resolved|closed|wontfix|dismissed)\s*\|/i;
  const explicitStatusFieldRe = /(?:^|[\s|;；,，(（\[【])(?:状态|status)\s*[:：]\s*(?:已修复|已解决|已关闭|fixed|resolved|closed|wontfix|dismissed)(?=$|[\s|;；,，)）\]】.。])/i;
  const leadingTagRe = /^(?:[-*+]|\d+\.)\s*(?:\[|【)\s*(?:已修复|已解决|已关闭|fixed|resolved|closed|wontfix|dismissed)\s*(?:\]|】)(?:\s|$|:|：)/i;
  for (const rawLine of clean.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^\|?[\s:-]+\|[\s|:-]*$/.test(line)) continue;
    if (/\bP[01]\s*[:=]\s*[1-9]\d*\b/i.test(line)) return true;
    if (/^[-*+]\s*\[[xX]\]/.test(line)) continue;
    const isClosedItem =
      !/^[-*+]\s*\[\s\]/.test(line)
      && (explicitTableCellRe.test(line) || explicitStatusFieldRe.test(line) || leadingTagRe.test(line));
    if (isClosedItem) continue;

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

  const stampFile = path.join(root, '.kelin', 'review.json');
  const defaultReviewFile = path.join(root, '.kelin', 'review.md');
  const inspectMode = !args.includes('--write') && !args.includes('--print');
  let stampData = null;
  if (inspectMode && !reviewFile && existsSync(stampFile)) {
    try {
      stampData = JSON.parse(readFileSync(stampFile, 'utf8'));
    } catch {
      stampData = null;
    }
  }

  const repoReal = realpathSync(wt.repo);
  const isInsideRepo = (candidatePath) => candidatePath === repoReal || candidatePath.startsWith(`${repoReal}${path.sep}`);
  const canonicalizeParent = (targetPath) => {
    try {
      return path.join(realpathSync(path.dirname(targetPath)), path.basename(targetPath));
    } catch {
      return path.resolve(targetPath);
    }
  };
  let activeReviewPath = '';
  let storedReportFile = '';
  let missingStampedReport = false;
  if (reviewFile) {
    const rawTarget = path.resolve(root, reviewFile);
    if (!existsSync(rawTarget)) {
      console.error(`${reviewFile}: not found`);
      process.exit(2);
    }
    const canonicalRaw = canonicalizeParent(rawTarget);
    const targetReal = realpathSync(rawTarget);
    if (!isInsideRepo(canonicalRaw) || !isInsideRepo(targetReal)) {
      console.error(`${reviewFile}: must be inside git repository ${repoReal}`);
      process.exit(2);
    }
    activeReviewPath = targetReal;
    storedReportFile = path.relative(repoReal, canonicalRaw);
  } else if (inspectMode && stampData && typeof stampData.reportFile === 'string' && stampData.reportFile) {
    const candidate = path.resolve(repoReal, stampData.reportFile);
    const canonicalCandidate = canonicalizeParent(candidate);
    if (!isInsideRepo(canonicalCandidate) || !existsSync(candidate)) {
      missingStampedReport = true;
    } else {
      const candidateReal = realpathSync(candidate);
      if (isInsideRepo(candidateReal)) {
        activeReviewPath = candidateReal;
      } else {
        missingStampedReport = true;
      }
    }
  } else if (existsSync(defaultReviewFile)) {
    const canonicalDefault = canonicalizeParent(defaultReviewFile);
    const defaultReal = realpathSync(defaultReviewFile);
    if (isInsideRepo(canonicalDefault) && isInsideRepo(defaultReal)) {
      activeReviewPath = defaultReal;
      storedReportFile = path.relative(repoReal, canonicalDefault);
    } else {
      missingStampedReport = true;
    }
  }

  let reportHash = null;
  let reportVerdict = 'stamp-only';
  let reportBody = '';
  if (activeReviewPath) {
    reportBody = readFileSync(activeReviewPath, 'utf8');
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
    ...(storedReportFile ? { reportFile: storedReportFile } : {}),
    createdAt: new Date().toISOString(),
  };

  if (args.includes('--print')) {
    console.log(JSON.stringify(record, null, 2));
    process.exit(0);
  }

  if (args.includes('--write')) {
    if (!activeReviewPath) {
      console.error('--write requires a review report: pass --review FILE or write .kelin/review.md; stamping CURRENT without a report is invalid');
      process.exit(2);
    }
    if (!hasVerdictRecord(reportBody)) {
      console.error('--write requires a review report with findings and verdicts; empty or verdict-free reports cannot stamp CURRENT');
      process.exit(2);
    }
    mkdirSync(path.dirname(stampFile), { recursive: true });
    writeFileSync(stampFile, `${JSON.stringify(record, null, 2)}\n`);
    const blocked = reportVerdict === 'blocked';
    console.log(JSON.stringify({ ok: !blocked, status: blocked ? 'BLOCKED' : 'CURRENT', ...record }, null, 2));
    process.exit(blocked ? 1 : 0);
  }

  let expected = '';
  let source = '';
  let staleByReport = missingStampedReport;
  let blocked = reportVerdict === 'blocked';

  if (reviewFile) {
    const match = /Worktree-Fingerprint:\s*([a-f0-9]{64})/i.exec(readFileSync(activeReviewPath, 'utf8'));
    expected = match ? match[1].toLowerCase() : '';
    source = reviewFile;
  } else if (existsSync(stampFile)) {
    expected = stampData?.fingerprint || '';
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
    else if (reviewFile || stampData?.reportHash) verdict = 'CURRENT';
    else verdict = 'UNVERIFIED';
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

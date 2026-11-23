#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeWorktreeFingerprint } from './fingerprint.mjs';

const stripLineHtmlComments = (line, inComment) => {
  let out = '';
  let i = 0;
  let state = inComment;
  while (i < line.length) {
    if (state) {
      const end = line.indexOf('-->', i);
      if (end < 0) return { text: out, inComment: true };
      state = false;
      i = end + 3;
      continue;
    }
    if (line[i] === '`') {
      let ticks = 1;
      while (i + ticks < line.length && line[i + ticks] === '`') ticks += 1;
      const delim = '`'.repeat(ticks);
      let close = line.indexOf(delim, i + ticks);
      while (close >= 0 && (line[close - 1] === '`' || line[close + ticks] === '`')) {
        close = line.indexOf(delim, close + 1);
      }
      if (close >= 0) {
        out += line.slice(i, close + ticks);
        i = close + ticks;
        continue;
      }
      out += delim;
      i += ticks;
      continue;
    }
    if (line.startsWith('<!--', i)) {
      const end = line.indexOf('-->', i + 4);
      if (end < 0) return { text: out, inComment: true };
      i = end + 3;
      continue;
    }
    out += line[i];
    i += 1;
  }
  return { text: out, inComment: false };
};

const stripMarkdownComments = (text, { dropFenced = false } = {}) => {
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
        out.push(dropFenced ? '' : rawLine);
        continue;
      }
      if (fenceChar) {
        const closeMatch = new RegExp(`^${fenceChar === '~' ? '~' : '`'}{${fenceLen},}\\s*$`);
        if (closeMatch.test(trimmed)) {
          fenceChar = '';
          fenceLen = 0;
        }
        out.push(dropFenced ? '' : rawLine);
        continue;
      }
    }
    const stripped = stripLineHtmlComments(rawLine, inComment);
    inComment = stripped.inComment;
    if (!inComment || stripped.text.trim()) out.push(stripped.text);
    else out.push('');
  }
  return out.join('\n');
};

const stripFenced = (text) => stripMarkdownComments(text, { dropFenced: true });
const stripHtmlComments = (text) => stripMarkdownComments(text, { dropFenced: false });

const OK_REVIEWER_STATES = new Set(['ok', 'pass', 'passed', 'clean', 'findings']);
const VALID_FM_VERDICTS = new Set(['clean', 'findings']);
const FAILED_FM_VERDICTS = new Set(['failed', 'fail', 'error', 'timeout']);
const FAILURE_DECLARATION_RE = /^\s*#{0,6}\s*(审查失败|review\s+failure)\s*[:：]/im;

const parseFrontmatter = (text) => {
  const raw = String(text || '').replace(/^\uFEFF/, '');
  const lines = raw.split(/\r?\n/);
  if (!/^---[ \t]*$/.test(lines[0] || '')) {
    return { present: false, verdict: null, failedReviewers: [], body: raw };
  }
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (/^(---|\.\.\.)[ \t]*$/.test(lines[i])) {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx < 0) return { present: false, verdict: null, failedReviewers: [], body: raw };

  let verdict = null;
  const failedReviewers = [];
  let blockKey = '';
  const checkReviewerPair = (name, rawStatus) => {
    const status = rawStatus.replace(/^['"]|['"]$/g, '').trim().toLowerCase();
    if (!OK_REVIEWER_STATES.has(status)) failedReviewers.push(`${name.trim()}:${status || 'empty'}`);
  };

  for (const line of lines.slice(1, closeIdx)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (/^[ \t]+/.test(line) && blockKey) {
      if (blockKey === 'reviewers') {
        const pair = /^(?:-\s*)?([^:#\s][^:#]*?)\s*:\s*(.*)$/.exec(trimmed);
        if (pair) checkReviewerPair(pair[1], pair[2].replace(/\s+#.*$/, ''));
      } else if (blockKey === 'failed_reviewers') {
        const item = /^-\s*(.+?)\s*$/.exec(trimmed);
        if (item) {
          const val = item[1].replace(/\s+#.*$/, '').replace(/^['"]|['"]$/g, '').trim();
          if (val && !/^(none|null|false)$/i.test(val)) failedReviewers.push(val);
        }
      }
      continue;
    }
    blockKey = '';
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(trimmed);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const val = kv[2].replace(/\s+#.*$/, '').replace(/^['"]|['"]$/g, '').trim();
    if (key === 'verdict') {
      verdict = val.toLowerCase();
    } else if (key === 'reviewers') {
      if (!val) blockKey = 'reviewers';
      else if (val.startsWith('{') && val.endsWith('}')) {
        for (const entry of val.slice(1, -1).split(',')) {
          const pair = /^\s*([^:#\s][^:#]*?)\s*:\s*(.+?)\s*$/.exec(entry);
          if (pair) checkReviewerPair(pair[1], pair[2]);
        }
      }
    } else if (key === 'failed_reviewers') {
      if (!val) blockKey = 'failed_reviewers';
      else if (!/^(\[\s*\]|none|null|0|false)$/i.test(val)) failedReviewers.push(val);
    }
  }
  return { present: true, verdict, failedReviewers, body: lines.slice(closeIdx + 1).join('\n') };
};

const hasBodySubstance = (body) => stripHtmlComments(body).split(/\r?\n/).some((rawLine) => {
  const line = rawLine.trim();
  if (!line) return false;
  if (/^#{1,6}(?:\s|$)/.test(line)) return false;
  if (/^[-*_]{3,}$/.test(line)) return false;
  if (/^(`{3,}|~{3,})/.test(line)) return false;
  if (/^Worktree-Fingerprint\s*:/i.test(line)) return false;
  return true;
});

export const extractTrailingVerdict = (text) => {
  const lines = stripHtmlComments(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return null;
  let last = lines[lines.length - 1];
  if (/^(`{3,}|~{3,})$/.test(last) && lines.length >= 2) {
    last = lines[lines.length - 2];
  }
  return last === 'CLEAN' || last === 'FINDINGS' ? last.toLowerCase() : null;
};

export function evaluateReviewReport(markdown) {
  const raw = String(markdown || '');
  if (!raw.trim()) return { ok: false, verdict: null, source: 'none', reason: 'empty' };
  const fm = parseFrontmatter(raw);
  if (fm.failedReviewers.length > 0) {
    return { ok: false, verdict: 'failed', source: 'frontmatter', reason: 'frontmatter-reviewer-failed' };
  }
  if (fm.present && fm.verdict !== null) {
    if (FAILED_FM_VERDICTS.has(fm.verdict)) {
      return { ok: false, verdict: 'failed', source: 'frontmatter', reason: 'frontmatter-failed' };
    }
    if (!VALID_FM_VERDICTS.has(fm.verdict)) {
      return { ok: false, verdict: null, source: 'frontmatter', reason: 'frontmatter-invalid-verdict' };
    }
    if (!hasBodySubstance(fm.body)) {
      return { ok: false, verdict: null, source: 'frontmatter', reason: 'frontmatter-empty-body' };
    }
    return { ok: true, verdict: fm.verdict, source: 'frontmatter', reason: null };
  }
  if (FAILURE_DECLARATION_RE.test(stripFenced(fm.body))) {
    return { ok: false, verdict: 'failed', source: 'none', reason: 'failure-declaration' };
  }
  const trailing = extractTrailingVerdict(fm.body);
  if (!trailing) return { ok: false, verdict: null, source: 'none', reason: 'missing-verdict' };
  return { ok: true, verdict: trailing, source: 'trailing-line', reason: null };
}

export const hasVerdictRecord = (text) => evaluateReviewReport(text).ok;

export function hasUnresolvedHighSeverity(markdown) {
  const clean = stripFenced(parseFrontmatter(markdown).body);
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
  let reportEval = { ok: false, verdict: null, source: 'none', reason: 'missing-report' };
  if (activeReviewPath) {
    reportBody = readFileSync(activeReviewPath, 'utf8');
    reportHash = createHash('sha256').update(reportBody).digest('hex');
    reportEval = evaluateReviewReport(reportBody);
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
    if (!reportEval.ok) {
      const hint = reportEval.verdict === 'failed'
        ? `--write refused (${reportEval.reason}): report records an unresolved review failure; resolve it before stamping a valid verdict`
        : `--write requires a valid review verdict (${reportEval.reason}): add frontmatter verdict: clean|findings with notes, or end with CLEAN/FINDINGS`;
      console.error(hint);
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
    const match = /Worktree-Fingerprint:\s*([a-f0-9]{64})/i.exec(reportBody);
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
    else if ((reviewFile || stampData?.reportHash) && reportEval.ok) verdict = 'CURRENT';
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

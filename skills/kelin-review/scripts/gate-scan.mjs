#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { stripSource } from '../../kelin-verify-stack/scripts/source-text.mjs';

const args = process.argv.slice(2);
const option = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

if (args.includes('--help') || args.includes('-h')) {
  console.error('Usage: node gate-scan.mjs [--root DIR] [--base REF, default origin/main] [--staged] [--file DIFF]');
  process.exit(2);
}

const root = path.resolve(option('--root', process.cwd()));
const explicitBase = option('--base', '');
let base = explicitBase || 'HEAD';
const staged = args.includes('--staged');
const diffFile = option('--file', '');
const git = (argv) => spawnSync('git', argv, { cwd: root, encoding: 'utf8' });

const resolveBase = () => {
  if (explicitBase) return explicitBase;
  const rev = (ref) => git(['rev-parse', '--verify', '--quiet', ref]);
  for (const ref of ['origin/main', 'origin/master']) {
    if (rev(ref).status === 0) return ref;
  }
  const head = rev('HEAD');
  const headSha = head.status === 0 ? head.stdout.trim() : '';
  for (const ref of ['main', 'master']) {
    const result = rev(ref);
    if (result.status === 0 && result.stdout.trim() !== headSha) return ref;
  }
  return 'HEAD';
};

let diff = '';
if (diffFile) {
  if (!existsSync(diffFile)) {
    console.error(`${diffFile}: not found`);
    process.exit(2);
  }
  diff = readFileSync(diffFile, 'utf8');
} else {
  const probe = git(['rev-parse', '--show-toplevel']);
  if (probe.status !== 0) {
    console.error(`not a git repository: ${root}`);
    process.exit(2);
  }
  base = staged ? base : resolveBase();
  const argv = ['diff', '--unified=0', '--no-color', '--no-ext-diff', '--binary'];
  if (staged) argv.push('--cached');
  else argv.push(base);
  const result = git(argv);
  if (result.status !== 0) {
    console.error(`git diff failed: ${(result.stderr || '').trim()}`);
    process.exit(2);
  }
  diff = result.stdout;
}

const isTest = (file) =>
  /(^|\/)(tests?|__tests__)\//.test(file) ||
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(file) ||
  /(^|\/)test_[^/]+\.py$/.test(file) ||
  /_test\.go$/.test(file) ||
  /Test\.java$/.test(file);
const isCI = (file) => /^\.github\/workflows\//.test(file) || /^\.gitlab-ci\.ya?ml$/.test(file) || /(^|\/)Jenkinsfile$/.test(file);
const isSnapshot = (file) => /(__snapshots__|\.snap$)/.test(file);
const isConfig = (file) =>
  /(^|\/)(package\.json|pyproject\.toml|setup\.cfg|tox\.ini|pytest\.ini|jest\.config\.[cm]?[jt]s|vitest\.config\.[cm]?[jt]s|tsconfig[^/]*\.json|\.eslintrc[^/]*|eslint\.config\.[cm]?[jt]s)$/.test(file);
const isGatePath = (file) => isTest(file) || isCI(file) || isSnapshot(file) || isConfig(file);
const stripForScan = (file, text) => (isTest(file) && /\.(?:[cm]?[jt]sx?|py|go)$/.test(file) ? stripSource(text) : text);

const findings = [];
const add = (tag, file, line, kind, evidence) => {
  const questions = {
    'RH-1': '这次删除或跳过测试，是为了掩盖哪个失败？',
    'RH-3': '快照变更有没有对应的测试意图变化？',
    'RH-4': '这个占位符会在什么条件下变成真检查？',
    'RH-12': '这个环境判断会不会让 CI 跳过本该跑的检查？',
    'RH-13': '这个抑制注解压掉了哪类错误？',
    'RH-14': '这个绕过开关是否会让门禁在失败时仍然通过？',
    'RH-15': '这次放宽阈值或超时，有没有测量或决策依据？',
    'RH-16': '这个吞异常会不会把失败变成静默通过？',
  };
  findings.push({ tag, path: file, line, kind, evidence: evidence.trim().slice(0, 160), question: questions[tag] });
};

let file = '';
let newLine = 0;
let oldLine = 0;
const changedFiles = new Set();
const hunks = [];
let current = null;

const flushHunk = () => {
  if (!current) return;
  const relaxed = new Map();
  for (const entry of current.removed) {
    const match = /(timeout|timeoutMs|maxRetries|retries|max|threshold|tolerance|sleep|waitFor)["']?\s*[:=]\s*(\d+(?:\.\d+)?)/i.exec(entry.code);
    if (match) relaxed.set(match[1].toLowerCase(), { value: Number(match[2]), text: entry.text, line: entry.line });
  }
  for (const entry of current.added) {
    const match = /(timeout|timeoutMs|maxRetries|retries|max|threshold|tolerance|sleep|waitFor)["']?\s*[:=]\s*(\d+(?:\.\d+)?)/i.exec(entry.code);
    if (!match) continue;
    const keyName = match[1].toLowerCase();
    const before = relaxed.get(keyName);
    if (!before || Number(match[2]) === before.value) continue;
    add('RH-15', current.file, entry.line, 'changed', `${keyName}: ${before.value} -> ${match[2]}`);
  }
  current = null;
};

for (const line of diff.split('\n')) {
  if (line.startsWith('diff --git ')) {
    flushHunk();
    file = '';
    continue;
  }
  if (line.startsWith('+++ b/')) {
    file = line.slice(6);
    changedFiles.add(file);
    continue;
  }
  if (line.startsWith('+++ /dev/null')) {
    file = '';
    continue;
  }
  const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (hunk) {
    flushHunk();
    oldLine = Number(hunk[1]);
    newLine = Number(hunk[2]);
    current = { file, added: [], removed: [] };
    hunks.push(current);
    continue;
  }
  if (!file || !current) continue;
  if (line.startsWith('+') && !line.startsWith('+++')) {
    const text = line.slice(1);
    current.added.push({ text, code: stripForScan(file, text), line: newLine });
    newLine += 1;
  } else if (line.startsWith('-') && !line.startsWith('---')) {
    const text = line.slice(1);
    current.removed.push({ text, code: stripForScan(file, text), line: oldLine });
    oldLine += 1;
  }
}
flushHunk();

const testFiles = [...changedFiles].filter(isTest);
const snapshotFiles = [...changedFiles].filter(isSnapshot);

for (const hunk of hunks) {
  const changedFile = hunk.file;
  if (!isGatePath(changedFile)) continue;
  const removedTests = hunk.removed.filter((entry) => /\b(it|test|describe)\s*\(|\bdef test_|\bfunc Test|\b@Test\b/.test(entry.code));
  const addedTests = hunk.added.filter((entry) => /\b(it|test|describe)\s*\(|\bdef test_|\bfunc Test|\b@Test\b/.test(entry.code));
  if (removedTests.length > addedTests.length) {
    add('RH-1', changedFile, removedTests[0].line, 'removed', removedTests[0].text);
  }
  if (isSnapshot(changedFile) && !testFiles.length) {
    add('RH-3', changedFile, hunk.added[0]?.line ?? 1, 'changed', 'snapshot changed without an owning test file');
  }
  for (const entry of hunk.added) {
    if (/\bTODO\b|\bFIXME\b|not implemented|expect\(true\)\.toBe\(true\)|expect\(1\)\.toBe\(1\)|\bassert True\b|\bpass\s*(#.*)?$/.test(entry.code)) {
      add('RH-4', changedFile, entry.line, 'added', entry.text);
    }
    if (/(\.skip\s*\(|\bxit\s*\(|\bxdescribe\s*\(|@pytest\.mark\.skip|unittest\.skip|\bt\.Skip\(|@Ignore\b)/.test(entry.code)) {
      add('RH-1', changedFile, entry.line, 'added', entry.text);
    }
    if (/process\.env\.(CI|NODE_ENV|GITHUB_ACTIONS|GITLAB_CI|BUILDKITE|CIRCLECI)\b/.test(entry.code)) {
      add('RH-12', changedFile, entry.line, 'added', entry.text);
    }
    if (/eslint-disable|@ts-ignore|@ts-expect-error|# noqa|# type: ignore|pytest\.mark\.skip|@Ignore\b/.test(entry.code)) {
      add('RH-13', changedFile, entry.line, 'added', entry.text);
    }
    if (/--force\b|--no-verify\b|continue-on-error:\s*true|allow_failure:\s*true|if:\s*always\(\)/.test(entry.code)) {
      add('RH-14', changedFile, entry.line, 'added', entry.text);
    }
    if (/catch\s*(\([^)]*\))?\s*\{\s*\}|except\s+[^:]+:\s*pass|\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/.test(entry.code)) {
      add('RH-16', changedFile, entry.line, 'added', entry.text);
    }
  }
}

const summary = {};
for (const finding of findings) summary[finding.tag] = (summary[finding.tag] || 0) + 1;

const result = {
  ok: findings.length === 0,
  root,
  base: diffFile ? `file:${path.basename(diffFile)}` : staged ? 'staged' : base,
  gateFiles: [...changedFiles].filter(isGatePath).sort(),
  testFiles,
  snapshotFiles,
  summary,
  findings,
};
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);

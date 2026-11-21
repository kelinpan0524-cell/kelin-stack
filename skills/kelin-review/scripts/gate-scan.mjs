#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { extractComments, stripSource } from '../../kelin-verify-stack/scripts/source-text.mjs';

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
const git = (argv) => spawnSync('git', argv, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

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
  base = staged ? (explicitBase || 'HEAD') : resolveBase();
  const argv = ['diff', '--unified=0', '--no-color', '--no-ext-diff', '--binary'];
  if (staged) {
    argv.push('--cached');
    if (explicitBase) argv.push(base);
  } else {
    argv.push(base);
  }
  const result = git(argv);
  if (result.status !== 0) {
    console.error(`git diff failed: ${(result.stderr || '').trim()}`);
    process.exit(2);
  }
  diff = result.stdout;
}

const unquoteGitPath = (raw) => {
  const trimmed = raw.trim();
  if (!(trimmed.startsWith('"') && trimmed.endsWith('"'))) return trimmed;
  const inner = trimmed.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < inner.length; i += 1) {
    if (inner[i] !== '\\') {
      bytes.push(...Buffer.from(inner[i], 'utf8'));
      continue;
    }
    const next = inner[i + 1];
    if (next >= '0' && next <= '7') {
      const oct = inner.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)[0];
      bytes.push(Number.parseInt(oct, 8));
      i += oct.length;
      continue;
    }
    const escapes = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92, '"': 34 };
    if (next in escapes) {
      bytes.push(escapes[next]);
      i += 1;
    } else {
      bytes.push(...Buffer.from(next || '', 'utf8'));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
};

const parseHeaderPath = (line, prefixChar) => {
  const raw = line.slice(4);
  if (raw === '/dev/null') return '';
  const unquoted = unquoteGitPath(raw);
  return unquoted.startsWith(`${prefixChar}/`) ? unquoted.slice(2) : unquoted;
};

const isTest = (file) =>
  /(^|\/)(tests?|__tests__)\//.test(file) ||
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(file) ||
  /(^|\/)test_[^/]+\.py$/.test(file) ||
  /_test\.go$/.test(file) ||
  /Test\.java$/.test(file);
const isCI = (file) =>
  /^\.github\/workflows\//.test(file) ||
  /^\.gitlab-ci\.ya?ml$/.test(file) ||
  /(^|\/)Jenkinsfile$/.test(file) ||
  /^\.circleci\/config\.ya?ml$/.test(file) ||
  /^\.buildkite\//.test(file) ||
  /^(azure-pipelines|bitbucket-pipelines)\.ya?ml$/.test(file);
const isSnapshot = (file) => /(__snapshots__|\.snap$)/.test(file);
const isConfig = (file) =>
  /(^|\/)(package\.json|pyproject\.toml|setup\.cfg|tox\.ini|pytest\.ini|jest\.config\.[cm]?[jt]s|vitest\.config\.[cm]?[jt]s|tsconfig[^/]*\.json|\.eslintrc[^/]*|eslint\.config\.[cm]?[jt]s)$/.test(file);
const isOwnGate = (file) =>
  /(^|\/)(guards\.json|verify\.json|kelin-policy\.json|feature-map\.json|ratchet\.json)$/.test(file) ||
  /^skills\/[^/]+\/scripts\/.*-check\.mjs$/.test(file) ||
  /^skills\/kelin-review\/scripts\/gate-scan\.mjs$/.test(file) ||
  /^skills\/kelin-ship\/scripts\/preflight\.mjs$/.test(file);
const isGatePath = (file) => isTest(file) || isCI(file) || isSnapshot(file) || isConfig(file) || isOwnGate(file);
const isCodeFile = (file) => /\.(?:[cm]?[jt]sx?|py|go)$/.test(file);

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

let oldFile = '';
let newFile = '';
let activeFile = '';
let renameFrom = '';
let renameTo = '';
let isDeletedFile = false;
let newLine = 0;
let oldLine = 0;
const changedFiles = new Set();
const deletedFiles = new Set();
const renamedOutOfGate = [];
const hunks = [];
let current = null;

const fileSourceCache = new Map();
const readRepoRevision = (revSpec) => {
  if (diffFile) return null;
  const res = git(['show', revSpec]);
  return res.status === 0 ? res.stdout : null;
};
const getFileContext = (file) => {
  if (fileSourceCache.has(file)) return fileSourceCache.get(file);
  if (diffFile) {
    fileSourceCache.set(file, null);
    return null;
  }
  const afterRaw = staged ? readRepoRevision(`:${file}`) : (existsSync(path.join(root, file)) ? readFileSync(path.join(root, file), 'utf8') : null);
  const beforeRaw = readRepoRevision(`${base}:${file}`);
  const ctx = {
    afterRaw,
    beforeRaw,
    afterCode: afterRaw !== null ? stripSource(afterRaw).split('\n') : null,
    afterComments: afterRaw !== null ? extractComments(afterRaw).split('\n') : null,
    beforeCode: beforeRaw !== null ? stripSource(beforeRaw).split('\n') : null,
  };
  fileSourceCache.set(file, ctx);
  return ctx;
};

const annotateHunkLines = (hunk) => {
  if (!hunk) return;
  const codeFile = isCodeFile(hunk.file);
  const fileCtx = codeFile && !hunk.deleted ? getFileContext(hunk.file) : null;
  if (fileCtx?.afterCode) {
    hunk.added.forEach((entry) => {
      entry.code = fileCtx.afterCode[entry.line - 1] ?? '';
      entry.comments = fileCtx.afterComments[entry.line - 1] ?? '';
    });
    hunk.removed.forEach((entry) => {
      entry.code = fileCtx.beforeCode ? (fileCtx.beforeCode[entry.line - 1] ?? '') : '';
    });
    return;
  }
  const joinAdded = hunk.added.map((e) => e.text).join('\n');
  const joinRemoved = hunk.removed.map((e) => e.text).join('\n');
  const addedCode = codeFile ? stripSource(joinAdded).split('\n') : hunk.added.map((e) => e.text);
  const addedComments = codeFile ? extractComments(joinAdded).split('\n') : hunk.added.map((e) => e.text);
  const removedCode = codeFile ? stripSource(joinRemoved).split('\n') : hunk.removed.map((e) => e.text);
  hunk.added.forEach((entry, idx) => {
    entry.code = addedCode[idx] ?? '';
    entry.comments = addedComments[idx] ?? '';
  });
  hunk.removed.forEach((entry, idx) => {
    entry.code = removedCode[idx] ?? '';
  });
};

const thresholdRelaxed = (keyName, beforeVal, afterVal) => {
  if (/^(min(?:imum|[a-z0-9_]*)|floor|quorum|required)$/i.test(keyName)) return afterVal < beforeVal;
  if (/^threshold$/i.test(keyName)) return afterVal !== beforeVal;
  return afterVal > beforeVal;
};

const flushHunk = () => {
  if (!current) return;
  annotateHunkLines(current);
  const relaxed = new Map();
  const threshRe = /(timeout|timeoutMs|maxRetries|retries|max|min[A-Za-z0-9_]*|minimum|threshold|tolerance|sleep|waitFor|floor|quorum|required|limit|delay)["']?\s*[:=]\s*(\d+(?:\.\d+)?)/i;
  for (const entry of current.removed) {
    const match = threshRe.exec(entry.code);
    if (!match) continue;
    const keyName = match[1].toLowerCase();
    if (!relaxed.has(keyName)) relaxed.set(keyName, []);
    relaxed.get(keyName).push({ value: Number(match[2]), text: entry.text, line: entry.line });
  }
  for (const entry of current.added) {
    const match = threshRe.exec(entry.code);
    if (!match) continue;
    const keyName = match[1].toLowerCase();
    const queue = relaxed.get(keyName);
    if (!queue?.length) continue;
    const before = queue.shift();
    const afterVal = Number(match[2]);
    if (thresholdRelaxed(keyName, before.value, afterVal)) {
      add('RH-15', current.file, entry.line, 'changed', `${keyName}: ${before.value} -> ${afterVal}`);
    }
  }
  current = null;
};

const flushRename = () => {
  if (renameFrom && renameTo) {
    if (isTest(renameFrom) && !isTest(renameTo)) add('RH-1', renameFrom, 1, 'renamed', `renamed test out of gate: ${renameFrom} -> ${renameTo}`);
    else if (isSnapshot(renameFrom) && !isSnapshot(renameTo)) add('RH-3', renameFrom, 1, 'renamed', `renamed snapshot out of gate: ${renameFrom} -> ${renameTo}`);
    else if (isCI(renameFrom) && !isCI(renameTo)) add('RH-14', renameFrom, 1, 'renamed', `renamed CI file out of CI paths: ${renameFrom} -> ${renameTo}`);
    else if (isOwnGate(renameFrom) && !isOwnGate(renameTo)) add('RH-14', renameFrom, 1, 'renamed', `renamed gate file out of gate: ${renameFrom} -> ${renameTo}`);
    else if (isConfig(renameFrom) && !isConfig(renameTo)) add('RH-14', renameFrom, 1, 'renamed', `renamed config out of config paths: ${renameFrom} -> ${renameTo}`);
  }
  renameFrom = '';
  renameTo = '';
};

const parseDiffGitOldPath = (line) => {
  const rest = line.slice('diff --git '.length);
  if (rest.startsWith('"')) {
    const endQuote = rest.search(/(?<!\\)" /);
    if (endQuote > 0) {
      const first = unquoteGitPath(rest.slice(0, endQuote + 1));
      return first.startsWith('a/') ? first.slice(2) : first;
    }
  }
  if ((rest.length - 1) % 2 === 0 && rest.startsWith('a/')) {
    const half = (rest.length - 1) / 2;
    if (rest[half] === ' ' && rest.slice(half + 1, half + 3) === 'b/' && rest.slice(2, half) === rest.slice(half + 3)) {
      return rest.slice(2, half);
    }
  }
  const mid = rest.indexOf(' b/');
  if (mid > 2 && rest.startsWith('a/')) return rest.slice(2, mid);
  return '';
};

let diffGitOld = '';
let oldRemain = 0;
let newRemain = 0;

for (const line of diff.split('\n')) {
  if (current && (oldRemain > 0 || newRemain > 0)) {
    if (line.startsWith('+')) {
      current.added.push({ text: line.slice(1), code: '', comments: '', line: newLine });
      newLine += 1;
      newRemain = Math.max(0, newRemain - 1);
      continue;
    }
    if (line.startsWith('-')) {
      current.removed.push({ text: line.slice(1), code: '', line: oldLine });
      oldLine += 1;
      oldRemain = Math.max(0, oldRemain - 1);
      continue;
    }
    if (line.startsWith(' ')) {
      oldLine += 1;
      newLine += 1;
      oldRemain = Math.max(0, oldRemain - 1);
      newRemain = Math.max(0, newRemain - 1);
      continue;
    }
    if (line.startsWith('\\')) continue;
  }
  if (line.startsWith('diff --git ')) {
    flushHunk();
    flushRename();
    oldFile = '';
    newFile = '';
    activeFile = '';
    isDeletedFile = false;
    oldRemain = 0;
    newRemain = 0;
    diffGitOld = parseDiffGitOldPath(line);
    continue;
  }
  if (line.startsWith('deleted file mode ')) {
    isDeletedFile = true;
    const deletedPath = oldFile || diffGitOld;
    if (deletedPath) {
      oldFile = deletedPath;
      activeFile = deletedPath;
      changedFiles.add(deletedPath);
      deletedFiles.add(deletedPath);
    }
    continue;
  }
  if (line.startsWith('rename from ')) {
    renameFrom = unquoteGitPath(line.slice('rename from '.length));
    if (renameFrom) changedFiles.add(renameFrom);
    continue;
  }
  if (line.startsWith('rename to ')) {
    renameTo = unquoteGitPath(line.slice('rename to '.length));
    if (renameTo) changedFiles.add(renameTo);
    continue;
  }
  if (line.startsWith('--- ')) {
    oldFile = parseHeaderPath(line, 'a');
    continue;
  }
  if (line.startsWith('+++ ')) {
    newFile = parseHeaderPath(line, 'b');
    isDeletedFile = line === '+++ /dev/null' && Boolean(oldFile);
    activeFile = newFile || oldFile;
    if (activeFile) changedFiles.add(activeFile);
    if (isDeletedFile && oldFile) deletedFiles.add(oldFile);
    continue;
  }
  const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (hunk) {
    flushHunk();
    oldLine = Number(hunk[1]);
    oldRemain = hunk[2] !== undefined ? Number(hunk[2]) : 1;
    newLine = Number(hunk[3]);
    newRemain = hunk[4] !== undefined ? Number(hunk[4]) : 1;
    current = { file: activeFile, deleted: isDeletedFile, added: [], removed: [] };
    hunks.push(current);
    continue;
  }
  if (!activeFile || !current) continue;
  if (line.startsWith('+') && !line.startsWith('+++')) {
    current.added.push({ text: line.slice(1), code: '', comments: '', line: newLine });
    newLine += 1;
  } else if (line.startsWith('-') && !line.startsWith('---')) {
    current.removed.push({ text: line.slice(1), code: '', line: oldLine });
    oldLine += 1;
  } else if (line.startsWith(' ')) {
    oldLine += 1;
    newLine += 1;
  }
}
flushHunk();
flushRename();

const testFiles = [...changedFiles].filter((f) => isTest(f) && !deletedFiles.has(f));
const snapshotFiles = [...changedFiles].filter(isSnapshot);
const deletedGateFiles = [...deletedFiles].filter(isGatePath).sort();

const snapshotHasOwner = (snapFile) => {
  if (!testFiles.length) return false;
  const snapBase = path.basename(snapFile).replace(/\.snap$/, '');
  const snapDir = path.dirname(snapFile).replace(/(?:^|\/)__snapshots__$/, '');
  const snapStem = snapBase.replace(/\.(test|spec)\.[cm]?[jt]sx?$/i, '');
  if (/\.(test|spec)\./i.test(snapBase)) {
    return testFiles.some((tf) => {
      const tfDir = path.dirname(tf);
      const sameFamilyDir = tfDir === snapDir || snapDir === '';
      const tfStem = path.basename(tf).replace(/\.(test|spec)\.[cm]?[jt]sx?$/i, '');
      return sameFamilyDir && (path.basename(tf) === snapBase || (snapStem && tfStem === snapStem));
    });
  }
  return testFiles.some((tf) => tf.endsWith(`/${snapBase}`) || tf === snapBase || (snapStem && path.basename(tf).replace(/\.(test|spec)\.[cm]?[jt]sx?$/i, '') === snapStem) || path.dirname(tf) === snapDir);
};

for (const deleted of deletedGateFiles) {
  if (isTest(deleted)) add('RH-1', deleted, 1, 'deleted', `deleted test file: ${deleted}`);
  else if (isSnapshot(deleted)) add('RH-3', deleted, 1, 'deleted', `deleted snapshot file: ${deleted}`);
  else if (isCI(deleted) || isOwnGate(deleted) || isConfig(deleted)) add('RH-14', deleted, 1, 'deleted', `deleted gate file: ${deleted}`);
}

const gateHunks = [];

const emptyCatchRe = /catch\s*(?:\([^)]*\))?\s*\{\s*\}|except\s+[^:\n]+:\s*(?:\n\s*)?pass\b|\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/g;
const reportedEmptyCatches = new Set();

for (const hunk of hunks) {
  const changedFile = hunk.file;
  if (!changedFile) continue;

  const gatePath = isGatePath(changedFile);
  if (gatePath) {
    gateHunks.push({ path: changedFile, added: hunk.added.length, removed: hunk.removed.length, deleted: hunk.deleted });
  }

  if (gatePath && !hunk.deleted) {
    if (isTest(changedFile)) {
      const testDeclRe = /(?:^|[^\w.$])(?:it|test|describe)\s*\(|\bdef test_|\bfunc Test|\b@Test\b/;
      const removedTests = hunk.removed.filter((entry) => testDeclRe.test(entry.code));
      const addedTests = hunk.added.filter((entry) => testDeclRe.test(entry.code));
      if (removedTests.length > addedTests.length) {
        add('RH-1', changedFile, removedTests[0].line, 'removed', removedTests[0].text);
      }
    }
    if (isSnapshot(changedFile) && !snapshotHasOwner(changedFile)) {
      add('RH-3', changedFile, hunk.added[0]?.line ?? 1, 'changed', 'snapshot changed without an owning test file');
    }
    const fileCtx = isCodeFile(changedFile) ? getFileContext(changedFile) : null;
    const afterLines = fileCtx?.afterRaw ? fileCtx.afterRaw.split(/\r?\n/) : null;
    const stripLineComment = (raw) => raw.replace(/(?<!:)\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const truthySkipRe = /\bskip\s*:\s*(?=\S)(?!false\b|0\b|null\b|undefined\b|['"]{2}(?:\s*[,})\n]|$)|``(?:\s*[,})\n]|$))[^\n,}]+/;
    const testCallStartRe = /(?:^|[^\w.$])(?:it|test|describe)\s*\(/;
    const ciDisabled = isCI(changedFile);
    const flaggedSkipLines = new Set();

    for (let idx = 0; idx < hunk.added.length; idx += 1) {
      const entry = hunk.added[idx];
      if (/\bnot implemented\b|expect\(true\)\.toBe\(true\)|expect\(1\)\.toBe\(1\)|\bassert True\b|\bpass\s*(#.*)?$/.test(entry.code) || /\b(TODO|FIXME)\b/.test(entry.comments)) {
        add('RH-4', changedFile, entry.line, 'added', entry.text);
      }
      let hasSkipCall = /(\.skip\s*\(|\bxit\s*\(|\bxdescribe\s*\(|@pytest\.mark\.skip|unittest\.skip|\bt\.Skip\(|@Ignore\b)/.test(entry.code);
      if (!hasSkipCall && testCallStartRe.test(entry.code)) {
        const rawSlice = afterLines
          ? afterLines.slice(entry.line - 1, entry.line + 7)
          : hunk.added.slice(idx, idx + 8).map((item) => item.text);
        const headWindow = rawSlice.map(stripLineComment).join('\n').split(/(?:\)|[A-Za-z_$][\w$]*)\s*=>|\bfunction\b|\)\s*\{/)[0];
        if (truthySkipRe.test(headWindow)) {
          hasSkipCall = true;
          for (let k = idx + 1; k < Math.min(hunk.added.length, idx + 8); k += 1) {
            if (truthySkipRe.test(stripLineComment(hunk.added[k].text))) flaggedSkipLines.add(k);
          }
        }
      } else if (!hasSkipCall && !flaggedSkipLines.has(idx) && /^\s*skip\s*:/.test(entry.code) && truthySkipRe.test(stripLineComment(entry.text))) {
        const prevLines = afterLines
          ? afterLines.slice(Math.max(0, entry.line - 7), entry.line - 1)
          : hunk.added.slice(Math.max(0, idx - 6), idx).map((item) => item.text);
        const contextUp = prevLines.map(stripLineComment).join('\n');
        if (testCallStartRe.test(contextUp)) hasSkipCall = true;
      }
      if (hasSkipCall) {
        add('RH-1', changedFile, entry.line, 'added', entry.text);
      }
      if (/process\.env\.(CI|NODE_ENV|GITHUB_ACTIONS|GITLAB_CI|BUILDKITE|CIRCLECI)\b/.test(entry.code)) {
        add('RH-12', changedFile, entry.line, 'added', entry.text);
      }
      if (
        /--force\b|--no-verify\b|continue-on-error:\s*true|allow_failure:\s*true|if:\s*always\(\)/.test(entry.code)
        || (ciDisabled && /^\s*(?:-\s*)?if:\s*(?:\$\{\{\s*)?false(?:\s*\}\})?(?:\s|$|#)/i.test(entry.text))
      ) {
        add('RH-14', changedFile, entry.line, 'added', entry.text);
      }
    }
  }

  if (!hunk.deleted && (gatePath || isCodeFile(changedFile))) {
    const isPy = /\.py$/i.test(changedFile);
    const suppressRe = isPy
      ? /^\s*#\s*(?:noqa|type:\s*ignore)\b/
      : /(?:^|\s)(?:\/\/|\/\*+|\*)\s*(?:@ts-ignore|@ts-expect-error|eslint-disable(?:-next-line|-line)?)\b/;
    for (const entry of hunk.added) {
      if (suppressRe.test(entry.comments)) {
        add('RH-13', changedFile, entry.line, 'added', entry.text);
      }
    }
    const fileCtx = getFileContext(changedFile);
    if (fileCtx?.afterCode && isCodeFile(changedFile)) {
      const fullAfterCode = fileCtx.afterCode.join('\n');
      const fullBeforeCode = (fileCtx.beforeCode || []).join('\n');
      const spanMatches = (code, lines) => {
        if (!code || !lines.length) return [];
        const min = Math.max(1, Math.min(...lines) - 1);
        const max = Math.max(...lines) + 1;
        return [...code.matchAll(emptyCatchRe)].map((m) => {
          const startLine = code.slice(0, m.index).split('\n').length;
          const endLine = startLine + m[0].split('\n').length - 1;
          return { startLine, endLine, text: m[0] };
        }).filter((item) => item.endLine >= min && item.startLine <= max);
      };
      const newLines = hunk.added.length ? hunk.added.map((e) => e.line) : hunk.removed.map((e) => e.line);
      const oldLines = hunk.removed.length ? hunk.removed.map((e) => e.line) : hunk.added.map((e) => e.line);
      const afterLocal = spanMatches(fullAfterCode, newLines);
      const beforeLocal = spanMatches(fullBeforeCode, oldLines);
      if (afterLocal.length > beforeLocal.length) {
        for (const item of afterLocal) {
          const key = `${changedFile}:${item.startLine}`;
          if (!reportedEmptyCatches.has(key)) {
            reportedEmptyCatches.add(key);
            add('RH-16', changedFile, item.startLine, 'added', item.text.replace(/\s+/g, ' '));
          }
        }
      }
    } else {
      const joinedAddedCode = hunk.added.map((e) => e.code).join('\n');
      for (const m of joinedAddedCode.matchAll(emptyCatchRe)) {
        const idx = joinedAddedCode.slice(0, m.index).split('\n').length - 1;
        const target = hunk.added[idx] || hunk.added[0];
        add('RH-16', changedFile, target?.line ?? 1, 'added', m[0].replace(/\s+/g, ' '));
      }
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
  deletedGateFiles,
  gateHunks,
  testFiles,
  snapshotFiles,
  summary,
  findings,
};
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);

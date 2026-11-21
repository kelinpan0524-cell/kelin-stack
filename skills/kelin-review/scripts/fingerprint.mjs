import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readlinkSync } from 'node:fs';
import path from 'node:path';

const MAX_BUFFER = 64 * 1024 * 1024;
const isRuntimeKelinPath = (rel) => /^(?:\.kelin\/(?!ci\/))/.test(rel);

export function computeWorktreeFingerprint(rootDir) {
  const root = path.resolve(rootDir || process.cwd());
  const git = (argv, cwd = root) => spawnSync('git', argv, { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER });
  const gitStrict = (argv, cwd = root) => {
    const res = git(argv, cwd);
    if (res.error || res.status !== 0) {
      throw new Error(`git ${argv.join(' ')} failed: ${(res.stderr || res.error?.message || '').trim() || `exit ${res.status}`}`);
    }
    return res.stdout;
  };
  const probe = git(['rev-parse', '--show-toplevel']);
  if (probe.status !== 0) {
    return {
      isGit: false,
      repo: root,
      head: null,
      branch: null,
      fingerprint: null,
      statusLines: 0,
      files: [],
    };
  }
  const repo = probe.stdout.trim();
  const headResult = git(['rev-parse', 'HEAD'], repo);
  const head = headResult.status === 0 ? headResult.stdout.trim() : 'NO_HEAD';
  const branchResult = git(['rev-parse', '--abbrev-ref', 'HEAD'], repo);
  const branch = branchResult.status === 0 ? branchResult.stdout.trim() : 'unknown';

  const statusRaw = gitStrict(['status', '--porcelain=v1', '-z'], repo);
  const tokens = statusRaw.split('\0');
  const statusEntries = [];
  const dirtyFiles = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const entry = tokens[i];
    if (!entry) continue;
    const code = entry.slice(0, 2);
    const rel = entry.slice(3);
    let extra = '';
    if ((code[0] === 'R' || code[0] === 'C') && i + 1 < tokens.length) {
      extra = tokens[i + 1];
      i += 1;
    }
    if (isRuntimeKelinPath(rel) && (!extra || isRuntimeKelinPath(extra))) continue;
    statusEntries.push(extra ? `${code} ${rel}\t${extra}` : `${code} ${rel}`);
    dirtyFiles.push(rel);
  }
  const status = statusEntries.length ? `${statusEntries.join('\n')}\n` : '';

  const stagedDiff = gitStrict(['diff', '--cached', '--binary', '--no-color', '--no-ext-diff'], repo);
  const worktreeDiff = gitStrict(['diff', '--binary', '--no-color', '--no-ext-diff'], repo);

  const untrackedRaw = gitStrict(['ls-files', '-z', '--others', '--exclude-standard'], repo);
  const untracked = untrackedRaw
    .split('\0')
    .filter((rel) => rel && !isRuntimeKelinPath(rel))
    .sort();

  const hashes = [];
  for (const rel of untracked) {
    const full = path.join(repo, rel);
    let st;
    try {
      st = lstatSync(full);
    } catch {
      throw new Error(`Unable to stat untracked file: ${rel}`);
    }
    if (st.isSymbolicLink()) {
      hashes.push(`${rel}:symlink:${readlinkSync(full)}`);
      continue;
    }
    if (!st.isFile()) continue;
    const modeTag = (st.mode & 0o111) !== 0 ? 'x' : 'r';
    const hashed = gitStrict(['hash-object', '--no-filters', '--', rel], repo);
    hashes.push(`${rel}:${modeTag}:${hashed.trim()}`);
  }

  const fingerprint = createHash('sha256')
    .update(`head:${head}\nbranch:${branch}\n`)
    .update(`status:\n${status}`)
    .update(`staged:\n${stagedDiff}`)
    .update(`worktree:\n${worktreeDiff}`)
    .update(`untracked:\n${hashes.join('\n')}\n`)
    .digest('hex');

  return {
    isGit: true,
    repo,
    head,
    branch,
    fingerprint,
    statusLines: statusEntries.length,
    files: dirtyFiles,
  };
}

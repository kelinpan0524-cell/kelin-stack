import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';

export function computeWorktreeFingerprint(rootDir) {
  const root = path.resolve(rootDir || process.cwd());
  const git = (argv, cwd = root) => spawnSync('git', argv, { cwd, encoding: 'utf8' });
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
  const statusResult = git(['status', '--porcelain=v1'], repo);
  const statusLines = (statusResult.status === 0 ? statusResult.stdout : '')
    .split('\n')
    .filter((line) => line && !/(^|\s)\.kelin\//.test(line));
  const status = statusLines.length ? `${statusLines.join('\n')}\n` : '';
  const diffResult =
    headResult.status === 0
      ? git(['diff', 'HEAD', '--binary', '--no-color', '--no-ext-diff'], repo)
      : { status: 0, stdout: '' };
  const diff = diffResult.status === 0 ? diffResult.stdout : '';
  const untracked = statusLines
    .filter((line) => line.startsWith('?? '))
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .sort();

  const hashes = [];
  for (const file of untracked) {
    const clean = file.startsWith('"') && file.endsWith('"') ? file.slice(1, -1) : file;
    const full = path.join(repo, clean);
    if (!existsSync(full)) continue;
    const hashed = git(['hash-object', '--no-filters', '--', clean], repo);
    hashes.push(`${file}:${hashed.status === 0 ? hashed.stdout.trim() : 'unreadable'}`);
  }

  const fingerprint = createHash('sha256')
    .update(`head:${head}\nbranch:${branch}\n`)
    .update(`status:\n${status}`)
    .update(`diff:\n${diff}`)
    .update(`untracked:\n${hashes.join('\n')}\n`)
    .digest('hex');

  return {
    isGit: true,
    repo,
    head,
    branch,
    fingerprint,
    statusLines: statusLines.length,
    files: statusLines.map((line) => line.slice(3).trim()).filter(Boolean),
  };
}

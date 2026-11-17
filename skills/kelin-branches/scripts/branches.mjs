#!/usr/bin/env node
// 分支看板：每条本地/远端分支在哪、推没推、进没进主干、改了什么、建议怎么处理。
// 只读，只报不动；删除/推送/合并一律等用户确认。
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

// ---- 纯逻辑（可单测） ----
export function mergeStateFrom({ isAncestor, ownCommitCount, cherryAllApplied, squashMatch }) {
  if (ownCommitCount === 0) return 'no_own_commits';
  if (isAncestor) return 'merged';
  if (squashMatch) return 'squash_merged';
  if (cherryAllApplied) return 'rebase_merged';
  return 'unmerged';
}

export function groupOf(state, flags = []) {
  const has = (f) => flags.includes(f);
  if (has('local_only') || has('remote_deleted_unmerged') || has('closed_pr_unmerged')) return 'needs_decision';
  if (state === 'unmerged') return has('uncommitted_changes') || has('recent') ? 'in_progress' : 'needs_decision';
  if (state === 'no_own_commits') return 'needs_decision';
  if (has('uncommitted_changes')) return 'in_progress';
  return 'cleanable';
}

export const FLAG_TEXT = {
  local_only: '只在这台电脑上，云端没有；删掉就找不回来了。',
  unpushed_commits: '有提交还没推到云端。',
  remote_deleted_unmerged: '云端的分支已经删了，但改动没进主干。',
  closed_pr_unmerged: 'PR 已经关闭，改动没进主干。',
  stale: '很久没动，也没有打开的 PR。',
  uncommitted_changes: '工作目录里有没提交的改动，说明有人正在改。',
  merged_but_dirty: '已经进了主干，但工作目录还有没提交的改动，清理前先看这些改动。',
};

// ---- 采集 ----
const git = (root, args) => {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};
const gitOk = (root, args) => {
  try {
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'], timeout: 20000 });
    return true;
  } catch {
    return false;
  }
};

function collect(root, fetch) {
  if (fetch) git(root, ['fetch', '--quiet', '--prune']);
  const defaultBranch = git(root, ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short']).replace(/^origin\//, '') || 'main';
  const base = `origin/${defaultBranch}`;
  const worktrees = git(root, ['worktree', 'list', '--porcelain']).split('\n\n').filter(Boolean).map((block) => {
    const entry = Object.fromEntries(block.split('\n').filter(Boolean).map((l) => [l.split(' ')[0], l.slice(l.indexOf(' ') + 1)]));
    return { path: entry.worktree, branch: entry.branch?.replace('refs/heads/', '') ?? null };
  });
  const aheadBehind = git(root, ['rev-list', '--left-right', '--count', `${base}...HEAD`]).split(/\s+/);
  const mainDirty = Boolean(git(root, ['status', '--porcelain']));
  const branches = git(root, ['for-each-ref', '--format=%(refname:short)|%(upstream:short)|%(committerdate:unix)', 'refs/heads'])
    .split('\n').filter(Boolean).map((line) => {
      const [name, upstream, ctime] = line.split('|');
      return { name, upstream, ctime: Number(ctime) };
    });
  return { root, defaultBranch, base, worktrees, aheadBehind, mainDirty, branches };
}

function branchDetail(root, base, b, now) {
  const ownCommitCount = Number(git(root, ['rev-list', '--count', `${base}..${b.name}`]) || '0');
  const isAncestor = gitOk(root, ['merge-base', '--is-ancestor', b.name, base]);
  const cherry = git(root, ['cherry', base, b.name]).split('\n').filter(Boolean);
  const cherryAllApplied = ownCommitCount > 0 && cherry.length > 0 && cherry.every((l) => l.startsWith('-'));
  const diffOwn = git(root, ['diff', `${base}...${b.name}`]);
  const diffTree = git(root, ['diff', base, b.name]);
  const squashMatch = Boolean(diffOwn) && !diffTree && !isAncestor;
  const state = mergeStateFrom({ isAncestor, ownCommitCount, cherryAllApplied, squashMatch });
  const ownCommits = git(root, ['log', `${base}..${b.name}`, '--format=%h %s']).split('\n').filter(Boolean).map((l) => ({ subject: l }));
  const stat = git(root, ['diff', '--shortstat', `${base}...${b.name}`]).trim();
  return { ...b, state, ownCommits, stat, daysIdle: Math.floor((now - b.ctime * 1000) / 86400000) };
}

// ---- 渲染 ----
function renderBoard(details, mainInfo) {
  const groups = { needs_decision: [], in_progress: [], cleanable: [] };
  for (const d of details) groups[groupOf(d.state, d.flags)].push(d);
  const lines = [];
  lines.push(mainInfo.length ? `**主干：${mainInfo.join('；')}**` : '**主干：本机和云端一致**');
  lines.push('');
  for (const [g, title] of [['needs_decision', '### 需要你决定'], ['in_progress', '### 正在进行'], ['cleanable', '### 已进主干，可以清理']]) {
    lines.push(title);
    if (!groups[g].length) { lines.push('（没有）', ''); continue; }
    if (g === 'cleanable') {
      lines.push(`${groups[g].length} 条：${groups[g].slice(0, 5).map((d) => `\`${d.name}\``).join('、')}${groups[g].length > 5 ? ' 等' : ''}。回复"清理"先看完整清单。`, '');
      continue;
    }
    for (const d of groups[g]) {
      lines.push(`**\`${d.name}\`** · ${d.worktree ? `工作目录 ${d.worktree}` : '没有工作目录'} · ${d.daysIdle} 天没动 · ${d.state}`);
      if (d.flags.length) lines.push(`- 状态：${d.flags.map((f) => FLAG_TEXT[f] ?? f).join(' ')}`);
      if (d.stat) lines.push(`- 改动：${d.stat}`);
      if (d.ownCommits.length) lines.push(`- 最近提交：${d.ownCommits.slice(0, 3).map((c) => c.subject).join(' / ')}`);
      lines.push('');
    }
  }
  lines.push('> 推送、合并、删除分支和清理工作目录都要等确认，本工具只报告。');
  return lines.join('\n');
}

// ---- CLI ----
import { pathToFileURL } from 'node:url';

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
const args = process.argv.slice(2);
const wsIndex = args.indexOf('--workspace');
const root = path.resolve(wsIndex >= 0 ? args[wsIndex + 1] : process.cwd());
const asJson = args.includes('--json');
const fetch = args.includes('--fetch');

if (!existsSync(path.join(root, '.git'))) {
  console.error(JSON.stringify({ ok: false, error: 'not a git repository' }));
  process.exit(2);
}

const data = collect(root, fetch);
const now = Date.now();
const mainInfo = [];
if (data.aheadBehind.length === 2) {
  if (Number(data.aheadBehind[0]) > 0) mainInfo.push(`本机主干比云端多 ${data.aheadBehind[0]} 个提交（没走 PR）`);
  if (Number(data.aheadBehind[1]) > 0) mainInfo.push(`云端主干领先本机 ${data.aheadBehind[1]} 个提交`);
}
if (data.mainDirty) mainInfo.push('主工作区有未提交改动');

const details = data.branches
  .filter((b) => b.name !== data.defaultBranch)
  .map((b) => {
    const d = branchDetail(root, data.base, b, now);
    d.worktree = data.worktrees.find((w) => w.branch === b.name)?.path ?? null;
    const flags = [];
    if (!b.upstream) flags.push('local_only');
    else if (git(root, ['rev-list', '--count', `${b.upstream}..${b.name}`]) !== '0') flags.push('unpushed_commits');
    if (d.daysIdle > 14) flags.push('stale');
    if (d.worktree && git(d.worktree, ['status', '--porcelain'])) flags.push('uncommitted_changes');
    d.flags = flags;
    return d;
  });

if (asJson) {
  console.log(JSON.stringify({ ok: true, root, defaultBranch: data.defaultBranch, mainInfo, branches: details.map(({ ownCommits, ...rest }) => ({ ...rest, commitCount: ownCommits.length })) }, null, 2));
} else {
  console.log(renderBoard(details, mainInfo));
}
}

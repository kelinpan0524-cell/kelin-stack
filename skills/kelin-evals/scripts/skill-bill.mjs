#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const args = process.argv.slice(2);
const option = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const root = path.resolve(option('--root', process.cwd()));
const check = args.includes('--check');
const explicitBase = option('--base', '');
const skillsDir = path.join(root, 'skills');

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
const base = resolveBase();

const rows = [];
for (const name of readdirSync(skillsDir).sort()) {
  const file = path.join(skillsDir, name, 'SKILL.md');
  if (!existsSync(file) || !statSync(file).isFile()) continue;
  const text = readFileSync(file, 'utf8');
  const bytes = Buffer.byteLength(text);
  const lines = text.split(/\r?\n/).length;
  const previous = git(['show', `${base}:skills/${name}/SKILL.md`]);
  const before = previous.status === 0 ? Buffer.byteLength(previous.stdout) : null;
  const deltaBytes = before === null ? null : bytes - before;
  const deltaPct = before ? Number((((bytes - before) / before) * 100).toFixed(1)) : null;
  rows.push({ name, bytes, lines, before, deltaBytes, deltaPct, due: deltaPct !== null && deltaPct > 10 });
}

const due = rows.filter((row) => row.due);
const result = { root, base, ok: due.length === 0, skills: rows.length, due: due.map((row) => row.name), rows };
console.log(JSON.stringify(result, null, 2));
process.exit(check && due.length ? 1 : 0);

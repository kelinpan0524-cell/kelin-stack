#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const args = process.argv.slice(2);
const rootIndex = args.indexOf('--root');
const root = path.resolve(rootIndex >= 0 && args[rootIndex + 1] ? args[rootIndex + 1] : process.cwd());
const check = args.includes('--check');
const skillsDir = path.join(root, 'skills');

const git = (argv) => spawnSync('git', argv, { cwd: root, encoding: 'utf8' });

const rows = [];
for (const name of readdirSync(skillsDir).sort()) {
  const file = path.join(skillsDir, name, 'SKILL.md');
  if (!existsSync(file) || !statSync(file).isFile()) continue;
  const text = readFileSync(file, 'utf8');
  const bytes = Buffer.byteLength(text);
  const lines = text.split(/\r?\n/).length;
  const previous = git(['show', `HEAD:skills/${name}/SKILL.md`]);
  const before = previous.status === 0 ? Buffer.byteLength(previous.stdout) : null;
  const deltaBytes = before === null ? null : bytes - before;
  const deltaPct = before ? Number((((bytes - before) / before) * 100).toFixed(1)) : null;
  rows.push({ name, bytes, lines, before, deltaBytes, deltaPct, due: deltaPct !== null && deltaPct > 10 });
}

const due = rows.filter((row) => row.due);
const result = { root, ok: due.length === 0, skills: rows.length, due: due.map((row) => row.name), rows };
console.log(JSON.stringify(result, null, 2));
process.exit(check && due.length ? 1 : 0);

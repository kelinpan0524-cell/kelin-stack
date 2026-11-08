#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const file = process.argv[2] || 'repo-map.json';
const base = path.dirname(path.resolve(file));

let spec;
try {
  spec = JSON.parse(readFileSync(file, 'utf8'));
} catch (error) {
  console.error(`${file}: ${error.message}`);
  process.exit(2);
}

const repos = Array.isArray(spec.repos) ? spec.repos : [];
const problems = [];
const add = (code, detail) => problems.push({ code, detail });

if (!repos.length) add('empty', 'repos is empty');

const names = new Set();
const owners = new Map();
for (const repo of repos) {
  if (!repo.name) add('missing-name', 'a repo has no name');
  else if (names.has(repo.name)) add('duplicate-name', repo.name);
  names.add(repo.name);
  if (!repo.owner) add('missing-owner', repo.name || '(unnamed)');
  if (!repo.purpose) add('missing-purpose', repo.name || '(unnamed)');
  for (const entity of repo.ownsData || []) {
    if (!owners.has(entity)) owners.set(entity, []);
    owners.get(entity).push(repo.name);
  }
}

for (const [entity, list] of owners) {
  if (list.length > 1) add('data-owner-conflict', `${entity}: ${list.join(', ')}`);
}

for (const repo of repos) {
  for (const dependency of repo.dependsOn || []) {
    if (!names.has(dependency)) add('missing-dependency', `${repo.name} -> ${dependency}`);
  }
  const root = repo.path ? path.resolve(base, repo.path) : base;
  for (const contract of repo.contracts || []) {
    if (/^https?:/.test(contract)) continue;
    if (!existsSync(path.resolve(root, contract))) add('missing-contract', `${repo.name}: ${contract}`);
  }
}

const visit = (name, stack, seen) => {
  if (stack.includes(name)) {
    add('cycle', [...stack, name].join(' -> '));
    return;
  }
  if (seen.has(name)) return;
  const repo = repos.find((entry) => entry.name === name);
  if (!repo) return;
  for (const dependency of repo.dependsOn || []) visit(dependency, [...stack, name], seen);
  seen.add(name);
};
const seen = new Set();
for (const repo of repos) visit(repo.name, [], seen);

const result = { ok: problems.length === 0, file, repos: repos.length, problems };
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);

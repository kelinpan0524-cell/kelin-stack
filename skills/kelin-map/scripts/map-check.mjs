#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

const file = process.argv[2] || 'feature-map.json';
const base = path.dirname(path.resolve(file));

const glob = (pattern) => {
  if (!pattern.includes('*')) return (target) => target === pattern;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const body = escaped.replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*');
  const regex = new RegExp(`^${body}$`);
  return (target) => regex.test(target);
};

const walk = async (root, rel = '') => {
  const entries = await readdir(path.join(root, rel), { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const next = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await walk(root, next)));
    else if (entry.isFile()) out.push(next);
  }
  return out;
};

let spec;
try {
  spec = JSON.parse(readFileSync(file, 'utf8'));
} catch (error) {
  console.error(`${file}: ${error.message}`);
  process.exit(2);
}

const problems = [];
const roots = Array.isArray(spec.roots) ? spec.roots : [];
const owners = Array.isArray(spec.owners) ? spec.owners : [];
const nonRuntime = Array.isArray(spec.nonRuntime) ? spec.nonRuntime : [];

if (!roots.length) problems.push('roots is empty');
if (!owners.length) problems.push('owners is empty');

for (const entry of [...owners, ...nonRuntime.map((pattern) => ({ pattern }))]) {
  if (typeof entry.pattern !== 'string' || !entry.pattern || entry.pattern.startsWith('/') || entry.pattern.includes('..')) {
    problems.push(`unsafe pattern: ${entry.pattern}`);
  }
}
for (const owner of owners) {
  if (!owner.feature) problems.push(`owner without feature: ${owner.pattern}`);
  if (!owner.verify) problems.push(`owner without verify: ${owner.pattern}`);
}

const files = [];
for (const root of roots) {
  try {
    const found = await walk(path.join(base, root));
    for (const rel of found) files.push(`${root}/${rel}`);
  } catch (error) {
    problems.push(`cannot walk ${root}: ${error.message}`);
  }
}

const unmapped = [];
const ambiguous = [];
const runtimeOwners = owners.map((owner) => ({ ...owner, match: glob(owner.pattern) }));
const runtimeFree = nonRuntime.map((pattern) => glob(pattern));

for (const rel of files) {
  const hits = runtimeOwners.filter((owner) => owner.match(rel));
  if (hits.length > 1) ambiguous.push({ path: rel, features: hits.map((hit) => hit.feature) });
  else if (hits.length === 0 && !runtimeFree.some((match) => match(rel))) unmapped.push(rel);
}

for (const item of ambiguous) problems.push(`ambiguous: ${item.path} -> ${item.features.join(', ')}`);
for (const item of unmapped) problems.push(`unmapped: ${item}`);

const result = {
  file,
  ok: problems.length === 0,
  files: files.length,
  mapped: files.length - unmapped.length - ambiguous.length,
  nonRuntime: files.filter((rel) => runtimeFree.some((match) => match(rel))).length,
  ambiguous,
  unmapped,
  problems,
};

console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);

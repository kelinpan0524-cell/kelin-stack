#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

const rawArgs = process.argv.slice(2);
let file = 'feature-map.json';
let explicitRoot = '';
for (let i = 0; i < rawArgs.length; i += 1) {
  if (rawArgs[i] === '--root' && rawArgs[i + 1]) {
    explicitRoot = rawArgs[i + 1];
    i += 1;
  } else if (!rawArgs[i].startsWith('-')) {
    file = rawArgs[i];
  }
}
const configDir = path.dirname(path.resolve(file));
const anchor = explicitRoot
  ? path.resolve(explicitRoot)
  : (path.basename(configDir) === '.kelin' ? path.dirname(configDir) : configDir);
let base = anchor;
const isWithin = (parentReal, childReal) => childReal === parentReal || childReal.startsWith(`${parentReal}${path.sep}`);

const glob = (pattern) => {
  if (!pattern.includes('*')) return (target) => target === pattern;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const body = escaped.replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*');
  const regex = new RegExp(`^${body}$`);
  return (target) => regex.test(target);
};

const walk = async (root, rel = '', boundaryReal = '') => {
  const entries = await readdir(path.join(root, rel), { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const next = rel ? `${rel}/${entry.name}` : entry.name;
    const full = path.join(root, next);
    if (boundaryReal && !isWithin(boundaryReal, realpathSync(full))) continue;
    if (entry.isDirectory()) out.push(...(await walk(root, next, boundaryReal)));
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
const roots = Array.isArray(spec?.roots) ? spec.roots : [];
const owners = Array.isArray(spec?.owners) ? spec.owners : [];
const nonRuntime = Array.isArray(spec?.nonRuntime) ? spec.nonRuntime : [];
const anchorReal = existsSync(anchor) ? realpathSync(anchor) : path.resolve(anchor);

if (typeof spec?.base === 'string' && spec.base) {
  if (explicitRoot) {
    if (path.isAbsolute(spec.base)) {
      problems.push(`unsafe base outside --root: ${spec.base}`);
    } else {
      const candidate = path.resolve(anchorReal, spec.base);
      const candidateReal = existsSync(candidate) ? realpathSync(candidate) : candidate;
      if (!isWithin(anchorReal, candidateReal)) {
        problems.push(`unsafe base outside --root: ${spec.base}`);
      } else {
        base = candidateReal;
      }
    }
  } else {
    base = path.resolve(configDir, spec.base);
  }
}
if (!roots.length) problems.push('roots is empty');
if (!owners.length) problems.push('owners is empty');

for (const root of roots) {
  if (typeof root !== 'string' || !root || root.startsWith('/') || root.includes('..')) problems.push(`unsafe root: ${root}`);
}
for (const entry of [...owners, ...nonRuntime.map((pattern) => ({ pattern }))]) {
  if (typeof entry?.pattern !== 'string' || !entry.pattern || entry.pattern.startsWith('/') || entry.pattern.includes('..')) {
    problems.push(`unsafe pattern: ${entry?.pattern}`);
  }
}
for (const owner of owners) {
  if (!owner?.feature) problems.push(`owner without feature: ${owner?.pattern}`);
  if (!owner?.verify) problems.push(`owner without verify: ${owner?.pattern}`);
}

const files = [];
const baseReal = existsSync(base) ? realpathSync(base) : path.resolve(base);
for (const root of roots) {
  try {
    const targetDir = path.join(base, root);
    const targetReal = realpathSync(targetDir);
    if (!isWithin(baseReal, targetReal) || (explicitRoot && !isWithin(anchorReal, targetReal))) {
      problems.push(`unsafe root escaping base: ${root}`);
      continue;
    }
    const found = await walk(targetReal, '', targetReal);
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

#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

const rawArgs = process.argv.slice(2);
let file = 'feature-map.json';
let explicitRoot = '';
let changedFrom = '';
let verifySpec = '.kelin/verify.json';
let verifyExplicit = false;
let writeRecord = false;
for (let i = 0; i < rawArgs.length; i += 1) {
  if (rawArgs[i] === '--root' && rawArgs[i + 1]) {
    explicitRoot = rawArgs[i + 1];
    i += 1;
  } else if (rawArgs[i] === '--changed-from') {
    if (!rawArgs[i + 1]) {
      console.error('--changed-from requires a git ref');
      process.exit(2);
    }
    changedFrom = rawArgs[i + 1];
    i += 1;
  } else if (rawArgs[i] === '--verify') {
    if (!rawArgs[i + 1] || rawArgs[i + 1].startsWith('-')) {
      console.error('--verify requires a verify.json path');
      process.exit(2);
    }
    verifySpec = rawArgs[i + 1];
    verifyExplicit = true;
    i += 1;
  } else if (rawArgs[i] === '--write') {
    writeRecord = true;
  } else if (!rawArgs[i].startsWith('-')) {
    file = rawArgs[i];
  }
}
if (writeRecord && !changedFrom) {
  console.error('--write requires --changed-from: there is no change set to record without a base ref');
  process.exit(2);
}
// ref/sha/missing 沿用门禁字段纪律；features 必须原样落盘——advance 按原文精确比对，归一化会造成覆盖假绿
const asciiClamp = (value) => {
  const cleaned = String(value ?? '')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/[<>`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 160 ? cleaned.slice(0, 160) : cleaned;
};
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
const blankOwners = owners.filter((owner) => typeof owner?.feature === 'string' && !owner.feature.trim());
if (blankOwners.length > 0) {
  console.error(`${file}: invalid feature id (blank after trim) on pattern(s): ${blankOwners.map((owner) => String(owner?.pattern ?? '')).join(', ')}`);
  process.exit(2);
}
const anchorReal = existsSync(anchor) ? realpathSync(anchor) : path.resolve(anchor);

if (typeof spec?.base === 'string' && spec.base) {
  if (path.isAbsolute(spec.base)) {
    problems.push(`unsafe base outside root: ${spec.base}`);
  } else {
    const configReal = existsSync(configDir) ? realpathSync(configDir) : path.resolve(configDir);
    const baseAnchor = isWithin(anchorReal, configReal) ? configReal : anchorReal;
    const candidate = path.resolve(baseAnchor, spec.base);
    const candidateReal = existsSync(candidate) ? realpathSync(candidate) : candidate;
    if (!isWithin(anchorReal, candidateReal)) {
      problems.push(`unsafe base outside root: ${spec.base}`);
    } else {
      base = candidateReal;
    }
  }
}

if (changedFrom) {
  const changedOwners = owners.filter((owner) => typeof owner?.pattern === 'string' && owner.pattern && !owner.pattern.startsWith('/') && !owner.pattern.includes('..'));
  const changedFree = nonRuntime.filter((pattern) => typeof pattern === 'string' && pattern && !pattern.startsWith('/') && !pattern.includes('..'));
  const ownerMatchers = changedOwners.map((owner) => ({ ...owner, match: glob(owner.pattern) }));
  const freeMatchers = changedFree.map((pattern) => glob(pattern));
  const git = (args) => spawnSync('git', ['-C', anchorReal, ...args], { encoding: 'utf8' });
  const topRes = git(['rev-parse', '--show-toplevel']);
  if (topRes.status !== 0 || !topRes.stdout.trim()) {
    console.error(`--changed-from requires a git repository: ${(topRes.stderr || '').trim() || anchorReal}`);
    process.exit(2);
  }
  const repoTop = realpathSync(topRes.stdout.trim());
  const revRes = git(['rev-parse', '--verify', `${changedFrom}^{commit}`]);
  if (revRes.status !== 0) {
    console.error(`invalid git ref: ${changedFrom} (did you pass a file path where a git ref was expected?): ${(revRes.stderr || '').trim()}`);
    process.exit(2);
  }
  const baseSha = revRes.stdout.trim();
  const diffRes = git(['diff', '--name-only', '--no-renames', '-z', baseSha, '--']);
  if (diffRes.status !== 0) {
    console.error(`git diff --name-only ${changedFrom} failed: ${(diffRes.stderr || '').trim()}`);
    process.exit(2);
  }
  const changed = [...new Set(diffRes.stdout.split('\0').filter(Boolean))].sort();
  const matched = [];
  const unmapped = [];
  const nonRuntimeHits = [];
  for (const rel of changed) {
    const abs = path.resolve(repoTop, rel);
    const baseRel = path.relative(base, abs).split(path.sep).join('/');
    const target = baseRel.startsWith('..') || path.isAbsolute(baseRel) ? rel : baseRel;
    const hits = ownerMatchers.filter((owner) => owner.match(target));
    if (hits.length) {
      for (const hit of hits) matched.push({ path: target, feature: hit.feature, pattern: hit.pattern, verify: hit.verify || '' });
    } else if (freeMatchers.some((match) => match(target))) {
      nonRuntimeHits.push(target);
    } else {
      unmapped.push(target);
    }
  }
  const ok = unmapped.length === 0;
  const verifyPath = path.resolve(anchor, verifySpec);
  let verifyChecked = false;
  const missing = [];
  if (verifyExplicit && !existsSync(verifyPath)) {
    console.error(`--verify file not found: ${verifyPath} (explicit --verify must exist; omit --verify to use the default .kelin/verify.json optionally)`);
    process.exit(2);
  }
  if (existsSync(verifyPath)) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(verifyPath, 'utf8'));
    } catch (error) {
      console.error(`${verifyPath}: ${error.message}`);
      process.exit(2);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.checks)) {
      console.error(`${verifyPath}: checks must be an array`);
      process.exit(2);
    }
    const blankVerifyChecks = parsed.checks.filter((check) => typeof check?.feature === 'string' && !check.feature.trim());
    if (blankVerifyChecks.length > 0) {
      console.error(`${verifyPath}: invalid feature id (blank after trim) on check(s): ${blankVerifyChecks.map((check) => String(check?.id ?? '')).join(', ')}`);
      process.exit(2);
    }
    const declared = new Set(parsed.checks.map((check) => (typeof check?.feature === 'string' && check.feature) || '').filter(Boolean));
    for (const feature of [...new Set(matched.map((entry) => entry.feature).filter(Boolean))].sort()) {
      if (!declared.has(feature)) missing.push(feature);
    }
    verifyChecked = true;
  }
  const pass = ok && missing.length === 0;
  if (writeRecord) {
    const recordPath = path.join(anchor, '.kelin', 'changed-features.json');
    const record = {
      ref: asciiClamp(changedFrom),
      sha: asciiClamp(baseSha),
      features: [...new Set(matched.map((entry) => entry.feature).filter(Boolean))].sort(),
      missing: missing.map(asciiClamp),
    };
    try {
      mkdirSync(path.dirname(recordPath), { recursive: true });
      writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    } catch (error) {
      console.error(`cannot write ${recordPath}: ${error.message}`);
      process.exit(2);
    }
  }
  console.log(JSON.stringify({
    file,
    ok: pass,
    ref: changedFrom,
    changed: changed.length,
    matched,
    unmapped,
    nonRuntime: nonRuntimeHits,
    missing,
    verifyChecked,
    verifyFile: verifyPath,
    ...(pass ? {} : { hint: unmapped.length ? 'map the unmapped paths in feature-map.json or state the verification basis' : 'add the missing feature to verify.json checks or declare skipReason per routing rules' }),
  }, null, 2));
  process.exit(pass ? 0 : 1);
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
    if (!isWithin(baseReal, targetReal) || !isWithin(anchorReal, targetReal)) {
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
const validOwners = owners.filter((owner) => typeof owner?.pattern === 'string' && owner.pattern && !owner.pattern.startsWith('/') && !owner.pattern.includes('..'));
const validNonRuntime = nonRuntime.filter((pattern) => typeof pattern === 'string' && pattern && !pattern.startsWith('/') && !pattern.includes('..'));
const runtimeOwners = validOwners.map((owner) => ({ ...owner, match: glob(owner.pattern) }));
const runtimeFree = validNonRuntime.map((pattern) => glob(pattern));

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

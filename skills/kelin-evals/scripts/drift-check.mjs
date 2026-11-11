#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const rootIndex = args.indexOf('--root');
const root = path.resolve(rootIndex >= 0 && args[rootIndex + 1] ? args[rootIndex + 1] : process.cwd());
const skillsDir = path.join(root, 'skills');
const missing = [];
let references = 0;

for (const name of readdirSync(skillsDir).sort()) {
  const file = path.join(skillsDir, name, 'SKILL.md');
  if (!existsSync(file) || !statSync(file).isFile()) continue;
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/skills\/([a-z][a-z0-9-]+)\/([A-Za-z0-9._/-]+?)(?=[\s)`'"，。；,;]|$)/g)) {
    references += 1;
    const target = path.join(root, 'skills', match[1], match[2]);
    if (!existsSync(target)) missing.push({ skill: name, reference: `skills/${match[1]}/${match[2]}` });
  }
  for (const match of text.matchAll(/node\s+(skills\/[A-Za-z0-9._/-]+\.(?:mjs|js))/g)) {
    references += 1;
    if (!existsSync(path.join(root, match[1]))) missing.push({ skill: name, reference: match[1] });
  }
}

const result = { root, ok: missing.length === 0, references, missing };
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);

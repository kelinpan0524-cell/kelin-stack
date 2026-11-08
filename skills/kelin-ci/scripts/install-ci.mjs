#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const target = args.find((arg) => !arg.startsWith('--'));
const option = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const force = args.includes('--force');
const testCommand = option('--test', 'echo "set --test <your test command>"');

if (!target) {
  console.error('Usage: node install-ci.mjs <repo> [--test "npm test"] [--force]');
  process.exit(2);
}

const repo = path.resolve(target);
const skillDir = path.resolve(import.meta.dirname, '..');
const templates = path.join(skillDir, 'templates');
const vendored = [
  ['agents-check.mjs', path.resolve(skillDir, '..', 'kelin-agents', 'scripts', 'agents-check.mjs')],
  ['map-check.mjs', path.resolve(skillDir, '..', 'kelin-map', 'scripts', 'map-check.mjs')],
  ['run-acceptance.mjs', path.resolve(skillDir, '..', 'kelin-verify', 'scripts', 'run-acceptance.mjs')],
  ['guard-check.mjs', path.resolve(skillDir, '..', 'kelin-guard', 'scripts', 'guard-check.mjs')],
];

const wrote = [];
const skipped = [];
const write = (file, body) => {
  if (existsSync(file) && !force) {
    skipped.push(path.relative(repo, file));
    return;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
  wrote.push(path.relative(repo, file));
};

const ciDir = path.join(repo, '.kelin', 'ci');
mkdirSync(ciDir, { recursive: true });
for (const [name, source] of vendored) {
  if (!existsSync(source)) {
    console.error(`missing source: ${source}`);
    process.exit(2);
  }
  const file = path.join(ciDir, name);
  if (existsSync(file) && !force) {
    skipped.push(path.relative(repo, file));
    continue;
  }
  copyFileSync(source, file);
  wrote.push(path.relative(repo, file));
}

const workflow = readFileSync(path.join(templates, 'kelin-gate.yml'), 'utf8').replaceAll('__TEST_COMMAND__', testCommand);
write(path.join(repo, '.github', 'workflows', 'kelin-gate.yml'), workflow);
write(path.join(repo, '.github', 'pull_request_template.md'), readFileSync(path.join(templates, 'pull_request_template.md'), 'utf8'));

console.log(JSON.stringify({
  ok: true,
  repo,
  wrote,
  skipped,
  next: [
    'set kelin-gate as a required check in GitHub branch protection',
    'add AGENTS.md (kelin-agents), feature-map.json (kelin-map), verify.json (kelin-verify) when ready',
    'run: node .kelin/ci/agents-check.mjs AGENTS.md',
  ],
}, null, 2));

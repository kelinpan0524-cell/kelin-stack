#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const args = process.argv.slice(2);
const option = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

if (args.includes('--help') || args.includes('-h')) {
  console.error('Usage: node pregate.mjs [--root DIR] [--config FILE] (--changed a,b | --changed-file FILE | --staged)');
  process.exit(2);
}

const root = path.resolve(option('--root', process.cwd()));
const configFile = path.resolve(root, option('--config', 'kelin-checks.json'));

if (!existsSync(configFile)) {
  console.error(`config not found: ${configFile}; copy skills/kelin-ci/templates/kelin-checks.json`);
  process.exit(2);
}

let config;
try {
  config = JSON.parse(readFileSync(configFile, 'utf8'));
} catch (error) {
  console.error(`${configFile}: ${error.message}`);
  process.exit(2);
}

const alwaysRun = Array.isArray(config.alwaysRun) ? config.alwaysRun.filter((entry) => typeof entry === 'string' && entry.trim()) : [];
const checks = Array.isArray(config.checks) ? config.checks : [];
if (!checks.length) {
  console.error('config.checks must contain at least one check');
  process.exit(2);
}

let changed = [];
if (args.includes('--staged')) {
  const output = execFileSync('git', ['-C', root, 'diff', '--cached', '--name-only'], { encoding: 'utf8' });
  changed = output.split('\n').map((line) => line.trim()).filter(Boolean);
} else if (option('--changed-file')) {
  const file = path.resolve(root, option('--changed-file'));
  if (!existsSync(file)) {
    console.error(`changed file not found: ${file}`);
    process.exit(2);
  }
  changed = readFileSync(file, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean);
} else {
  changed = option('--changed').split(',').map((line) => line.trim()).filter(Boolean);
}

if (!changed.length) {
  console.error('no changed paths supplied; pass --changed a,b, --changed-file FILE or --staged');
  process.exit(2);
}

const glob = (pattern) => {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const body = escaped.replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*');
  return new RegExp(`^${body}$`);
};

const selected = [];
const skipped = [];
for (const check of checks) {
  if (!check || typeof check.command !== 'string' || !check.command.trim() || !Array.isArray(check.paths)) {
    console.error('each check needs id, paths[] and command');
    process.exit(2);
  }
  const hit = check.paths.some((pattern) => {
    const matcher = glob(pattern);
    return changed.some((file) => matcher.test(file));
  });
  if (hit) selected.push({ id: check.id || check.command, command: check.command });
  else skipped.push({ id: check.id || check.command, command: check.command });
}

const commands = [...new Set([...alwaysRun, ...selected.map((entry) => entry.command)])];
const result = {
  ok: true,
  root,
  changed: changed.sort(),
  alwaysRun,
  selected: selected.map((entry) => entry.id),
  skipped: skipped.map((entry) => entry.id),
  commands,
};
console.log(JSON.stringify(result, null, 2));

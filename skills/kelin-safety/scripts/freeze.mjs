#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { freezeFile } from './freeze-lib.mjs';

const args = process.argv.slice(2);
const filtered = [];
let root = process.env.ZCODE_PROJECT_DIR || process.cwd();
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--root') {
    root = args[index + 1] || root;
    index += 1;
    continue;
  }
  filtered.push(args[index]);
}
const [command, ...rest] = filtered;
const projectDir = path.resolve(root);
const file = freezeFile(projectDir);

if (command === 'set') {
  if (!rest.length) {
    console.error('Usage: node freeze.mjs set <path...> [--root DIR] | clear | status');
    process.exit(2);
  }
  const roots = rest.map((entry) => path.resolve(projectDir, entry));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ roots, createdAt: new Date().toISOString() }, null, 2)}\n`);
  console.log(JSON.stringify({ frozen: true, roots }, null, 2));
  process.exit(0);
}

if (command === 'clear') {
  if (existsSync(file)) rmSync(file);
  console.log(JSON.stringify({ frozen: false }, null, 2));
  process.exit(0);
}

if (command === 'status') {
  if (!existsSync(file)) {
    console.log(JSON.stringify({ frozen: false }, null, 2));
    process.exit(0);
  }
  try {
    console.log(JSON.stringify({ frozen: true, ...JSON.parse(readFileSync(file, 'utf8')) }, null, 2));
    process.exit(0);
  } catch (error) {
    console.error(`${file}: ${error.message}`);
    process.exit(1);
  }
}

console.error('Usage: node freeze.mjs set <path...> [--root DIR] | clear | status');
process.exit(2);

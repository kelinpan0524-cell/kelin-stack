#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const args = process.argv.slice(2);
const target = args.find((arg) => !arg.startsWith('--')) || '.';
const option = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const checkOnly = args.includes('--check');
const uninstall = args.includes('--uninstall');
const force = args.includes('--force');
const marker = '# kelin-stack pre-commit';
const hookName = 'pre-commit';
const helperName = 'kelin-precommit.mjs';

const repo = path.resolve(target);
let hooksDir = option('--hooks-dir');
if (hooksDir) {
  hooksDir = path.resolve(hooksDir);
} else {
  const result = spawnSync('git', ['-C', repo, 'rev-parse', '--git-path', 'hooks'], { encoding: 'utf8' });
  if (result.status !== 0) {
    console.error(`not a git repository: ${repo}`);
    process.exit(2);
  }
  hooksDir = path.resolve(repo, result.stdout.trim());
}

const hook = path.join(hooksDir, hookName);
const helper = path.join(hooksDir, helperName);
const exists = existsSync(hook);
const ours = exists && readFileSync(hook, 'utf8').includes(marker);
const report = (action, ok = true, extra = {}) => {
  console.log(JSON.stringify({ ok, hook, helper, action, ...extra }, null, 2));
  process.exit(ok ? 0 : 1);
};

if (checkOnly) {
  if (!exists) report('missing', false);
  if (!ours) report('foreign', false);
  report('installed', true);
}

if (uninstall) {
  if (!exists) report('missing', false);
  if (!ours) report('foreign', false);
  unlinkSync(hook);
  if (existsSync(helper)) unlinkSync(helper);
  report('uninstalled', true);
}

if (exists && !ours && !force) report('foreign', false, { hint: 'merge it manually or rerun with --force' });

const wrapper = [
  '#!/bin/sh',
  marker,
  `exec node "$(dirname "$0")/${helperName}" "$@"`,
  '',
].join('\n');

const helperBody = `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

if (process.env.KELIN_SKIP_PRECOMMIT === '1') process.exit(0);

const git = (args) => spawnSync('git', args, { encoding: 'utf8' });
const staged = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']);
if (staged.status !== 0) process.exit(0);

const findings = [];
const warnings = [];
for (const file of staged.stdout.split('\\n').filter(Boolean)) {
  if (/(^|\\/)\\.env(\\.|$)/.test(file) || /\\.(pem|key)$/i.test(file) || /(^|\\/)id_rsa/.test(file)) findings.push('secret-file: ' + file);
  if (/\\.(xlsx|xls|numbers)$/i.test(file)) findings.push('real-data: ' + file);
  if (/\\.(csv|tsv)$/i.test(file)) warnings.push('data-file: ' + file);
}

const diff = git(['diff', '--cached', '--unified=0']).stdout || '';
const patterns = [
  [/sk-[A-Za-z0-9]{20,}/, 'provider key'],
  [/gh[pousr]_[A-Za-z0-9]{20,}/, 'github token'],
  [/AKIA[0-9A-Z]{16}/, 'aws key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/(api[_-]?key|secret|token|password)\\s*[:=]\\s*["'][^"']{8,}["']/i, 'credential assignment'],
];

let current = '';
for (const line of diff.split('\\n')) {
  const header = /^\\+\\+\\+ b\\/(.+)$/.exec(line);
  if (header) current = header[1];
  if (!line.startsWith('+') || line.startsWith('+++')) continue;
  for (const [pattern, label] of patterns) {
    if (pattern.test(line)) findings.push(label + ' in ' + (current || 'unknown file'));
  }
}

for (const warning of warnings) console.error('kelin pre-commit warning: ' + warning);
if (findings.length) {
  console.error('kelin pre-commit blocked:');
  for (const finding of findings) console.error('  - ' + finding);
  console.error('Fix the finding, or set KELIN_SKIP_PRECOMMIT=1 to bypass.');
  process.exit(1);
}
process.exit(0);
`;

mkdirSync(hooksDir, { recursive: true });
writeFileSync(hook, wrapper);
writeFileSync(helper, helperBody);
chmodSync(hook, 0o755);
chmodSync(helper, 0o644);
report(exists ? 'replaced' : 'installed');

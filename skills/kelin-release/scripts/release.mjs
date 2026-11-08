#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const option = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const flag = (name) => args.includes(name);

const root = path.resolve(option('--root', process.cwd()));
const bump = option('--bump', 'patch');
const publish = flag('--publish');
const confirm = flag('--confirm');

const git = (gitArgs, allowFail = false) => {
  try {
    return execFileSync('git', ['-C', root, ...gitArgs], { encoding: 'utf8' }).trim();
  } catch (error) {
    if (allowFail) return '';
    throw error;
  }
};

const manifests = ['.zcode-plugin/plugin.json', '.claude-plugin/plugin.json', 'package.json']
  .map((rel) => path.join(root, rel))
  .filter((file) => existsSync(file));

const withVersion = manifests.filter((file) => {
  try {
    return Boolean(JSON.parse(readFileSync(file, 'utf8')).version);
  } catch {
    return false;
  }
});
if (!withVersion.length) {
  console.error('No manifest with a version field found');
  process.exit(2);
}

const current = JSON.parse(readFileSync(withVersion[0], 'utf8')).version;
const parts = current.split('.').map(Number);
if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) {
  console.error(`Unsupported version: ${current}`);
  process.exit(2);
}
if (!['patch', 'minor', 'major'].includes(bump)) {
  console.error('--bump must be patch, minor or major');
  process.exit(2);
}
if (bump === 'major') parts.splice(0, 3, parts[0] + 1, 0, 0);
else if (bump === 'minor') parts.splice(1, 3, parts[1] + 1, 0);
else parts.splice(2, 1, parts[2] + 1);
const next = parts.join('.');

const lastTag = git(['describe', '--tags', '--abbrev=0'], true);
const range = lastTag ? `${lastTag}..HEAD` : 'HEAD';
const commits = git(['log', '--oneline', '--no-decorate', range], true).split('\n').filter(Boolean);
const status = git(['status', '--porcelain'], true);
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], true);

const plan = {
  root,
  branch,
  current,
  next,
  bump,
  lastTag: lastTag || null,
  commits: commits.length,
  commitsPreview: commits.slice(0, 20),
  manifests: withVersion.map((file) => path.relative(root, file)),
  changelog: existsSync(path.join(root, 'CHANGELOG.md')) ? 'update' : 'create',
  clean: status === '',
  mode: publish ? 'publish' : 'dry-run',
};

if (!publish) {
  console.log(JSON.stringify(plan, null, 2));
  process.exit(0);
}
if (!confirm) {
  console.error('Refusing to publish without --confirm');
  process.exit(2);
}
if (!plan.clean) {
  console.error('Working tree is not clean; commit or stash first');
  process.exit(1);
}

const steps = [];
const run = (label, command, commandArgs) => {
  execFileSync(command, commandArgs, { cwd: root, stdio: 'pipe' });
  steps.push(label);
};

for (const file of withVersion) {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  data.version = next;
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}
steps.push('bump manifests');

const changelog = path.join(root, 'CHANGELOG.md');
const entry = [`## v${next} - ${new Date().toISOString().slice(0, 10)}`, '', ...commits.map((line) => `- ${line}`), ''].join('\n');
if (existsSync(changelog)) {
  const existing = readFileSync(changelog, 'utf8');
  const lines = existing.split('\n');
  const title = existing.startsWith('#') ? `${lines[0]}\n\n` : '# Changelog\n\n';
  const body = existing.startsWith('#') ? lines.slice(1).join('\n').replace(/^\n+/, '') : existing;
  writeFileSync(changelog, `${title}${entry}${body}`);
} else {
  writeFileSync(changelog, `# Changelog\n\n${entry}`);
}
steps.push('write changelog');

run('commit', 'git', ['add', ...withVersion.map((file) => path.relative(root, file)), 'CHANGELOG.md']);
run('commit', 'git', ['commit', '-m', `chore(release): v${next}`]);
run('tag', 'git', ['tag', `v${next}`]);
run('push tag', 'git', ['push', 'origin', `v${next}`]);
run('github release', 'gh', ['release', 'create', `v${next}`, '--title', `v${next}`, '--notes', entry]);

console.log(JSON.stringify({ ok: true, version: next, steps }, null, 2));

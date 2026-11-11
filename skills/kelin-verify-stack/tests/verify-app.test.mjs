import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const scan = path.resolve(import.meta.dirname, '..', '..', 'kelin-verify-app', 'scripts', 'scan-app.mjs');
const generate = path.resolve(import.meta.dirname, '..', '..', 'kelin-verify-app', 'scripts', 'generate.mjs');

const run = (script, args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

const project = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kelin-verify-app-'));
  await mkdir(path.join(dir, 'app', 'users'), { recursive: true });
  await writeFile(path.join(dir, 'app', 'page.tsx'), 'export default function Page() { return null; }\n');
  await writeFile(path.join(dir, 'app', 'users', 'page.tsx'), 'export default function Page() { return null; }\n');
  await writeFile(path.join(dir, '.env.example'), 'PORT=3100\n');
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'demo-app', scripts: { dev: 'next dev', test: 'node --test' }, dependencies: { next: '1', react: '1' }, bin: { 'demo-cli': 'cli.mjs' } }, null, 2),
  );
  return dir;
};

test('scan detects stack, launch, port and features', async () => {
  const dir = await project();
  const result = run(scan, ['--root', dir]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.name, 'demo-app');
  assert.ok(payload.stack.includes('next'));
  assert.equal(payload.launch, 'npm run dev');
  assert.equal(payload.port, 3100);
  assert.ok(payload.features.some((entry) => entry.name.includes('/users')));
  assert.ok(payload.features.some((entry) => entry.name.includes('demo-cli')));
});

test('generate previews without writing, then writes the five sections and feature map', async () => {
  const dir = await project();
  const preview = run(generate, ['--root', dir]);
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).preview, true);
  assert.equal(existsSync(path.join(dir, '.zcode')), false);

  const written = run(generate, ['--root', dir, '--write']);
  assert.equal(written.status, 0, written.stderr);
  const skillFile = path.join(dir, '.zcode', 'skills', 'verify-demo-app', 'SKILL.md');
  const body = await readFile(skillFile, 'utf8');
  for (const heading of ['## 启动', '## 体检', '## 驱动', '## 留证', '## 清理']) assert.ok(body.includes(heading), heading);
  const map = await readFile(path.join(dir, '.zcode', 'skills', 'verify-demo-app', 'features', 'README.md'), 'utf8');
  assert.ok(map.includes('/users'));

  const again = run(generate, ['--root', dir, '--write']);
  assert.equal(again.status, 1);
  assert.equal(JSON.parse(again.stdout).ok, false);

  const forced = run(generate, ['--root', dir, '--write', '--force']);
  assert.equal(forced.status, 0, forced.stderr);
});

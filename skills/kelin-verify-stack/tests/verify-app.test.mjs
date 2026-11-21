import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const scan = path.resolve(import.meta.dirname, '..', '..', 'kelin-verify-app', 'scripts', 'scan-app.mjs');
const generate = path.resolve(import.meta.dirname, '..', '..', 'kelin-verify-app', 'scripts', 'generate.mjs');

const run = (script, args, cwd) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });

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

test('scan detects stack, harnesses, launch, port, methods, stable ids, and >8 routes', async () => {
  const dir = await project();
  await mkdir(path.join(dir, 'src'), { recursive: true });
  const lines = [];
  for (let i = 1; i <= 10; i += 1) {
    lines.push(`app.post('/api/items/${i}', () => {});`);
  }
  await writeFile(path.join(dir, 'src', 'routes.ts'), lines.join('\n'));

  const result = run(scan, ['--root', dir]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.name, 'demo-app');
  assert.ok(payload.stack.includes('next'));
  assert.ok(payload.harnesses.includes('node-test'));
  assert.equal(payload.launch, 'npm run dev');
  assert.equal(payload.port, 3100);
  assert.ok(payload.features.length >= 12, `expected >= 12 features, got ${payload.features.length}`);
  const users = payload.features.find((entry) => entry.name.includes('/users'));
  assert.ok(users);
  assert.match(users.id, /^page-users-[a-f0-9]{6}$/);
  const post10 = payload.features.find((entry) => entry.entrypoint === 'POST /api/items/10');
  assert.ok(post10);
  assert.match(post10.id, /^api-post-api-items-10-[a-f0-9]{6}$/);
  assert.ok(payload.features.some((entry) => entry.name.includes('demo-cli') && /^cli-demo-cli-[a-f0-9]{6}$/.test(entry.id)));

  const capped = run(scan, ['--root', dir, '--limit', '3']);
  assert.equal(capped.status, 0, capped.stderr);
  assert.ok(JSON.parse(capped.stdout).features.length <= 3);
});

test('generate previews without writing, syncs incrementally without overwriting manual edits, matches legacy numbered files, and refuses symlink escapes', async () => {
  const dir = await project();
  const preview = run(generate, ['--root', dir]);
  assert.equal(preview.status, 0, preview.stderr);
  const previewJson = JSON.parse(preview.stdout);
  assert.equal(previewJson.preview, true);
  assert.ok(previewJson.diff.added.some((name) => /^page-users-[a-f0-9]{6}\.md$/.test(name)));
  assert.equal(existsSync(path.join(dir, '.zcode')), false);

  const written = run(generate, ['--root', dir, '--write']);
  assert.equal(written.status, 0, written.stderr);
  const skillFile = path.join(dir, '.zcode', 'skills', 'verify-demo-app', 'SKILL.md');
  const body = await readFile(skillFile, 'utf8');
  for (const heading of ['## 启动', '## 体检', '## 驱动', '## 留证', '## 清理']) assert.ok(body.includes(heading), heading);
  const usersRel = previewJson.diff.added.find((name) => /^page-users-[a-f0-9]{6}\.md$/.test(name));
  const usersFile = path.join(dir, '.zcode', 'skills', 'verify-demo-app', 'features', usersRel);
  assert.equal(existsSync(usersFile), true);
  const usersBody = await readFile(usersFile, 'utf8');
  assert.match(usersBody, /sync_commit:/);
  assert.match(usersBody, /evidence_dir:/);
  await writeFile(usersFile, `${usersBody}\nMANUAL_NOTE_KEEP\n`);

  const orphanFile = path.join(dir, '.zcode', 'skills', 'verify-demo-app', 'features', 'legacy-orphan.md');
  await writeFile(orphanFile, '# Legacy\n');
  await mkdir(path.join(dir, 'app', 'settings'), { recursive: true });
  await writeFile(path.join(dir, 'app', 'settings', 'page.tsx'), 'export default function Page() { return null; }\n');

  const again = run(generate, ['--root', dir, '--write']);
  assert.equal(again.status, 1);
  assert.equal(JSON.parse(again.stdout).ok, false);

  const synced = run(generate, ['--root', dir, '--write', '--sync']);
  assert.equal(synced.status, 0, synced.stderr);
  const syncJson = JSON.parse(synced.stdout);
  assert.equal(syncJson.sync, true);
  assert.ok(syncJson.diff.added.some((name) => /^page-settings-[a-f0-9]{6}\.md$/.test(name)));
  assert.ok(syncJson.diff.preserved.includes(usersRel));
  assert.ok(syncJson.diff.orphaned.includes('legacy-orphan.md'));
  assert.match(await readFile(usersFile, 'utf8'), /MANUAL_NOTE_KEEP/);
  assert.equal(existsSync(orphanFile), true);
  const map = await readFile(path.join(dir, '.zcode', 'skills', 'verify-demo-app', 'features', 'README.md'), 'utf8');
  assert.ok(map.includes('/users'));
  assert.ok(map.includes('/settings'));

  const forced = run(generate, ['--root', dir, '--write', '--force']);
  assert.equal(forced.status, 0, forced.stderr);

  // Legacy 01-*.md file matching entrypoint is preserved on sync without duplication
  const legacyDir = await project();
  await mkdir(path.join(legacyDir, '.zcode', 'skills', 'verify-demo-app', 'features'), { recursive: true });
  await writeFile(path.join(legacyDir, '.zcode', 'skills', 'verify-demo-app', 'features', '01-users.md'), '# 页面或接口 /users\nLEGACY_KEEP\n');
  const legacySync = run(generate, ['--root', legacyDir, '--write', '--sync']);
  assert.equal(legacySync.status, 0, legacySync.stderr);
  const legacyDiff = JSON.parse(legacySync.stdout).diff;
  assert.ok(legacyDiff.preserved.includes('01-users.md'));
  assert.ok(!legacyDiff.added.some((name) => /^page-users-/.test(name)));

  // Distinct routes sharing a slug (/foo/bar vs /foo-bar) never collide
  const collideDir = await mkdtemp(path.join(tmpdir(), 'kelin-collide-'));
  await writeFile(path.join(collideDir, 'package.json'), JSON.stringify({ name: 'c' }));
  await mkdir(path.join(collideDir, 'src'), { recursive: true });
  await writeFile(path.join(collideDir, 'src', 'r.ts'), "app.get('/foo/bar', () => {});\napp.get('/foo-bar', () => {});\n");
  const collideScan = JSON.parse(run(scan, ['--root', collideDir]).stdout);
  const ids = collideScan.features.map((f) => f.id);
  assert.equal(ids.length, 2);
  assert.equal(new Set(ids).size, 2);

  // Symlink escape refused
  const outside = await mkdtemp(path.join(tmpdir(), 'kelin-outside-'));
  const symDir = await project();
  await mkdir(path.join(symDir, '.zcode'), { recursive: true });
  await symlink(outside, path.join(symDir, '.zcode', 'skills'));
  const escaped = run(generate, ['--root', symDir, '--write']);
  assert.equal(escaped.status, 2);
});

test('generate validates flags, rejects file --root, and --help creates no files in cwd', async () => {
  const dir = await project();
  const result = run(generate, ['--help'], dir);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /--write/);
  assert.equal(existsSync(path.join(dir, '.zcode')), false);

  const badFlag = run(generate, ['--root', dir, '--bogus'], dir);
  assert.equal(badFlag.status, 2);
  assert.match(badFlag.stderr, /--bogus/);
  assert.equal(existsSync(path.join(dir, '.zcode')), false);

  const missingVal = run(generate, ['--root', '--write'], dir);
  assert.equal(missingVal.status, 2);
  assert.match(missingVal.stderr, /requires a value/);

  const dupOut = run(generate, ['--root', dir, '--out', path.join(dir, 'a'), '--out', path.join(dir, 'b'), '--write'], dir);
  assert.equal(dupOut.status, 2);
  assert.match(dupOut.stderr, /Duplicate option: --out/);
  assert.equal(existsSync(path.join(dir, 'a')), false);
  assert.equal(existsSync(path.join(dir, 'b')), false);

  const fileRoot = run(generate, ['--root', path.join(dir, 'package.json')], dir);
  assert.equal(fileRoot.status, 2);
  assert.match(fileRoot.stderr, /existing directory/);
});

test('generate handles ambiguous legacy API headings, table-footer splicing, and >30 routes during --sync', async () => {
  // Single GET /ping matches legacy # 页面或接口 /ping; dual GET+POST /ping surfaces ambiguousLegacy
  const singleDir = await mkdtemp(path.join(tmpdir(), 'kelin-va-single-'));
  await writeFile(path.join(singleDir, 'package.json'), JSON.stringify({ name: 'single-api' }));
  await mkdir(path.join(singleDir, 'src'), { recursive: true });
  await writeFile(path.join(singleDir, 'src', 'r.ts'), "app.get('/ping', () => {});\n");
  await mkdir(path.join(singleDir, '.zcode', 'skills', 'verify-single-api', 'features'), { recursive: true });
  await writeFile(path.join(singleDir, '.zcode', 'skills', 'verify-single-api', 'features', '01-ping.md'), '# 页面或接口 /ping\nKEEP\n');
  const singleSync = JSON.parse(run(generate, ['--root', singleDir, '--write', '--sync'], singleDir).stdout);
  assert.ok(singleSync.diff.preserved.includes('01-ping.md'));
  assert.equal(singleSync.diff.ambiguousLegacy, undefined);

  const dualDir = await mkdtemp(path.join(tmpdir(), 'kelin-va-dual-'));
  await writeFile(path.join(dualDir, 'package.json'), JSON.stringify({ name: 'dual-api' }));
  await mkdir(path.join(dualDir, 'src'), { recursive: true });
  await writeFile(path.join(dualDir, 'src', 'r.ts'), "app.get('/ping', () => {});\napp.post('/ping', () => {});\n");
  await mkdir(path.join(dualDir, '.zcode', 'skills', 'verify-dual-api', 'features'), { recursive: true });
  await writeFile(path.join(dualDir, '.zcode', 'skills', 'verify-dual-api', 'features', '01-ping.md'), '# 页面或接口 /ping\nAMBIGUOUS\n');
  const dualSync = JSON.parse(run(generate, ['--root', dualDir, '--write', '--sync'], dualDir).stdout);
  assert.equal(dualSync.diff.ambiguousLegacy?.length, 1);
  assert.equal(dualSync.diff.ambiguousLegacy[0].candidates.length, 2);

  // Splicing missing rows into table leaves trailing sections intact & discovers beyond 30 routes on --sync
  const bigDir = await project();
  const routes = [];
  for (let i = 1; i <= 30; i += 1) {
    routes.push(`app.get('/api/r/${String(i).padStart(2, '0')}', () => {});`);
  }
  await mkdir(path.join(bigDir, 'src'), { recursive: true });
  await writeFile(path.join(bigDir, 'src', 'routes.ts'), routes.join('\n') + '\n');
  assert.equal(run(generate, ['--root', bigDir, '--write'], bigDir).status, 0);

  const readmePath = path.join(bigDir, '.zcode', 'skills', 'verify-demo-app', 'features', 'README.md');
  const initialReadme = await readFile(readmePath, 'utf8');
  await writeFile(readmePath, `${initialReadme}\n## 手工说明\n不要破坏这段备注\n`);

  routes.push("app.get('/api/z-extra-31', () => {});", "app.get('/api/z-extra-32', () => {});");
  await writeFile(path.join(bigDir, 'src', 'routes.ts'), routes.join('\n') + '\n');
  const bigSyncRes = run(generate, ['--root', bigDir, '--write', '--sync'], bigDir);
  assert.equal(bigSyncRes.status, 0, bigSyncRes.stderr);
  const bigSync = JSON.parse(bigSyncRes.stdout);
  assert.ok(bigSync.diff.added.some((n) => n.includes('z-extra-31')), JSON.stringify(bigSync.diff));
  assert.ok(bigSync.diff.added.some((n) => n.includes('z-extra-32')));

  const updatedReadme = await readFile(readmePath, 'utf8');
  const extraIdx = updatedReadme.indexOf('/api/z-extra-32');
  const noteIdx = updatedReadme.indexOf('## 手工说明');
  assert.ok(extraIdx > 0 && noteIdx > extraIdx, 'new table rows must be spliced above trailing notes');
  assert.match(updatedReadme, /不要破坏这段备注/);

  // P2-7, P2-8, P2-9: page+API shared path triggers ambiguousLegacy, compact |ID| stays 5-col, deep route ID bounded <= 72 chars
  const mixDir = await mkdtemp(path.join(tmpdir(), 'kelin-va-mix-'));
  await writeFile(path.join(mixDir, 'package.json'), JSON.stringify({ name: 'mix' }));
  await mkdir(path.join(mixDir, 'app', 'items'), { recursive: true });
  await writeFile(path.join(mixDir, 'app', 'items', 'page.tsx'), 'export default function P() { return null; }\n');
  await mkdir(path.join(mixDir, 'src'), { recursive: true });
  await writeFile(
    path.join(mixDir, 'src', 'r.ts'),
    "app.get('/items', () => {});\napp.get('/' + 'segment/'.repeat(12) + 'leaf', () => {});\napp.get('/very/deep/" + Array.from({ length: 16 }, (_, i) => `seg${i}`).join('/') + "', () => {});\n",
  );
  await mkdir(path.join(mixDir, '.zcode', 'skills', 'verify-mix', 'features'), { recursive: true });
  await writeFile(path.join(mixDir, '.zcode', 'skills', 'verify-mix', 'features', '01-items.md'), '# 页面或接口 /items\nMIX\n');
  await writeFile(path.join(mixDir, '.zcode', 'skills', 'verify-mix', 'features', 'README.md'), '|ID|功能|用户怎么到达|怎么驱动|成功的样子|\n|---|---|---|---|---|\n|old|旧功能|访问 /old|点|ok|\n');
  const mixSync = JSON.parse(run(generate, ['--root', mixDir, '--write', '--sync'], mixDir).stdout);
  assert.equal(mixSync.diff.ambiguousLegacy?.length, 1);
  assert.ok(mixSync.diff.added.every((name) => name.replace(/\.md$/, '').length <= 72));
  const mixReadme = await readFile(path.join(mixDir, '.zcode', 'skills', 'verify-mix', 'features', 'README.md'), 'utf8');
  const newRows = mixReadme.trim().split('\n').slice(3);
  assert.ok(newRows.every((r) => r.split('|').length - 2 === 5), `compact 5-col table must emit 5-col rows: ${mixReadme}`);
});

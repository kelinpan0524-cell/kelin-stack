import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const script = path.resolve(import.meta.dirname, '..', '..', 'kelin-mode', 'scripts', 'mode.mjs');

const run = (args, root) => {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args, '--root', root], { encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.status ?? 1, stdout: `${error.stdout || ''}${error.stderr || ''}` };
  }
};

const artifact = async (root, name, body = 'x\n') => {
  await mkdir(path.join(root, '.kelin'), { recursive: true });
  await writeFile(path.join(root, '.kelin', name), body);
};

test('mode walks every phase and enforces artifacts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kelin-mode-'));

  assert.equal(run(['init', '--mode', 'feature'], root).code, 0);
  assert.equal(run(['advance'], root).code, 0);
  assert.equal(run(['advance'], root).code, 1);

  await artifact(root, 'scope.md');
  assert.equal(run(['advance'], root).code, 0);
  assert.match(run(['status'], root).stdout, /"phase": "design"/);

  assert.equal(run(['advance'], root).code, 1);
  await artifact(root, 'goal.md');
  await artifact(root, 'plan.md');
  assert.equal(run(['advance'], root).code, 0);

  assert.equal(run(['advance'], root).code, 1);
  await artifact(root, 'build.md');
  assert.equal(run(['advance'], root).code, 0);

  await artifact(root, 'verify.json', '{}\n');
  await artifact(root, 'acceptance.json', '{"ok": false}\n');
  assert.equal(run(['advance'], root).code, 1);
  await artifact(root, 'acceptance.json', '{"ok": true}\n');
  assert.equal(run(['advance'], root).code, 0);

  await artifact(root, 'review.md');
  assert.equal(run(['advance'], root).code, 0);
  assert.match(run(['status'], root).stdout, /"phase": "refine"/);

  await artifact(root, 'refine.md');
  assert.equal(run(['advance'], root).code, 1, 'refine must rerun acceptance before ship');
  await artifact(root, 'acceptance.json', '{"ok": false}\n');
  assert.equal(run(['advance'], root).code, 1, 'refine must reject ok:false acceptance');
  await artifact(root, 'acceptance.json', '{"ok": true}\n');
  assert.equal(run(['advance'], root).code, 0);
  assert.match(run(['status'], root).stdout, /"phase": "ship"/);

  await artifact(root, 'ship.md');
  assert.equal(run(['advance'], root).code, 0);
  assert.match(run(['status'], root).stdout, /"phase": "reflect"/);

  await artifact(root, 'reflect.md');
  assert.equal(run(['advance'], root).code, 0);
  assert.match(run(['status'], root).stdout, /"phase": "done"/);
  assert.equal(run(['advance'], root).code, 1);

  const state = JSON.parse(await readFile(path.join(root, '.kelin', 'state.json'), 'utf8'));
  assert.equal(state.history.length, 10);
});

test('legacy mode requires a feature map instead of scope', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kelin-mode-legacy-'));
  assert.equal(run(['init', '--mode', 'legacy'], root).code, 0);
  assert.equal(run(['advance'], root).code, 0);
  await artifact(root, 'scope.md');
  assert.equal(run(['advance'], root).code, 1);
  await artifact(root, 'feature-map.json', '{}\n');
  assert.equal(run(['advance'], root).code, 0);
});

test('light mode skips map and review', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kelin-mode-light-'));
  assert.equal(run(['init', '--mode', 'light'], root).code, 0);
  assert.equal(run(['advance'], root).code, 0);
  assert.match(run(['status'], root).stdout, /"phase": "design"/);
  await artifact(root, 'goal.md');
  await artifact(root, 'plan.md');
  assert.equal(run(['advance'], root).code, 0);
  await artifact(root, 'build.md');
  assert.equal(run(['advance'], root).code, 0);
  await artifact(root, 'verify.json');
  await artifact(root, 'acceptance.json', '{"ok": true}\n');
  assert.equal(run(['advance'], root).code, 0);
  await artifact(root, 'ship.md');
  assert.equal(run(['advance'], root).code, 0);
  await artifact(root, 'reflect.md');
  assert.equal(run(['advance'], root).code, 0);
  assert.match(run(['status'], root).stdout, /"phase": "done"/);
  const state = JSON.parse(await readFile(path.join(root, '.kelin', 'state.json'), 'utf8'));
  assert.equal(state.history.length, 7);
});

test('init rejects a second run and an unknown mode', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kelin-mode-'));
  assert.equal(run(['init', '--mode', 'feature'], root).code, 0);
  assert.equal(run(['init', '--mode', 'feature'], root).code, 1);
  const other = await mkdtemp(path.join(tmpdir(), 'kelin-mode-'));
  assert.equal(run(['init', '--mode', 'nope'], other).code, 2);
});

test('rewind moves one phase back and records the reason', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kelin-mode-rewind-'));
  assert.equal(run(['init', '--mode', 'feature'], root).code, 0);
  assert.equal(run(['advance'], root).code, 0);
  assert.match(run(['status'], root).stdout, /"phase": "map"/);
  assert.equal(run(['rewind'], root).code, 2);
  assert.equal(run(['rewind', '--reason', 'recheck scope'], root).code, 0);
  assert.match(run(['status'], root).stdout, /"phase": "intake"/);
  const state = JSON.parse(await readFile(path.join(root, '.kelin', 'state.json'), 'utf8'));
  assert.equal(state.history.at(-1).rewind, 'recheck scope');
});

test('audit mode follows read-only track and enforces coverage declaration', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kelin-mode-audit-'));
  assert.equal(run(['init', '--mode', 'audit'], root).code, 0);
  assert.equal(run(['advance'], root).code, 0);
  assert.match(run(['status'], root).stdout, /"phase": "map"/);
  await artifact(root, 'feature-map.json', '{}\n');
  assert.equal(run(['advance'], root).code, 0);
  assert.match(run(['status'], root).stdout, /"phase": "audit"/);

  await artifact(root, 'audit.md', '# Bad audit\n');
  assert.equal(run(['advance'], root).code, 1, 'audit without coverage declaration must be blocked');

  await artifact(
    root,
    'audit.md',
    '# Audit\n\n## 覆盖声明\n| 面 | 状态 | 范围 |\n| --- | --- | --- |\n| 正确性 | 已审 | src/a.mjs |\n',
  );
  assert.equal(run(['advance'], root).code, 0);
  assert.match(run(['status'], root).stdout, /"phase": "reflect"/);
  await artifact(root, 'reflect.md');
  assert.equal(run(['advance'], root).code, 0);
  assert.match(run(['status'], root).stdout, /"phase": "done"/);
});

test('mode verify rejects stale acceptance receipts when verify.json or worktree changes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kelin-mode-stale-'));
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 'm@example.invalid']);
  git(['config', 'user.name', 'm']);
  await writeFile(path.join(root, '.gitignore'), '.kelin/\n');
  await writeFile(path.join(root, 'app.mjs'), 'export const x = 1;\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'base']);

  assert.equal(run(['init', '--mode', 'light'], root).code, 0);
  assert.equal(run(['advance'], root).code, 0);
  await artifact(root, 'goal.md');
  await artifact(root, 'plan.md');
  assert.equal(run(['advance'], root).code, 0);
  await artifact(root, 'build.md');
  assert.equal(run(['advance'], root).code, 0);

  const runAcc = path.resolve(import.meta.dirname, '..', '..', 'kelin-verify', 'scripts', 'run-acceptance.mjs');
  const specFile = path.join(root, '.kelin', 'verify.json');
  await writeFile(specFile, JSON.stringify({ checks: [{ id: 'c1', cmd: 'node -e "process.exit(0)"' }] }));
  const accOut = execFileSync(process.execPath, [runAcc, specFile, '--json'], { cwd: root, encoding: 'utf8' });
  await writeFile(path.join(root, '.kelin', 'acceptance.json'), accOut);

  await writeFile(path.join(root, 'app.mjs'), 'export const x = 2;\n');
  const staleTree = run(['advance'], root);
  assert.equal(staleTree.code, 1);
  assert.match(staleTree.stdout, /worktree changed/);

  await writeFile(path.join(root, 'app.mjs'), 'export const x = 1;\n');
  await writeFile(specFile, JSON.stringify({ checks: [{ id: 'c1', cmd: 'node -e "process.exit(0)"' }, { id: 'c2', cmd: 'true' }] }));
  const staleSpec = run(['advance'], root);
  assert.equal(staleSpec.code, 1);
  assert.match(staleSpec.stdout, /verify\.json changed/);
});

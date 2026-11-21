import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hashTree, sha256 } from '../scripts/io.mjs';
import { publish } from '../scripts/verify-stack.mjs';

const releaseScript = path.resolve(import.meta.dirname, '..', '..', 'kelin-release', 'scripts', 'release.mjs');

const initPluginGitRepo = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kelin-pub-'));
  const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'pub@example.invalid']);
  git(['config', 'user.name', 'pub']);
  await mkdir(path.join(dir, '.zcode-plugin'), { recursive: true });
  await writeFile(path.join(dir, '.zcode-plugin', 'plugin.json'), JSON.stringify({ name: 'demo', version: '0.1.0' }, null, 2));
  git(['add', '-A']);
  git(['commit', '-qm', 'init']);
  const head = git(['rev-parse', 'HEAD']);
  return { dir, head, git };
};

test('verify-stack publish binds gitHead, treeHash, and --require-live', async () => {
  const { dir, head, git } = await initPluginGitRepo();
  const runDir = await mkdtemp(path.join(tmpdir(), 'kelin-run-'));
  const tree = await hashTree(dir);
  const staticArtifact = path.join(runDir, 'static', 'zcode-manifest.json');
  await mkdir(path.dirname(staticArtifact), { recursive: true });
  const body = '{"ok":true}\n';
  await writeFile(staticArtifact, body);
  await writeFile(path.join(runDir, 'gate.md'), '## gate\nPASS\n');

  const receipt = {
    ok: true,
    verificationLevel: 'static',
    plugin: { root: dir, gitHead: head, treeHash: tree.hash, treeHashAfter: tree.hash },
    observations: [
      {
        feature: 'zcode:manifest',
        kind: 'static',
        ok: true,
        artifacts: [{ path: 'static/zcode-manifest.json', sha256: sha256(body) }],
      },
    ],
  };
  await writeFile(path.join(runDir, 'receipt.json'), JSON.stringify(receipt, null, 2));

  await assert.rejects(
    () => publish({ confirm: true, repo: 'o/r', pr: 1, run: runDir, requireLive: true }),
    /static-only/,
  );

  await assert.rejects(
    () => publish({ confirm: true, repo: 'o/r', pr: 1, run: runDir, sha: '0'.repeat(40) }),
    /refusing to publish on/,
  );

  await writeFile(path.join(dir, 'extra.txt'), 'mutated\n');
  await assert.rejects(
    () => publish({ confirm: true, repo: 'o/r', pr: 1, run: runDir }),
    /Plugin tree changed/,
  );

  git(['clean', '-fdq']);
  await writeFile(
    path.join(runDir, 'receipt.json'),
    JSON.stringify({ ...receipt, plugin: { ...receipt.plugin, treeHashAfter: 'b'.repeat(64) } }),
  );
  await assert.rejects(
    () => publish({ confirm: true, repo: 'o/r', pr: 1, run: runDir }),
    /inconsistent/,
  );
});

test('release.mjs blocks wrong branch and stale receipt before touching manifests', async () => {
  const { dir, head, git } = await initPluginGitRepo();
  git(['checkout', '-qb', 'feat/work']);
  const receiptFile = path.join(dir, 'receipt.json');
  await writeFile(receiptFile, JSON.stringify({ ok: true, plugin: { gitHead: 'a'.repeat(40), treeHash: 'x', treeHashAfter: 'x' } }));
  git(['add', 'receipt.json']);
  git(['commit', '-qm', 'add receipt']);

  const wrongBranch = spawnSync(
    process.execPath,
    [releaseScript, '--root', dir, '--bump', 'patch', '--publish', '--confirm'],
    { encoding: 'utf8' },
  );
  assert.equal(wrongBranch.status, 1);
  assert.match(wrongBranch.stderr, /Refusing release on branch feat\/work/);

  const staleReceipt = spawnSync(
    process.execPath,
    [releaseScript, '--root', dir, '--bump', 'patch', '--allow-branch', '--receipt', receiptFile, '--publish', '--confirm'],
    { encoding: 'utf8' },
  );
  assert.equal(staleReceipt.status, 1);
  assert.match(staleReceipt.stderr, /Receipt check failed/);

  const dryPlan = spawnSync(
    process.execPath,
    [releaseScript, '--root', dir, '--bump', 'patch', '--receipt', receiptFile],
    { encoding: 'utf8' },
  );
  assert.equal(dryPlan.status, 0);
  const plan = JSON.parse(dryPlan.stdout);
  assert.equal(plan.gates.branchAllowed, false);
  assert.equal(plan.gates.receipt.ok, false);
  assert.notEqual(plan.head, head);
});

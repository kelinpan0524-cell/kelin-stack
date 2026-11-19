import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repo = path.resolve(import.meta.dirname, '..', '..', '..');
const installer = path.join(repo, 'install.sh');

test('Antigravity native plugin manifest, hooks.json, rules, and logo are present and consistent', () => {
  const agy = JSON.parse(readFileSync(path.join(repo, '.antigravity-plugin', 'plugin.json'), 'utf8'));
  const zcode = JSON.parse(readFileSync(path.join(repo, '.zcode-plugin', 'plugin.json'), 'utf8'));
  const claude = JSON.parse(readFileSync(path.join(repo, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(agy.name, 'kelin-stack');
  assert.equal(agy.version, zcode.version);
  assert.equal(agy.version, claude.version);
  assert.ok(agy.logo && existsSync(path.join(repo, agy.logo)));
  assert.ok(Array.isArray(agy.suggestedPrompts) && agy.suggestedPrompts.length === 3);

  const allowedKeys = new Set(['name', 'displayName', 'version', 'description', 'logo', 'author', 'homepage', 'repository', 'suggestedPrompts', 'disabled']);
  for (const key of Object.keys(agy)) {
    assert.ok(allowedKeys.has(key), `unexpected top-level manifest key: ${key}`);
  }

  const hooks = JSON.parse(readFileSync(path.join(repo, 'hooks.json'), 'utf8'));
  assert.ok(Array.isArray(hooks['kelin-session-start']?.SessionStart));
  assert.ok(Array.isArray(hooks['kelin-safety']?.PreToolUse));
  assert.ok(existsSync(path.join(repo, 'rules', 'AGENTS.md')));
});

test('install.sh installs clean Antigravity plugin, guards foreign dirs, and uninstalls cleanly', async () => {
  const fakeHome = await mkdtemp(path.join(tmpdir(), 'kelin-agy-home-'));
  try {
    const env = { ...process.env, HOME: fakeHome };
    const pluginDir = path.join(fakeHome, '.gemini', 'config', 'plugins', 'kelin-stack');

    const dry = spawnSync('bash', [installer, '--host', 'antigravity', '--scope', 'user', '--dry-run'], { encoding: 'utf8', env });
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(existsSync(pluginDir), false);

    const sym = spawnSync('bash', [installer, '--host', 'antigravity', '--scope', 'user', '--symlink'], { encoding: 'utf8', env });
    assert.equal(sym.status, 2);

    const installed = spawnSync('bash', [installer, '--host', 'antigravity', '--scope', 'user'], { encoding: 'utf8', env });
    assert.equal(installed.status, 0, installed.stdout + installed.stderr);
    assert.equal(existsSync(path.join(pluginDir, '.antigravity-plugin', 'plugin.json')), true);
    assert.equal(existsSync(path.join(pluginDir, 'hooks.json')), true);
    assert.equal(existsSync(path.join(pluginDir, 'rules', 'AGENTS.md')), true);
    assert.equal(existsSync(path.join(pluginDir, 'assets', 'logo.svg')), true);
    assert.equal(existsSync(path.join(pluginDir, 'skills', 'kelin-mode', 'SKILL.md')), true);
    assert.equal(existsSync(path.join(pluginDir, 'agents', 'kelin-reviewer.md')), true);
    assert.equal(existsSync(path.join(pluginDir, '.git')), false);
    assert.equal(existsSync(path.join(pluginDir, 'hooks', 'hooks.json')), false);

    const hasAgy = spawnSync('which', ['agy'], { encoding: 'utf8' }).status === 0;
    if (hasAgy) {
      const validated = spawnSync('agy', ['plugin', 'validate', pluginDir, '--strict', '--json'], { encoding: 'utf8', env });
      assert.equal(validated.status, 0, validated.stdout + validated.stderr);
      const report = JSON.parse(validated.stdout);
      assert.equal(report.findings?.length ?? 0, 0, JSON.stringify(report.findings));
      assert.equal(report.components?.agents, 3);
      assert.equal(report.components?.hooks, 2);
      assert.equal(report.components?.rules, 1);
      assert.ok((report.components?.skills ?? 0) >= 40);
    }

    const reinstall = spawnSync('bash', [installer, '--host', 'antigravity', '--scope', 'user'], { encoding: 'utf8', env });
    assert.equal(reinstall.status, 0, reinstall.stdout + reinstall.stderr);

    const uninstall = spawnSync('bash', [installer, '--host', 'antigravity', '--scope', 'user', '--uninstall'], { encoding: 'utf8', env });
    assert.equal(uninstall.status, 0, uninstall.stdout + uninstall.stderr);
    assert.equal(existsSync(pluginDir), false);

    await mkdir(pluginDir, { recursive: true });
    await writeFile(path.join(pluginDir, 'custom.txt'), 'foreign\n');
    const refused = spawnSync('bash', [installer, '--host', 'antigravity', '--scope', 'user'], { encoding: 'utf8', env });
    assert.equal(refused.status, 1);
    assert.equal(existsSync(path.join(pluginDir, 'custom.txt')), true);

    const subset = spawnSync('bash', [installer, '--host', 'antigravity', '--scope', 'user', '--subset', 'kelin-mode,kelin-neat'], { encoding: 'utf8', env });
    assert.equal(subset.status, 0, subset.stdout + subset.stderr);
    assert.equal(existsSync(path.join(fakeHome, '.gemini', 'config', 'skills', 'kelin-mode', 'SKILL.md')), true);
    assert.equal(existsSync(path.join(fakeHome, '.gemini', 'config', 'skills', 'kelin-neat', 'SKILL.md')), true);
  } finally {
    await rm(fakeHome, { recursive: true, force: true });
  }
});

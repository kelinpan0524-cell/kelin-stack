import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { classify, validateRegistry } from '../scripts/core.mjs';

const repo = path.resolve(import.meta.dirname, '..', '..', '..');
const installer = path.join(repo, 'install.sh');

test('Antigravity native plugin manifest, hooks.json, rules, logo, and classify mapping are consistent', () => {
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
  assert.ok(hooks['kelin-session-start']?.SessionStart?.length > 0);
  assert.ok(hooks['kelin-session-start'].SessionStart[0].command.includes('hooks/session-start.mjs'));
  assert.ok(hooks['kelin-safety']?.PreToolUse?.[0]?.hooks?.length > 0);
  assert.ok(hooks['kelin-safety'].PreToolUse[0].hooks[0].command.includes('hooks/pre-tool-use.mjs'));
  assert.ok(existsSync(path.join(repo, 'rules', 'AGENTS.md')));

  const registry = validateRegistry(JSON.parse(readFileSync(path.join(repo, 'skills', 'kelin-verify-stack', 'features', 'registry.json'), 'utf8')));
  const mapped = classify({ paths: ['rules/AGENTS.md', 'install.sh'], registry });
  assert.equal(mapped.noRuntime, false);
  assert.deepEqual(mapped.features, ['zcode:tools']);
});

test('install.sh installs clean Antigravity plugin, guards unsafe targets, handles legacy & symlink uninstall', async () => {
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
    assert.equal(existsSync(path.join(pluginDir, 'docs', 'skills.md')), true);
    assert.equal(existsSync(path.join(pluginDir, 'docs', 'support-matrix.md')), true);
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

    // Foreign dir without manifest -> refused
    await mkdir(pluginDir, { recursive: true });
    await writeFile(path.join(pluginDir, 'custom.txt'), 'foreign\n');
    assert.equal(spawnSync('bash', [installer, '--host', 'antigravity', '--scope', 'user'], { encoding: 'utf8', env }).status, 1);

    // Corrupt manifest -> refused
    await writeFile(path.join(pluginDir, '.kelin-install.json'), '{broken');
    assert.equal(spawnSync('bash', [installer, '--host', 'antigravity', '--scope', 'user'], { encoding: 'utf8', env }).status, 1);

    // Wrong mode manifest -> refused
    await writeFile(path.join(pluginDir, '.kelin-install.json'), JSON.stringify({ mode: 'other' }));
    assert.equal(spawnSync('bash', [installer, '--host', 'antigravity', '--scope', 'user'], { encoding: 'utf8', env }).status, 1);
    await rm(pluginDir, { recursive: true, force: true });

    // Symlink pointing to another dir with valid manifest -> refused without touching target
    const decoy = path.join(fakeHome, 'decoy-dir');
    await mkdir(decoy, { recursive: true });
    await writeFile(path.join(decoy, '.kelin-install.json'), JSON.stringify({ mode: 'antigravity-plugin' }));
    await writeFile(path.join(decoy, 'keep.txt'), 'safe\n');
    await symlink(decoy, pluginDir);
    assert.equal(spawnSync('bash', [installer, '--host', 'antigravity', '--scope', 'user'], { encoding: 'utf8', env }).status, 1);
    assert.equal(existsSync(path.join(decoy, 'keep.txt')), true);
    await rm(pluginDir, { force: true });

    // Legacy ~/.gemini/antigravity-cli/skills uninstall
    const legacyDir = path.join(fakeHome, '.gemini', 'antigravity-cli', 'skills');
    await mkdir(path.join(legacyDir, 'kelin-mode'), { recursive: true });
    await writeFile(path.join(legacyDir, '.kelin-install.json'), JSON.stringify({ entries: ['kelin-mode'] }));
    const legacyUninstall = spawnSync('bash', [installer, '--host', 'antigravity', '--scope', 'user', '--uninstall'], { encoding: 'utf8', env });
    assert.equal(legacyUninstall.status, 0, legacyUninstall.stdout + legacyUninstall.stderr);
    assert.equal(existsSync(path.join(legacyDir, 'kelin-mode')), false);
    assert.equal(existsSync(path.join(legacyDir, '.kelin-install.json')), false);

    // Symlink subset install & uninstall removes symlink without touching source
    const subsetSym = spawnSync('bash', [installer, '--host', 'antigravity', '--scope', 'user', '--subset', 'kelin-mode,kelin-neat', '--symlink'], { encoding: 'utf8', env });
    assert.equal(subsetSym.status, 0, subsetSym.stdout + subsetSym.stderr);
    const linkPath = path.join(fakeHome, '.gemini', 'config', 'skills', 'kelin-mode');
    assert.equal(lstatSync(linkPath).isSymbolicLink(), true);
    const subsetUninstall = spawnSync('bash', [installer, '--host', 'antigravity', '--scope', 'user', '--uninstall'], { encoding: 'utf8', env });
    assert.equal(subsetUninstall.status, 0, subsetUninstall.stdout + subsetUninstall.stderr);
    assert.equal(existsSync(linkPath), false);
    assert.equal(existsSync(path.join(repo, 'skills', 'kelin-mode', 'SKILL.md')), true);
  } finally {
    await rm(fakeHome, { recursive: true, force: true });
  }
});

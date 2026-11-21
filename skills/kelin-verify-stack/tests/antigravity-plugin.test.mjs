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

    // Failed atomic swap leaves existing plugin intact and cleans up lock/stage
    const swapFail = spawnSync('bash', [installer, '--host', 'antigravity', '--scope', 'user'], {
      encoding: 'utf8',
      env: { ...env, KELIN_INSTALL_SIMULATE_SWAP_FAIL: '1' },
    });
    assert.notEqual(swapFail.status, 0);
    assert.equal(existsSync(path.join(pluginDir, '.antigravity-plugin', 'plugin.json')), true);
    const recover = spawnSync('bash', [installer, '--host', 'antigravity', '--scope', 'user'], { encoding: 'utf8', env });
    assert.equal(recover.status, 0, recover.stdout + recover.stderr);

    // --clean-legacy removes legacy antigravity-cli/skills WITHOUT removing new native plugin
    const legacyDirKeep = path.join(fakeHome, '.gemini', 'antigravity-cli', 'skills');
    await mkdir(path.join(legacyDirKeep, 'kelin-mode'), { recursive: true });
    await writeFile(path.join(legacyDirKeep, '.kelin-install.json'), JSON.stringify({ entries: ['kelin-mode'] }));
    const cleanLegacy = spawnSync('bash', [installer, '--host', 'antigravity', '--scope', 'user', '--clean-legacy'], { encoding: 'utf8', env });
    assert.equal(cleanLegacy.status, 0, cleanLegacy.stdout + cleanLegacy.stderr);
    assert.equal(existsSync(path.join(legacyDirKeep, 'kelin-mode')), false);
    assert.equal(existsSync(path.join(pluginDir, '.antigravity-plugin', 'plugin.json')), true);

    // Symlink lock file must be refused without truncating target on both install and uninstall
    const lockTarget = path.join(fakeHome, 'precious.txt');
    const lockPath = path.join(fakeHome, '.gemini', 'config', 'plugins', '.kelin-stack.lock');
    await writeFile(lockTarget, 'precious\n');
    await rm(lockPath, { force: true });
    await symlink(lockTarget, lockPath);
    assert.notEqual(spawnSync('bash', [installer, '--host', 'antigravity', '--scope', 'user'], { encoding: 'utf8', env }).status, 0);
    assert.equal(readFileSync(lockTarget, 'utf8'), 'precious\n');
    assert.notEqual(spawnSync('bash', [installer, '--host', 'antigravity', '--scope', 'user', '--uninstall'], { encoding: 'utf8', env }).status, 0);
    assert.equal(readFileSync(lockTarget, 'utf8'), 'precious\n');
    await rm(lockPath, { force: true });

    const uninstall = spawnSync('bash', [installer, '--host', 'antigravity', '--scope', 'user', '--uninstall'], { encoding: 'utf8', env });
    assert.equal(uninstall.status, 0, uninstall.stdout + uninstall.stderr);
    assert.equal(existsSync(pluginDir), false);

    // Corrupt skills manifest must fail uninstall (never report success)
    const brokenSkills = path.join(fakeHome, '.gemini', 'config', 'skills');
    await mkdir(brokenSkills, { recursive: true });
    await writeFile(path.join(brokenSkills, '.kelin-install.json'), '{broken');
    const brokenUninstall = spawnSync('bash', [installer, '--host', 'antigravity', '--scope', 'user', '--uninstall'], { encoding: 'utf8', env });
    assert.notEqual(brokenUninstall.status, 0);
    await rm(path.join(brokenSkills, '.kelin-install.json'), { force: true });

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
    // Subset install resolves runtime deps so kelin-mode works directly under --symlink too
    const subsetProj = path.join(fakeHome, 'subset-proj');
    await mkdir(subsetProj, { recursive: true });
    const modeSub = spawnSync(process.execPath, [path.join(linkPath, 'scripts', 'mode.mjs'), 'init', '--mode', 'light', '--root', subsetProj], { encoding: 'utf8', env });
    assert.equal(modeSub.status, 0, modeSub.stdout + modeSub.stderr);
    assert.match(modeSub.stdout, /"phase": "intake"/);
    const subsetUninstall = spawnSync('bash', [installer, '--host', 'antigravity', '--scope', 'user', '--uninstall'], { encoding: 'utf8', env });
    assert.equal(subsetUninstall.status, 0, subsetUninstall.stdout + subsetUninstall.stderr);
    assert.equal(existsSync(linkPath), false);
    assert.equal(existsSync(path.join(repo, 'skills', 'kelin-mode', 'SKILL.md')), true);

    // Copied --subset kelin-review and kelin-release/kelin-mode resolves transitive runtime deps cleanly
    const copySub = spawnSync('bash', [installer, '--host', 'codex', '--scope', 'project', '--path', fakeHome, '--subset', 'kelin-review,kelin-mode'], { encoding: 'utf8', env });
    assert.equal(copySub.status, 0, copySub.stdout + copySub.stderr);
    const copiedSkillsDir = path.join(fakeHome, '.agents', 'skills');
    assert.equal(spawnSync(process.execPath, [path.join(copiedSkillsDir, 'kelin-review', 'scripts', 'gate-scan.mjs'), '--help'], { encoding: 'utf8' }).status, 2);
    assert.equal(spawnSync(process.execPath, [path.join(copiedSkillsDir, 'kelin-review', 'scripts', 'review-check.mjs'), '--help'], { encoding: 'utf8' }).status, 2);
    const routedCopy = spawnSync(process.execPath, [path.join(copiedSkillsDir, 'kelin-mode', 'scripts', 'mode.mjs'), 'route', '--task', '修 bug', '--root', fakeHome], { encoding: 'utf8' });
    assert.equal(routedCopy.status, 0, routedCopy.stderr);
    assert.equal(JSON.parse(routedCopy.stdout).mode, 'fix');

    // --subset kelin-verify-stack includes kelin-plan so plan_valid runs inside copied subset
    const vsSubset = spawnSync('bash', [installer, '--host', 'codex', '--scope', 'project', '--path', fakeHome, '--subset', 'kelin-verify-stack'], { encoding: 'utf8', env });
    assert.equal(vsSubset.status, 0, vsSubset.stdout + vsSubset.stderr);
    assert.equal(existsSync(path.join(copiedSkillsDir, 'kelin-plan', 'scripts', 'check-plan.mjs')), true);
  } finally {
    await rm(fakeHome, { recursive: true, force: true });
  }
});

test('verify-stack smoke passes for antigravity and codex and rejects invalid host', () => {
  const verifyStack = path.join(repo, 'skills', 'kelin-verify-stack', 'scripts', 'verify-stack.mjs');
  for (const host of ['antigravity', 'codex']) {
    const res = spawnSync(process.execPath, [verifyStack, 'smoke', '--host', host], { encoding: 'utf8' });
    assert.equal(res.status, 0, `${host} smoke failed:\n${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, new RegExp(`PASS smoke:${host}`));
  }
  const bad = spawnSync(process.execPath, [verifyStack, 'smoke', '--host', 'foo'], { encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
});

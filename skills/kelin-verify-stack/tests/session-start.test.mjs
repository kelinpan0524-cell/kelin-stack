import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repo = path.resolve(import.meta.dirname, '..', '..', '..');
const hook = path.join(repo, 'hooks', 'session-start.mjs');
const version = JSON.parse(readFileSync(path.join(repo, '.zcode-plugin', 'plugin.json'), 'utf8')).version;

const run = (payload, env) => spawnSync(process.execPath, [hook], {
  encoding: 'utf8',
  input: JSON.stringify(payload),
  env: { ...process.env, ZCODE_PLUGIN_ROOT: repo, ...env },
});

test('SessionStart injects activation, current state and local verify skills', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kelin-session-'));
  await mkdir(path.join(dir, '.kelin'), { recursive: true });
  await mkdir(path.join(dir, '.zcode', 'skills', 'verify-demo'), { recursive: true });
  await writeFile(path.join(dir, '.kelin', 'state.json'), JSON.stringify({ mode: 'feature', phase: 'build' }));
  await writeFile(path.join(dir, '.zcode', 'skills', 'verify-demo', 'SKILL.md'), '---\nname: verify-demo\ndescription: demo\n---\n');

  const result = run({ hook_event_name: 'SessionStart', source: 'startup' }, { ZCODE_PROJECT_DIR: dir });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.hookSpecificOutput.hookEventName, 'SessionStart');
  const context = payload.hookSpecificOutput.additionalContext;
  assert.match(context, new RegExp(version.replace(/\./g, '\\.')));
  assert.match(context, /kelin-mode/);
  assert.match(context, /mode=feature phase=build/);
  assert.match(context, /verify-demo/);
  assert.match(context, /不需要点名/);
});

test('SessionStart still activates without a state file', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kelin-session-empty-'));
  const result = run({ hook_event_name: 'SessionStart' }, { ZCODE_PROJECT_DIR: dir });
  assert.equal(result.status, 0, result.stderr);
  const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /未初始化/);
  assert.match(context, /未发现 verify-/);
});

test('SessionStart ignores invalid input', () => {
  const result = spawnSync(process.execPath, [hook], { encoding: 'utf8', input: 'not json', env: { ...process.env, ZCODE_PLUGIN_ROOT: repo } });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

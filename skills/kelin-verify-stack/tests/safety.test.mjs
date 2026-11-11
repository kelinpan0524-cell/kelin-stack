import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { decide } from '../../kelin-safety/scripts/check-command.mjs';

const hook = path.resolve(import.meta.dirname, '..', '..', '..', 'hooks', 'pre-tool-use.mjs');
const freeze = path.resolve(import.meta.dirname, '..', '..', 'kelin-safety', 'scripts', 'freeze.mjs');

const runHook = (payload, env = {}) => spawnSync(process.execPath, [hook], {
  encoding: 'utf8',
  input: JSON.stringify(payload),
  env: { ...process.env, ...env },
});

test('decide blocks catastrophic deletes and force pushes to the default branch', () => {
  assert.equal(decide('rm -rf /').decision, 'deny');
  assert.equal(decide('sudo rm -rf -- /').decision, 'deny');
  assert.equal(decide('rm -rf ~').decision, 'deny');
  assert.equal(decide('rm -rf $HOME').decision, 'deny');
  assert.equal(decide('rm -rf "/"').decision, 'deny');
  assert.equal(decide("rm -rf '/'").decision, 'deny');
  assert.equal(decide('find / -delete').decision, 'deny');
  assert.equal(decide('git push --force origin main').decision, 'deny');
  assert.equal(decide('git push origin +main').decision, 'deny');
  assert.equal(decide('git push --mirror origin').decision, 'deny');
  assert.equal(decide('chmod -R 777 /').decision, 'deny');
});

test('decide allows safe build deletes and asks for risky ones', () => {
  assert.equal(decide('rm -rf node_modules').decision, 'allow');
  assert.equal(decide('rm -rf .next dist coverage').decision, 'allow');
  assert.equal(decide('rm -rf src/build-output').decision, 'ask');
  assert.equal(decide('find . -name "*.log" -delete').decision, 'ask');
  assert.equal(decide('echo x | xargs rm -rf').decision, 'ask');
  assert.equal(decide('git push -f origin feature/x').decision, 'ask');
  assert.equal(decide('git push origin +feature/x').decision, 'ask');
  assert.equal(decide('git reset --hard').decision, 'ask');
  assert.equal(decide('git clean -fdx').decision, 'ask');
  assert.equal(decide('echo "rm -rf /"').decision, 'allow');
});

test('hook emits a deny decision and stays silent on allow', () => {
  const denied = runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf /' } });
  assert.equal(denied.status, 0);
  const payload = JSON.parse(denied.stdout);
  assert.equal(payload.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(payload.hookSpecificOutput.permissionDecisionReason, /recursive delete/);

  const allowed = runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls -la' } });
  assert.equal(allowed.status, 0);
  assert.equal(allowed.stdout, '');
});

test('freeze blocks writes outside the allowed roots and clear lifts it', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kelin-freeze-'));
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await mkdir(path.join(dir, 'docs'), { recursive: true });

  const set = spawnSync(process.execPath, [freeze, 'set', 'src', '--root', dir], { encoding: 'utf8' });
  assert.equal(set.status, 0, set.stderr);

  const inside = runHook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(dir, 'src/a.ts') } }, { ZCODE_PROJECT_DIR: dir });
  assert.equal(inside.status, 0);
  assert.equal(inside.stdout, '');

  const outside = runHook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(dir, 'docs/b.md') } }, { ZCODE_PROJECT_DIR: dir });
  assert.equal(outside.status, 0);
  assert.equal(JSON.parse(outside.stdout).hookSpecificOutput.permissionDecision, 'deny');

  const clear = spawnSync(process.execPath, [freeze, 'clear', '--root', dir], { encoding: 'utf8' });
  assert.equal(clear.status, 0, clear.stderr);
  const after = runHook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(dir, 'docs/b.md') } }, { ZCODE_PROJECT_DIR: dir });
  assert.equal(after.stdout, '');
});

test('a corrupt freeze file fails closed', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kelin-freeze-broken-'));
  await mkdir(path.join(dir, '.kelin'), { recursive: true });
  await writeFile(path.join(dir, '.kelin', 'freeze.json'), '{broken');
  const result = runHook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(dir, 'a.ts') } }, { ZCODE_PROJECT_DIR: dir });
  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(payload.hookSpecificOutput.permissionDecisionReason, /unreadable/);
});

test('freeze blocks bash redirection outside the allowed roots', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kelin-freeze-bash-'));
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await mkdir(path.join(dir, 'docs'), { recursive: true });
  spawnSync(process.execPath, [freeze, 'set', 'src', '--root', dir], { encoding: 'utf8' });

  const blocked = runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo x > docs/b.md' } }, { ZCODE_PROJECT_DIR: dir });
  assert.equal(JSON.parse(blocked.stdout).hookSpecificOutput.permissionDecision, 'deny');

  const allowed = runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo x > src/a.ts' } }, { ZCODE_PROJECT_DIR: dir });
  assert.equal(allowed.stdout, '');

  const devnull = runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo x > /dev/null' } }, { ZCODE_PROJECT_DIR: dir });
  assert.equal(devnull.stdout, '');
});

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { decide, redirectTargets } from '../../kelin-safety/scripts/check-command.mjs';

const hook = path.resolve(import.meta.dirname, '..', '..', '..', 'hooks', 'pre-tool-use.mjs');
const freeze = path.resolve(import.meta.dirname, '..', '..', 'kelin-safety', 'scripts', 'freeze.mjs');

const runHook = (payload, env = {}) => spawnSync(process.execPath, [hook], {
  encoding: 'utf8',
  input: JSON.stringify(payload),
  env: { ...process.env, KELIN_SAFETY: 'strict', ...env },
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

test('wrappers do not bypass safety decisions', () => {
  assert.equal(decide('sh -c "rm -rf /"').decision, 'deny');
  assert.equal(decide('git -C /some/dir push --force origin main').decision, 'deny');
  assert.equal(decide('rm -rf /tmp/build-cache').decision, 'allow');
});

test('deny always takes precedence over an earlier ask in compound commands', () => {
  assert.equal(decide('rm -rf src/build-output && rm -rf /').decision, 'deny');
  assert.equal(decide('git reset --hard && chmod -R 777 /').decision, 'deny');
  assert.equal(decide('rm -rf src/build-output && git push --force origin main').decision, 'deny');
  assert.equal(decide('echo ok\nrm -rf /').decision, 'deny');
  assert.equal(decide('printf ok\ngit push --force origin main').decision, 'deny');
  assert.equal(decide('echo ok\ngit reset --hard\nchmod -R 777 /').decision, 'deny');
  assert.equal(decide('cat <<< hi\nrm -rf /').decision, 'deny');
  assert.equal(decide('# cat <<EOF\nrm -rf /').decision, 'deny');
});

const runAgyHook = (payload, env = {}) => {
  const clean = { ...process.env, ...env };
  delete clean.ZCODE_PLUGIN_ROOT;
  delete clean.ZCODE_PROJECT_DIR;
  return spawnSync(process.execPath, [hook, '--host', 'antigravity'], {
    encoding: 'utf8',
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    env: clean,
  });
};

test('antigravity PreToolUse maps off/allow to ask (defer), risky to force_ask, catastrophic to deny', () => {
  const off = runAgyHook(
    { hookEventName: 'PreToolUse', toolCall: { name: 'run_command', args: { CommandLine: 'rm -rf /' } } },
    { KELIN_SAFETY: 'off' },
  );
  assert.equal(off.status, 0);
  assert.deepEqual(JSON.parse(off.stdout), { decision: 'ask' });

  const safe = runAgyHook(
    { hookEventName: 'PreToolUse', toolCall: { name: 'run_command', args: { CommandLine: 'ls -la' } } },
    { KELIN_SAFETY: 'strict' },
  );
  assert.equal(safe.status, 0);
  assert.deepEqual(JSON.parse(safe.stdout), { decision: 'ask' });

  const riskyStrict = runAgyHook(
    { hookEventName: 'PreToolUse', toolCall: { name: 'run_command', args: { CommandLine: 'git reset --hard' } } },
    { KELIN_SAFETY: 'strict' },
  );
  assert.equal(riskyStrict.status, 0);
  assert.equal(JSON.parse(riskyStrict.stdout).decision, 'force_ask');

  const riskyRelaxed = runAgyHook(
    { hookEventName: 'PreToolUse', toolCall: { name: 'run_command', args: { CommandLine: 'git reset --hard' } } },
    { KELIN_SAFETY: 'relaxed' },
  );
  assert.equal(riskyRelaxed.status, 0);
  assert.deepEqual(JSON.parse(riskyRelaxed.stdout), { decision: 'ask' });

  const catastrophic = runAgyHook(
    { hookEventName: 'PreToolUse', toolCall: { name: 'run_command', args: { CommandLine: 'rm -rf /' } } },
    { KELIN_SAFETY: 'relaxed' },
  );
  assert.equal(catastrophic.status, 0);
  assert.equal(JSON.parse(catastrophic.stdout).decision, 'deny');

  const invalid = runAgyHook('not json', { KELIN_SAFETY: 'strict' });
  assert.equal(invalid.status, 0);
  assert.deepEqual(JSON.parse(invalid.stdout), { decision: 'ask' });

  const jsonNull = runAgyHook('null', { KELIN_SAFETY: 'strict' });
  assert.equal(jsonNull.status, 0);
  assert.deepEqual(JSON.parse(jsonNull.stdout), { decision: 'ask' });

  const zcodeNull = runHook('null');
  assert.equal(zcodeNull.status, 0);
  assert.equal(zcodeNull.stdout, '');

  const invalidMode = runAgyHook(
    { hookEventName: 'PreToolUse', toolCall: { name: 'run_command', args: { CommandLine: 'rm -rf /' } } },
    { KELIN_SAFETY: 'typo-mode' },
  );
  assert.equal(invalidMode.status, 0);
  assert.equal(JSON.parse(invalidMode.stdout).decision, 'deny');
  assert.match(invalidMode.stderr, /invalid KELIN_SAFETY/);
});

test('antigravity PreToolUse enforces edit freeze on write_file, edit_file and run_command redirection', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kelin-freeze-agy-'));
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await mkdir(path.join(dir, 'docs'), { recursive: true });
  assert.equal(spawnSync(process.execPath, [freeze, 'set', 'src', '--root', dir], { encoding: 'utf8' }).status, 0);

  const inside = runAgyHook(
    { hookEventName: 'PreToolUse', cwd: dir, workspacePaths: [dir], toolCall: { name: 'write_file', args: { Path: path.join(dir, 'src/ok.js') } } },
    { KELIN_SAFETY: 'strict' },
  );
  assert.deepEqual(JSON.parse(inside.stdout), { decision: 'ask' });

  const outsideWrite = runAgyHook(
    { hookEventName: 'PreToolUse', cwd: dir, workspacePaths: [dir], toolCall: { name: 'write_file', args: { Path: path.join(dir, 'docs/nope.md') } } },
    { KELIN_SAFETY: 'strict' },
  );
  assert.equal(JSON.parse(outsideWrite.stdout).decision, 'deny');

  const outsideEdit = runAgyHook(
    { hookEventName: 'PreToolUse', cwd: dir, workspacePaths: [dir], toolCall: { name: 'edit_file', args: { Path: path.join(dir, 'docs/nope.md') } } },
    { KELIN_SAFETY: 'strict' },
  );
  assert.equal(JSON.parse(outsideEdit.stdout).decision, 'deny');

  const outsideRedirect = runAgyHook(
    { hookEventName: 'PreToolUse', cwd: dir, workspacePaths: [dir], toolCall: { name: 'run_command', args: { CommandLine: 'echo hi > docs/nope.md' } } },
    { KELIN_SAFETY: 'strict' },
  );
  assert.equal(JSON.parse(outsideRedirect.stdout).decision, 'deny');

  const explicitCwdOutside = runAgyHook(
    { hookEventName: 'PreToolUse', cwd: dir, workspacePaths: [dir], toolCall: { name: 'run_command', args: { CommandLine: 'echo hi > nope.md', Cwd: path.join(dir, 'docs') } } },
    { KELIN_SAFETY: 'strict' },
  );
  assert.equal(JSON.parse(explicitCwdOutside.stdout).decision, 'deny');

  const explicitCwdInside = runAgyHook(
    { hookEventName: 'PreToolUse', cwd: dir, workspacePaths: [dir], toolCall: { name: 'run_command', args: { CommandLine: 'echo hi > ok.js', Cwd: path.join(dir, 'src') } } },
    { KELIN_SAFETY: 'strict' },
  );
  assert.deepEqual(JSON.parse(explicitCwdInside.stdout), { decision: 'ask' });

  const askPlusFreezeStrict = runAgyHook(
    { hookEventName: 'PreToolUse', cwd: dir, workspacePaths: [dir], toolCall: { name: 'run_command', args: { CommandLine: 'git reset --hard && echo hi > docs/nope.md' } } },
    { KELIN_SAFETY: 'strict' },
  );
  assert.equal(JSON.parse(askPlusFreezeStrict.stdout).decision, 'deny');

  const askPlusFreezeRelaxed = runAgyHook(
    { hookEventName: 'PreToolUse', cwd: dir, workspacePaths: [dir], toolCall: { name: 'run_command', args: { CommandLine: 'git reset --hard && echo hi > docs/nope.md' } } },
    { KELIN_SAFETY: 'relaxed' },
  );
  assert.equal(JSON.parse(askPlusFreezeRelaxed.stdout).decision, 'deny');

  // Tight redirect, quoted path with spaces, dynamic redirect, and quoted non-redirect
  const tightRedirect = runAgyHook(
    { hookEventName: 'PreToolUse', cwd: dir, workspacePaths: [dir], toolCall: { name: 'run_command', args: { CommandLine: 'echo hi>docs/nope.md' } } },
    { KELIN_SAFETY: 'strict' },
  );
  assert.equal(JSON.parse(tightRedirect.stdout).decision, 'deny');

  const quotedSpaces = runAgyHook(
    { hookEventName: 'PreToolUse', cwd: dir, workspacePaths: [dir], toolCall: { name: 'run_command', args: { CommandLine: 'echo hi > "docs/my file.md"' } } },
    { KELIN_SAFETY: 'strict' },
  );
  assert.equal(JSON.parse(quotedSpaces.stdout).decision, 'deny');

  const dynamicRedirect = runAgyHook(
    { hookEventName: 'PreToolUse', cwd: dir, workspacePaths: [dir], toolCall: { name: 'run_command', args: { CommandLine: 'echo hi > $OUT' } } },
    { KELIN_SAFETY: 'strict' },
  );
  assert.equal(JSON.parse(dynamicRedirect.stdout).decision, 'deny');

  const quotedLiteral = runAgyHook(
    { hookEventName: 'PreToolUse', cwd: dir, workspacePaths: [dir], toolCall: { name: 'run_command', args: { CommandLine: 'echo "hi > docs/nope.md"' } } },
    { KELIN_SAFETY: 'strict' },
  );
  assert.deepEqual(JSON.parse(quotedLiteral.stdout), { decision: 'ask' });

  // Event cwd is a subdirectory under workspacePaths root where .kelin/freeze.json lives
  const subCwdWrite = runAgyHook(
    { hookEventName: 'PreToolUse', cwd: path.join(dir, 'docs'), workspacePaths: [dir], toolCall: { name: 'write_file', args: { Path: 'sub.md' } } },
    { KELIN_SAFETY: 'strict' },
  );
  assert.equal(JSON.parse(subCwdWrite.stdout).decision, 'deny');

  const subCwdRedirect = runAgyHook(
    { hookEventName: 'PreToolUse', cwd: path.join(dir, 'docs'), workspacePaths: [dir], toolCall: { name: 'run_command', args: { CommandLine: 'echo x > sub.md' } } },
    { KELIN_SAFETY: 'strict' },
  );
  assert.equal(JSON.parse(subCwdRedirect.stdout).decision, 'deny');

  // cd changes directory mid-command before relative redirect
  const cdOutside = runAgyHook(
    { hookEventName: 'PreToolUse', cwd: path.join(dir, 'src'), workspacePaths: [dir], toolCall: { name: 'run_command', args: { CommandLine: 'cd ../docs && echo x > nope.md' } } },
    { KELIN_SAFETY: 'strict' },
  );
  assert.equal(JSON.parse(cdOutside.stdout).decision, 'deny');

  const subshellCdOutside = runAgyHook(
    { hookEventName: 'PreToolUse', cwd: path.join(dir, 'src'), workspacePaths: [dir], toolCall: { name: 'run_command', args: { CommandLine: '(cd ../docs && echo x > nope.md)' } } },
    { KELIN_SAFETY: 'strict' },
  );
  assert.equal(JSON.parse(subshellCdOutside.stdout).decision, 'deny');

  const cdDynamic = runAgyHook(
    { hookEventName: 'PreToolUse', cwd: path.join(dir, 'src'), workspacePaths: [dir], toolCall: { name: 'run_command', args: { CommandLine: 'cd "$TARGET" && echo x > out.md' } } },
    { KELIN_SAFETY: 'strict' },
  );
  assert.equal(JSON.parse(cdDynamic.stdout).decision, 'deny');

  const cdInside = runAgyHook(
    { hookEventName: 'PreToolUse', cwd: dir, workspacePaths: [dir], toolCall: { name: 'run_command', args: { CommandLine: 'cd src && echo x > ok.js' } } },
    { KELIN_SAFETY: 'strict' },
  );
  assert.deepEqual(JSON.parse(cdInside.stdout), { decision: 'ask' });

  // Heredoc body containing > does not trigger false freeze deny, while redirect on heredoc command line still does
  const heredocSafe = runAgyHook(
    { hookEventName: 'PreToolUse', cwd: dir, workspacePaths: [dir], toolCall: { name: 'run_command', args: { CommandLine: "cat <<'EOF'\na > docs/notes.txt\nEOF" } } },
    { KELIN_SAFETY: 'strict' },
  );
  assert.deepEqual(JSON.parse(heredocSafe.stdout), { decision: 'ask' });

  const heredocOutside = runAgyHook(
    { hookEventName: 'PreToolUse', cwd: dir, workspacePaths: [dir], toolCall: { name: 'run_command', args: { CommandLine: "cat <<'EOF' > docs/out.txt\nhello\nEOF" } } },
    { KELIN_SAFETY: 'strict' },
  );
  assert.equal(JSON.parse(heredocOutside.stdout).decision, 'deny');

  // Non-breaking space after tee terminates cleanly without hanging
  assert.deepEqual(redirectTargets('echo hi | tee \u00a0out.txt'), ['\u00a0out.txt']);

  // Here-string <<< must not eat subsequent lines
  const hereStringFollowup = runAgyHook(
    { hookEventName: 'PreToolUse', cwd: dir, workspacePaths: [dir], toolCall: { name: 'run_command', args: { CommandLine: 'cat <<< hi\necho x > docs/nope.md' } } },
    { KELIN_SAFETY: 'strict' },
  );
  assert.equal(JSON.parse(hereStringFollowup.stdout).decision, 'deny');

  // Subshell cd does not leak into parent shell relative redirect after )
  const subshellRestore = runAgyHook(
    { hookEventName: 'PreToolUse', cwd: path.join(dir, 'docs'), workspacePaths: [dir], toolCall: { name: 'run_command', args: { CommandLine: '(cd ../src && echo a > ok.js) && echo b > nope.md' } } },
    { KELIN_SAFETY: 'strict' },
  );
  assert.equal(JSON.parse(subshellRestore.stdout).decision, 'deny');

  // File descriptor duplication 2>&1 does not false-deny under freeze; &> and >| still deny outside freeze
  const fdDup = runAgyHook(
    { hookEventName: 'PreToolUse', cwd: dir, workspacePaths: [dir], toolCall: { name: 'run_command', args: { CommandLine: 'ls 2>&1' } } },
    { KELIN_SAFETY: 'strict' },
  );
  assert.deepEqual(JSON.parse(fdDup.stdout), { decision: 'ask' });

  const ampRedirect = runAgyHook(
    { hookEventName: 'PreToolUse', cwd: dir, workspacePaths: [dir], toolCall: { name: 'run_command', args: { CommandLine: 'echo hi &>docs/out.log' } } },
    { KELIN_SAFETY: 'strict' },
  );
  assert.equal(JSON.parse(ampRedirect.stdout).decision, 'deny');

  const clobberRedirect = runAgyHook(
    { hookEventName: 'PreToolUse', cwd: dir, workspacePaths: [dir], toolCall: { name: 'run_command', args: { CommandLine: 'echo hi >| docs/out.log' } } },
    { KELIN_SAFETY: 'strict' },
  );
  assert.equal(JSON.parse(clobberRedirect.stdout).decision, 'deny');

  // Shell comment containing << must not swallow subsequent lines
  const commentHeredoc = runAgyHook(
    { hookEventName: 'PreToolUse', cwd: dir, workspacePaths: [dir], toolCall: { name: 'run_command', args: { CommandLine: 'echo ok # <<EOF\necho hi > docs/nope.md' } } },
    { KELIN_SAFETY: 'strict' },
  );
  assert.equal(JSON.parse(commentHeredoc.stdout).decision, 'deny');

  // cd in pipeline, conditional branch, or command substitution never falsely moves parent shell into allowed root
  for (const cmd of [
    'cd ../src | cat; echo x > nope.md',
    'false && cd ../src; echo x > nope.md',
    'true || cd ../src; echo x > nope.md',
    'echo $(cd ../src); echo x > nope.md',
    'cd ../src; echo x > nope.md',
  ]) {
    const res = runAgyHook(
      { hookEventName: 'PreToolUse', cwd: path.join(dir, 'docs'), workspacePaths: [dir], toolCall: { name: 'run_command', args: { CommandLine: cmd } } },
      { KELIN_SAFETY: 'strict' },
    );
    assert.equal(JSON.parse(res.stdout).decision, 'deny', `expected deny for: ${cmd}`);
  }

  const cmdSubCd = runAgyHook(
    { hookEventName: 'PreToolUse', cwd: path.join(dir, 'src'), workspacePaths: [dir], toolCall: { name: 'run_command', args: { CommandLine: 'echo $(cd ../docs && echo x > nope.md)' } } },
    { KELIN_SAFETY: 'strict' },
  );
  assert.equal(JSON.parse(cmdSubCd.stdout).decision, 'deny');

  // Escaped space before # is part of the word, NOT a comment
  const escapedSpaceHash = runAgyHook(
    { hookEventName: 'PreToolUse', cwd: dir, workspacePaths: [dir], toolCall: { name: 'run_command', args: { CommandLine: 'echo a\\ #b > docs/nope.md' } } },
    { KELIN_SAFETY: 'strict' },
  );
  assert.equal(JSON.parse(escapedSpaceHash.stdout).decision, 'deny');

  // Predicted cd directory does not leak past && into a subsequent ; or || branch
  for (const cmd of [
    'cd ../src && echo a; echo b > nope.md',
    'cd ../src && echo a || echo b > nope.md',
  ]) {
    const res = runAgyHook(
      { hookEventName: 'PreToolUse', cwd: path.join(dir, 'docs'), workspacePaths: [dir], toolCall: { name: 'run_command', args: { CommandLine: cmd } } },
      { KELIN_SAFETY: 'strict' },
    );
    assert.equal(JSON.parse(res.stdout).decision, 'deny', `expected deny for: ${cmd}`);
  }
});

#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { decide, redirectTargets } from '../skills/kelin-safety/scripts/check-command.mjs';
import { decidePath } from '../skills/kelin-safety/scripts/freeze-lib.mjs';

const hostIndex = process.argv.indexOf('--host');
const hostArg = hostIndex >= 0 ? process.argv[hostIndex + 1] || '' : '';
const explicitAgy = hostArg === 'antigravity';
const VALID_SAFETY = new Set(['off', 'relaxed', 'strict']);

const safetyMode = () => {
  const env = (process.env.KELIN_SAFETY || '').trim().toLowerCase();
  if (env) {
    if (VALID_SAFETY.has(env)) return env;
    process.stderr.write(`kelin-safety: invalid KELIN_SAFETY=${JSON.stringify(env)}, defaulting to strict\n`);
    return 'strict';
  }
  try {
    const val = readFileSync(path.join(homedir(), '.kelin', 'safety.mode'), 'utf8').trim().toLowerCase();
    if (!val) return 'off';
    if (VALID_SAFETY.has(val)) return val;
    process.stderr.write(`kelin-safety: invalid ~/.kelin/safety.mode=${JSON.stringify(val)}, defaulting to strict\n`);
    return 'strict';
  } catch {
    return 'off';
  }
};

// In Antigravity PreToolUse, "ask" defers to normal host permission/whitelist rules without auto-approving.
const agyDefer = () => process.stdout.write(JSON.stringify({ decision: 'ask' }));
const agyEnvHint = Boolean(process.env.PLUGIN_ROOT) && !process.env.ZCODE_PLUGIN_ROOT && !process.env.CLAUDE_PLUGIN_ROOT;

const MODE = safetyMode();
if (MODE === 'off' && !explicitAgy && !agyEnvHint) process.exit(0);

let raw = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) raw += chunk;

const invalidExit = () => {
  if (explicitAgy || (!hostArg && agyEnvHint)) agyDefer();
  process.exit(0);
};

let input;
try {
  input = raw.trim() ? JSON.parse(raw) : {};
} catch {
  invalidExit();
}
if (!input || typeof input !== 'object' || Array.isArray(input)) invalidExit();

const isAgy =
  explicitAgy ||
  (!hostArg && (Boolean(input.toolCall) || Array.isArray(input.workspacePaths) || agyEnvHint));

if (MODE === 'off') {
  if (isAgy) agyDefer();
  process.exit(0);
}

const toolCall = input.toolCall && typeof input.toolCall === 'object' && !Array.isArray(input.toolCall) ? input.toolCall : null;
const rawArgs = toolCall?.args ?? input.tool_input ?? input.toolInput;
const toolArgs = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
const tool = typeof toolCall?.name === 'string'
  ? toolCall.name
  : typeof input.tool_name === 'string'
    ? input.tool_name
    : typeof input.toolName === 'string'
      ? input.toolName
      : '';

const firstWorkspace = Array.isArray(input.workspacePaths) && typeof input.workspacePaths[0] === 'string' ? input.workspacePaths[0] : '';
const eventCwd = typeof input.cwd === 'string' ? input.cwd : '';
const projectDir = isAgy
  ? eventCwd || firstWorkspace || ''
  : process.env.ZCODE_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd();

const resolveExecDir = () => {
  const explicitCwd = typeof toolArgs.Cwd === 'string' ? toolArgs.Cwd : typeof toolArgs.cwd === 'string' ? toolArgs.cwd : '';
  if (!explicitCwd) return projectDir;
  if (explicitCwd === '~' || explicitCwd.startsWith('~/')) return path.join(homedir(), explicitCwd.slice(1));
  return path.isAbsolute(explicitCwd) ? explicitCwd : path.resolve(projectDir || process.cwd(), explicitCwd);
};

const resolveTarget = (baseDir, target) => {
  if (target === '~' || target.startsWith('~/')) return path.join(homedir(), target.slice(1));
  return path.isAbsolute(target) ? target : path.resolve(baseDir, target);
};

const SHELL_TOOLS = new Set(['Bash', 'run_command']);
const WRITE_TOOLS = new Set([
  'Write',
  'Edit',
  'ApplyPatch',
  'MultiEdit',
  'write_file',
  'edit_file',
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
]);

let result = { decision: 'allow', reason: '' };
if (SHELL_TOOLS.has(tool)) {
  const command = typeof toolArgs.CommandLine === 'string'
    ? toolArgs.CommandLine
    : typeof toolArgs.command === 'string'
      ? toolArgs.command
      : '';
  result = decide(command);
  const freezeRoot = projectDir || resolveExecDir();
  if (result.decision !== 'deny' && freezeRoot) {
    const execDir = resolveExecDir() || freezeRoot;
    for (const target of redirectTargets(command)) {
      const guard = decidePath(freezeRoot, resolveTarget(execDir, target));
      if (guard.decision === 'deny') {
        result = guard;
        break;
      }
      if (guard.decision === 'ask' && result.decision === 'allow') result = guard;
    }
  }
} else if (WRITE_TOOLS.has(tool) && projectDir) {
  const filePath = [toolArgs.Path, toolArgs.path, toolArgs.TargetFile, toolArgs.file_path].find((v) => typeof v === 'string') || '';
  result = decidePath(projectDir, filePath);
}

if (result.decision === 'ask' && MODE === 'relaxed') result = { decision: 'allow', reason: '' };

if (isAgy) {
  if (result.decision === 'deny') {
    process.stdout.write(JSON.stringify({ decision: 'deny', reason: result.reason }));
  } else if (result.decision === 'ask') {
    process.stdout.write(JSON.stringify({ decision: 'force_ask', reason: result.reason }));
  } else {
    agyDefer();
  }
  process.exit(0);
}

if (result.decision === 'allow') process.exit(0);

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: result.decision,
    permissionDecisionReason: result.reason,
  },
}));

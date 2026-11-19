#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { decide, resolveRedirectTargets } from '../skills/kelin-safety/scripts/check-command.mjs';
import { decidePath, freezeFile } from '../skills/kelin-safety/scripts/freeze-lib.mjs';

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

const workspaceList = Array.isArray(input.workspacePaths)
  ? input.workspacePaths.filter((entry) => typeof entry === 'string' && entry.trim())
  : [];
const eventCwd = typeof input.cwd === 'string' ? input.cwd : '';

const containsPath = (parent, child) => {
  if (!parent || !child) return false;
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

const pickFreezeRoot = (execDir) => {
  if (!isAgy) return process.env.ZCODE_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const enclosing = workspaceList.filter((ws) => containsPath(ws, execDir || eventCwd));
  const candidates = [...enclosing, ...workspaceList, eventCwd, execDir].filter(Boolean);
  const unique = [...new Set(candidates)];
  const withFreeze = unique.find((dir) => existsSync(freezeFile(dir)));
  return withFreeze || enclosing[0] || workspaceList[0] || eventCwd || execDir || '';
};

const resolveExecDir = () => {
  const base = isAgy
    ? eventCwd || workspaceList[0] || ''
    : process.env.ZCODE_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const explicitCwd = typeof toolArgs.Cwd === 'string' ? toolArgs.Cwd : typeof toolArgs.cwd === 'string' ? toolArgs.cwd : '';
  if (!explicitCwd) return base;
  if (explicitCwd === '~' || explicitCwd.startsWith('~/')) return path.join(homedir(), explicitCwd.slice(1));
  return path.isAbsolute(explicitCwd) ? explicitCwd : path.resolve(base || process.cwd(), explicitCwd);
};

const resolveTarget = (baseDir, target) => {
  if (!target) return '';
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
  const execDir = resolveExecDir();
  const freezeRoot = pickFreezeRoot(execDir);
  if (result.decision !== 'deny' && freezeRoot) {
    const base = execDir || freezeRoot;
    for (const target of resolveRedirectTargets(command, base, homedir())) {
      const guard = decidePath(freezeRoot, target);
      if (guard.decision === 'deny') {
        result = guard;
        break;
      }
      if (guard.decision === 'ask' && result.decision === 'allow') result = guard;
    }
  }
} else if (WRITE_TOOLS.has(tool)) {
  const base = isAgy ? eventCwd || workspaceList[0] || '' : process.env.ZCODE_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const freezeRoot = pickFreezeRoot(base);
  if (freezeRoot) {
    const filePath = [toolArgs.Path, toolArgs.path, toolArgs.TargetFile, toolArgs.file_path].find((v) => typeof v === 'string') || '';
    result = decidePath(freezeRoot, resolveTarget(base || freezeRoot, filePath));
  }
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

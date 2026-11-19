#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { decide, redirectTargets } from '../skills/kelin-safety/scripts/check-command.mjs';
import { decidePath } from '../skills/kelin-safety/scripts/freeze-lib.mjs';

const hostIndex = process.argv.indexOf('--host');
const hostArg = hostIndex >= 0 ? process.argv[hostIndex + 1] || '' : '';
const explicitAgy = hostArg === 'antigravity';

const safetyMode = () => {
  const env = (process.env.KELIN_SAFETY || '').trim().toLowerCase();
  if (['off', 'relaxed', 'strict'].includes(env)) return env;
  try {
    const val = readFileSync(path.join(homedir(), '.kelin', 'safety.mode'), 'utf8').trim().toLowerCase();
    return ['off', 'relaxed', 'strict'].includes(val) ? val : 'off';
  } catch {
    return 'off';
  }
};

// In Antigravity PreToolUse, "ask" defers to normal host permission/whitelist rules without auto-approving.
const agyDefer = () => process.stdout.write(JSON.stringify({ decision: 'ask' }));

const MODE = safetyMode();
if (MODE === 'off' && !explicitAgy && !process.env.PLUGIN_ROOT) process.exit(0);

let raw = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) raw += chunk;

let input;
try {
  input = JSON.parse(raw || '{}');
} catch {
  if (explicitAgy || (Boolean(process.env.PLUGIN_ROOT) && !process.env.ZCODE_PLUGIN_ROOT && !process.env.CLAUDE_PLUGIN_ROOT)) {
    agyDefer();
  }
  process.exit(0);
}

const isAgy =
  explicitAgy ||
  (!hostArg &&
    (Boolean(input.toolCall) ||
      Array.isArray(input.workspacePaths) ||
      (Boolean(process.env.PLUGIN_ROOT) && !process.env.ZCODE_PLUGIN_ROOT && !process.env.CLAUDE_PLUGIN_ROOT)));

if (MODE === 'off') {
  if (isAgy) agyDefer();
  process.exit(0);
}

const tool = input.toolCall?.name || input.tool_name || input.toolName || '';
const toolArgs = input.toolCall?.args || input.tool_input || input.toolInput || {};
const projectDir = isAgy
  ? input.cwd || (Array.isArray(input.workspacePaths) && input.workspacePaths[0]) || ''
  : process.env.ZCODE_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd();

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
  const command = toolArgs.CommandLine || toolArgs.command || '';
  result = decide(command);
  if (result.decision === 'allow' && projectDir) {
    for (const target of redirectTargets(command)) {
      const guard = decidePath(projectDir, target);
      if (guard.decision !== 'allow') {
        result = guard;
        break;
      }
    }
  }
} else if (WRITE_TOOLS.has(tool) && projectDir) {
  const filePath = toolArgs.Path || toolArgs.path || toolArgs.TargetFile || toolArgs.file_path || '';
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

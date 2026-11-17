#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { decide, redirectTargets } from '../skills/kelin-safety/scripts/check-command.mjs';
import { decidePath } from '../skills/kelin-safety/scripts/freeze-lib.mjs';

const safetyMode = () => {
  const env = process.env.KELIN_SAFETY;
  if (env) return env;
  try {
    return readFileSync(path.join(homedir(), '.kelin', 'safety.mode'), 'utf8').trim() || 'off';
  } catch {
    return 'off';
  }
};
const MODE = safetyMode();
if (MODE === 'off') process.exit(0);

let raw = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) raw += chunk;

let input;
try {
  input = JSON.parse(raw || '{}');
} catch {
  process.exit(0);
}

const tool = input.tool_name || input.toolName || '';
const projectDir = process.env.ZCODE_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd();

let result = { decision: 'allow', reason: '' };
if (tool === 'Bash') {
  const command = input.tool_input?.command || input.toolInput?.command || '';
  result = decide(command);
  if (result.decision === 'allow') {
    for (const target of redirectTargets(command)) {
      const guard = decidePath(projectDir, target);
      if (guard.decision !== 'allow') {
        result = guard;
        break;
      }
    }
  }
} else if (['Write', 'Edit', 'ApplyPatch', 'MultiEdit'].includes(tool)) {
  const filePath = input.tool_input?.file_path || input.tool_input?.path || input.toolInput?.file_path || input.toolInput?.path || '';
  result = decidePath(projectDir, filePath);
}

if (result.decision === 'ask' && MODE === 'relaxed') result = { decision: 'allow', reason: '' };

if (result.decision === 'allow') process.exit(0);

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: result.decision,
    permissionDecisionReason: result.reason,
  },
}));

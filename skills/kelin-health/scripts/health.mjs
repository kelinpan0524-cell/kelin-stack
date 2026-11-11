#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const args = process.argv.slice(2);
const rootIndex = args.indexOf('--root');
const root = path.resolve(rootIndex >= 0 && args[rootIndex + 1] ? args[rootIndex + 1] : process.cwd());

const candidates = [
  { id: 'unit-tests', file: 'skills/kelin-verify-stack/tests', args: ['--test', 'skills/kelin-verify-stack/tests'], needs: 'skills/kelin-verify-stack/tests' },
  { id: 'offline', file: 'skills/kelin-verify-stack/scripts/offline-check.mjs', args: ['skills/kelin-verify-stack/scripts/offline-check.mjs'], needs: 'skills/kelin-verify-stack/scripts/offline-check.mjs' },
  { id: 'skill-eval', file: 'skills/kelin-evals/scripts/skill-eval.mjs', args: ['skills/kelin-evals/scripts/skill-eval.mjs', '--root', '.'], needs: 'skills/kelin-evals/scripts/skill-eval.mjs' },
  { id: 'neat', file: 'skills/kelin-neat/scripts/neat-check.mjs', args: ['skills/kelin-neat/scripts/neat-check.mjs', 'neat.json'], needs: 'skills/kelin-neat/scripts/neat-check.mjs' },
  { id: 'docs', file: 'skills/kelin-docs/scripts/gen-docs.mjs', args: ['skills/kelin-docs/scripts/gen-docs.mjs', '--check'], needs: 'skills/kelin-docs/scripts/gen-docs.mjs' },
  { id: 'agents', file: 'skills/kelin-agents/scripts/agents-check.mjs', args: ['skills/kelin-agents/scripts/agents-check.mjs', 'AGENTS.md'], needs: 'skills/kelin-agents/scripts/agents-check.mjs' },
  { id: 'guards', file: 'skills/kelin-guard/scripts/guard-check.mjs', args: ['skills/kelin-guard/scripts/guard-check.mjs', 'guards.json'], needs: 'skills/kelin-guard/scripts/guard-check.mjs' },
];

const checks = [];
for (const candidate of candidates) {
  if (!existsSync(path.join(root, candidate.needs))) continue;
  const started = Date.now();
  const result = spawnSync(process.execPath, candidate.args, { cwd: root, encoding: 'utf8', timeout: 120_000 });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim().replace(/\s+/g, ' ');
  checks.push({
    id: candidate.id,
    command: `node ${candidate.args.join(' ')}`,
    exit: result.status ?? 1,
    ok: result.status === 0,
    ms: Date.now() - started,
    summary: output.slice(0, 160),
  });
}

const failed = checks.filter((check) => !check.ok);
const result = { root, ok: failed.length === 0, total: checks.length, failed: failed.map((check) => check.id), checks };
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);

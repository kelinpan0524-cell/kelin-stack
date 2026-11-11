#!/usr/bin/env node
import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const args = process.argv.slice(2);
const rootIndex = args.indexOf('--root');
const root = path.resolve(rootIndex >= 0 && args[rootIndex + 1] ? args[rootIndex + 1] : process.cwd());
const testsDir = path.join(root, 'skills', 'kelin-verify-stack', 'tests');
const testFiles = existsSync(testsDir)
  ? readdirSync(testsDir).filter((file) => file.endsWith('.test.mjs')).sort().map((file) => path.join('skills', 'kelin-verify-stack', 'tests', file))
  : [];

const candidates = [
  ...(testFiles.length ? [{ id: 'unit-tests', args: ['--test', ...testFiles], needs: 'skills/kelin-verify-stack/tests' }] : []),
  { id: 'offline', args: ['skills/kelin-verify-stack/scripts/offline-check.mjs'], needs: 'skills/kelin-verify-stack/scripts/offline-check.mjs' },
  { id: 'skill-eval', args: ['skills/kelin-evals/scripts/skill-eval.mjs', '--root', '.'], needs: 'skills/kelin-evals/scripts/skill-eval.mjs' },
  { id: 'neat', args: ['skills/kelin-neat/scripts/neat-check.mjs', 'neat.json'], needs: 'skills/kelin-neat/scripts/neat-check.mjs' },
  { id: 'docs', args: ['skills/kelin-docs/scripts/gen-docs.mjs', '--check'], needs: 'skills/kelin-docs/scripts/gen-docs.mjs' },
  { id: 'agents', args: ['skills/kelin-agents/scripts/agents-check.mjs', 'AGENTS.md'], needs: 'skills/kelin-agents/scripts/agents-check.mjs' },
  { id: 'guards', args: ['skills/kelin-guard/scripts/guard-check.mjs', 'guards.json'], needs: 'skills/kelin-guard/scripts/guard-check.mjs' },
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

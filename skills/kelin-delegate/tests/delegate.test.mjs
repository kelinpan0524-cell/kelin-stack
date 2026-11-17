import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveRole, sandboxFor, ROLES } from '../scripts/delegate.mjs';

test('resolveRole returns explicit runner first', () => {
  assert.deepEqual(resolveRole('review', { roles: { review: 'codex' } }, 'antigravity'), { runner: 'antigravity', source: 'explicit' });
});

test('resolveRole maps host to USE_HOST and unconfigured to NEEDS_ROLE_CHOICE', () => {
  assert.equal(resolveRole('critique', { roles: { critique: 'host' } }).status, 'USE_HOST');
  assert.equal(resolveRole('diagnose', { roles: {} }).status, 'NEEDS_ROLE_CHOICE');
});

test('resolveRole keeps multi-runner lists for diagnose', () => {
  const r = resolveRole('diagnose', { roles: { diagnose: ['codex', 'antigravity'] } });
  assert.deepEqual(r.runner, ['codex', 'antigravity']);
});

test('sandboxFor enforces read-only per runner', () => {
  assert.deepEqual(sandboxFor('review', 'codex'), ['-s', 'read-only', '-c', 'model_reasoning_effort="high"']);
  assert.deepEqual(sandboxFor('implement', 'codex'), ['-s', 'workspace-write']);
  assert.deepEqual(sandboxFor('review', 'antigravity'), ['--mode', 'plan']);
  assert.deepEqual(sandboxFor('implement', 'antigravity'), ['--mode', 'accept-edits']);
});

test('every role maps to a known access mode', () => {
  for (const mode of Object.values(ROLES)) assert.ok(['read', 'write'].includes(mode));
});

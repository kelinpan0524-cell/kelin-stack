import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { bodyNeedle, classify, completeEvidence, matches, parseFrontmatter, validateRegistry } from '../scripts/core.mjs';
import { evaluateAssertions } from '../scripts/harness.mjs';
import { sanitizeText } from '../scripts/io.mjs';
import { renderReport } from '../scripts/report.mjs';

const registry = validateRegistry({
  skills: 'skills',
  agents: 'agents',
  manifests: ['.claude-plugin/plugin.json'],
  assets: ['assets/**'],
  hooks: ['hooks/**'],
  setup: ['skills/setup-pstack/**'],
  tools: ['skills/*/scripts/**'],
  nonRuntime: ['docs/**', 'README.md'],
});

test('registry rejects missing keys and unsafe entries', () => {
  assert.throws(() => validateRegistry({ skills: 'skills' }), /Invalid registry/);
  assert.throws(() => validateRegistry({ ...registry, assets: ['../x'] }), /Invalid registry/);
  assert.throws(() => validateRegistry({ ...registry, hooks: ['a', 'a'] }), /Duplicate/);
});

test('matches supports exact, star and double star', () => {
  assert.ok(matches('skills/a/SKILL.md', 'skills/a/SKILL.md'));
  assert.ok(matches('skills/*/scripts/**', 'skills/x/scripts/log.sh'));
  assert.ok(!matches('skills/*/scripts/**', 'skills/x/references/a.md'));
  assert.ok(matches('assets/**', 'assets/logo.png'));
  assert.ok(!matches('assets/**', 'assets'));
});

test('classify maps skill files to live invocation features', () => {
  const result = classify({ paths: ['skills/how/SKILL.md'], registry });
  assert.deepEqual(result.features, ['zcode:skill-invocation:how']);
  assert.deepEqual(result.skills, ['how']);
  assert.equal(result.noRuntime, false);
});

test('classify adds tools for script changes', () => {
  const result = classify({ paths: ['skills/poteto-mode/scripts/check-plan.mjs'], registry });
  assert.deepEqual(result.features, ['zcode:skill-invocation:poteto-mode', 'zcode:tools'].sort());
});

test('classify fails closed on unknown paths', () => {
  assert.throws(() => classify({ paths: ['random/file.txt'], registry }), /Unmapped path/);
  assert.throws(() => classify({ paths: ['../escape'], registry }), /Unsafe path/);
});

test('classify treats documentation as no runtime change', () => {
  const result = classify({ paths: ['docs/guide/01.md', 'README.md'], registry });
  assert.equal(result.noRuntime, true);
  assert.deepEqual(result.features, []);
});

test('version-only manifest change reaches manifest only', () => {
  const result = classify({ paths: ['.claude-plugin/plugin.json'], registry, versionOnly: ['.claude-plugin/plugin.json'] });
  assert.deepEqual(result.features, ['zcode:manifest']);
});

test('full manifest change reaches manifest and catalog', () => {
  const result = classify({ paths: ['.claude-plugin/plugin.json'], registry });
  assert.deepEqual(result.features, ['zcode:catalog', 'zcode:manifest']);
});

test('frontmatter parsing reads quoted values and body', () => {
  const parsed = parseFrontmatter('---\nname: demo\ndescription: "a: b"\n---\n\n# Title\nBody line\n');
  assert.equal(parsed.data.name, 'demo');
  assert.equal(parsed.data.description, 'a: b');
  assert.match(parsed.body, /# Title/);
  assert.throws(() => parseFrontmatter('---\nname: demo\n'), /Unterminated/);
});

test('bodyNeedle picks a substantial body line and strips markup', () => {
  const needle = bodyNeedle('---\nname: x\ndescription: y\n---\n# Title\n**Prime directive:** keep it small and simple.\n');
  assert.ok(needle.includes('Prime directive'));
  assert.ok(!needle.includes('**'));
});

test('completeEvidence requires one passing record with artifacts', () => {
  const receipt = {
    features: ['zcode:catalog'],
    observations: [{ feature: 'zcode:catalog', kind: 'static', ok: true, assertions: [{ id: 'a', ok: true }], artifacts: [{ path: 'static/x.json', sha256: 'a'.repeat(64) }] }],
  };
  assert.doesNotThrow(() => completeEvidence(receipt));
  assert.throws(() => completeEvidence({ ...receipt, observations: [] }), /Missing or duplicate/);
  assert.throws(() => completeEvidence({ ...receipt, observations: [{ ...receipt.observations[0], assertions: [{ id: 'a', ok: false }] }] }), /Failed assertion/);
  assert.throws(() => completeEvidence({ ...receipt, observations: [{ ...receipt.observations[0], artifacts: [] }] }), /No artifacts/);
});

test('sanitizeText drops unsafe publishing values', () => {
  assert.equal(sanitizeText('ok text'), 'ok text');
  assert.equal(sanitizeText('bad `tick`'), '');
  assert.equal(sanitizeText('bad <angle>'), '');
  assert.equal(sanitizeText('汉字'), '');
  assert.equal(sanitizeText('x'.repeat(200)), '');
});

test('assertions check skill calls, files and responses', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'vps-test-'));
  await writeFile(path.join(dir, 'answer.md'), 'contains VPS-ABC and Be lazy. Stay simple.\n');
  const results = await evaluateAssertions(
    [
      { id: 'skill', type: 'skill_called', value: 'pstack:demo' },
      { id: 'marker', type: 'file_contains', path: 'answer.md', value: '{{marker}}' },
      { id: 'text', type: 'file_contains', path: 'answer.md', value: 'Be lazy' },
      { id: 'size', type: 'file_min_bytes', path: 'answer.md', value: '10' },
      { id: 'reply', type: 'response_equals', value: 'DONE' },
    ],
    { toolCalls: [{ name: 'Skill', input: { skill: 'pstack:demo' } }], response: 'DONE', fixtureDir: dir, marker: 'VPS-ABC' },
  );
  assert.deepEqual(results.map((entry) => entry.ok), [true, true, true, true, true]);
});

test('assertions fail on the wrong skill and missing files', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'vps-test-'));
  const results = await evaluateAssertions(
    [
      { id: 'skill', type: 'skill_called', value: 'pstack:other' },
      { id: 'file', type: 'file_exists', path: 'nope.md' },
    ],
    { toolCalls: [{ name: 'Skill', input: { skill: 'pstack:demo' } }], response: '', fixtureDir: dir, marker: '' },
  );
  assert.deepEqual(results.map((entry) => entry.ok), [false, false]);
});

test('assertion paths cannot escape the fixture', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'vps-test-'));
  const results = await evaluateAssertions([{ id: 'escape', type: 'file_exists', path: '../../etc/passwd' }], { toolCalls: [], response: '', fixtureDir: dir, marker: '' });
  assert.equal(results[0].ok, false);
  assert.match(results[0].detail, /escapes fixture/);
});

test('report renders conclusion first and lists failures', () => {
  const report = renderReport({
    ok: false,
    plugin: { root: '/p', name: 'pstack', version: '0.0.1', treeHash: 'a'.repeat(64), treeHashAfter: 'a'.repeat(64) },
    zcodeVersion: '0.17.1',
    started: 't0',
    finished: 't1',
    features: ['zcode:catalog'],
    sessionsRun: 0,
    observations: [{ feature: 'zcode:catalog', kind: 'static', ok: false, assertions: [{ id: 'x', ok: false, detail: 'boom' }] }],
  });
  assert.match(report, /结论：未通过/);
  assert.match(report, /boom/);
});

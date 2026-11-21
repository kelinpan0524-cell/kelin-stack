import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const auditCheck = path.resolve(import.meta.dirname, '..', '..', 'kelin-audit', 'scripts', 'audit-check.mjs');
const decisionCheck = path.resolve(import.meta.dirname, '..', '..', 'kelin-decision-log', 'scripts', 'decision-check.mjs');

const write = async (name, body) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kelin-audit-'));
  const file = path.join(dir, name);
  await writeFile(file, body);
  return file;
};

const run = (script, file) => spawnSync(process.execPath, [script, file], { encoding: 'utf8' });

test('audit-check accepts a report with an explicit coverage table', async () => {
  const file = await write('audit.md', [
    '# Audit',
    '',
    '## 覆盖声明',
    '| 面 | 状态 | 范围 |',
    '| --- | --- | --- |',
    '| 正确性 | 已审 | src/a.ts |',
    '| 安全 | 未审 | 没读鉴权 |',
    '',
    '## 必须修',
    '- none',
  ].join('\n'));
  const result = run(auditCheck, file);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('audit-check rejects a missing coverage table and not-assessed claims of no problems', async () => {
  const missing = await write('audit.md', '# Audit\n\n## 必须修\n- none\n');
  assert.equal(run(auditCheck, missing).status, 1);

  const spoofedNote = await write('audit.md', [
    '## 覆盖声明',
    '| 面 | 状态 | 范围 |',
    '| --- | --- | --- |',
    '| 安全 | 未审 | notes mention audited only |',
  ].join('\n'));
  assert.equal(run(auditCheck, spoofedNote).status, 1);

  const contradictory = await write('audit.md', [
    '## 覆盖声明',
    '| 面 | 状态 | 范围 |',
    '| --- | --- | --- |',
    '| 安全 | 未审 | 没问题 |',
  ].join('\n'));
  const result = run(auditCheck, contradictory);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /not-assessed row cannot claim no problems/);
});

test('decision-check accepts pointer evidence and rejects prose or invalid fields', async () => {
  const good = await write('decisions.tsv', [
    'ts\tphase\tdecision\twhy\tevidence\tresult',
    '2026-11-11T00:00:00Z\t设计\t选 A\tB 更贵\tREADME.md:10\t待验证',
  ].join('\n'));
  assert.equal(run(decisionCheck, good).status, 0);

  const prose = await write('decisions.tsv', [
    'ts\tphase\tdecision\twhy\tevidence\tresult',
    '2026-11-11T00:00:00Z\t设计\t选 A\tB 更贵\t我们讨论后觉得可以\t待验证',
  ].join('\n'));
  assert.equal(run(decisionCheck, prose).status, 1);

  const badPhase = await write('decisions.tsv', [
    'ts\tphase\tdecision\twhy\tevidence\tresult',
    '2026-11-11T00:00:00Z\t随便\t选 A\tB 更贵\tREADME.md:10\t待验证',
  ].join('\n'));
  const result = run(decisionCheck, badPhase);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /invalid phase/);

  const startOnly = await write('decisions-start.tsv', [
    'ts\tphase\tdecision\twhy\tevidence\tresult',
    '2026-11-11T00:00:00Z\tstart\t开启新会话\t接续上次断点\tagent-123\tstart',
  ].join('\n'));
  const startOnlyRes = run(decisionCheck, startOnly);
  assert.equal(startOnlyRes.status, 1);
  assert.match(startOnlyRes.stdout, /no substantive decision rows/);

  const startWithDecision = await write('decisions-start-plus.tsv', [
    'ts\tphase\tdecision\twhy\tevidence\tresult',
    '2026-11-11T00:00:00Z\tstart\t开启新会话\t接续上次断点\tagent-123\tstart',
    '2026-11-11T00:05:00Z\t设计\t选 A\tB 更贵\tREADME.md:10\t待验证',
  ].join('\n'));
  assert.equal(run(decisionCheck, startWithDecision).status, 0);
});

test('audit-check handles fences, header schema and escaped pipes; decision-check validates ts and URL hosts', async () => {
  const fenced = await write('audit-fenced.md', [
    '```markdown',
    '## 覆盖声明',
    '| 面 | 状态 | 范围 |',
    '| --- | --- | --- |',
    '| 正确性 | 已审 | src/fake.ts |',
    '```',
  ].join('\n'));
  assert.equal(run(auditCheck, fenced).status, 1);

  const wrongHeader = await write('audit-header.md', [
    '## 覆盖声明',
    '| 模块 | 负责人 | 备注 |',
    '| --- | --- | --- |',
    '| core | 已审 | note |',
  ].join('\n'));
  const wrongRes = run(auditCheck, wrongHeader);
  assert.equal(wrongRes.status, 1);
  assert.match(wrongRes.stdout, /状态\/status/);

  const noSep = await write('audit-nosep.md', [
    '## 覆盖声明',
    '| 面 | 状态 | 范围 |',
    '| core | 已审 | note |',
  ].join('\n'));
  assert.equal(run(auditCheck, noSep).status, 1);

  const escapedPipe = await write('audit-escaped.md', [
    '## 覆盖声明',
    '| 面 | 状态 | 范围',
    '| --- | --- | ---',
    '| 安全 | 已审 | a \\| b',
  ].join('\n'));
  assert.equal(run(auditCheck, escapedPipe).status, 0);

  const badTs = await write('decisions-bad-ts.tsv', [
    'ts\tphase\tdecision\twhy\tevidence\tresult',
    'not-a-timestamp\t设计\t选 A\t理由\tREADME.md:10\t待验证',
  ].join('\n'));
  const badTsRes = run(decisionCheck, badTs);
  assert.equal(badTsRes.status, 1);
  assert.equal(JSON.parse(badTsRes.stdout).substantiveRows, 0);

  const bareUrl = await write('decisions-bare-url.tsv', [
    'ts\tphase\tdecision\twhy\tevidence\tresult',
    '2026-11-11T00:05:00Z\t设计\t选 A\t理由\thttps://\t待验证',
  ].join('\n'));
  assert.equal(run(decisionCheck, bareUrl).status, 1);
});

import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const script = path.resolve(import.meta.dirname, '..', '..', 'kelin-benchmark', 'scripts', 'bench-check.mjs');

const check = async (spec) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kelin-bench-'));
  const file = path.join(dir, 'bench.json');
  await writeFile(file, JSON.stringify(spec));
  const result = spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
  return { status: result.status, payload: JSON.parse(result.stdout || '{}') };
};

const good = {
  claim: 'export is 30% faster at p50 on the 60k-row dataset',
  limiter: 'JSON parsing on one core',
  runs: 7,
  median: { before: 41, after: 33 },
  range: { before: [39, 44], after: [32, 35] },
  errors: 0,
  workHappened: true,
  verdict: 'faster',
};

test('accepts a complete, reproducible benchmark', async () => {
  const result = await check(good);
  assert.equal(result.status, 0, JSON.stringify(result.payload));
  assert.equal(result.payload.ok, true);
  assert.deepEqual(result.payload.problems, []);
});

test('rejects a missing limiter', async () => {
  const { limiter, ...rest } = good;
  const result = await check(rest);
  assert.equal(result.status, 1);
  assert.ok(result.payload.problems.some((entry) => entry.includes('limiter')));
});

test('requires five runs unless explicitly a ballpark', async () => {
  const result = await check({ ...good, runs: 1 });
  assert.equal(result.status, 1);
  assert.ok(result.payload.problems.some((entry) => entry.includes('at least 5')));

  const ballpark = await check({ ...good, runs: 1, ballpark: true, verdict: 'no measurable difference' });
  assert.equal(ballpark.status, 0, JSON.stringify(ballpark.payload));
  assert.equal(ballpark.payload.ballpark, true);
});

test('rejects a verdict that contradicts the medians', async () => {
  const result = await check({ ...good, median: { before: 33, after: 41 } });
  assert.equal(result.status, 1);
  assert.ok(result.payload.problems.some((entry) => entry.includes('faster requires')));
});

test('warns when ranges overlap', async () => {
  const result = await check({
    ...good,
    median: { before: 40, after: 40 },
    range: { before: [30, 42], after: [32, 44] },
    verdict: 'no measurable difference',
  });
  assert.equal(result.status, 0, JSON.stringify(result.payload));
  assert.ok(result.payload.warnings.some((entry) => entry.includes('overlap')));
});

test('rejects workHappened false or unexplained errors with directional verdict, and verifies raw samples', async () => {
  const noWork = await check({ ...good, workHappened: false });
  assert.equal(noWork.status, 1);
  assert.ok(noWork.payload.problems.some((e) => e.includes('workHappened false')));

  const withErrors = await check({ ...good, errors: 2 });
  assert.equal(withErrors.status, 1);
  assert.ok(withErrors.payload.problems.some((e) => e.includes('errors > 0')));

  const blankExplanation = await check({ ...good, errors: 2, errorsExplained: '   ' });
  assert.equal(blankExplanation.status, 1);
  assert.ok(blankExplanation.payload.problems.some((e) => e.includes('errors > 0')));

  const badMedian = await check({
    ...good,
    samples: { before: [40, 40, 41, 42, 44], after: [32, 33, 33, 34, 35], alternating: true },
  });
  assert.equal(badMedian.status, 1);
  assert.ok(badMedian.payload.problems.some((e) => e.includes('disagrees with samples')));

  const goodSamples = await check({
    ...good,
    runs: 5,
    median: { before: 41, after: 33 },
    range: { before: [39, 44], after: [32, 35] },
    samples: { before: [39, 41, 44, 40, 42], after: [32, 35, 33, 33, 34], alternating: true },
  });
  assert.equal(goodSamples.status, 0, JSON.stringify(goodSamples.payload));
});

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const script = path.resolve(import.meta.dirname, '..', '..', 'kelin-docs', 'scripts', 'doc-coverage.mjs');

const run = (dir) => spawnSync(process.execPath, [script, '--root', dir, '--check'], { encoding: 'utf8' });

test('flags skills that only appear in the generated index', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kelin-doc-coverage-'));
  for (const name of ['kelin-a', 'kelin-b', 'kelin-c']) {
    await mkdir(path.join(dir, 'skills', name), { recursive: true });
    await writeFile(path.join(dir, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: x\n---\n\n# ${name}\n`);
  }
  await mkdir(path.join(dir, 'docs'), { recursive: true });
  await writeFile(path.join(dir, 'README.md'), '- kelin-a\n');
  await writeFile(path.join(dir, 'docs', 'skills.md'), '- kelin-a\n- kelin-b\n- kelin-c\n');
  await writeFile(path.join(dir, 'docs', 'guide.md'), '- kelin-b\n');

  const result = run(dir);
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.uncovered, ['kelin-c']);

  await writeFile(path.join(dir, 'README.md'), '- kelin-a\n- kelin-c\n');
  const fixed = run(dir);
  assert.equal(fixed.status, 0, fixed.stdout + fixed.stderr);
});

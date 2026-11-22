import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const script = path.resolve(import.meta.dirname, '..', 'scripts', 'review-check.mjs');

const initRepo = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kelin-review-check-'));
  const git = (...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  writeFileSync(path.join(dir, '.gitignore'), '.kelin/\n');
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('add', '.gitignore');
  git('commit', '--allow-empty', '-q', '-m', 'init');
  return dir;
};

test('review-check --write refuses to stamp CURRENT without a review report', () => {
  const dir = initRepo();
  try {
    const res = spawnSync(process.execPath, [script, '--root', dir, '--write'], { encoding: 'utf8' });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /report/i);
    assert.equal(existsSync(path.join(dir, '.kelin', 'review.json')), false, 'no stamp file may be written without a report');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('review-check --write stamps CURRENT with a report and stays CURRENT on re-check', () => {
  const dir = initRepo();
  try {
    mkdirSync(path.join(dir, '.kelin'), { recursive: true });
    writeFileSync(path.join(dir, '.kelin', 'review.md'), '## 审查结论\nP0: 0 / P1: 0\nCLEAN\n');
    const writeRes = spawnSync(process.execPath, [script, '--root', dir, '--write'], { encoding: 'utf8' });
    assert.equal(writeRes.status, 0, writeRes.stdout + writeRes.stderr);
    assert.equal(JSON.parse(writeRes.stdout).status, 'CURRENT');
    const checkRes = spawnSync(process.execPath, [script, '--root', dir], { encoding: 'utf8' });
    assert.equal(checkRes.status, 0, checkRes.stdout + checkRes.stderr);
    assert.equal(JSON.parse(checkRes.stdout).status, 'CURRENT');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('review-check --write refuses empty or verdict-free reports', () => {
  const dir = initRepo();
  try {
    mkdirSync(path.join(dir, '.kelin'), { recursive: true });
    writeFileSync(path.join(dir, '.kelin', 'review.md'), '   \n');
    const empty = spawnSync(process.execPath, [script, '--root', dir, '--write'], { encoding: 'utf8' });
    assert.notEqual(empty.status, 0);
    assert.match(empty.stderr, /verdict/i);
    assert.equal(existsSync(path.join(dir, '.kelin', 'review.json')), false, 'no stamp may be written for an empty report');

    writeFileSync(path.join(dir, '.kelin', 'review.md'), '随手记：今天天气不错\n');
    const noVerdict = spawnSync(process.execPath, [script, '--root', dir, '--write'], { encoding: 'utf8' });
    assert.notEqual(noVerdict.status, 0);
    assert.match(noVerdict.stderr, /verdict/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a stamp-only receipt without a report hash never reads as CURRENT', () => {
  const dir = initRepo();
  try {
    mkdirSync(path.join(dir, '.kelin'), { recursive: true });
    const printed = spawnSync(process.execPath, [script, '--root', dir, '--print'], { encoding: 'utf8' });
    assert.equal(printed.status, 0, printed.stdout + printed.stderr);
    const { fingerprint } = JSON.parse(printed.stdout);
    writeFileSync(
      path.join(dir, '.kelin', 'review.json'),
      `${JSON.stringify({ fingerprint, verdict: 'stamp-only', createdAt: new Date().toISOString() }, null, 2)}\n`,
    );
    const check = spawnSync(process.execPath, [script, '--root', dir], { encoding: 'utf8' });
    assert.notEqual(check.status, 0, 'stamp-only receipt must not pass as CURRENT');
    const payload = JSON.parse(check.stdout);
    assert.equal(payload.status, 'UNVERIFIED');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('review-check --write refuses a heading-only template report (no verdict record)', () => {
  const dir = initRepo();
  try {
    mkdirSync(path.join(dir, '.kelin'), { recursive: true });
    writeFileSync(path.join(dir, '.kelin', 'review.md'), '## 审查结论\n');
    const res = spawnSync(process.execPath, [script, '--root', dir, '--write'], { encoding: 'utf8' });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /verdict/i);
    assert.equal(existsSync(path.join(dir, '.kelin', 'review.json')), false, 'heading-only template must not stamp');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('review-check --write refuses reports declaring unresolved review failure (never CURRENT)', () => {
  const dir = initRepo();
  try {
    mkdirSync(path.join(dir, '.kelin'), { recursive: true });
    writeFileSync(path.join(dir, '.kelin', 'review.md'), '审查失败：必需审查者超时\n');
    const res = spawnSync(process.execPath, [script, '--root', dir, '--write'], { encoding: 'utf8' });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /(verdict|失败)/i);
    assert.equal(existsSync(path.join(dir, '.kelin', 'review.json')), false, 'failure declaration must not stamp');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('review-check --write requires an explicit machine verdict line (Chinese conclusions alone are not enough)', () => {
  const dir = initRepo();
  try {
    mkdirSync(path.join(dir, '.kelin'), { recursive: true });
    writeFileSync(path.join(dir, '.kelin', 'review.md'), '## 审查结论\n结论：P0: 0 / P1: 0\n');
    const res = spawnSync(process.execPath, [script, '--root', dir, '--write'], { encoding: 'utf8' });
    assert.notEqual(res.status, 0);
    assert.equal(existsSync(path.join(dir, '.kelin', 'review.json')), false, 'report without a verdict line must not stamp');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('review-check --write refuses failure declarations in headings and accepts findings prose with a verdict line', () => {
  const dir = initRepo();
  try {
    mkdirSync(path.join(dir, '.kelin'), { recursive: true });
    writeFileSync(path.join(dir, '.kelin', 'review.md'), '## 审查失败：必需审查者超时\n');
    const heading = spawnSync(process.execPath, [script, '--root', dir, '--write'], { encoding: 'utf8' });
    assert.notEqual(heading.status, 0, 'failure declaration in a heading must not stamp');

    writeFileSync(path.join(dir, '.kelin', 'review.md'), '## 审查结论\n10 起审查失败均已在上一轮关闭\n无审查失败\nFINDINGS\n');
    const findings = spawnSync(process.execPath, [script, '--root', dir, '--write'], { encoding: 'utf8' });
    assert.equal(findings.status, 0, findings.stdout + findings.stderr);
    assert.equal(JSON.parse(findings.stdout).status, 'CURRENT');

    writeFileSync(path.join(dir, '.kelin', 'review.md'), '## 审查结论\n无审查失败\n结论：通过\nCLEAN\n');
    const clean = spawnSync(process.execPath, [script, '--root', dir, '--write'], { encoding: 'utf8' });
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);
    assert.equal(JSON.parse(clean.stdout).verdict, 'clean');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verdict line inside a fenced code block counts as the machine contract', () => {
  const dir = initRepo();
  try {
    mkdirSync(path.join(dir, '.kelin'), { recursive: true });
    writeFileSync(path.join(dir, '.kelin', 'review.md'), '## 审查结论\n```\nCLEAN\n```\n');
    const res = spawnSync(process.execPath, [script, '--root', dir, '--write'], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.equal(JSON.parse(res.stdout).status, 'CURRENT');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('explicit --review path enforces the verdict line too (stale-check cannot bypass the new gate)', () => {
  const dir = initRepo();
  try {
    mkdirSync(path.join(dir, '.kelin'), { recursive: true });
    const reportPath = path.join(dir, '.kelin', 'review.md');
    writeFileSync(reportPath, '# Review\n结论：无问题\n');
    const printed = spawnSync(process.execPath, [script, '--root', dir, '--print'], { encoding: 'utf8' });
    assert.equal(printed.status, 0, printed.stdout + printed.stderr);
    const { fingerprint } = JSON.parse(printed.stdout);

    writeFileSync(reportPath, `# Review\nWorktree-Fingerprint: ${fingerprint}\n结论：无问题\n`);
    const noVerdict = spawnSync(process.execPath, [script, '--root', dir, '--review', '.kelin/review.md'], { encoding: 'utf8' });
    assert.notEqual(noVerdict.status, 0, 'verdict-line-less report must not read as CURRENT via --review');
    assert.equal(JSON.parse(noVerdict.stdout).status, 'UNVERIFIED');

    writeFileSync(reportPath, `# Review\nWorktree-Fingerprint: ${fingerprint}\nCLEAN\n`);
    const withVerdict = spawnSync(process.execPath, [script, '--root', dir, '--review', '.kelin/review.md'], { encoding: 'utf8' });
    assert.equal(withVerdict.status, 0, withVerdict.stdout + withVerdict.stderr);
    assert.equal(JSON.parse(withVerdict.stdout).status, 'CURRENT');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('review-check --write accepts an explicitly passed report file', () => {
  const dir = initRepo();
  try {
    writeFileSync(path.join(dir, 'review.md'), '## 审查结论\nP0: 0 / P1: 0\nCLEAN\n');
    const res = spawnSync(process.execPath, [script, '--root', dir, '--write', '--review', 'review.md'], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.equal(JSON.parse(res.stdout).status, 'CURRENT');
    assert.equal(JSON.parse(res.stdout).verdict, 'clean');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

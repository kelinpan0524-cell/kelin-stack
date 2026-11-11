import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.cache', 'out', 'tmp', 'vendor']);
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.go$/;

const walk = async (root, current = root, depth = 0, acc = []) => {
  if (depth > 6 || acc.length > 3000) return acc;
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (SKIP.has(entry.name)) continue;
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) await walk(root, full, depth + 1, acc);
    else if (TEST_FILE.test(path.relative(root, full))) acc.push(path.relative(root, full));
  }
  return acc;
};

const TEST_START = /^\s*(?:it|test)(?:\.skip|\.only)?\s*\(|^\s*xit\s*\(|^\s*xdescribe\s*\(|^\s*def test_|^func Test/;
const ASSERTION = /\bassert\b|\bexpect\s*\(|\.should\b|\bt\.(?:Error|Fatal|Errorf|Fatalf)\b|\brequire\.|\bassertEqual\b|\bassert\.True\b|panic\(/;
const SKIPPED = /\.skip\s*\(|\bxit\s*\(|\bxdescribe\s*\(|@pytest\.mark\.skip|unittest\.skip|\bt\.Skip\(|@Ignore\b/;
const SELF_COMPARE = [
  /expect\s*\(\s*([^)]+)\s*\)\.(?:toBe|toEqual|toStrictEqual)\s*\(\s*\1\s*\)/,
  /assert\.equal\(\s*([^,]+),\s*\1\s*\)/,
];
const SNAPSHOT = /toMatchSnapshot\s*\(/;

const blocks = (lines) => {
  const starts = [];
  lines.forEach((line, index) => {
    if (TEST_START.test(line)) starts.push(index);
  });
  return starts.map((start, index) => ({
    start,
    end: index + 1 < starts.length ? starts[index + 1] : lines.length,
    body: lines.slice(start, index + 1 < starts.length ? starts[index + 1] : lines.length).join('\n'),
  }));
};

export const auditTests = async (root) => {
  const dir = path.resolve(root);
  const files = await walk(dir);
  const candidates = [];
  let tests = 0;
  for (const file of files) {
    let text;
    try {
      text = await readFile(path.join(dir, file), 'utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (const block of blocks(lines)) {
      tests += 1;
      const line = block.start + 1;
      if (SKIPPED.test(lines[block.start])) {
        candidates.push({ file, line, pattern: 'skipped', evidence: lines[block.start].trim().slice(0, 160), question: '这个跳过是临时的还是永久退役？' });
        continue;
      }
      if (SELF_COMPARE.some((pattern) => pattern.test(block.body))) {
        candidates.push({ file, line, pattern: 'self-comparison', evidence: lines[block.start].trim().slice(0, 160), question: '这个断言是不是自己和自己比，永远通过？' });
        continue;
      }
      if (SNAPSHOT.test(block.body) && !ASSERTION.test(block.body.replace(/expect\s*\([^)]*\)\.toMatchSnapshot\s*\([^)]*\)/g, ''))) {
        candidates.push({ file, line, pattern: 'snapshot-only', evidence: lines[block.start].trim().slice(0, 160), question: '快照之外有没有行为断言？' });
        continue;
      }
      if (!ASSERTION.test(block.body)) {
        candidates.push({ file, line, pattern: 'no-assertion', evidence: lines[block.start].trim().slice(0, 160), question: '这个测试失败时能抓到什么行为？' });
      }
    }
  }
  const summary = candidates.reduce((acc, entry) => {
    acc[entry.pattern] = (acc[entry.pattern] || 0) + 1;
    return acc;
  }, {});
  return { root: dir, scanned: { files: files.length, tests }, summary, candidates };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf('--root');
  const root = rootIndex >= 0 && args[rootIndex + 1] ? args[rootIndex + 1] : process.cwd();
  const result = await auditTests(root);
  console.log(JSON.stringify({ ok: args.includes('--fail') ? result.candidates.length === 0 : true, ...result }, null, 2));
  process.exit(args.includes('--fail') && result.candidates.length ? 1 : 0);
}

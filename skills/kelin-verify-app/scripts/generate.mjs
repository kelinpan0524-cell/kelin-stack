import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { scanApp } from './scan-app.mjs';

const USAGE = `Usage: node generate.mjs [--root <dir>] [--name <app>] [--out <dir>] [--write] [--sync] [--force]

Generate a project-local verify-<app> skill (preview by default; pass --write to save).

Options:
  --root <dir>   Project root to scan (default: cwd)
  --name <app>   Override detected app name
  --out <dir>    Output skills directory (default: <root>/.zcode/skills)
  --write        Write generated files to disk
  --sync         Incrementally add missing features without overwriting edited ones
  --force        Overwrite existing files (use only for deliberate regeneration)
  -h, --help     Show this help message and exit

Examples:
  node generate.mjs --root .
  node generate.mjs --root . --write --sync`;

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  console.log(USAGE);
  process.exit(0);
}

const VALUE_FLAGS = new Set(['--root', '--name', '--out']);
const BOOL_FLAGS = new Set(['--write', '--sync', '--force']);
const options = new Map();
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (VALUE_FLAGS.has(arg)) {
    if (options.has(arg)) {
      console.error(`Duplicate option: ${arg}\n\n${USAGE}`);
      process.exit(2);
    }
    const value = args[i + 1];
    if (!value || value.startsWith('-')) {
      console.error(`${arg} requires a value\n\n${USAGE}`);
      process.exit(2);
    }
    options.set(arg, value);
    i += 1;
  } else if (BOOL_FLAGS.has(arg)) {
    options.set(arg, true);
  } else {
    console.error(`Unknown argument: ${arg}\n\n${USAGE}`);
    process.exit(2);
  }
}
const option = (name, fallback = '') => options.get(name) || fallback;

const root = path.resolve(option('--root', process.cwd()));
if (!existsSync(root) || !statSync(root).isDirectory()) {
  console.error(`--root must be an existing directory: ${root}`);
  process.exit(2);
}
const gitHead = (() => {
  const res = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : null;
})();
const scan = await scanApp(root);
const appName = option('--name', scan.name);
const slug = appName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'app';
const outBase = path.resolve(option('--out', path.join(root, '.zcode', 'skills')));
const skillDir = path.join(outBase, `verify-${slug}`);
const write = Boolean(options.get('--write'));
const sync = Boolean(options.get('--sync'));
const force = Boolean(options.get('--force'));

const featureSlug = (feature) => (
  feature.id
  || feature.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
  || 'feature'
);

const skillBody = `---
name: verify-${slug}
description: 项目本地验证 skill：启动、体检、驱动、留证、清理。用于 ${appName}。
---

# 验证 ${appName}

这是给下一个 agent 看的验证手册。它会在任务中途冷读，所以写清命令和判断标准，不写背景故事。

## 启动

- 命令：\`${scan.launch || '未识别，先问用户'}\`
- 就绪判断：${scan.readyHint}
- 清理：记录自己启动的进程和端口，结束时只关自己启动的。

## 体检

一条只读检查，回答“这个实例值得驱动吗”：

- 进程在、端口属于我们；
- 版本或构建号对；
- 登录/权限有效；
- 数据目录是隔离的，不碰用户真实数据。

## 驱动

按 [features/README.md](features/README.md) 的功能地图走真实用户路径：

- 优先稳定选择器：ARIA、data-*、路由、命令名；
- 不用坐标、不用内部 setter、不用测试专用端点；
- 一次只驱动一个功能，避免两个实例抢端口和数据。

## 留证

每条验证至少留一种证据：

- 截图或终端记录；
- HTTP 响应体、状态码、日志片段；
- 退出码；
- 副作用：文件、数据库行、消息。

证据放在 \`.kelin/verify/<timestamp>/\`，清理时不能删证据。

## 清理

- 只关自己启动的进程，不按进程名杀；
- 删除本次创建的临时数据和端口；
- 确认证据还在。

## 规则

- 一次只开一个实例；24GB 机器不并行跑构建和浏览器；
- 用户路径失败就报失败，不改弱旅程来通过；
- 旅程失败后先重跑体检或重置状态，记清尝试入口与缺失前置条件，再决定是否继续；
- 证据标准写在功能文件里，模型自述不算；
- 生成后必须真跑一遍：启动、体检、驱动一个功能、留证、清理，再确认证据还在。

## 验证

本 skill 由 \`kelin-verify-app\` 生成；它是项目本地 skill，不参与插件自身的 live recipe。
`;

const featureRow = (feature) => `| ${feature.id || featureSlug(feature)} | ${feature.name} | ${feature.howToReach} | ${feature.drive} | ${feature.endState} |`;

const featureIndex = `# ${appName} 功能地图

> 由 \`kelin-verify-app\` 生成。新增功能时跑 \`--write --sync\` 增量补全，已手改文件不会被覆盖。

| ID | 功能 | 用户怎么到达 | 怎么驱动 | 成功的样子 |
| --- | --- | --- | --- | --- |
${scan.features.map((feature) => featureRow(feature)).join('\n')}
`;

const featureFiles = scan.features.map((feature) => {
  const id = featureSlug(feature);
  const body = `# ${feature.name}

- feature_id: \`${id}\`
- kind: \`${feature.kind || 'flow'}\`
- entrypoint: \`${feature.entrypoint || feature.howToReach}\`
- sync_commit: \`${gitHead || 'untracked'}\`
- evidence_dir: \`.kelin/verify/<timestamp>/${id}/\`

## 子功能

- [待填] 这个功能包含哪些子操作。

## 用户怎么到达

${feature.howToReach}

## 怎么驱动

${feature.drive}

## 成功的样子

${feature.endState}

## 坑

- 首次运行后把真实选择器、命令和前置数据补到这里。
- 旅程失败就报失败，不要改弱它来通过。
`;
  return { id, name: `${id}.md`, feature, body };
});

const rootReal = realpathSync(root);
const isInsideRoot = (parentReal, childReal) => {
  const rel = path.relative(parentReal, childReal);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
const assertSafeTarget = (targetPath) => {
  const rel = path.relative(path.resolve(root), path.resolve(targetPath));
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Refusing output outside project root: ${targetPath}`);
  }
  const parts = rel ? rel.split(path.sep).filter(Boolean) : [];
  let cursor = path.resolve(root);
  for (const part of parts) {
    cursor = path.join(cursor, part);
    const st = lstatSync(cursor, { throwIfNoEntry: false });
    if (!st) break;
    if (st.isSymbolicLink()) {
      throw new Error(`Refusing symlink in output path: ${path.relative(root, cursor)}`);
    }
    if (!isInsideRoot(rootReal, realpathSync(cursor))) {
      throw new Error(`Refusing path escaping project root: ${path.relative(root, cursor)}`);
    }
  }
};

const featuresDir = path.join(skillDir, 'features');
const existingFeatureFiles = existsSync(featuresDir)
  ? (await readdir(featuresDir)).filter((entry) => entry.endsWith('.md') && entry !== 'README.md').sort()
  : [];

const existingMeta = [];
for (const file of existingFeatureFiles) {
  const full = path.join(featuresDir, file);
  const st = lstatSync(full, { throwIfNoEntry: false });
  if (!st || st.isSymbolicLink() || !st.isFile()) continue;
  const raw = await readFile(full, 'utf8');
  const ep = /^\s*-\s*entrypoint:\s*`([^`]+)`/m.exec(raw);
  const fid = /^\s*-\s*feature_id:\s*`([^`]+)`/m.exec(raw);
  const h1 = /^#\s+(.+)$/m.exec(raw);
  existingMeta.push({
    file,
    entrypoint: ep ? ep[1].trim() : '',
    featureId: fid ? fid[1].trim() : '',
    heading: h1 ? h1[1].trim() : '',
  });
}

const matchedExistingFiles = new Set();
const added = [];
const preserved = [];
const matchedByPlannedName = new Map();
for (const item of featureFiles) {
  const ep = item.feature.entrypoint || '';
  const match = existingMeta.find((meta) => ep && meta.entrypoint === ep)
    || existingMeta.find((meta) => meta.heading === item.feature.name || (ep && meta.heading === `页面或接口 ${ep}`))
    || existingMeta.find((meta) => meta.file === item.name && (!meta.entrypoint || meta.entrypoint === ep));
  if (match) {
    matchedExistingFiles.add(match.file);
    matchedByPlannedName.set(item.name, match.file);
    preserved.push(match.file);
  } else {
    added.push(item.name);
  }
}

const diff = {
  added,
  preserved,
  orphaned: existingFeatureFiles.filter((name) => !matchedExistingFiles.has(name)),
};

const files = [
  { path: path.join(skillDir, 'SKILL.md'), body: skillBody, kind: 'skill' },
  { path: path.join(featuresDir, 'README.md'), body: featureIndex, kind: 'index' },
  ...featureFiles.map((entry) => ({ path: path.join(featuresDir, entry.name), body: entry.body, kind: 'feature', entry })),
];

if (!write) {
  console.log(JSON.stringify({
    ok: true,
    preview: true,
    sync,
    skillDir,
    scan,
    diff,
    files: files.map((entry) => ({ path: path.relative(root, entry.path), bytes: Buffer.byteLength(entry.body) })),
  }, null, 2));
  process.exit(0);
}

try {
  assertSafeTarget(outBase);
  assertSafeTarget(skillDir);
  for (const entry of files) assertSafeTarget(entry.path);
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

const conflicts = files.filter((entry) => existsSync(entry.path)).map((entry) => path.relative(root, entry.path));
if (conflicts.length && !force && !sync) {
  console.log(JSON.stringify({ ok: false, reason: 'target exists; pass --force or --sync', conflicts, diff }, null, 2));
  process.exit(1);
}

if (sync && !force) {
  const written = [];
  const preservedOut = [];
  for (const file of files) {
    await mkdir(path.dirname(file.path), { recursive: true });
    if (file.kind === 'index' && existsSync(file.path)) {
      const current = await readFile(file.path, 'utf8');
      const fiveCol = current.includes('| ID |');
      const missingRows = featureFiles
        .filter((item) => !matchedByPlannedName.has(item.name) && !current.includes(`| ${item.id} |`) && !current.includes(`| ${item.feature.name} |`))
        .map((item) => (fiveCol
          ? featureRow(item.feature)
          : `| ${item.feature.name} | ${item.feature.howToReach} | ${item.feature.drive} | ${item.feature.endState} |`));
      if (missingRows.length) {
        const next = `${current.trimEnd()}\n${missingRows.join('\n')}\n`;
        await writeFile(file.path, next);
        written.push(path.relative(root, file.path));
      } else {
        preservedOut.push(path.relative(root, file.path));
      }
      continue;
    }
    if (file.kind === 'feature' && matchedByPlannedName.has(file.entry.name)) {
      preservedOut.push(path.relative(root, path.join(featuresDir, matchedByPlannedName.get(file.entry.name))));
      continue;
    }
    if (existsSync(file.path)) {
      preservedOut.push(path.relative(root, file.path));
      continue;
    }
    await writeFile(file.path, file.body);
    written.push(path.relative(root, file.path));
  }
  console.log(JSON.stringify({ ok: true, preview: false, sync: true, skillDir, written, preserved: preservedOut, diff }, null, 2));
  process.exit(0);
}

for (const entry of files) {
  await mkdir(path.dirname(entry.path), { recursive: true });
  await writeFile(entry.path, entry.body);
}

console.log(JSON.stringify({ ok: true, preview: false, sync: false, skillDir, written: files.map((entry) => path.relative(root, entry.path)), diff }, null, 2));

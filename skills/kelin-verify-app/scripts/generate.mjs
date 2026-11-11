import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { scanApp } from './scan-app.mjs';

const args = process.argv.slice(2);
const option = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const root = path.resolve(option('--root', process.cwd()));
const scan = await scanApp(root);
const appName = option('--name', scan.name);
const slug = appName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'app';
const outBase = path.resolve(option('--out', path.join(root, '.zcode', 'skills')));
const skillDir = path.join(outBase, `verify-${slug}`);
const write = args.includes('--write');
const force = args.includes('--force');

const featureSlug = (name, index) => `${String(index + 1).padStart(2, '0')}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'feature'}`;

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
- 证据标准写在功能文件里，模型自述不算；
- 生成后必须真跑一遍：启动、体检、驱动一个功能、留证、清理，再确认证据还在。

## 验证

本 skill 由 \`kelin-verify-app\` 生成；它是项目本地 skill，不参与插件自身的 live recipe。
`;

const featureIndex = `# ${appName} 功能地图

> 由 \`kelin-verify-app\` 生成。新增功能时补一行，并同步一个功能文件。

| 功能 | 用户怎么到达 | 怎么驱动 | 成功的样子 |
| --- | --- | --- | --- |
${scan.features.map((feature) => `| ${feature.name} | ${feature.howToReach} | ${feature.drive} | ${feature.endState} |`).join('\n')}
`;

const featureFiles = scan.features.map((feature, index) => {
  const body = `# ${feature.name}

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
  return { name: `${featureSlug(feature.name, index)}.md`, body };
});

const files = [
  { path: path.join(skillDir, 'SKILL.md'), body: skillBody },
  { path: path.join(skillDir, 'features', 'README.md'), body: featureIndex },
  ...featureFiles.map((entry) => ({ path: path.join(skillDir, 'features', entry.name), body: entry.body })),
];

if (!write) {
  console.log(JSON.stringify({ ok: true, preview: true, skillDir, scan, files: files.map((entry) => ({ path: path.relative(root, entry.path), bytes: Buffer.byteLength(entry.body) })) }, null, 2));
  process.exit(0);
}

const conflicts = files.filter((entry) => existsSync(entry.path)).map((entry) => path.relative(root, entry.path));
if (conflicts.length && !force) {
  console.log(JSON.stringify({ ok: false, reason: 'target exists; pass --force to overwrite', conflicts }, null, 2));
  process.exit(1);
}

for (const entry of files) {
  await mkdir(path.dirname(entry.path), { recursive: true });
  await writeFile(entry.path, entry.body);
}

console.log(JSON.stringify({ ok: true, preview: false, skillDir, written: files.map((entry) => path.relative(root, entry.path)) }, null, 2));

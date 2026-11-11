---
name: kelin-verify-app
description: 给项目生成一套本地验证 skill：启动、体检、驱动真实用户路径、留证据、清理，并维护功能地图。用于“这个项目怎么验收”“给仓库做一套可重复验证”“每次都说能跑但没有证据”的场景。
---

# 项目级验证 skill

`kelin-verify-stack` 验证插件自己；这个 skill 验证**你的项目**。目标不是再写一份测试文档，是让下一个 agent 能照着命令真跑一遍并留下证据。

## 什么时候用

- 项目没有脚本化的验收方式，每次靠人点；
- 交付前要证明“用户路径真的能走通”；
- 功能地图和代码对不上，想建立可维护的验证源。

## 三步

### 1. 扫描

```sh
node skills/kelin-verify-app/scripts/scan-app.mjs --root .
```

输出：项目名、技术栈、启动命令、就绪判断、测试命令、端口、识别到的页面/接口/CLI 功能。

识别不了启动命令时不要猜，先问用户。

### 2. 预览

```sh
node skills/kelin-verify-app/scripts/generate.mjs --root .
```

只打印将写入的文件，不落盘。确认功能列表和启动命令没问题再写。

### 3. 写入

```sh
node skills/kelin-verify-app/scripts/generate.mjs --root . --write
```

默认写到 `.zcode/skills/verify-<app>/`；项目用 `.agents/skills/` 时加 `--out .agents/skills`。已存在时默认拒绝覆盖，确认后用 `--force`。

## 生成的结构

```text
verify-<app>/
├── SKILL.md
└── features/
    ├── README.md
    └── 01-....md
```

`SKILL.md` 固定五段：

1. **启动**：确切命令、就绪判断、清理；
2. **体检**：一条只读检查，判断实例值不值得驱动；
3. **驱动**：按功能地图走真实用户路径；
4. **留证**：截图、终端记录、响应体、退出码、副作用，放到 `.kelin/verify/<timestamp>/`；
5. **清理**：只关自己启动的，证据不能删。

## 功能地图怎么维护

- 每个用户可见功能一个文件，四个 H2：子功能、用户怎么到达、怎么驱动、坑；
- 代码新增功能后重跑扫描；功能列表变化时用 `--force` 重新生成，再人工补真实选择器和前置数据；
- 一个功能一次只驱动一个实例；需要覆盖多个功能就顺序跑；
- 证据必须能在清理后仍然存在；证据被清理吃掉，这次验证判失败。

## 生成后必须做一次

1. 启动；
2. 体检；
3. 驱动**一个**功能；
4. 留证；
5. 清理；
6. 确认证据还在。

生成后没跑过的 skill 只是草稿，不算交付。

## 边界

- 不替用户改业务代码；只生成验证手册和功能地图；
- 不并行起多个实例，不并行跑构建和浏览器；
- 不为了让旅程通过而改弱断言或跳过步骤；
- 浏览器自动化复用现有 `browser-use`，不另起守护进程。

## 验证

```sh
node --test skills/kelin-verify-stack/tests/verify-app.test.mjs
```

本 skill 有脚本和单元测试，没有 live recipe。

---
name: kelin-verify-app
description: 给项目生成一套本地验证 skill：启动、体检、驱动真实用户路径、留证据、清理，并维护功能地图。用于“这个项目怎么验收”“给仓库做一套可重复验证”“每次都说能跑但没有证据”的场景。
---

# 项目级验证 skill

> 命令里的 `$SKILL_DIR` 指本 Skill 所在目录的绝对路径，执行前先替换成实际路径。

`kelin-verify-stack` 验证插件自己；这个 skill 验证**你的项目**。目标不是再写一份测试文档，是让下一个 agent 能照着命令真跑一遍并留下证据。

## 什么时候用

项目缺脚本化验收、交付前要证明用户路径能走通，或要建立可维护的功能地图时用。

## 三步

1. **扫描**（识别不了启动命令先问用户，不要猜）：
```sh
node "$SKILL_DIR"/scripts/scan-app.mjs --root .
```
2. **预览**（只打印文件清单不落盘，确认后再写）：
```sh
node "$SKILL_DIR"/scripts/generate.mjs --root .
```
3. **写入**（默认 `.zcode/skills/verify-<app>/`，另选目录加 `--out .agents/skills`；`--help` 看参数）：
```sh
node "$SKILL_DIR"/scripts/generate.mjs --root . --write
```

## 生成的结构

```text
verify-<app>/
├── SKILL.md
└── features/
    ├── README.md
    └── <feature-id>.md
```

`SKILL.md` 固定五段：

1. **启动**：确切命令、就绪判断、清理；
2. **体检**：一条只读检查，判断实例值不值得驱动；
3. **驱动**：按功能地图走真实用户路径；
4. **留证**：截图、终端记录、响应体、退出码、副作用，放到 `.kelin/verify/<timestamp>/`；
5. **清理**：只关自己启动的，证据不能删。

## 定期维护循环

- 新增入口后跑 `generate.mjs --root . --write --sync` 增量补全并保留手改，不靠 `--force` 覆盖；
- 按 `diff.added / orphaned` 人工复核孤儿功能与 `sync_commit` 漂移；
- 失败分三类：**地图漂移**改地图；**驱动缺口**修驱动重跑；**产品真坏**只报失败，不改弱旅程；
- 旅程失败后先重跑体检或重置状态，记清尝试入口与缺失前置条件再继续（进程活着≠状态健康）；
- 关键新断言先在已知坏结果上确认能失败；CLI/TUI 驱动见 [references/cli-harness.md](references/cli-harness.md)。

## 生成后必须真跑一轮

启动 → 体检 → 驱动**一个**功能 → 留证 → 清理 → 确认证据仍在（没跑过只是草稿，不算交付）。

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

## 下游衔接

| 下一步 | 去哪 |
| --- | --- |
| 项目 verify 生成完 | 交给 `kelin-verify` 消费 |

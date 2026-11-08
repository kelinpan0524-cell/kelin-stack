---
name: kelin-docs
description: 从 skills 目录生成文档：skill 索引、命令速查、一页 agent digest，并做 drift check，手改生成文件会被 CI 拦。用户说“更新文档索引”“生成 agents digest”“文档和 skill 对不上”时使用。
---

# 生成式文档

手写的索引一定会漂移：加了 skill 忘了改数量、改了口号忘了改说明。这里的原则是**从源头生成，CI 检查**。

## 生成什么

```sh
node skills/kelin-docs/scripts/gen-docs.mjs
node skills/kelin-docs/scripts/gen-docs.mjs --check
```

- `docs/skills.md`：全部 skill 的索引，含命令、用途、是否有脚本、是否有 live recipe；
- `agents-digest/kelin-AGENTS.md`：一页速查，给不能装插件的 agent（WorkBuddy、Codex、Cursor 等）用。

`--check` 只比较不写入，生成结果和文件不一致就退出 1。CI 跑这个，手改生成文件会红。

## 为什么

- 数量、命令名、用途只维护一处：`skills/*/SKILL.md` 和 `recipes.json`；
- 一页 digest 让别的 agent 不装插件也能知道“有哪些命令、什么时候用”；
- 漂移在 CI 暴露，不靠人记得改。

## 分组

digest 按阶段分组：规划、执行、交付、上下文、验证。新增 skill 时在生成器的 `GROUPS` 里加一条，否则 `--check` 会提示未分组。

## 不要做

- 手改 `docs/skills.md` 或 `agents-digest/kelin-AGENTS.md`；
- 在生成文件里加只有本机才有的路径；
- 把长说明塞进 digest，它只放“什么时候用哪条”。

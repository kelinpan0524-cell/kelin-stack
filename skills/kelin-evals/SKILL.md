---
name: kelin-evals
description: 给 skill 自己做验收：静态检查结构、描述触发词、引用文件和长度；用真实语料测“该不该触发”；决定什么时候用 hook、什么时候用 AGENTS.md 和 CI。用户说“skill 有没有测过”“加个 eval”“这条规则要不要做成 hook”时使用。
---

# Skill 验收

skill 也是代码。没有验收，它就会慢慢变成一篇没人维护的文档。

## 两层 eval

| 层 | 查什么 | 成本 |
| --- | --- | --- |
| 静态 | 结构、长度、引用、触发词 | 0 tokens，每次 CI 跑 |
| 行为 | 真开无头会话，按配方断言 | 每个约 40 万 tokens，发版前抽样 |

行为层就是 `kelin-verify-stack` 的 recipes：fixture + prompt + 机器断言。这里不重复。

## 静态检查

```sh
node skills/kelin-evals/scripts/skill-eval.mjs --root .
```

它检查：

- frontmatter `name` 等于目录名；
- description 非空、不超过 240 字符；
- 正文不超过 220 行（超过就该拆到 references）；
- 相对链接指向的文件存在；
- 正文里引用的 `skills/<名字>/...` 路径存在；
- 同一篇里没有重复标题；
- 没有密钥特征。

## 触发 eval

`evals/trigger-evals.json` 存真实说法：

```json
{
  "cases": [
    { "query": "这个老项目改造一下，太乱了", "expect": "kelin-legacy", "cues": ["老仓库", "迁移"] },
    { "query": "文档和代码对不上，收尾同步一下", "expect": "kelin-neat", "cues": ["整理文档", "文档和代码对不上"] }
  ]
}
```

检查规则：`expect` 指向的 skill 必须存在，且它的 description 至少包含一个 `cues`。这能抓到“描述被改得不再提这个场景”的退化。

负样本（不该触发）目前靠人审，脚本不做语义打分。

## 什么时候加 hook

规则分两种，放的地方不同：

| 规则性质 | 放哪 | 例子 |
| --- | --- | --- |
| 必须每次都成立、能机器判定 | hook 或 CI | 提交前格式化、禁止提交密钥、文件写完跑 lint |
| 提醒性的偏好 | AGENTS.md | 先规划再写、收尾对齐文档 |
| 只在特定任务用 | skill | 权限设计、批量修改 |

**本插件不加 SessionStart hook**，原因：

- AGENTS.md 已经能在每个仓库里自动带出“跨文件任务先 `/kelin-mode`”，不需要额外注入；
- hook 每次会话都跑，增加上下文和故障面，失败还可能挡住正常会话；
- 你的机器内存紧张，少一层进程更稳；
- 真要强制，用 CI 或 pre-commit，比 hook 更可验证。

结论：**能用 AGENTS.md 说清的用 AGENTS.md，能用 CI 拦住的用 CI，两者都不行的才考虑 hook。**

## 维护节奏

- 每次改 skill 描述：跑一次静态检查；
- 每次新增 skill：至少加一条触发 eval 和一条 recipe（或明确标 static-only）；
- 发版前：`verify-stack run --all --live` 抽样跑行为层；
- 发现描述和实际触发不符：先改 description，再加一条 cue。

## 反模式

- 只写 skill 不写 eval，改坏了没人知道；
- 给每条规则都做 hook，启动越来越慢；
- 触发 eval 只写“应该触发”，不写用户真实会说的话；
- 用模型自述“测试通过”代替断言。

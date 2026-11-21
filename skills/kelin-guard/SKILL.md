---
name: kelin-guard
description: 发现一个 bug 或重复纠错后，选最强且最便宜的防再犯手段并证明能拦住：先架构/类型/带指引的 Lint 棘轮，再回归测试与 CI，最后才是 AGENTS.md。用户说“这个 bug 怎么防再犯”“写个 lint”“加个检查”“别再犯了”时使用。
---

# 防再犯

> 命令里的 `$SKILL_DIR` 指本 Skill 所在目录的绝对路径，执行前先替换成实际路径。

修完 bug 或纠错后不算完。**下一次同样的错误必须被机器拦住**，否则它一定会回来。

## 主动挖错误类（动手前先翻账）

不要只等出事再补洞：定期或开工前扫近期 commits、reverts、PR 评审批注和 `shortcut:`/妥协注释，把同类错归类；**同一个错在两个以上地方出现**，就按下面阶梯从高往低选结构性防线一次性根除。

## Guard 阶梯（从强到弱，选第一个能落地的）

| 级别 | 手段 | 什么时候用 | 强度 |
| --- | --- | --- | --- |
| 0 | 架构消除（让错状态不可表达） | 改数据结构/唯一写入者/边界即可根除 | 根治，优先评估 |
| 1 | 类型 / schema 约束 | 字段缺失、枚举越界、单位混用、边界解析 | 编译期拦住 |
| 2 | 带修法指引的 Lint / 棘轮 | 编译器看不到的危险写法或老仓存量规范 | 提交时拦住 |
| 3 | 回归测试（旧代码必须失败） | 任何行为错误或外部契约 | 行为级拦住 |
| 4 | CI 检查 / 脚本 | 跨文件映射、数据约束、门禁汇总 | 合并前拦住 |
| 5 | AGENTS.md 一句话 + 执行器表 | 无法自动检测的判断（配执行器登记） | 最弱，只做提醒 |

**报错即指导**：自定义 lint/检查报错必须直接写出正确写法（哪个文件的哪个函数或类型）。**结构或检查防住后，同步删掉对应旧文字提醒。**

## 老仓库棘轮（只拦新增、删除收紧）

老项目存量多、直接全仓拦截会炸时，用棘轮脚本把现状登记进基线：只拦新违规（哪怕总数量持平、挪到新文件也会抓），旧违规一旦被修掉就运行 `--update-baseline` 收紧：

```sh
node "$SKILL_DIR"/scripts/ratchet-check.mjs ratchet.json --check
node "$SKILL_DIR"/scripts/ratchet-check.mjs ratchet.json --strict-shrink
node "$SKILL_DIR"/scripts/ratchet-check.mjs ratchet.json --update-baseline
```

任何例外豁免必须带 `location`/`file`、`reason`、`owner`、`expires`（YYYY-MM-DD），过期自动报错。

## 证明 guard 有效

写完必须验证它能抓住原来的错（只验证“现在通过”不算数）：

1. 临时退回修复代码（`git stash` 或注释掉修复）；
2. 跑 guard：测试必须失败 / lint 必须报错并指路 / 类型必须编不过；
3. 恢复修复再跑一次 → 必须通过。

## 登记与执行映射（`guards.json`）

在 `guards.json` 登记：`id`、`bug`、`rootCause`、`guard`（`type`: `arch|test|type|lint|ci|agents`、`location`、`command`）、`proof`（`expected: "fail-on-old"`）、`enforcedIn`（实际运行该检查的 CI 文件，如 `.github/workflows/ci.yml`）与可选 `exceptions`。校验：

```sh
node "$SKILL_DIR"/scripts/guard-check.mjs guards.json
```

`AGENTS.md` 同步留一张规则 ↔ 执行器映射，确保本地和 CI 跑同一条命令。

## 严进常删与不加的情形

- 一次性环境问题、无法自动检测的判断、大量误报规则不加（写一行理由留档）；
- 严进三条（同类重复、跨模块、机器可检）；常删四种（误报/逼出过度防御、已被更高层接管、模块下线、数月未复现），在 `kelin-reflect` 定期清理。

## 下游衔接

| 下一步 | 去哪 |
| --- | --- |
| guard 落地 | `kelin-ci` 接成合并门禁 |
| 确实无法 guard | 写一行理由留档，不硬凑 |

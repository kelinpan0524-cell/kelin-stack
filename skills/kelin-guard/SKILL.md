---
name: kelin-guard
description: 发现一个 bug 后，选择最强且最便宜的防再犯手段并证明它真的能拦住：回归测试优先，其次类型/schema、lint 规则、CI 检查，最后才是 AGENTS.md 一句话。用户说“这个 bug 怎么防再犯”“写个 lint”“加个检查”“别再犯了”时使用。
---

# 防再犯

> 命令里的 `$SKILL_DIR` 指本 Skill 所在目录的绝对路径，执行前先替换成实际路径。

修完 bug 不算完。**下一次同样的错误必须被机器拦住**，否则它一定会回来。

## Guard 阶梯

从强到弱，选第一个能落地的：

| 级别 | 手段 | 什么时候用 | 强度 |
| --- | --- | --- | --- |
| 0 | 架构消除（让错状态不可表达） | 改数据结构/入口就能根除且成本低 | 根治，优先评估 |
| 1 | 回归测试（旧代码必须失败） | 任何行为错误 | 最强，常规首选 |
| 2 | 类型 / schema 约束 | 字段缺失、枚举越界、单位混用 | 编译期拦住 |
| 3 | lint 规则 / 自定义检查 | 团队约定、危险调用、命名 | 提交时拦住 |
| 4 | CI 检查 / 脚本 | 跨文件、跨模块、数据约束 | 合并前拦住 |
| 5 | AGENTS.md 一句话 | 无法自动检测的判断 | 最弱，只做提醒 |

先看能否低成本从结构消除错状态（仍用旧行为复现证明），再往下选测试、类型、lint。**文档是最后手段；一旦结构或检查防住了，把对应的旧文字提醒删掉。**

## 证明 guard 有效

写完必须验证它能抓住原来的 bug：

1. 把修复代码临时退回去（`git stash` 或注释掉那一行）；
2. 跑 guard：
   - 测试 → 必须失败；
   - lint / CI 检查 → 必须报错；
   - 类型 → 必须编译不过；
3. 恢复修复，再跑一次 → 必须通过。

只验证“现在通过了”不算数——那可能只是 guard 没生效。

## 记录

在 `guards.json` 里留一条：

```json
{
  "guards": [
    {
      "id": "quote-empty-qty",
      "bug": "数量为 0 时除零，返回 Infinity",
      "rootCause": "未校验 qty > 0",
      "guard": { "type": "test", "location": "test/quote.test.ts", "command": "node --test test/quote.test.ts" },
      "proof": { "command": "<!-- revert fix --> node --test test/quote.test.ts", "expected": "fail-on-old" }
    }
  ]
}
```

字段含义：

- `type`：`test` / `type` / `lint` / `ci` / `agents`；
- `location`：guard 所在文件；
- `command`：能重复执行的验证命令；
- `proof.expected`：`fail-on-old`（回退修复时必须失败）。

校验：

```sh
node "$SKILL_DIR"/scripts/guard-check.mjs guards.json
```

它检查字段完整、类型合法、`location` 存在、`command` 非空。退出 1 表示有不合格的 guard。

## 什么时候不加

- 一次性环境问题（依赖没装、网络抖动）；
- 无法自动检测的判断（需要人拍板的取舍）；
- 加了会让正常代码大量误报的规则。

不加也要写一行理由，免得下次又从头讨论。

## 严进常删（guard 与规则的新陈代谢）

**严进三条全满足才加**：同类问题重复出现 ≥2-3 次；跨模块通用（不是单个历史文件的特例）；无法用更便宜的机器手段拦住。

**常删四种果断删**：经常误报、逼出过度防御代码；已被测试/脚本/CI 自动接管；涉及模块已重构下线；数月没在别处发生第二次。guard 只进不出，`guards.json` 迟早发胖成噪声源——定期（每次 `kelin-reflect` 时）对照这四条清一遍。

## 和别的 skill 的关系

- `kelin-tdd`：复现测试就是第 1 级 guard；
- `kelin-reflect`：复盘结论如果是“会再犯”，转给 `kelin-guard`；
- `kelin-mode` 的 fix 流程：修完 → 写 guard → 再 verify；
- `kelin-ci`：把 guard 的检查接进 CI，变成合并门禁。

## 反模式

- 只修当前实例，不修共享函数；
- 写了测试但没验证它在旧代码上会失败；
- 什么都往 AGENTS.md 里写；
- 为一条偶发问题加一堆误报规则。

## 下游衔接

| 下一步 | 去哪 |
| --- | --- |
| guard 落地 | `kelin-ci` 接成合并门禁 |
| 确实无法 guard | 写一行理由留档，不硬凑 |

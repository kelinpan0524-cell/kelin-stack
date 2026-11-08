---
name: kelin-unslop
description: 去掉文字里的 AI 味：套话、三段式、假对立、抽象大词、过度对冲、装饰性 emoji、聊天腔。用于 README、PRD、PR 正文、提交信息、界面文案。用户说“太 AI 了”“说人话”“润色一下”“去掉套话”时使用。
---

# 去 AI 味

保留事实，改说法。目标不是“更像人”，是**让读者一眼知道你在说什么**。

## 中文常见 AI 味

| 模式 | 例子 | 改法 |
| --- | --- | --- |
| 空洞总结 | 综上所述、总的来说、由此可见 | 有结论就直接说，没有就删 |
| 三段式 | 首先…其次…最后… | 没有递进关系就列点，不要凑三 |
| 假对立 | 不是…而是…、不仅…更是… | 直接说结论 |
| 抽象大词 | 赋能、抓手、闭环、生态、范式、底座 | 换成具体动作或对象 |
| 空泛程度 | 极大地、显著地、有效地 | 给数字或删掉 |
| 过度对冲 | 可能、或许、在一定程度上 叠着用 | 只留一个，或直接判断 |
| 同义词循环 | 用户、客户、使用者 一段里换着用 | 选一个，重复用 |
| 假范围 | 从战略到执行（不在一个尺度） | 直接列要说的 |
| 聊天腔 | 希望这对你有帮助、当然可以、好问题 | 删 |
| 装饰 | 标题和列表里的 emoji、满屏加粗 | 删，靠结构表达层级 |

## 英文常见 AI 味

- 大词：delve、crucial、landscape、tapestry、testament、vibrant、foster、garner、intricate、pivotal、seamless、robust（没有具体所指时）；
- 句式：Not just X, but Y；serves as / stands as（直接说 is）；
- 对冲：could potentially possibly；
- 标题：Title Case 改成句首大写。

## 检查

```sh
node skills/kelin-unslop/scripts/slop-check.mjs README.md
node skills/kelin-unslop/scripts/slop-check.mjs README.md --strict
```

默认只报告，退出 0；`--strict` 有命中就退出 1，适合接进 CI。

## 改写步骤

1. 跑检查，标出命中行；
2. 逐条判断：是套话就删，是事实就换成具体说法；
3. 一句话只放一个意思，长句拆开；
4. 主动语态，能说“谁做了什么”就别用被动；
5. 改完再跑一次，确认没引入新套话。

## 不要做

- 为了去味改掉事实或数字；
- 把所有术语都删掉，读者反而看不懂；
- 把句子拆成碎片，读起来更累；
- 用另一套套话替换这一套。

## 和别的 skill 的关系

- `kelin-refine` 管代码精简，这里管文字；
- `kelin-neat` 对齐事实，这里只改表达；
- `kelin-ship` 的 PR 正文、`kelin-principles` 的“说人话”都可以先过一遍。

---
name: kelin-loop
description: 有明确停止条件的循环执行：每轮跑验证、记录证据、判断继续还是停，设预算上限和升级条件，禁止无限重试。用户说“循环跑”“自动迭代”“跑到通过为止”“hillclimb”时使用。
---

# 循环执行

循环不是“一直试”。循环是**每轮都有证据、随时能停**的重复。

## 什么时候可以用

同时满足三条：

1. 有机器可判定的停止条件（命令退出码、指标阈值、文件内容）；
2. 每轮改动可回退（有 git 或备份）；
3. 失败不会对外产生影响（不碰生产、不发消息）。

任一条不满足，不要循环，先人工分析。

## 写契约

`loop.json`：

```json
{
  "goal": "把导出耗时降到 10s 以内",
  "stop": { "command": "node scripts/bench-export.mjs", "expect": "exit 0" },
  "maxIterations": 6,
  "evidence": ["bench 输出", "git diff --stat", "测试结果"],
  "escalateAfter": 2
}
```

字段含义：

- `stop`：唯一判定标准，不接受“看起来快了”；
- `maxIterations`：硬上限，1-50；
- `evidence`：每轮必须留下的证据；
- `escalateAfter`：连续几轮没有进展就停下来找人。

## 每一轮

1. 跑一次基线（第一轮）或上一轮结果；
2. 只改一个变量；
3. 跑 `stop.command`，记录输出；
4. 比较：比上轮好、没变、变差；
5. 连续 `escalateAfter` 轮没变好 → 停，写下“卡在哪、试过什么、下一步建议”。

## 校验与执行

```sh
node skills/kelin-loop/scripts/loop-check.mjs loop.json
```

检查契约是否完整。`loop-check` 通过之前不要开始循环。

## 反模式

- 没有停止条件，靠感觉收工；
- 每轮改多个变量，最后不知道哪个起作用；
- 失败了自动重跑，不分析；
- 预算无上限，烧到没 token 才停；
- 把“外部接口挂了”当成“再试一次就好”。

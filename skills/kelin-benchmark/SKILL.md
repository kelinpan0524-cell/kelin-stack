---
name: kelin-benchmark
description: 报性能数字前先取证：瓶颈是什么、有没有调优、是否可复现、端到端是否有意义。至少交替跑 5 次，报中位数和范围，结论只允许 faster/slower/no measurable difference/inconclusive。用户说“快了多少”“性能对比”“有没有变慢”“benchmark”时使用。
---

# 性能数字取证

一个数字要能站住，必须回答七个问题。回答不了，结论就是 `inconclusive`，不是“差不多”。

## 七问

1. **为什么不是两倍？** 先找瓶颈。在不报告的那一轮里做 profile（`node --cpu-prof`、`py-spy`、`perf`、`top`、`strace -c`），把热点映射到源码；如果压测工具先饱和，你测到的是压测工具。
2. **有没有调优？** 两边都按生产配置跑：release build、生产参数、批处理/事务设置、连接池、冷热缓存、相同版本和数据。一边用默认配置，比的是配置，不是实现。
3. **有没有碰到物理上限？** 如果已经接近磁盘、网络、单核或内存带宽的上限，再优化也不会大幅变快；说清上限在哪。
4. **有没有报错？** 把错误数、重试数、超时数写进结果；有错误的速度数字不算数。
5. **能不能复现？** 两边至少交替跑 5 次（A、B、A、B……），报中位数和范围。差距小于运行间波动就是 `no measurable difference`；接近时用秩和检验或工具自带统计。
6. **端到端有没有意义？** 用户感知的是完整路径，不是某个函数。只测函数时说明它占端到端多少。
7. **计时区间内工作真的发生了吗？** 查缓存命中、短路、dry-run、空数据、被优化掉的调用；用文件、网络、数据库行数或日志确认工作确实做了。

## 快速估算

用户只要一个 ballpark 时，可以只跑一次；但必须检查第 4、7 问，并明确写“只跑了一次”。**在两个选项之间做选择时，不允许用 ballpark。**

## bench.json

```json
{
  "claim": "export is 30% faster at p50 on the 60k-row dataset",
  "limiter": "JSON parsing on one core",
  "runs": 7,
  "median": { "before": 41, "after": 33 },
  "range": { "before": [39, 44], "after": [32, 35] },
  "errors": 0,
  "workHappened": true,
  "verdict": "faster"
}
```

校验：

```sh
node skills/kelin-benchmark/scripts/bench-check.mjs bench.json
```

字段缺失、范围不包住中位数、`faster` 但中位数没变小，都会退出 1。范围重叠只给 warning，由人决定是否做统计检验。

## 结论四选一

| 结论 | 什么时候用 |
| --- | --- |
| `faster` | 中位数变小，范围不重叠或统计显著，瓶颈说得清 |
| `slower` | 中位数变大，原因说得清 |
| `no measurable difference` | 差距小于运行间波动 |
| `inconclusive` | 说不清瓶颈、有一边没调优、第 4/7 问没查 |

## 输出格式

一句话结论 + 一张表（before/after 中位数、范围、runs、errors、limiter）+ `bench.json` 路径。不要只贴一个百分比。

## 接进现有流程

- `kelin-loop`：`stop.evidence` 指向 `bench.json`；
- `kelin-verify`：验收项引用具体数字和命令；
- `kelin-review`：性能结论必须带 `bench.json`；
- `kelin-plan`：性能预算写成可测数字，不写“尽量快”。

## 反模式

- 只跑一次就宣布“快 30%”；
- 拿 debug build 和生产 build 比；
- 改完不跑基线，凭感觉说变快了；
- 用平均值掩盖长尾；
- 报数字不报瓶颈；
- 缓存命中率变了，却说是代码变快。

## 验证

本 skill 带脚本和单元测试；没有 live recipe。

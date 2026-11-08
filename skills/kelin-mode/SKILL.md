---
name: kelin-mode
description: 自动编排整套 kelin-stack：先判断任务类型（新功能/修 bug/老仓库改造/全仓审计），再按阶段调用 goal、plan、architect、map、tdd、verify、review、refine、ship，每一步有产物和退出条件。多代理最多 2 个，适配 24GB 内存。用户输入 /kelin-mode，或说“全自动做完这个需求”“对老仓库启动 kelin-mode”时使用。
---

# kelin-mode

目标：**你说一句要什么，agent 自己知道下一步做什么、调哪个 skill、什么时候停。**

它不是“更努力的自动补全”。它是一个有状态、有门禁、会停下来的流程机。

## 什么时候用，什么时候别用

用：需求已经明确到“能做”，你愿意让 agent 连续做完几个阶段。
别用：需求还在讨论、要动生产数据、要对外发布、你只想问个问题。

## 四种模式

| 模式 | 适用 | 主链路 |
| --- | --- | --- |
| `feature` | 加功能、改行为 | goal → plan → architect → map → tdd → verify → review → refine → ship |
| `fix` | 修 bug、回归 | correctness（复现测试）→ tdd → verify → review → ship |
| `legacy` | 老仓库改造、迁移 | legacy（基线+地图+热点）→ plan → tdd（切片）→ verify → review → refine → ship |
| `audit` | 只审不改 | audit → map → plan（修复清单） |

模式由 `kelin-mode` 在 intake 阶段判断；判断不了就问一句，不要猜。

## 状态机

状态存在 `.kelin/state.json`，阶段顺序固定：

```
intake → map → design → build → verify → review → refine → ship → done
```

每个阶段的**退出条件是一组文件**，缺一个就不能前进：

| 阶段 | 产物 | 说明 |
| --- | --- | --- |
| intake | `.kelin/state.json` | 模式、仓库、开始时间 |
| map | `scope.md`（feature/fix）或 `feature-map.json`（legacy/audit） | 改哪里、测哪里 |
| design | `goal.md` + `plan.md` | 目标契约 + 可执行计划 |
| build | `build.md` | 改了什么、加了哪些测试 |
| verify | `verify.json` + `acceptance.json`（`ok: true`） | 验收清单与结果 |
| review | `review.md` | P0-P3 审查结论 |
| refine | `refine.md` | 删了什么、简化了什么 |
| ship | `ship.md` | 分支、PR、CI 结论 |
| done | `reflect.md` | 复盘与沉淀 |

用脚本推进，不靠记忆：

```sh
node skills/kelin-mode/scripts/mode.mjs init --mode feature
node skills/kelin-mode/scripts/mode.mjs status
node skills/kelin-mode/scripts/mode.mjs advance
```

`advance` 会检查当前阶段的产物；缺了会列出缺什么，退出 1。**不要手改 `state.json` 绕过它。**

## 每个阶段做什么

**intake**：读项目 `AGENTS.md`、`git status`、最近提交；判断模式和风险级别。高风险（动数据、动权限、对外接口）先停下来问。

**map**：用 `kelin-map` 建或更新功能地图。只改一小块时写 `scope.md`：影响哪些文件、哪些调用方、哪些测试。

**design**：`kelin-goal` 写目标契约，`kelin-plan` 拆任务，`kelin-architect` 出类型和签名，`kelin-blast-radius` 算影响面。**停在这里等确认**，除非用户已明确授权连续执行。

**build**：`kelin-tdd` 红-绿-重构。每完成一个可验证单元就提交一次，提交信息带 `[ZCode]`。写 `build.md`：改了哪些文件、加了哪些测试、还剩什么。

**verify**：把验收写成 `verify.json`，用 `run-acceptance.mjs` 跑出 `acceptance.json`。任何一条失败就回 build，不要进 review。

**review**：`kelin-review` 做自审，必要时起 `kelin-reviewer` 子代理。P0/P1 必须清零。

**refine**：`kelin-refine` 按必要性阶梯删代码、合并重复、去掉没人用的抽象。改完重跑 verify。

**ship**：`kelin-ship` 跑 `preflight.mjs`，开 PR，`kelin-watch` 盯 CI。**部署不在这一步**。

**done**：`kelin-reflect` 把结论写回 AGENTS.md 或记忆。

## 多代理与内存预算（24GB）

硬限制，防止把机器拖死：

- **最多 2 个子代理**，且同一时刻只允许 1 个写、1 个读；写操作永远由主代理做。
- 子代理只做窄任务：读代码画地图、按清单审查、跑只读检查。**不允许嵌套子代理。**
- 起代理前看一眼内存：

```sh
sysctl -n vm.swapusage
memory_pressure | tail -1
```

swap 已用超过 1GB，或空闲内存低于 2GB，就**只跑单代理**。

- 不并行跑构建和测试；不并行跑两个测试套件；不在这台机器上开浏览器自动化 + 构建。
- 读文件先用 grep 定位再读区间，单次不超过 400 行；不要整仓读。
- Node 脚本统一加 `NODE_OPTIONS=--max-old-space-size=2048`。
- 子代理任务结束立即收掉，不要保留 3 个以上会话。

## 怎么知道 AI 写对了

进入 build 之前读 `kelin-correctness`。核心三条：

1. 新行为的测试必须**在改之前失败**，改之后通过；
2. 断言行为，不断言实现；
3. 边界值单独列：空、0、负数、重复、超长、并发。

没有这三条，build 不算完成。

## 自治边界

可以自动做：读、改、跑测试、本地提交、开 PR、跑只读检查。

必须先问：部署、删数据/分支、force push、发版、发消息/邮件、花钱、改权限、动生产配置。

## 停止条件

出现任一条就停，写清楚卡在哪：

- 连续两轮验证没有变好；
- 需要上面“必须先问”的任一件事；
- 需求出现两种合理解释且影响实现；
- 同一失败重试两次仍挂。

## 老仓库模式

`legacy` 先跑 `kelin-legacy`：基线能不能构建/测试、功能地图、热点（改动频率 × 复杂度）、特征测试。然后按切片改造，**一次只动一个缝**，每个切片都要能独立验证和回滚。禁止大爆炸重写，禁止在同一片里顺手升级依赖。

## 反模式

- 跳过 map 直接写代码；
- verify 没过就进 review；
- 为了让流程往前走，手改 state.json；
- 一次起 4 个子代理“并行提速”；
- 把“能编译”当成“写对了”；
- 在 ship 阶段顺手部署。

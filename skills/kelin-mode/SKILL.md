---
name: kelin-mode
description: 自动编排整套 kelin-stack：安装后 SessionStart 自动启用；非平凡任务自动进入，按阶段调用 goal、plan、architect、map、tdd、verify、review、refine、ship，每一步有产物和退出条件。多代理最多 2 个，适配 24GB 内存。用户输入 /kelin-mode，或说“全自动做完这个需求”时使用。
---

# kelin-mode

目标：**你说一句要什么，agent 自己知道下一步做什么、调哪个 skill、什么时候停。**

如果仓库的 `AGENTS.md` 写了“跨文件/多步/产品类任务先 `/kelin-mode`”，就不用每次说命令，agent 会自己进来。

它不是“更努力的自动补全”。它是一个有状态、有门禁、会停下来的流程机。

安装后 SessionStart 会自动注入激活上下文；用户只需要记住 `kelin-mode`，不需要每次点名 skill。完整阶段路由见 [references/routing.md](references/routing.md)。

## 什么时候用，什么时候别用

用：需求已经明确到“能做”，你愿意让 agent 连续做完几个阶段。
别用：需求还在讨论、要动生产数据、要对外发布、你只想问个问题。

## 不知道做什么？先读这张表

| 你看到的情况 | 该做什么 | 不该做什么 |
| --- | --- | --- |
| 只有一个文件、改动不到 30 分钟 | 直接改 + `kelin-verify` 快速档 | 不要开 mode，不要 plan |
| 2-5 个文件、需求清楚 | `kelin-plan` + `kelin-tdd` + `kelin-verify` | 不要开子代理 |
| 跨模块、动数据、对外接口 | `kelin-mode feature` | 不要跳过 map |
| 需求还模糊 | `kelin-goal` 问清楚 | 不要开始写代码 |
| 想跑 goal 但说不清 | `kelin-goal` 先给草稿、三问、写 goal+plan，再给 `/goal` 命令 | 不要让用户先组织语言 |
| 同一问题反复失败 | `kelin-loop`（设上限） | 不要无限重试 |
| 只想知道哪里有问题 | `kelin-audit` | 不要顺手改 |
| 老仓库、迁移 | `kelin-mode legacy` | 不要大爆炸重写 |
| 涉及多个仓库、跨仓数据 | `kelin-multirepo` + `kelin-mode legacy` | 不要两个仓同时改、不要共享库表 |
| 前端界面 | 加 `kelin-ui` | 不要只看代码 |
| 文字太 AI 味 | `kelin-unslop` | 不要用一套套话换另一套 |

### 什么时候用 ZCode 的 `/workflow`

- 用：任务能拆成 ≥3 个互不写同一文件的子任务；`budget.mjs` 显示 `maxAgents >= 2`；你不需要在旁边逐步确认。
- 不用：1-2 个文件；需要连续对话；多个子任务要改同一批文件；机器已经在 swap。
- 用的时候并发也压到 ≤2，每个子任务的验收写成可执行命令。

### 什么时候 plan，什么时候跳过

判断依据是**任务信号**，不是用户有没有说“plan”。

- plan：跨文件、跨模块、动数据/权限/对外接口，或上次类似任务返工过。
- 跳过：单文件、可逆、有现成模式、不到 30 分钟。
- 产品类任务（有用户、权限、上传导出、数据量）即使没说 plan，也要先走 `kelin-product` + `kelin-plan`。
- 不确定时做最轻的 plan：三行写清目标、验收、任务。

### 什么时候 refine

- verify 通过之后，diff 超过 100 行，或新增了抽象/依赖/死代码。
- 不做：紧急修复、纯配置、diff 不到 20 行。

### verify 的三档

| 档 | 用于 | 做什么 |
| --- | --- | --- |
| 快速 | 文案、样式、单文件 | 一条命令或一张截图 |
| 标准 | 普通功能 | `acceptance.json` + 边界矩阵 |
| 严格 | 钱、权限、迁移、对外接口 | 标准 + 差分对照或变异 sanity |

## 五种模式

| 模式 | 适用 | 主链路 |
| --- | --- | --- |
| `light` | 单文件、文案、小修 | goal（三行）→ build → verify（快速）→ ship → reflect |
| `feature` | 加功能、改行为 | goal → plan → architect → map → tdd → verify → review → refine → ship |
| `fix` | 修 bug、回归 | correctness（复现测试）→ tdd → guard → verify → review → ship |
| `legacy` | 老仓库改造、迁移 | legacy（基线+地图+热点）→ plan → tdd（切片）→ verify → review → refine → ship |
| `audit` | 只审不改 | 按状态机走；build 记录发现，refine 阶段才改 |

模式由 `kelin-mode` 在 intake 阶段判断；判断不了就问一句，不要猜。

## 状态机

状态存在 `.kelin/state.json`，阶段顺序固定：

```
intake → map → design → build → verify → review → refine → ship → reflect → done
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
| reflect | `reflect.md` | 复盘与沉淀 |
| done | 无 | 终点，不能再前进 |

用脚本推进，不靠记忆：

```sh
node skills/kelin-mode/scripts/mode.mjs init --mode feature
node skills/kelin-mode/scripts/mode.mjs status
node skills/kelin-mode/scripts/mode.mjs advance
```

`advance` 只检查产物文件是否存在；内容质量要用对应脚本校验（`goal-check`、`check-plan`、`map-check`、`run-acceptance`），校验不过不要 `advance`。**不要手改 `state.json` 绕过它。**

## 策略文件

根目录放 `kelin-policy.json`（模板在 `skills/kelin-mode/templates/kelin-policy.json`）：

- `autonomy.allow/ask`：能自动做什么、必须先问什么；
- `paths.writable/forbidden`：能改哪些路径、绝对不碰哪些；
- `checks.required`：交付前必须通过的检查；
- `release`：版本策略和发布前置；
- `budget.maxAgents/maxLiveEvals`：并发和 live 验证上限。

```sh
node skills/kelin-mode/scripts/policy-check.mjs kelin-policy.json
```

没有这个文件时用默认边界，但不会因此扩大权限。

## 每个阶段做什么

每阶段默认调用的 skill 见 [references/routing.md](references/routing.md)；按任务信号自动选，不要等用户点名。下面是各阶段的退出条件。

**intake**：先跑 `node skills/kelin-agents/scripts/ensure-workflow.mjs AGENTS.md`（缺文件就建，缺工作流块就补，有就跳过；只追加标记块，不重写文件），再读 `AGENTS.md`、`kelin-policy.json`（如果有）、`git status`、最近提交；判断模式和风险级别。策略里的 `allow` 可以直接做，`ask` 必须先问，写文件只落在 `paths.writable`，`forbidden` 不碰，子代理和 live 验证不超过 `budget`。没有 AGENTS.md 时脚本会建一份骨架；超过 150 行先精简；`agents-check` 有失败项先修，再开工。高风险（动数据、动权限、对外接口）先停下来问。

**map**：用 `kelin-map` 建或更新功能地图。只改一小块时写 `scope.md`：影响哪些文件、哪些调用方、哪些测试。

**design**：`kelin-goal` 写目标契约，`kelin-plan` 拆任务，`kelin-architect` 出类型和签名，`kelin-blast-radius` 算影响面。产品类任务（有用户、权限、上传导出、数据量）先跑 `kelin-product`，把用户环境、权限矩阵、上传预览确认、分页和性能预算定下来。feature/legacy 跨模块的计划，写完跑 `kelin-plan` 的计划评审门（产品 + 工程两个镜头，最多 2 个子代理），有 `pending` 决策就停。**停在这里等确认**，除非用户已明确授权连续执行。

**build**：`kelin-tdd` 红-绿-重构。修 bug 时用 `kelin-guard` 选最强且最便宜的防再犯手段，并证明它在旧代码上会失败。每完成一个可验证单元就提交一次，提交信息带 `[ZCode]`。写 `build.md`：改了哪些文件、加了哪些测试和 guard、还剩什么。

**verify**：把验收写成 `verify.json`，用 `run-acceptance.mjs` 跑出 `acceptance.json`。任何一条失败就回 build，不要进 review。

**review**：`kelin-review` 做自审，必要时起 `kelin-reviewer` 子代理。P0/P1 必须清零。

**refine**：`kelin-refine` 按必要性阶梯删代码、合并重复、去掉没人用的抽象。改完重跑 verify。

**ship**：先跑 `kelin-neat` 把文档和代码对齐，再 `kelin-ship` 跑 `preflight.mjs`，开 PR，`kelin-watch` 盯 CI。**部署不在这一步**。

**done**：只做 `kelin-reflect`。文档对齐已经在 ship 前完成，不要在这里补。

## 多代理与内存预算（24GB）

先跑一次预算检查，按它的建议决定并发：

```sh
node skills/kelin-mode/scripts/budget.mjs
```

输出里的 `maxAgents` 是硬上限：0 就单干，1 最多一个子代理，2 才是“一写一读”。

硬限制，防止把机器拖死：

- **最多 2 个子代理**，且同一时刻只允许 1 个写、1 个读；写操作永远由主代理做。需要通用 worker 时用 `agents/kelin-worker.md`，它先读本 skill 和 `kelin-principles`，不自行扩大范围。
- 子代理只做窄任务：读代码画地图、按清单审查、跑只读检查。**不允许嵌套子代理。**
- swap 超过 1GB 或空闲内存低于 2GB，只跑单代理。
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

## Token 预算

链路长不等于一定贵：阶段在**同一个会话**里推进，不会每个阶段新开 session。真正贵的是子代理和 live 验证。

| 动作 | 实测消耗 | 建议 |
| --- | --- | --- |
| 静态检查（`run --all` 默认） | 0 tokens | 每次改完都跑 |
| 一个 live skill 验证 | 约 42 万 tokens（大部分命中缓存），10-20 秒 | 发版前或改 skill 后抽样 |
| 一个子代理 | 新会话，10 万级上下文 | 最多 2 个，只做窄任务 |
| 全链路 kelin-mode | 一个会话，随阶段缓慢增长 | 小任务用 `light` |

省法：小任务 `light`；默认只跑静态；`--live` 按需；不要每个阶段都起子代理。

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

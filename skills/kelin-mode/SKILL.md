---
name: kelin-mode
description: 自动编排整套 kelin-stack：安装后 SessionStart 自动启用；说“kelin mode setup”一键配置环境，说“kelin mode”自动路由并串联 goal、plan（含设计草图）、map、tdd、verify、review、refine、ship，每步有产物和门禁。多代理最多 2 个，适配 24GB 内存。
---

# kelin-mode

> 命令里的 `$SKILL_DIR` 指本 Skill 所在目录的绝对路径，执行前先替换成实际路径。

目标：**新手只要说一句“kelin mode setup”或“用 kelin mode 做 X”，agent 自动选路、导入配套 skill 并按门禁推进。**

安装后 SessionStart 自动注入激活上下文；不需要记忆 40 个 skill 名字，完整阶段与判定明细见 [references/routing.md](references/routing.md)。

## 零门槛自动入口（kelin mode / setup / route）

| 你说什么 | 自动做什么 | 命令 |
| --- | --- | --- |
| “kelin mode setup”（首次接入/体检） | 先只读预览环境检查项（`AGENTS.md`、`.gitignore`、`kelin-policy.json`、`verify-*`、`pre-commit`、内存/安全/委托），确认后加 `--apply` 写入 | `node "$SKILL_DIR"/scripts/mode.mjs setup --root . [--host antigravity\|codex\|zcode] [--apply] [--with-verify-app] [--with-precommit]` |
| “用 kelin mode 做 `<任务>`”（不懂选模式） | 自动检查是否需要 setup / 续跑、判定模式（`setup`/`audit`/`legacy`/`fix`/`light`/`feature`）、是否要先 `kelin-grill` 问清、并返回首阶段配套 `companionSkills` | `node "$SKILL_DIR"/scripts/mode.mjs route --task "<需求>" --root .` |
| 直接按任务开跑 | 若上一轮已到 `done`，再次 `init` 自动归档到 `.kelin/history/`；`init`/`status`/`advance` 会直接带出当前阶段 `activeSkills` 与人话摘要 | `node "$SKILL_DIR"/scripts/mode.mjs init --task "<需求>" --root .` |

## 什么时候用，什么时候别用

用：需求能进入实现/审查/修复/老项目改造，或第一次把仓库接入 kelin-stack。
别用：纯概念问答、直接动生产数据、或未确认的对外发布。

## 不知道做什么？先读这张表

| 你看到的情况 | 该做什么 | 不该做什么 |
| --- | --- | --- |
| 刚装好插件、第一次开仓库 | `mode.mjs setup --root .`（看清清单再 `--apply`） | 不要盲目手写规则或跳过检查 |
| 只有一个文件、不到 30 分钟 | `kelin-mode light` 或直接改 + `kelin-verify` 快速档 | 不要硬开复杂规划与子代理 |
| 2-5 个文件、需求清楚 | `kelin-plan` + `kelin-tdd` + `kelin-verify` | 不要开多代理 |
| 跨模块、动数据、对外接口 | `kelin-mode feature` | 不要跳过 map |
| 需求模糊 / 只给十几个字 | `kelin-grill` 先问透 + `kelin-goal` 写契约 | 不要边猜边写代码 |
| 同一问题反复失败 | `kelin-loop`（设上限） | 不要无限重试 |
| 只想知道哪里有问题 | `kelin-mode audit`（只读轨道） | 不要顺手改 |
| 老仓库、迁移或跨仓 | `kelin-mode legacy`（多仓加 `kelin-multirepo`） | 不要两个仓同时改或大爆炸重写 |
| 前端界面 / AI 味文案 | 配套 `kelin-ui` / `kelin-unslop` | 不要只看代码或套话互换 |

plan / refine / verify 三档与 ZCode `/workflow` 选择细节见 [references/routing.md](references/routing.md)。

## 五种模式

| 模式 | 适用 | 主链路 |
| --- | --- | --- |
| `light` | 单文件、文案、小修 | intake → design（三行）→ build → verify（快速）→ ship → reflect → done |
| `feature` | 加功能、改行为 | intake → map → design（跨模块含草图）→ build → verify → review → refine → ship → reflect → done |
| `fix` | 修 bug、回归 | intake → map → design → build（`tdd` + `guard`）→ verify → review → refine → ship → reflect → done |
| `legacy` | 老仓库改造、迁移 | intake → map（`feature-map.json`）→ design → build（切片）→ verify → review → refine → ship → reflect → done |
| `audit` | 只审不改 | intake → map（`feature-map.json`）→ audit（含覆盖声明）→ reflect → done |

模式由 `route` 在 intake 阶段自动判定；判断不了就问一句，不靠猜。

## 状态机

状态存在 `.kelin/state.json`，每阶段退出条件是一组产物与脚本门禁，缺一项就不能 `advance`：

| 阶段 | 产物 | 配套校验脚本 |
| --- | --- | --- |
| intake | `.kelin/state.json` | `setup` / `route` / `agents-check` |
| map | `scope.md` 或 `feature-map.json` | `map-check.mjs` |
| audit | `audit.md`（仅 `audit` 模式） | `audit-check.mjs` |
| design | `goal.md` + `plan.md`（可选 `plan-gate.json`） | `goal-check`、`check-plan`、`plan-gate` |
| build | `build.md` | 单测 / `guard-check` / `ratchet-check` |
| verify | `verify.json` + `acceptance.json`（`VERIFIED` + 指纹） | `run-acceptance.mjs` / `verify-*` |
| review | `review.md` | `gate-scan.mjs` + `review-check.mjs` |
| refine | `refine.md`（须重跑 `verify`） | `run-acceptance.mjs` |
| ship | `ship.md` | `neat-check.mjs` + `preflight.mjs` |
| reflect | `reflect.md` | `decision-check.mjs` |

用脚本推进，**不要手改 `state.json` 绕过门禁**：

```sh
node "$SKILL_DIR"/scripts/mode.mjs route --task "你的需求" --root .
node "$SKILL_DIR"/scripts/mode.mjs init --task "你的需求" --root .
node "$SKILL_DIR"/scripts/mode.mjs status --root .
node "$SKILL_DIR"/scripts/mode.mjs advance --root .
```

## 策略文件与个人偏好

根目录放 `kelin-policy.json`（`setup --apply` 会自动补默认模板，校验跑 `node "$SKILL_DIR"/scripts/policy-check.mjs kelin-policy.json`），定义 `autonomy.allow/ask`、`paths.writable/forbidden`、`checks.required`、`release`、`budget`。没有该文件时用默认边界，不扩大权限。

个人偏好：`node "$SKILL_DIR"/scripts/prefs.mjs get kelin-mode --host zcode`（按宿主替换，覆盖共享偏好但永不覆盖安全约束）。

## 每个阶段做什么

每阶段 `status`/`advance` 返回的 `activeSkills` 会提示默认调用的配套 skill（全表见 [references/routing.md](references/routing.md)）：

- **intake**：`ensure-workflow.mjs` 幂等检查 `AGENTS.md`，读 `kelin-policy.json` 与 `git status`，确定模式与风险；高风险先停。
- **map**：`kelin-map` 建/更新地图或 `scope.md`，`kelin-blast-radius` 算影响面。
- **design**：`kelin-goal` + `kelin-plan`（先切最小闭环分批上线，外部底座先跑 10 行真探针；跨模块出设计草图）。**停在这里等确认**，除非已明确授权。
- **build**：`kelin-tdd` 红-绿-重构，修 bug 加 `kelin-guard`；每单元提交加当前宿主前缀，写 `build.md`。
- **verify**：写 `verify.json`，`run-acceptance.mjs` 产出绑定工作树指纹的 `acceptance.json`；有本地 `verify-*` 时优先执行。任何失败回 build。
- **review**：`kelin-review` 自审 + `gate-scan.mjs`；常态 2 轮、收敛可定点复验（最多 4 轮，二审起只核未关闭项、修复 diff 与直接回归），打转或要决策立刻停下由人拍板。
- **refine**：`kelin-refine` 删多余代码与注释；改完必须重跑 verify。
- **ship**：`kelin-neat` 对齐文档 → `kelin-brief` 摘要 → `kelin-ship` 跑 `preflight` → `kelin-watch` 盯 CI。**部署不在这一步**。
- **done**：只做 `kelin-reflect`；下一需求直接 `init` 会自动归档本轮记录。

## 多代理与内存预算（24GB）

```sh
node "$SKILL_DIR"/scripts/budget.mjs
```

- `maxAgents` 为硬上限（0 单干，1 单子代理，2 最多“1 写 1 读”，禁止嵌套子代理）；
- 不并行跑构建和测试，不并行开浏览器自动化与构建；读文件先定位再读区间（<=400 行）；Node 脚本配 `NODE_OPTIONS=--max-old-space-size=2048`。

## 质量、Token 与边界

- **正确性底线**：进入 build 先看 `kelin-correctness`（先见测试失败再变绿、断言行为、边界值矩阵）。
- **Token 预算**：全链路同一会话内推进；静态默认 0 tokens，live 验证按需抽样，小改动用 `light`。
- **自治边界**：只读/改码/跑测/本地提交/开 PR 可自动做；**部署、删数据/分支、force push、发版、发消息、花钱、改权限、动生产配置**必须先问。
- **停止条件**：审查二审后不收敛或满 4 轮仍阻塞、单插件/脚本超 500-600 行未收住、连续两轮无进展、触发“必须先问”项、需求二义性 -> 立即停并用大白话说明卡点。
- **反模式**：跳过 map 直接改、verify 未过进 review、手改 `state.json`、开 4 个子代理、把能编译当写对、ship 顺手部署。

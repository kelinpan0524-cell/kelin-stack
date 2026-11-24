# kelin-mode 阶段路由

SessionStart 会把这份路由注入会话。用户不需要点名 skill；按任务信号选，不要等用户说“用 kelin-*”。

## 阶段 → 默认 skill

| 阶段 | 默认调用 | 什么时候加/跳过 |
| --- | --- | --- |
| intake | `kelin-agents`（AGENTS.md 缺失或超长时）、`kelin-mode init` | 高风险/动数据先停 |
| map | `kelin-map`；小改只写 `scope.md` | 单文件小修跳过 |
| design | `kelin-goal`、`kelin-plan`；产品类加 `kelin-product`；跨模块时 `kelin-plan` 的设计草图（双候选）、`kelin-blast-radius`；有性能目标加 `kelin-benchmark` 预算 | 需求不清先回 goal |
| build | `kelin-tdd`；修 bug 加 `kelin-guard`；高风险改动先 `kelin-safety` 冻结范围；正确性存疑加 `kelin-correctness` | 不并行跑构建和测试 |
| verify | `kelin-verify`；项目有 `.zcode/skills/verify-*` 或 `.agents/skills/verify-*` 时优先 `kelin-verify-app` 生成的本地 skill；有性能数字加 `kelin-benchmark`；收尾跑 `kelin-health` | 任何一条失败回 build |
| review | `kelin-review`（门禁扫描 + 对抗审查）；必要时 `kelin-reviewer`；审完 `review-check --write` | P0/P1 清零才前进 |
| refine | `kelin-refine`（含注释审查）；文档对齐用 `kelin-neat` | diff <20 行可跳过 |
| ship | `kelin-brief` 写交付摘要；`kelin-ship` 跑 preflight（强制评审 CURRENT）；`kelin-watch` 盯 CI | 部署必须等人点头 |
| reflect | `kelin-reflect`；关键决定补 `kelin-decision-log` | 没有新结论就直说 |

## 自动激活规则

- 每个会话 SessionStart 注入版本、当前 mode/phase、本阶段配套 skill（`activeSkills`）、项目接入状态、本地 verify skill、冻结状态和安全钩子。
- 有 `.kelin/state.json` 且未到 `done` 就续跑；若上一轮已 `done`，再次 `init` 会自动归档到 `.kelin/history/`。
- 说“kelin mode setup”或首次接入仓库时，先预览 `setup --root .`，确认后再 `--apply`（可选 `--with-verify-app` / `--with-precommit`）。
- 说“kelin mode”或任意任务描述时，先跑 `route --task "<需求>" --root .` 自动判定模式、是否需要 `kelin-grill` 先问透、以及条件 companion（`kelin-product`/`kelin-ui`/`kelin-multirepo`/`kelin-benchmark`）。
- 本地 `verify-*` skill 只在验证阶段执行；会话开始不自动起服务。
- 不要每轮重复声明 kelin-stack 规则；按本表选 skill。

## plan / refine / verify 决策规则

- **何时 plan**：跨文件、跨模块、动数据/权限/对外接口、或同类任务曾返工；产品类先 `kelin-product` 再 `kelin-plan`。单文件可逆小改跳过。
- **何时 refine**：`verify` 过后 diff > 100 行，或新增了抽象/依赖/死代码；紧急修复/纯配置/<20 行跳过。
- **verify 三档**：快速（文案/单文件：1 条命令或截图）、标准（`acceptance.json` + 边界矩阵）、严格（钱/权限/迁移/对外接口：标准 + 差分/变异）。
- **verify 覆盖改动路径**：verify.json 至少覆盖 `kelin-map` 的 `map-check.mjs --changed-from <ref>` 列出的全部 feature 对应验证项（`matched` 里的 verify 是核验要求原文，不是命令）；无法覆盖的写进 skipReason。
- **verify 失败回退**：verify 阶段失败即用 `mode.mjs rewind --reason "<失败断言>"` 回 build，不允许失败后直接进 review；
- 修完重跑**同一批断言**，不许只跑新增或改过的检查项；
- 同一根因连续两轮仍失败，才启用 `kelin-loop` 的预算契约，不许无上限重试。
- **老仓库模式（`legacy`）**：先跑 `kelin-legacy` 建基线、功能地图、热点与特征测试，再按切片推进，**一次只动一个缝**，禁大爆炸重写与顺手升依赖。

## 何时用 ZCode `/workflow` 与资源约束

- 用：任务可拆为 >=3 个互不写同一文件的子任务、`budget.mjs` 给出 `maxAgents >= 2` 且无需人工分步确认；不用：1-2 文件或会改同一批文件。
- 最多 2 个子代理（1 写 1 读）；`budget.mjs` 说 1 就只用 1；不允许嵌套子代理。
- 不并行跑构建和测试；不在同一时刻开浏览器自动化和构建。
- 子代理只接窄任务；通用 worker 用 `agents/kelin-worker.md`，它先读本 skill 和 `kelin-principles`。

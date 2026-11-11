# kelin-mode 阶段路由

SessionStart 会把这份路由注入会话。用户不需要点名 skill；按任务信号选，不要等用户说“用 kelin-*”。

## 阶段 → 默认 skill

| 阶段 | 默认调用 | 什么时候加/跳过 |
| --- | --- | --- |
| intake | `kelin-agents`（AGENTS.md 缺失或超长时）、`kelin-mode init` | 高风险/动数据先停 |
| map | `kelin-map`；小改只写 `scope.md` | 单文件小修跳过 |
| design | `kelin-goal`、`kelin-plan`；产品类加 `kelin-product`；设计加 `kelin-architect`（双候选）、`kelin-blast-radius`；有性能目标加 `kelin-benchmark` 预算 | 需求不清先回 goal |
| build | `kelin-tdd`；修 bug 加 `kelin-guard`；高风险改动先 `kelin-safety` 冻结范围；正确性存疑加 `kelin-correctness` | 不并行跑构建和测试 |
| verify | `kelin-verify`；项目有 `.zcode/skills/verify-*` 或 `.agents/skills/verify-*` 时优先 `kelin-verify-app` 生成的本地 skill；有性能数字加 `kelin-benchmark`；收尾跑 `kelin-health` | 任何一条失败回 build |
| review | `kelin-review`（门禁扫描 + 对抗审查）；必要时 `kelin-reviewer`；审完 `review-check --write` | P0/P1 清零才前进 |
| refine | `kelin-refine`（含注释审查）；文档对齐用 `kelin-neat` | diff <20 行可跳过 |
| ship | `kelin-brief` 写交付摘要；`kelin-ship` 跑 preflight（强制评审 CURRENT）；`kelin-watch` 盯 CI | 部署必须等人点头 |
| reflect | `kelin-reflect`；关键决定补 `kelin-decision-log` | 没有新结论就直说 |

## 自动激活规则

- 每个会话 SessionStart 注入版本、当前 mode/phase、本地 verify skill、冻结状态和安全钩子。
- 有 `.kelin/state.json` 就续跑，不重新 interview；没有就在任务开始时 `init`。
- 非平凡任务（跨 2 个文件、多步、产品/交付/审计）自动进入 kelin-mode；单文件小修直接做 + `kelin-verify` 快速档。
- 本地 `verify-*` skill 只在验证阶段执行；会话开始不自动起服务。
- 不要每轮重复声明 kelin-stack 规则；按本表选 skill。

## 资源约束

- 最多 2 个子代理（1 写 1 读）；`budget.mjs` 说 1 就只用 1。
- 不并行跑构建和测试；不在同一时刻开浏览器自动化和构建。
- 子代理只接窄任务；通用 worker 用 `agents/kelin-worker.md`，它先读本 skill 和 `kelin-principles`。

# Build（审计发现）

## 结论

结构、脚本、eval 全部通过；发现 2 个 P2 文档漂移、2 个 P3 表述问题，无 P0/P1。

## 已跑检查

- 单元测试：20/20 通过
- offline-check：通过
- agents-check：通过（AGENTS.md 36 行）
- guard-check：通过（2 条 guard）
- neat-check：通过（0 冲突）
- skill-eval：通过（31 个 skill）
- slop-check README：0 命中
- PRD 模板：通过

## 问题

### P2-1 README 的 CI 描述过期
`README.md:180` 写“CI 每次 push 跑这四类”，实际 CI 有 7 个步骤、6 类（单元测试、结构检查、AGENTS、guards、neat、eval）。

### P2-2 kelin-mode 模式数量写错
`skills/kelin-mode/SKILL.md:63` 写“四种模式”，表格实际有 5 种（light/feature/fix/legacy/audit）。

### P3-1 状态机门禁的边界没说清
`advance` 只检查产物文件存在，不校验内容；今天 plan.md 第一次没写“怎么验证”，`advance` 仍然放行，靠 `check-plan` 才发现。

### P3-2 audit 链路描述与状态机不一致
表格写 `audit → map → plan`，实际 audit 模式仍走完整状态机，只是 build 记录发现、refine 才改。

## 未发现

- 断链、端口冲突、版本漂移、重复文档
- 密钥、真实数据、个人路径
- 缺失的 skill 配方或 eval

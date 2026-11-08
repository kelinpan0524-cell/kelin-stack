# 审查结论

P0: 0 / P1: 0 / P2: 2 / P3: 2 —— 建议：修完 P2 再收尾。

## P2

1. **README 的 CI 描述过期**（`README.md:180`）
   - 场景：新贡献者按 README 以为 CI 只有四类检查。
   - 实际：CI 有 7 个步骤、6 类（单元测试、结构检查、AGENTS、guards、neat、eval）。
   - 改法：改成六类并列出。

2. **kelin-mode 模式数量写错**（`skills/kelin-mode/SKILL.md:63`）
   - 标题写“四种模式”，表格有 5 种（light/feature/fix/legacy/audit）。
   - 改法：改为“五种模式”。

## P3

1. **状态机门禁边界没说清**（`skills/kelin-mode/SKILL.md:106`）
   - `advance` 只查文件存在，不校验内容。今天 `plan.md` 第一次缺“怎么验证”，仍被放行，靠 `check-plan` 才发现。
   - 改法：明确写“内容要用对应脚本校验，不过不要 advance”。

2. **audit 链路与状态机不一致**（`skills/kelin-mode/SKILL.md:71`）
   - 表格写 `audit → map → plan`，实际仍走完整状态机；只是 build 记录发现、refine 才改。
   - 改法：补一句说明。

## 已检查且没问题

- 断链、端口、版本、重复段落、旧计划残留
- 密钥、真实数据、个人路径
- skill 结构、触发词、配方覆盖
- 测试与静态验证

---
name: kelin-verify
description: 把“做完了”变成可执行的证明：先写验收断言，再跑基线、跑改动、交证据表。用户说“验证一下”“怎么证明能用”“跑个验收”“别只说做好了”时使用。
---

# 验证

> 命令里的 `$SKILL_DIR` 指本 Skill 所在目录的绝对路径，执行前先替换成实际路径。

“完成”不是一句判断，是一组能重复执行的断言。

## 核心规则

1. **先写验收，再动手。** 断言落到命令、文件、接口或页面操作。
2. **模型自述不算证据。** 只有退出码、输出、哈希、接口返回、截图算。
3. **先跑基线。** 改前跑一遍，单列原有失败，不混进本次结论。
4. **造最小验证脚本。** 非平凡验收写最小可重跑脚本或 CLI（不是框架），脚本本身可复跑。
5. **三值裁决。** 预先声明命题与判据：达标 `VERIFIED`；有效证据未达标 `NOT VERIFIED`；必需项跳过、基线不可比或测量失败 `INCONCLUSIVE`（不算通过，不软化负结果）。兼容改动可绿→绿，性能改善按 `kelin-benchmark` 达标。
6. **验 dry-run 副作用。** 预览或 `--dry-run` 核对承诺不碰的文件、网络或 Git refs 未改。
7. **快慢分层。** 局部快测途中跑；全量/端到端只在严格档与合并门禁跑一次（见 `kelin-tdd`）。

## 步骤

1. **写验收清单**（每条一行，写不出说明需求未定清）：

```
[ ] `npm test` 退出码 0
[ ] `curl /api/health` 返回 {"ok":true}
[ ] 生成文件含 `quote_id` 且行数 = 输入行数
[ ] 页面 1280x800 无横向滚动（截图）
[ ] 数据库迁移演练无法执行时标 `skipped: true`，必填 `skipReason` 写明阻塞原因与最近可达路径（非空、≤160 字符、可打印 ASCII、不含反引号和尖括号）
```

2. **跑基线 → 改后逐条执行**：命令记退出码与关键输出；文件记路径与哈希；接口记状态码与响应；页面记尺寸与截图。
3. **交证据表**：

```markdown
| 断言 | 命令/操作 | 结果 | 证据 |
| --- | --- | --- | --- |
| 单测全过 | `npm test` | 通过 42/42 | 输出见下 |
```

## 界面与插件验证

- **UI 改动**：按 `kelin-ui` 留目标尺寸截图、空状态、错误状态；装了 `impeccable` 时并入其 `critique`/`audit`。
- **插件/仓库级**：用 `kelin-verify-stack` 体检环境、按改动路径分类并跑带哈希回执的验证。

## 反模式

- 只跑 happy path；
- 用“应该”“理论上”代替执行；
- 测试失败后改测试让它过；
- 把跳过说成通过。

## 配套脚本

把验收清单写成 `verify.json`，一次跑完并留下证据：

```json
{ "checks": [
  { "id": "unit", "cmd": "npm test" },
  { "id": "health", "cmd": "curl -fsS localhost:3000/health" }
] }
```

```sh
node "$SKILL_DIR"/scripts/run-acceptance.mjs verify.json
node "$SKILL_DIR"/scripts/run-acceptance.mjs verify.json --json > acceptance.json
```

默认打印 PASS/FAIL、超时标记和汇总 JSON；`--json` 只输出纯 JSON（供 `kelin-mode` 等直接消费）；`--help` 看示例。执行前先校验整份规格，任何参数或规格错退出 2 且不跑任何命令；任意检查失败或超时退出 1。

## 下游衔接

| 下一步 | 去哪 |
| --- | --- |
| 验收失败 | 回 build（`kelin-tdd`），不进 review |
| 验收通过 | `kelin-review`；之后 `kelin-refine` |
| 要项目级可重复验证 | `kelin-verify-app` 生成项目 skill |

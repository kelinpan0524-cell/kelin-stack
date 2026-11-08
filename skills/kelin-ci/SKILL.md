---
name: kelin-ci
description: 把 kelin-stack 的检查装进任意仓库的 CI 和 PR 模板：跑测试、AGENTS.md 预算、功能地图覆盖、验收清单，并让这些成为合并门禁。用户说“给仓库加 CI”“PR 质量太低”“把检查接进 GitHub Actions”时使用。
---

# 接 CI 和 PR 门禁

skill 靠自觉，CI 靠强制。**能自动拦住的规则，不要只写在文档里。**

## 装什么

```sh
node skills/kelin-ci/scripts/install-ci.mjs <仓库目录> --test "npm test"
```

会写入：

- `.kelin/ci/agents-check.mjs`：AGENTS.md 长度/重复/断链/秘密；
- `.kelin/ci/map-check.mjs`：功能地图是否覆盖所有路径；
- `.kelin/ci/run-acceptance.mjs`：跑 `verify.json` 里的验收清单；
- `.kelin/ci/guard-check.mjs`：校验 `guards.json` 里的防再犯记录；
- `.github/workflows/kelin-gate.yml`：push 和 PR 时跑上面三项 + 你的测试命令；
- `.github/pull_request_template.md`：强制写验证证据、风险回滚、防再犯。

已存在的文件默认不覆盖；确实要换用 `--force`。

## CI 跑什么，不跑什么

跑：

- 你的测试命令；
- AGENTS.md 预算（超过 200 行直接失败）；
- `feature-map.json` 覆盖检查（存在时）；
- `verify.json` 验收清单（存在时）；
- `guards.json` 防再犯记录（存在时）。

**不跑** live skill 验证。原因：CI 里没有 ZCode 登录，每次 live 还要花 token。live 验证留在本地或发版前，用 `kelin-verify-stack` 手动跑。

## 装完之后

1. 在 GitHub 仓库设置里把 `kelin-gate` 设为 **required check**，否则它只是建议；
2. 保护主分支：禁止直推、要求 PR、要求 check 通过；
3. 第一次跑先看哪一项失败，把 `AGENTS.md`、`feature-map.json`、`verify.json` 补齐；
4. PR 模板里的“防再犯”一栏，对应 `kelin-guard` 的 guard。

## 仓库该有什么

| 文件 | 作用 | 没有会怎样 |
| --- | --- | --- |
| `AGENTS.md` | 给 agent 的硬约束 | `kelin-agents` 初始化 |
| `feature-map.json` | 路径 → 功能 → 怎么验证 | `kelin-map` 生成 |
| `verify.json` | 验收清单 | `kelin-verify` 生成 |
| `guards.json` | bug → 防再犯手段 | `kelin-guard` 生成 |

四个都没有时，CI 仍会跑测试，但门禁价值有限。先把最关键的补上，不要一次全上。

## 分支保护建议

- 主分支：禁止直接 push，只能 PR；
- required checks：`kelin-gate`；
- 至少一个 review；
- 合并后自动删分支。

这些是 GitHub 设置，不在仓库文件里，需要人去点。

## 反模式

- 装了 workflow 但没设 required check，等于没装；
- 为每个仓库复制一份检查脚本再各自改，最后不一致；用 `--force` 重装统一版本；
- 把 live 验证塞进 CI，结果每次都花钱还经常因登录失败而红。

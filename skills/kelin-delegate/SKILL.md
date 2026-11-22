---
name: kelin-delegate
description: 把边界清楚的单次任务委托给外部 CLI（codex、antigravity、zcode 无头），带回结构化结果并能续接追问；按角色记忆交给谁（review 审查、critique 挑刺、diagnose 会诊、implement 实现），读类角色强制只读沙箱。用户说“交给 codex 审”“让另一个模型看看”“双模型会诊”“委托实现”时使用。
---

> 命令里的 `$SKILL_DIR` 指本 Skill 所在目录的绝对路径，执行前先替换成实际路径。

# 委托

一次委托一个边界清楚的任务。任务文本会发给所选 CLI 的模型服务商并可能产生费用——**密钥、凭据、客户数据不进提示词**。**外部 agent 的自报结果不是证据**：调用方负责检查工作区有没有越界改动、跑真实验证。

## 四个角色

| 角色 | 用途 | 权限 |
| --- | --- | --- |
| `review` | 独立代码审查 | 只读（codex `-s read-only`；agy 无头默认拒写） |
| `critique` | 动手前的方案挑刺 | 只读 |
| `diagnose` | 疑难会诊，可配双路各出一份 | 只读 |
| `implement` | 按已确认方案实现 | 可写（codex workspace-write；agy accept-edits） |

角色交给谁存在 `~/.kelin/delegate.json`（与 `~/.kelin/preferences.md` 分工：前者只管角色路由，后者是通用偏好）。用户说“以后 review 都交给 codex”时保存：

```sh
node "$SKILL_DIR"/scripts/delegate.mjs config --set-role review=codex
node "$SKILL_DIR"/scripts/delegate.mjs config --set-role "diagnose=codex,antigravity"
node "$SKILL_DIR"/scripts/delegate.mjs config --set-role critique=host
```

## 跑

```sh
node "$SKILL_DIR"/scripts/delegate.mjs run --role review --workspace "<项目绝对路径>" --prompt "<目标、边界、完成标准与真实验证命令>"
node "$SKILL_DIR"/scripts/delegate.mjs onboard --scan   # 看本机装了哪些 CLI
```

- 输出固定 JSON：`status / runner / session_id / resumable / workspace_dirty_after / response`；
- `NEEDS_ROLE_CHOICE`（退出码 12）：这个角色还没选过，把 candidates 给用户看、问一次再存；
- `USE_HOST`（退出码 13）：偏好是当前宿主自己做——改用本宿主的全新只读子代理，不调外部 CLI；
- 读类角色回来后核对 `workspace_dirty_after` 为空（自己落的 `.kelin-delegate-last.md` 除外）；有越界改动按红线处理；
- zcode 无头无法强制只读，读类角色不建议配它（配置了会带 warning note）。

## 续接

```sh
node "$SKILL_DIR"/scripts/delegate.mjs run --role review --workspace "<原路径>" --session <上次的 session_id> --prompt "<只发新信息，不重复任务>"
```

codex 与 antigravity 都支持续接（实测）；zcode 不支持，`resumable: false` 时开新任务补背景。

## 委托提示词五要素

目标与边界（不该动什么）、完成标准、入口线索（1-4 个已确认文件）、真实验证命令（从仓库配置确认，不写空泛的“跑测试”）、汇报格式（改动文件 / 验证结果 / 未完成项）。

委托 `review` 须写明口径：只拦有可达触发、后果与证据的真实 P0/P1（纯假设与风格归 P2/P3）；常态 2 轮、收敛可定点复验至多 4 轮，复审只带上轮未关闭项、修复 diff 对比范围与验证证据（核对关闭情况及补丁直接回归，禁重扫全仓新挖坑）。

委托审查的输出契约追加末行裁决：报告最后一行必须是机器可读裁决——无发现写 `CLEAN`、有发现写 `FINDINGS`；末行缺失或为空 = 审查失败，按 `kelin-review` 的"审查失败显性化"处理，禁止解读为"无发现"。

委托命令必须显式带超时参数（`delegate.mjs run --timeout <秒>`）；超时或空输出按显性失败处理，给出可诊断信息（退出码、日志尾部），不得当"审查通过"。

## 下游衔接

| 下一步 | 去哪 |
| --- | --- |
| review 返回 Must Fix | 逐条回读代码确认成立（`kelin-review` 回读剔除），交回实现方修 |
| critique 返回事实错误 | 改进方案后回 `kelin-plan` |
| implement 完成 | `kelin-verify` 亲跑验收 + `kelin-review` 自审，不信自报 |
| 同一根因连续两轮无进展 | 停止返工并带证据报人拍板（需继续查因时转 `kelin-correctness`） |

---
name: kelin-ship
description: 按纪律交付：一任务一分支、带前缀的提交、PR 说明写清验证方式、CI 失败先找根因、部署必须等明确授权、合并后清理。用户说“提交”“开个 PR”“合并”“上线/部署”“收尾”时使用。
---

# 交付

> 命令里的 `$SKILL_DIR` 指本 Skill 所在目录的绝对路径，执行前先替换成实际路径。

交付不是“代码写完了”，是**别人能安全地接过去**。

## 硬规则

1. **一任务一分支。** 分支名说清做什么：`feat/quote-export`、`fix/empty-qty`。
2. **提交信息带当前宿主前缀**（如 `[Antigravity]` / `[Codex]` / `[ZCode]`），第一行说结果，正文说为什么。
3. **进度以远端 main 为准。** 合并前先 rebase/merge 最新 main，别在本地猜。
4. **部署要人点头。** 没听到明确的“部署/上线”，只做到 push + PR。CI 绿不等于可以部署。
5. **真实数据、密钥不进仓库。** 提交前扫一眼暂存区。

## 步骤

### 1. 交付前自审

严车道改动（见下方「自动合并门」分流）须走完整 `kelin-review` 自审且 P0/P1 清零，并写评审回执：

```sh
node "$SKILL_DIR"/../kelin-review/scripts/review-check.mjs --write
```

提交前再跑一次不带 `--write` 的检查。只认 `CURRENT`；`STALE`、`UNVERIFIED`、`MISSING` 都不能当“审过了”。快车道低风险小改可免等跨模型阻断回执（仍须过本地自验与 `gate-scan`），若工作区已存在 `.kelin/review.json`，`preflight` 仍要求其保持 `CURRENT`。

### 2. 验证

用 `kelin-verify` skill 跑验收清单。把命令和结果写进 PR 正文，不要写“已测试”。

### 3. 提交

```sh
git status --short          # 确认只改了该改的
git diff --stat             # 确认没有意外的文件
git add <明确路径>           # 不用 git add -A
git commit -m "[Antigravity] 一句话说结果" -m "为什么这么改，风险是什么"
```

### 4. PR 与易审化

拆开机械改动（改名/格式）与核心逻辑（契约→核心→接线→测试）；整理历史前后核对 `git rev-parse HEAD^{tree}` 一致。正文至少五段，附一句审阅入口顺序：

```markdown
## 做了什么
## 怎么验证的（命令 + 结果）
## 风险与回滚
## 防再犯（guard 或理由）
## 没做的事（及原因）
```

修 bug 的 PR 必须填“防再犯”（对应 `kelin-guard`）。

### 5. CI

- 红了先看**第一个**失败的 job 找根因；网络抖动说明后重跑一次，不改测试或加 `--force`。

### 6. 合并与收尾

- 确认远端 main 已有提交 → 删本地分支 → 交 `kelin-reflect`。

## 自动合并门（快车道 / 严车道）

部署检查（最前）：先判断合并是否触发部署（workflow deploy job 或服务器 cron 轮询都算）；触发部署的仓库必须有明确部署授权才能走自动合并，否则只做到 push + PR。

先跑只读分流脚本确定本次 PR 走哪条车道，避免小修被过度阻塞、同时守住高危防线：

```sh
node "$SKILL_DIR"/scripts/merge-lane.mjs --root . --base origin/main
```

| 车道 | 机器判定条件（`merge-lane.mjs`） | 放行门槛 |
| --- | --- | --- |
| **快车道（`fast`）** | 仅 1–2 个文件、总改动 < 50 行、无二进制 diff、未碰高危路径且 `gate-scan` 0 未解释放宽 | 满足基础五条（CI 全绿且用例只增不减、本地自验通过、PR 写明回滚、非 Dependabot、`gate-scan` 干净）即可合入；深度跨模型审查可合后并行跑，发现真实缺陷发轻量 fix-forward 小 PR |
| **严车道（`strict`）** | 任一命中：≥ 3 文件、≥ 50 行、含二进制 diff、`gate-scan` 有发现，或触碰高危路径（`.github/**` / CI / 门禁脚本 / `REVIEW.md` / `install.sh` / 鉴权与权限 / 支付 / SQL 与迁移 / 生产部署与锁文件 / 密钥与数据表） | 全部六条硬门全过：基础五条 + 必须完成跨模型独立审查（`CLEAN` 且主裁裁决）且 `kelin-review` 回执为 `CURRENT`、P0/P1 = 0 |

以下六条（快车道可跳过第 2 条的跨模型阻塞等待，严车道必须全满足）：

1. CI 全绿，且用例总数相对基线只增不减（机器核对方式见下方证据绑定段：`merge-lane.mjs --pr <N>` 的 `ci.status` 非 `pass` 不许合并）；
2. （严车道强制）`kelin-review` 回执为 `CURRENT` 且 P0/P1 = 0，本档全部必需审查者返回合法裁决且主裁完成裁决（存在未消解审查失败时禁止合并，即使 P0/P1 计数为 0）；
3. PR 正文写明回滚方式；
4. 非 Dependabot 或其他依赖机器人 PR；
5. `gate-scan` 无未解释的门禁放宽类发现；
6. 改动不涉及未授权的自动部署、密钥或真实数据。

证据绑定用机器核对，不要肉眼比对。证据采集前先跑：

```sh
node "$SKILL_DIR"/scripts/merge-lane.mjs --root . --base origin/main --pr <N>
```

传 `--pr` 时脚本依次机器核对（任何一项不过就 `ok:false`、退出码非 0，`ci` 段写明原因）：工作区干净（否则 `dirty`，先提交或清理）；PR 非 draft（否则 `draft`）；PR head SHA 与本地 HEAD 一致（否则 `mismatch`，输出两个 SHA）；该 head 的检查全绿（有失败为 `fail`、还在跑或排队为 `pending`、一条检查都没有为 `none` 即「没有成功记录」；`gh` 调用失败为 `error`，不当成通过）。**`ci.status` 不是 `pass` 一律不许合并**——六条里的第 1 条（CI 全绿）与证据绑定段（HEAD == 远端 PR head SHA）就以这条命令的输出为证据，不靠模型自称。先同步最新目标分支，再针对**同一远端 PR head SHA** 核对分流结果、CI、gate-scan（以及严车道的审查回执），合并命令用 `gh pr merge --squash --match-head-commit <SHA>` 锁定（按仓库合并策略显式传 `--merge`/`--rebase`/`--squash`），禁止拿本地旧回执拼远端新提交的绿门。

任一不满足：停下，列明缺项，交用户拍板。两条红线**优先于本门通用兜底**：Dependabot 大版本依赖 PR 依旧交人拍板或关闭；"合并即部署"仓库的部署确认不在此门覆盖内。

## 部署（只有明确授权才执行）

确认影响与回滚命令 → 可回滚前提下执行 → 立刻查健康/页面/接口 → 出问题先回滚再分析。

## 反模式

- 在 main 上改、PR 只有“update”、CI 红了反复重跑、顺手夹带无关改动。

## 提交前检查

```sh
node "$SKILL_DIR"/scripts/preflight.mjs
```

在暂存之后执行。它检查：是不是直接在 main/master、有没有暂存表格类真实数据、暂存内容里有没有密钥特征；存在 `.kelin/review.json` 时还要求评审指纹是 `CURRENT`，`STALE`/`UNVERIFIED` 直接退出 1。`--require-review` 要求必须有评审回执，`--no-review` 显式跳过评审检查。有问题退出 1，并列出文件；通过退出 0。

## 下游衔接

| 下一步 | 去哪 |
| --- | --- |
| CI 失败 | `kelin-watch` 分类处置 |
| 合并完成 | `kelin-reflect` 复盘；文档先 `kelin-neat` |
| 要部署/发版 | 等明确授权，`kelin-release` 走闸门 |

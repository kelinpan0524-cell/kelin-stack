# Changelog

# 0.26.0（2026-11-28）

吸收 `pstack` 场景剧本路由、开场问题校准与 PR 易审化实践（不膨胀技能数量，全部收口进现有核心技能与脚本门禁）：

- **`kelin-mode` 九条剧本路由与只读硬护栏**：在原有 5 条工程主轨道（`feature`/`fix`/`legacy`/`audit`/`light`）外新增 4 条轻量场景剧本——`investigate`（只读调研/讲原理，`intake → investigate → done`）、`prototype`（抛弃式原型/10 行真探针，`intake → prototype → done`）、`resume`（跨会话续做与安全暂停交接，`intake → handoff → done`，若已有活跃 `.kelin/state.json` 仍保留原轨道不覆盖）、`babysit`（PR 值守/修 CI/分支清理，`intake → babysit → done`）；`routeTask` 返回新增 `playbook` 与 `readOnly` 字段，明确要求只读（即便提及报错/重构/修改方式）一律强制进 `investigate`（或全仓 `audit`），不串联 `setup` 写入，绝不误送开发建分支流程；新增 [skills/kelin-mode/references/playbooks.md](skills/kelin-mode/references/playbooks.md) 写明四条轻剧本步骤，并将新产物与 `changed-features.json` 纳入 `done` 后自动归档清单。
- **`SessionStart` 单真源同步**：`hooks/session-start.mjs` 直接从 `mode.mjs` 导出 `PHASES_BY_MODE` 派生 `VALID_MODES`，消除模式集合重复定义，原生识别四条新剧本状态与配套技能。
- **`kelin-grill` 开场三步校准**：在首轮拷问前融入 `pstack` 的 `in-your-own-words` / `reframe` / `sharpen` 思路——先大白话复述意图、再给模糊描述定名纠偏、最后拔高客观验收标尺并将可实验选择分流到 `kelin-mode prototype`。
- **`kelin-ship` PR 易审化清单**：吸收 `make-pr-easy-to-review`，明确按依赖顺序分层提交、改写历史前后校验 `HEAD^{tree}` 一致、在 PR 正文开头给出审查 TL;DR 与文件阅读顺序。
- **回归测试补齐**：`mode.test.mjs` 新增 4 条新剧本端到端状态机流转、归档与「明确只读不得误入开发流」回归矩阵；`session-start.test.mjs` 新增新剧本状态注入测试。

# 0.25.0（2026-11-25）

验证闭环补缺（第二批，分支 `feat/verify-loop-hardening`）：

- **破坏性变化：`skipped:true` 必须带合规 `skipReason`（第一批，提交 914eb98 的行为收紧说明）**：旧规格里 `skipped:true` 缺 `skipReason`、或原因不合规（要求非空、≤160 字符、可打印 ASCII、不含反引号和尖括号）的 verify.json，`run-acceptance.mjs` 现在会在**执行任何命令之前**以退出码 2 失败（0.24.0 及之前会静默跳过并当通过处理）。迁移办法：给每个 `skipped:true` 的检查补一条写明阻塞原因与最近可达路径的 `skipReason` 字段。
- **验证闭环四缺口（第一批，提交 914eb98）**：补齐 verify 实例新鲜度校验（过期实例不再当有效证据）、改动路径消费（verify 结果按本次改动路径分类执行）、skipReason 显性化（跳过的检查必须带原因，不静默当作通过）与失败回退路径（验证失败时回退到可复核的基线动作），让验证闭环的四类绕过口全部变成机器可拦。
- **合并门前机器核对远端 CI 与 HEAD（本批，kelin-ship）**：`merge-lane.mjs` 新增 `--pr <N>`（**不传 `--pr` 时普通分流的输出与退出码不变**；`--help` 文本新增 `--pr N` 属于文本变化）：依次核对工作区干净（`dirty`）、PR 非 draft（`draft`）、PR head SHA 与本地 HEAD 一致（`mismatch`，输出两个 SHA）、该 head 的检查全绿（`fail` / `pending` / `none`，`gh` 调用失败为 `error` 且不当成通过），核心逻辑抽成可导入纯函数 `evaluatePrCi`，理由字段全部按仓规限为可打印 ASCII 且 ≤160 字符；`kelin-ship/SKILL.md` 把自动合并门第 1 条与证据绑定段的执行方式绑定到 `merge-lane.mjs --pr <N>` 命令输出，`ci.status` 非 `pass` 一律不许合并，`--match-head-commit <SHA>` 锁定要求保留。
- **值守分类看日志证据、等待有上限（本批，kelin-watch）**：`watch.mjs` 失败分类改为证据优先级「日志 > 名字 > unknown」——对能定位到 Actions run/job 的失败 check 拉取失败日志尾部（≤8000 字符）判类（代码/环境/网络/权限），名字正则降级为无日志时的兜底且每个失败项带 `source`（`log`/`name`/`none`）与 `note`；无日志且名字无信号时给 `unknown` 并提示人看一眼，不许无证据当 code 开修；`total === 0` 结论改 `no-checks`（退出 2）不再报 pass；补齐文档已承诺的 `--interval <秒>` / `--max <次数>` 有限轮询（只在 pending 时继续、到上限带 pending 返回、只打印状态变化），分类与轮询抽成可导入纯函数并新增 `skills/kelin-watch/tests/watch.test.mjs`。
- **假绿修复轮：机器门禁证据收紧（本批终审 7 条，同一分支追加）**：
  - `merge-lane.mjs --pr`：工作区查询失败不再当干净——`git status` 显式带 `--untracked-files=normal`（命令行参数覆盖用户 `status.showUntrackedFiles` 配置），`git status` 或 `git rev-parse HEAD` 退出非 0 时 `ci.status=error`、`ok:false`；远端证据必须完整——`isDraft` 必须是显式布尔（缺失即 `error`），rollup 按 GitHub 两种检查类型分别判定（CheckRun 要求 `status=COMPLETED` 且 `conclusion=SUCCESS`，StatusContext 要求 `state=SUCCESS`），识别不了的形状归 `unknown` 不通过，且必须至少有一条明确成功——只有 SKIPPED/NEUTRAL 的 rollup 归 `none` 不通过，有成功项时其余跳过项才可放过。
  - `watch.mjs`：判定以 `bucket` 为准（`fail`/`cancel` 失败、`pending` 等待、`pass` 通过、`skipping` 中性），`state` 与 `bucket` 矛盾或 bucket 缺失/无法识别归 `unknown`（退出 2 交人看，不报 pass），修复 `state=ERROR`/`state=EXPECTED` 被报成 pass 的假绿；识别 gh 的真实「no checks reported on the '<branch>' branch」失败响应为 `no-checks`（退出 2），其他 gh 失败仍按通用错误退出 2。
  - `map-check.mjs --changed-from`：先 `git rev-parse --verify <ref>^{commit}` 解析成 SHA，失败退出 2 并提示是否误传了文件路径（此前传路径会算成「无需验证」的假绿）；取路径改用 `git diff --name-only --no-renames -z <sha> --`，重命名场景旧路径（含 owner 归属）与新路径同时计入，旧 owner 的验证项不再消失。
  - `map-check.mjs` 新增 `--verify <path>`（默认 `.kelin/verify.json`，文件不存在则跳过）：比对 `matched` 的 feature 集合与 verify.json `checks[].feature` 声明集合，缺项输出 `missing` 数组并退出 1；`run-acceptance.mjs` 允许并透传 `check.feature`（可选字符串，1-64 位可打印 ASCII，不含反引号和尖括号），裁决语义不变；`kelin-mode` 路由规定 verify 阶段必须跑 `map-check.mjs <map> --changed-from <base> --verify .kelin/verify.json`，退出非 0 不得 advance，无法覆盖的 feature 用 `skipReason` 申报（仍判 INCONCLUSIVE）。

# 0.24.0（2026-11-23）

系统吸收上游 `pstack` / `open-pstack` / `noodle` 防审查钻牛角尖机制，补齐审查契约、噪音分诊与合并门分层（PR #29 / #30 / #31）：
- **仓库级 `REVIEW.md` 审查契约与基线安全注入（PR #29）**：新增通用模板 `skills/kelin-mode/templates/REVIEW.md` 与本仓 `REVIEW.md`（纳入 `verify-stack` `registry.json`）；`mode.mjs setup` 支持 `--with-review-policy` 预览与幂等生成并将路径安全校验前置到首次写入前；`delegate.mjs` 在 `role=review` 首轮自动读取并追加基线分支权威 `REVIEW.md`（防止待审分支篡改审查口径，提供 `--allow-worktree-review-policy` / `--no-review-policy` 及仓外符号链接拦截）。
- **按体量建议限额与怀疑式噪音分诊表（PR #30）**：新增 `skills/kelin-review/references/noise-triage.md`（修复 / 证据驳回 / 交人拍板三分法与 6 条内置低风险噪音模式，保留 `gate-scan` 门禁放宽交人拍板优先）；`kelin-review/SKILL.md` 与 `agents/kelin-reviewer.md` 补齐小改每维 ≤1 条（总计 ≤3 条）、大改每维 ≤4 条的非阻断上限与“无实质问题直接输出 `CLEAN`”规则。
- **自动合并门快/严车道与机器分流脚本（PR #31）**：新增只读分流脚本 `skills/kelin-ship/scripts/merge-lane.mjs` 及测试 `skills/kelin-ship/tests/merge-lane.test.mjs`，统一从仓根按文件数（≤2）、改动行数（<50）、高危路径表、二进制 diff、未追踪文件与 `gate-scan` 联动结果输出 `fast | strict | none`；`kelin-ship/SKILL.md` 同步拆分为快车道（低风险小改 CI 绿 + 本地自验即可合并、深度审查事后 fix-forward）与严车道（强阻塞跨模型审查与 `CURRENT` 回执），守住部署与依赖机器人两条红线。

# 0.23.1（2026-11-23）

`review-check` 签章与 `kelin-mode` 流程门禁统一升级为「结构化裁决 + 正文松绑」并补齐防钻牛角尖规则：
- **结构化封面优先，正文彻底松绑**：`review-check.mjs` 新增并导出 `evaluateReviewReport`，优先读取报告顶部 YAML frontmatter 的 `verdict: clean | findings | failed`（及可选 `reviewers` / `failed_reviewers` 状态）；正文只需非空且无未闭环 P0/P1，正文中英文或代码块引用失败示例均不再误伤。
- **末尾裁决兼容与边界封堵**：无封面报告改为仅认剥除 HTML 注释后的末尾有效行 `CLEAN` / `FINDINGS`（堵死隐藏注释藏词与正文中间示例代码混充）；失败声明检测改跑在剥除代码块和注释后的正文上并忽略英文大小写（修 `Review Failure:` 漏拦与代码块引用误伤）。
- **单真源统一门禁与委托结构化提取**：`kelin-mode/scripts/mode.mjs` 删除独立旧正则，在 `review` / `ship` 阶段统一复用 `evaluateReviewReport`，消除签章与推进打架及旧回执绕过；`kelin-delegate/scripts/delegate.mjs` 在长输出截断前从完整原文提取 `verdict`（`CLEAN` / `FINDINGS` / `MISSING`）随 JSON 返回。
- **防审查钻牛角尖底线**：`kelin-review/SKILL.md` 与 `agents/kelin-reviewer.md` 吸收 `pstack` / `open-pstack` 经验，明确「可达 ≠ 有后果（实际使用面原则）」「怀疑式分诊（修复/驳回/交人拍板，禁止逢评必改）」与「拆前提止损（同一前提连修两轮不过即换结构方案）」。

# 0.23.0（2026-11-23）

对照 poteto/noodle 对抗审查模式补齐委托审查硬约束与自动合并门（SKILL.md 文本 + delegate.mjs 截断保留头尾 + 版本号）：

- **审查者硬约束（kelin-review）**：对抗审查者必须跑在对面模型的 CLI 上（Claude 系代理显式走 `kelin-delegate --runner codex --role review` 的 codex exec 只读沙箱；Codex 系代理显式走 `claude -p --permission-mode plan` 只读，不支持该模式或无法保证只读时按审查失败处理，不得以禁部分工具充当只读），均不经 delegate 路由且通用角色路由只能作为对抗审查之外的补充视角、不能充当必需审查者，指定入口不可用按审查失败处理，禁止用运行在自家模型上的子代理或内部委托机制充当独立审查者、不把本家模型输出计为独立审查。
- **审查失败显性化（kelin-review / kelin-delegate）**：审查者输出缺失、为空、超时或异常退出 = 显性失败，必须点名写进审查结论，禁止静默当作"无发现"；委托命令必须显式带 `--timeout`，超时给出退出码或日志尾部等可诊断信息；审查报告末行必须是机器可读裁决（无发现 `CLEAN`、有发现 `FINDINGS`，从返回 JSON 的 `response` 字段读取），末行缺失按审查失败处理；全部必需审查者返回合法末行裁决且主裁完成裁决才允许签回执，存在未消解审查失败时禁止签 `CURRENT`、禁止合并，首轮放行同此前提；`review-check --write` 无审查报告或报告为空/无逐条发现与裁决记录时拒绝签章（须 `--review FILE` 或 `.kelin/review.md`），无报告哈希的 stamp-only 旧回执一律不判 `CURRENT`；delegate.mjs 长 `response` 截断改为保留头尾（仅超 14000 字符才前 12000 + 末 2000 拼接加省略标记，避免头尾重叠），末行裁决不再被截掉。
- **Lead Judgment 与意图先行（kelin-review）**：按固定顺序处理外来发现——去重 → 逐条回读取证并明判接受 / 驳回加一句理由（证据不足在裁决中说明理由后剔除）→ 筛出行动项，回读剔除环节同样只许记录驳回理由后剔除，点名误报、过度引申、把风格当实质三类典型问题；审查开始先一句话写明改动意图，只挑战是否达成意图、不挑战意图本身，意图与发现一起进结论；意图先行不豁免 gate-scan 与安全检查。
- **体量分档与自动合并门（kelin-review / kelin-ship）**：审查档位叠加体量维度（< 50 行且 ≤ 2 个文件轻量核验、≥ 50 行或 ≥ 3 个文件独立深审、> 200 行或 ≥ 5 个文件独立深审 + 全量对抗审查），与风险档位取更严者、同时命中多档按最高档执行，体量档绑定首轮完整 diff、后续按增量复验；kelin-ship 新增自动合并门：部署检查前置（触发部署的仓库须有明确部署授权），六条全满足才可合并（CI 全绿且用例只增不减、review 回执 CURRENT 且 P0/P1 = 0、PR 写明回滚方式、非依赖机器人 PR、gate-scan 无未解释放宽、不碰生产配置/密钥/迁移高危区），证据采集前工作树须干净且 HEAD == 远端 PR head SHA，审查回执、CI 与 gate-scan 须绑定同一远端 head SHA 并用 `gh pr merge --squash --match-head-commit`（按仓库策略选 merge/rebase/squash）锁定；Dependabot 大版本 PR 直接关与"合并即部署"仓库部署确认两条红线优先于本门通用兜底。

# 0.22.0（2026-11-21）

全面对齐上游 `pstack` / `open-pstack` 工程强约束，并落地 `kelin-mode` 零门槛自动化：

- **可信证据与发布门禁绑定**：`kelin-verify/run-acceptance` 支持 `--root` 与多维哈希（`specHash` / `worktreeFingerprint` / `requiredIds` / 三值 `verdict`）；`kelin-audit` 强制覆盖声明表（校验状态列与已审计数）并接入 `audit` 只读状态机轨道；`kelin-verify-stack` 与 `kelin-release` 绑定 `gitHead`、`treeHash`、干净工作区校验、`verificationLevel` 与 `--require-live`；`kelin-benchmark` 与 `kelin-decision-log`（需至少一条实质决策记录，单独 `start` 标记会拒绝）封堵零工作量定向结论与无决策日志通过。
- **门禁静态扫描补盲（`kelin-review` / `kelin-ship`）**：新增注释通道 `extractComments()`，精准捕获注释里的 `RH-13`、`try/catch {}` 跨行吞异常、整文件删除测例/快照、C 转义路径与无关快照篡改，同步修正字符串字面量与更严格超时收紧的误报；`preflight --strict-gates` 强制拦截。
- **计划门禁与 Guard 棘轮机制**：`kelin-plan` 升级 `check-plan.mjs`（依赖环检测、单任务 `- verify:` 与 `planHash`）与 `plan-gate.mjs`（双镜头审查与决策哈希绑定）；`kelin-guard` 新增 `arch` 架构防线、`enforcedIn` 机制检查、例外到期校验与 `ratchet-check.mjs --strict-shrink` 只减不增计数棘轮；`kelin-refine` 等补齐注释审改分离与溯源规则。
- **项目验证与跨宿主冒烟验证**：`kelin-verify-app` 保留 HTTP 方法、`limit` 提至 30、生成稳定 ID 与现有测试框架探测，并支持 `--write --sync` 增量同步不覆盖手改；`kelin-verify-stack` 支持多用例 `(feature, caseId)` 回执校验，并新增离线零 token `smoke --host antigravity|codex`。
- **`kelin-mode` 零门槛丝滑接入**：`mode.mjs` 新增只读预览 `setup`（`--apply` 接入 `AGENTS.md`、`.gitignore`、`kelin-policy.json` 及可选 `--with-verify-app`/`--with-precommit`）与 `route` 自动路由（按任务判定模式、companion skills、`needsGrill` 与续跑检测）；`init --task` 自动选模式并在上一轮 `done` 后自动归档到 `.kelin/history/`；`SessionStart` 同步注入配套技能与未接入提示。

# 0.21.0（2026-11-20）

- **验收 CLI 升级（吸收 `cli-for-agent` / `verify-this`）**：`skills/kelin-verify/scripts/run-acceptance.mjs` 新增 `--help`/`-h`（带示例）、纯 stdout `--json`（可直接重定向给 `kelin-mode` 的 `acceptance.json`）、执行前整份规格校验（缺参/重复 id/小数或越界 `timeoutMs`/含 NUL 字符/未知参数立即退出 2 且零副作用，兼容旧 `"5000"` 与 `0`）、进程组超时终止（`SIGTERM` → 宽限 `SIGKILL`）与大输出防截断；`kelin-mode/scripts/mode.mjs` 在 `refine` 阶段补齐 `acceptance.json` 的 `ok:true` 校验；新增单元测试 `verify-acceptance.test.mjs`。
- **验证方法论与项目验证维护（吸收 `pstack` / `control-cli`）**：`kelin-verify` 补齐最小可重跑验证脚本、预声明三值裁决（`VERIFIED`/`NOT VERIFIED`/`INCONCLUSIVE`）与 dry-run 副作用核查；`kelin-verify-app` 修正不再用 `--force` 覆盖手工旅程，加入三类失败分流（地图漂移/驱动缺口/产品真坏）、旅程失败后重跑体检/重置状态、新断言“先见其失败”与 `references/cli-harness.md`（`tmux`/PTY 确定性等待与清理隔离）；`generate.mjs` 补 `--help` 与严格参数校验。
- **代码即注释与工程底线升级（吸收 `no-comments` / `deslop` / `correct`）**：`kelin-refine` 合并重复注释段落为「代码即注释」（五类严格白名单、自家怪行为=重构目标、`shortcut:` 临时债务、约束注释溯源编码后删、抑制注解 diff 核定、清理内部信任边界多余 `try/catch`）；`kelin-guard` 新增 0 级「架构消除」并强调结构防住后删文档规则；`kelin-correctness` 补行为测试第二刀与修复须有运行时证据；`kelin-principles` 与 `kelin-plan` 精炼补入先减后加、边界纪律与低成本实测原型；更新 `NOTICE` 与 `registry.json`。

# 0.20.0（2026-11-20）

- **Antigravity 原生插件**：新增 `.antigravity-plugin/plugin.json`、根目录 `hooks.json`、`rules/AGENTS.md`、`assets/logo.svg`，三份插件清单统一升至 `0.20.0`，ZCode / Antigravity 共用全部 40 skills、3 agents 与 2 个钩子脚本。
- **双宿主钩子适配**：`hooks/session-start.mjs` 与 `hooks/pre-tool-use.mjs` 支持 `--host antigravity` 及自动识别；`SessionStart` 按 AGY `injectSteps` 格式注入并兼容空工作区；`PreToolUse` 支持 `run_command`/`write_file`/`edit_file` 等工具，放行用 `{"decision":"ask"}` 交回宿主默认权限，高危用 `force_ask`，灾难与越界冻结用 `deny`。
- **安装器升级**：`install.sh --host antigravity --scope user` 默认安装干净原生插件包到 `~/.gemini/config/plugins/kelin-stack`（排除 `.git` 与 ZCode 专用 `hooks/hooks.json`，通过 `agy plugin validate --strict` 零警告）；`--subset` 修正为装入 `~/.gemini/config/skills/`。
- **门禁与 neat 对齐**：`offline-check`、`verify-stack`、`registry.json`、`neat-check`、`release.mjs`、`kelin-policy.json` 纳入 `.antigravity-plugin/plugin.json` 与 `hooks.json`；新增双宿主钩子与安装器单元测试；同步 README、AGENTS.md、support-matrix 与 kelin-safety 文档。

# 0.19.0（2026-11-18）

- **新 skill**：`kelin-grill`（拷问）——移植 Matt Pocock 的 grilling（`mattpocock/skills`，MIT，32.7 万 star，2026-11-18 版）。设计树 + 轮次：每轮问完整个前沿、每题给推荐答案、事实自己查、决定交给人，前沿问空才算收。定位在 `kelin-plan` 之前，专治“还没想清楚就开写”。补了它与 plan/product/goal/architect/review 的分工、反模式与下游衔接。
- gen-docs 分组加入 `kelin-grill`；README 命令数 39 → 40。

# 0.18.0（2026-11-18）

跨宿主大版本：ZCode / Codex / Antigravity 三宿主可用（能力边界见 docs/support-matrix.md）。

- **安装**：`install.sh` 支持 codex/antigravity 项目级（共用 `.agents/skills/`）与用户级、`--subset` 子集、幂等与安全卸载（只删清单内自有条目）。
- **自定位**：全部 SKILL.md 脚本调用改 `$SKILL_DIR` 占位符；drift-check 升级为查 66 处引用并拦截仓库根相对调用。
- **新 skill**：`kelin-delegate`（三 runner 委托、四角色记忆、读类强制只读沙箱、codex/agy 会话续接）；`kelin-branches`（分支看板：合入五分类、三分组、只报不动）。
- **方法论吸收（oil-dev-skills）**：根因排查手册进 correctness；执行快规则（测试控频）进 tdd/verify；plan 增加"本期不做"+好差对照（check-plan 强制）；guard/agents 严进常删；review 回读剔除；worker 禁自行提交；AGENTS 骨架加开发约定节；全部 skill 补下游衔接表。
- **精简**：kelin-architect 并入 kelin-plan 设计草图节（触发词重叠修复）；触发词全量审计零重叠。
- **行为 eval**：evals/fixtures 三 case（generate→install→delegate→grade 全链路），首轮实测两过一 3/4。
- **个人偏好**：`~/.kelin/preferences.md`（四层优先级，host 覆盖回退共享）。
- **安全钩子改为 opt-in**：`KELIN_SAFETY` off（默认）/relaxed/strict 三档；修复 `sh -c` 引号与 `git -C` 包装绕过（附回归测试）。
- CI 补 drift-check 与全量测试文件。
- **遗留清理（同日）**：gate-scan 新增 CircleCI/Buildkite/Azure/Bitbucket 识别（含测试）；委托审查输出契约强制逐条 `file:line`（review+delegate 双侧）；fixture 判分器结构化断言 + `--selftest` 关键词堆砌负例；run-fixture 退出码纳入 delegate 成败；吸收 oil-explore 快速探索档进 kelin-map、审查风险分层档进 kelin-review；明确与 oil-delegate 共装分工规则。


## v0.17.0 - 2026-11-11

- SessionStart 自动激活：每个会话注入 kelin-mode 入口、当前 mode/phase、本地 verify-* skill 和安全钩子状态，用户不需要每次点名 skill。
- `kelin-health` 修复单元测试命令：显式传测试文件列表，不再在 Node 26 下报找不到模块。
- `kelin-review/gate-scan` 默认基准改为 `origin/main`（回退本地 main/master 或 HEAD），提交后仍能扫描；测试文件先剥离字符串/注释，减少夹具误报。
- `kelin-ship/preflight` 强制评审指纹：`.kelin/review.json` 存在时只接受 `CURRENT`；支持 `--require-review` 和 `--no-review`。
- `kelin-mode` 增加阶段路由：design/verify/review/ship 分别接入 benchmark、safety、verify-app、health、brief、review 指纹。
- `kelin-safety` 补绕过：引号根路径、`find -delete`、`xargs rm`、`git push +main`/`--mirror`、冻结状态下的 Bash 重定向写文件。
- `kelin-evals` 增加五步编辑阶梯和四层落点；`skill-bill` 默认对比 `origin/main`，支持 `--base`。
- `kelin-docs` 文档覆盖率、`kelin-audit` 覆盖声明、`kelin-verify-app` 生成器等沿用 0.16.0。

## v0.16.0 - 2026-11-11

- 新增 `kelin-benchmark`、`kelin-brief`、`kelin-safety`、`kelin-verify-app`、`kelin-test-audit`、`kelin-health`。
- `kelin-review` 增加门禁完整性扫描和评审指纹；`kelin-ship` 只接受 CURRENT。
- `kelin-audit` 增加覆盖声明；`kelin-architect` 增加双候选；`kelin-decision-log` 增加证据指针校验。
- `kelin-evals` 增加体量账单和引用漂移；`kelin-ci` 增加按改动裁剪；`kelin-docs` 增加文档覆盖率。
- 新增 `kelin-worker` 代理；`kelin-refine` 增加注释审查；`kelin-principles` 增加六条工程原则。

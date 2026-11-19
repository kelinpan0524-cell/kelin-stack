# Changelog

# 0.21.0（2026-11-20）

- **验收 CLI 升级（吸收 `cli-for-agent` / `verify-this`）**：`skills/kelin-verify/scripts/run-acceptance.mjs` 新增 `--help`/`-h`（带示例）、纯 stdout `--json`（可直接重定向给 `kelin-mode` 的 `acceptance.json`）、执行前整份规格校验（缺参/重复 id/非法 `timeoutMs`/`cwd` 或未知参数立即退出 2 且零副作用）、以及显式超时状态（`timedOut`/`signal`/`error`）；新增单元测试 `verify-acceptance.test.mjs`。
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

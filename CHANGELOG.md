# Changelog

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

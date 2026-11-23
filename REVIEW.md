# REVIEW.md — kelin-stack 仓库审查契约

本文件与 `AGENTS.md` 并列，作为 `kelin-stack` 独立代码审查（Codex / 外部模型 / 主裁）的事实依据与阻断口径。不覆盖 `AGENTS.md` 的硬约束，也不豁免真实功能或安全缺陷。

## 怎么判定是否阻断

- **可达 ≠ 有后果**：能走到某分支不等于必须拦交付；只把在真实 `kelin-stack` 使用链路下可触发、会改变真实判定/安装/运行结果的缺陷定为 P0/P1。
- **实际使用面原则**：须由本仓脚本、宿主 Agent 或 CI 真实产出的输入触发。靠人工故意伪造合法格式内容、恶意篡改本地 `.kelin/` 状态文件，或构造上游绝不产出的极端输入才触发的边界，除安全与路径越界外，一律归 P2/P3 不拦交付。
- **发现 ≠ 判决**：审查者可报任何观察到的边界，是否阻断由主裁结合本契约与改动意图判断；未验证的猜测标“待确认”，不升格为必改项。
- **代码靠真实结果挣位置**：改完不改变真实 PR 或插件行为的防御性加固、重构偏好、措辞风格，不作为阻断缺陷。

## 实际运行与使用面事实

- **运行环境**：Node.js 22+（ESM，零外部 npm 依赖），运行在开发者 macOS 本机（Antigravity / Codex / ZCode）及 GitHub Actions `ubuntu-latest` CI。本仓是本地开发者工具与插件包，不是多租户公网服务。
- **安装与打包方式**：`install.sh` 支持全量原生插件安装与 `--subset <skill>` 单技能子集安装；`docs/skills.md` 与 `agents-digest/kelin-AGENTS.md` 由 `skills/kelin-docs/scripts/gen-docs.mjs` 生成，CI 做 drift 校验。
- **验证基线**：全量单测 `node --test $(find skills -name '*.test.mjs' | sort | tr '\n' ' ')`、`offline-check.mjs`、`health.mjs`、`ratchet-check.mjs`、`drift-check.mjs`、`policy-check.mjs`、`gate-scan.mjs`、`agy plugin validate .` 与 `verify-stack.mjs run --all`。

## 明确不阻断的入口边界（免拦清单）

- **本机防误不防故意作弊**：`skills/kelin-review/scripts/review-check.mjs`、`skills/kelin-mode/scripts/mode.mjs` 与 `skills/kelin-verify/scripts/run-acceptance.mjs` 用于防漏步骤、空模板、失败误签、陈旧回执和脚本打架；本机操作者故意伪造合法结构化字段或合法测试输出以欺骗本地门禁不在阻断范围内。
- **单技能子集自包含**：`install.sh` 支持 `--subset kelin-delegate` 独立安装；因此 `skills/kelin-delegate/scripts/delegate.mjs` 为保持零跨 skill 强依赖而内聚少量通用解析逻辑是有意设计，不以 DRY 原则判 P0/P1。
- **多宿主仓库根目录布局告警**：在仓库根目录运行 `agy plugin validate .` 出现的 2 条目录布局警告（根目录 `AGENTS.md` 与 ZCode 专用 `hooks/hooks.json`）属多宿主仓库预期行为；真正安装产物通过 `install.sh` 剥离上述路径并经 `--strict` 校验。
- **生成文件**：`docs/skills.md` 与 `agents-digest/kelin-AGENTS.md` 只受 `gen-docs.mjs --check` 约束，不单独挑剔生成格式。

## 不可豁免红线（任何路径均不得免拦）

- `.github/workflows/**`、`ratchet.json`、`guards.json`、门禁测试与断言被无依据放宽或删减；
- `install.sh` 与各类写入脚本的路径安全（symlink 逃逸、误删非安装清单目录、越界写入）；
- `skills/kelin-ship/scripts/preflight.mjs` 的密钥/真实数据/默认分支拦截，以及 `delegate.mjs` 对只读沙箱与仓外路径读取的防护；
- 任何导致 CI、插件校验或三处 `plugin.json` 版本/结构失配的真实回归。

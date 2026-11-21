# Kelin Stack

**跨宿主工作流插件（ZCode + Antigravity 原生插件，Codex 兼容）**：把“怎么把活干扎实”从口号变成一套能执行、能检查的流程。

pstack 是为 Claude Code / Codex 写的，直接搬到 ZCode 和 Antigravity 会水土不服：命令撞名、钩子协议不同、依赖 bun、无头会话接法也不同。所以这里是重写，不是 fork。

## 一个命令跑完：`/kelin-mode`

`/kelin-mode` 是编排层。它先判断任务类型，再按阶段调用 skill；五个模式：`light`、`feature`、`fix`、`legacy`、`audit`。状态存在 `.kelin/state.json`，用 `mode.mjs` 推进，每个阶段有产物门禁。阶段顺序、命令和门禁规则见 [kelin-mode](skills/kelin-mode/SKILL.md)。

**24GB 内存的硬限制**：最多 2 个子代理（1 写 1 读），不并行跑构建和测试，不整仓读文件，Node 脚本加 `--max-old-space-size=2048`；起代理前先跑 `node skills/kelin-mode/scripts/budget.mjs`，按它给的 `maxAgents` 决定并发。

## 一条链路，四十个命令

按阶段分组；每个命令的用途、是否有脚本、是否有 live 检查，见生成索引 [docs/skills.md](docs/skills.md)。

- **想清楚**：`kelin-mode`、`kelin-goal`、`kelin-product`、`kelin-grill`（拷问）、`kelin-plan`（含设计草图）、`kelin-blast-radius`、`kelin-map`、`kelin-legacy`、`kelin-multirepo`、`kelin-ci`
- **做扎实**：`kelin-tdd`、`kelin-correctness`、`kelin-verify`、`kelin-loop`、`kelin-safety`、`kelin-test-audit`
- **交出去**：`kelin-review`、`kelin-delegate`、`kelin-ui`、`kelin-audit`、`kelin-refine`、`kelin-unslop`、`kelin-brief`、`kelin-decision-log`、`kelin-guard`、`kelin-ship`、`kelin-release`、`kelin-watch`
- **接得住**：`kelin-recall`、`kelin-branches`（分支看板）、`kelin-agents`、`kelin-neat`、`kelin-reflect`、`kelin-principles`
- **验证自己**：`kelin-verify-stack`、`kelin-verify-app`、`kelin-benchmark`、`kelin-health`、`kelin-evals`、`kelin-docs`

命令统一带 `kelin-` 前缀，避免和 ZCode 内置命令、已装 skill 冲突。

## 硬机制

- **门禁完整性**：`kelin-review/scripts/gate-scan.mjs` 扫 diff 里被删的测试、被放宽的阈值、被关掉的检查；门禁类发现只问人不自动修。
- **评审指纹**：`kelin-review/scripts/review-check.mjs` 把评审绑定到工作树；`STALE` 或 `UNVERIFIED` 不能当“审过了”。
- **运行时安全（默认关闭，要求才开启）**：`kelin-safety` 三档——off 默认完全不启动；relaxed 只挡灾难级；strict 全量拦 `rm -rf /`、强推默认分支、冻结范围外写入。开关：`KELIN_SAFETY` 环境变量或 `echo strict > ~/.kelin/safety.mode`。
- **性能取证**：`kelin-benchmark` 要求至少交替跑 5 次、报中位数和范围，结论只允许四选一。
- **项目级验证**：`kelin-verify-app` 生成项目本地 `verify-<app>` skill，固定启动/体检/驱动/留证/清理五段。
- **人话简报**：`kelin-brief` 先一句“现在等你什么”，再列决定、推荐、证据、风险。
- **质量面板**：`kelin-health` 一次跑完测试、结构、文档、AGENTS、guards 检查，只报不改。

## 三个子代理

- `kelin-reviewer`：只报能证明的问题，每条带位置、触发条件、后果、改法；
- `kelin-verifier`：只认命令输出和文件证据，不接受“理论上没问题”；
- `kelin-worker`：通用执行代理，先读 `kelin-mode` 和 `kelin-principles`，不自行扩大范围，不嵌套子代理。

## 验证器怎么工作

`/kelin-verify-stack` 从 [open-pstack](https://github.com/ericlitman/open-pstack) 的验证思路改造而来，换成了 ZCode 原生实现：

1. 体检：ZCode CLI、插件清单、登录凭据结构（只读键名）、输出目录；
2. 分类：按改动路径算出该测哪些功能，未知路径直接拒绝；
3. 真跑：启动无头 `zcode -p` 会话，从会话记录里确认 `Skill` 真的被调用；
4. 断言：文件里必须出现随机标记或 skill 正文原句，模型自述不算；
5. 回执：逐条断言、transcript 哈希、产物哈希、插件树哈希；
6. 复核：出报告前重新校验所有哈希；插件树前后不一致直接判失败。

它默认验证 kelin-stack 自己，也能验证任何 ZCode 插件：

```sh
# 默认：只跑静态检查，不花 token
node skills/kelin-verify-stack/scripts/verify-stack.mjs run --all --output /tmp/ks-static

# 需要真会话时显式加 --live
node skills/kelin-verify-stack/scripts/verify-stack.mjs run --all --live --output /tmp/ks-live
```

静态检查不花模型调用。live 检查每个功能约 42 万 tokens（大部分命中缓存）、10-20 秒；10 个 live 功能约 420 万 tokens、3 分钟。不并行，内存里同时只有一个会话。显式 `--feature zcode:skill-invocation:<名字>` 会直接跑 live；`--all` 和 `--changed` 默认只跑静态，加 `--live` 才跑配方。

## Token 预算

| 动作 | 实测消耗 | 什么时候用 |
| --- | --- | --- |
| `run --all`（静态） | 0 | 每次改完 |
| `run --all --live` | 约 420 万 tokens | 发版前、改了很多 skill 之后 |
| 一个 live 功能 | 约 42 万 tokens | 只改了一个 skill 时 |
| 一个子代理 | 新会话，10 万级上下文 | 窄任务，最多 2 个 |

省法：默认静态；`--live` 只抽样；小任务用 `kelin-mode light`；不要每个阶段都起子代理。

## 安装

三个宿主共用同一份 `skills/`、`agents/` 与钩子脚本：

**Antigravity（原生插件，推荐）**：

```sh
git clone https://github.com/kelinpan0524-cell/kelin-stack.git && cd kelin-stack

# 用户级（默认装完整原生插件到 ~/.gemini/config/plugins/kelin-stack，自动排除 .git 与 ZCode 专用 hooks/hooks.json）
./install.sh --host antigravity --scope user
agy plugin validate ~/.gemini/config/plugins/kelin-stack --strict

# 只装 skill 子集到全局 ~/.gemini/config/skills/（省上下文）
./install.sh --host antigravity --scope user --subset "kelin-mode,kelin-plan,kelin-verify,kelin-review"

# 项目级（装进目标项目 .agents/skills/）
./install.sh --host antigravity --scope project --path /path/to/your-project

# 卸载（只删本安装器创建的插件目录或清单条目）
./install.sh --host antigravity --scope user --uninstall
```

也可用 `agy plugin install ./kelin-stack` 直接安装，注意它会把 `.git` 和 ZCode 的 `hooks/hooks.json` 一并拷入插件目录。

**ZCode（插件市场，推荐）**：

```sh
zcode plugins marketplace add kelinpan0524-cell/kelin-stack
zcode plugins install kelin-stack@kelin-stack-market
```

**Codex（用安装脚本）**：

```sh
git clone https://github.com/kelinpan0524-cell/kelin-stack.git && cd kelin-stack

# 项目级（装进 .agents/skills/）
./install.sh --host codex --scope project --path /path/to/your-project

# 用户级（全局 ~/.agents/skills/）
./install.sh --host codex --scope user

# 只装一部分（省上下文注入）
./install.sh --host codex --scope user --subset "kelin-mode,kelin-plan,kelin-verify,kelin-review"

# 可选：把 kelin 路由块写进全局 AGENTS.md（进入 kelin-mode 的入口）
node skills/kelin-agents/scripts/ensure-workflow.mjs --global codex --dry-run

# 卸载（只删本安装器装的 kelin-* 条目）
./install.sh --host codex --scope user --uninstall
```

安装器幂等、写入前显示目标、不覆盖非 kelin 内容、`--uninstall` 只删清单记录的条目。各宿主的能力边界与实测结论见 [docs/support-matrix.md](docs/support-matrix.md)。

ZCode 本地开发时可用目录安装；注意它会把整个目录（含 `.git`）拷进插件缓存：

```sh
zcode plugins marketplace add ./kelin-stack
zcode plugins install kelin-stack@kelin-stack-market
```

装完重启 ZCode（Antigravity 热加载，下轮生效），输入 `kelin-plan` 或 `/kelin-plan` 就能看到。

## 安装后怎么用（小白版）

在 ZCode、Codex 或 Antigravity 装好后，每个新会话会自动注入 kelin-stack 上下文（Antigravity 还自带常驻规则 `rules/AGENTS.md`），**不懂流程也只需记住两句话**：

1. **新仓库一键接入**：直接说 **`kelin mode setup`**（或运行 `node skills/kelin-mode/scripts/mode.mjs setup --root .`）。先只读预览缺什么（`AGENTS.md`、`.gitignore`、`kelin-policy.json`、本地验证手册、`pre-commit`、内存预算与安全钩子），确认后再加 `--apply` 自动配置。
2. **直接交办任务**：直接说 **`用 kelin mode 帮我做 <需求>`**，agent 会先跑 `route` 判断模式（`light`/`feature`/`fix`/`legacy`/`audit`）、自动挂载当前阶段的配套 skill（如产品先走 `kelin-product`、前端加 `kelin-ui`、模糊需求先 `kelin-grill`），并按 `.kelin/state.json` 门禁推进，不再需要记住 40 个 skill 名字。
3. **连续多轮不打架**：上一轮跑到 `done` 后，下个需求直接 `init` 会自动把旧记录归档到 `.kelin/history/`；没做完的任务下个会话直接续跑。
4. **项目与安全兜底**：项目里有 `.zcode/skills/verify-*` 或 `.agents/skills/verify-*` 时验证阶段自动启用；高危操作由 `PreToolUse` 按 `KELIN_SAFETY`（off/relaxed/strict）兜底拦住。

## 给 WorkBuddy 用

WorkBuddy 支持标准 `SKILL.md`。分三种情况：

- **纯指令类 skill**（plan、review、principles 等）：把 `skills/<名字>/` 整个目录拷到 `~/.workbuddy/skills/`（全局）或项目的 `.workbuddy/skills/` 即可；
- **带脚本的 skill**（map、verify、agents、guard、ci 等）：脚本是 Node，无外部依赖；脚本调用使用 `$SKILL_DIR` 占位符自定位；
- **插件安装**：WorkBuddy 支持插件 ZIP / 自定义 marketplace，但清单格式不同；本仓库目前有 `.zcode-plugin` / `.claude-plugin` / `.cursor-plugin` / `.antigravity-plugin` 四份清单。需要的话可以补一份 WorkBuddy 清单，告诉我它的 manifest 路径和字段即可。

注意：`kelin-verify-stack`（含 `verify-stack run --all`）依赖本机 ZCode CLI；无 ZCode 环境可跑通用的 `offline-check.mjs` 与 `node --test`，Antigravity 环境另跑 `agy plugin validate`；斜杠命令名也可能随运行时不同。

## 开发

```sh
node skills/kelin-health/scripts/health.mjs --root .
node --test $(find skills -name '*.test.mjs' | sort | tr '\n' ' ')
node skills/kelin-verify-stack/scripts/offline-check.mjs
node skills/kelin-agents/scripts/agents-check.mjs AGENTS.md
node skills/kelin-guard/scripts/guard-check.mjs guards.json
node skills/kelin-guard/scripts/ratchet-check.mjs ratchet.json --strict-shrink
node skills/kelin-neat/scripts/neat-check.mjs neat.json
node skills/kelin-evals/scripts/skill-eval.mjs --root .
node skills/kelin-evals/scripts/skill-bill.mjs --root .
node skills/kelin-evals/scripts/drift-check.mjs --root .
node skills/kelin-docs/scripts/gen-docs.mjs --check
node skills/kelin-docs/scripts/doc-coverage.mjs --root . --check
node skills/kelin-mode/scripts/policy-check.mjs kelin-policy.json
node skills/kelin-verify-stack/scripts/verify-stack.mjs smoke --host antigravity
node skills/kelin-verify-stack/scripts/verify-stack.mjs smoke --host codex
agy plugin validate .
```

CI 每次 push 跑十项检查：全量单元测试、离线结构检查、引用漂移检查、AGENTS.md 预算、guards 完整性与棘轮不回退检查、文档一致性、skill 结构与触发检查、生成文档 drift、策略文件校验（不需要宿主登录，不消耗模型）。

改 skill 之后，按改动路径验证：

```sh
node skills/kelin-verify-stack/scripts/verify-stack.mjs classify --changed skills/kelin-plan/SKILL.md
node skills/kelin-verify-stack/scripts/verify-stack.mjs run --changed skills/kelin-plan/SKILL.md --output /tmp/ks-one
```

## 安全边界

- 仓库里没有凭据、没有真实业务数据、没有联网上传逻辑。
- 验证器只检查 ZCode 凭据文件的键名，不读值、不复制。
- 唯一会对外写入的是 `verify-stack publish`（PR 评论 + commit status），必须显式 `--confirm`，且 `run` 不会自动调用它。
- 报告里的字段经过净化：只允许可打印 ASCII、≤160 字符、不含反引号和尖括号。
- `preflight.mjs` 在提交前拦截表格类真实数据、`.env`/私钥文件和常见密钥特征。
- 通过 `kelin-delegate` 委托的任务描述与相关文件会发送给对应 CLI 的模型服务商，可能产生费用；**不要把密钥、凭据或客户数据写进委托提示词**。

## 和 pstack 的差异

| pstack | kelin-stack | 原因 |
| --- | --- | --- |
| 46 个 skill | 40 个 | 每个都对应一个会真实发生的错误，不凑数 |
| poteto-mode 编排 | `kelin-mode` | 同样的“自动跑完整流程”，但加了 24GB 内存上限和老仓库模式 |
| T3、宿主外编排平台 | 不做 | 会与 ZCode 自身的模型调度冲突；SessionStart 自动激活与跨 CLI 委托（kelin-delegate）已实现 |
| 多代理并行编排（swarm/arena） | 最多 2 个，1 写 1 读 | 24GB 内存，3 个以上会话会把机器拖进 swap |
| 20+ 条 principle-* | 合并成一页 `kelin-principles` | 原则多了没人读，十条能记住 |

明确没做：自动开 PR、自动合并、自动部署（跨 CLI 委托已由 kelin-delegate 提供）。这些不是“还没写”，是刻意不做——它们需要人拍板。

## 目录

```
kelin-stack/
├── .antigravity-plugin/ # Antigravity 原生插件清单
├── .zcode-plugin/       # ZCode 插件清单
├── .claude-plugin/      # Claude Code 插件与市场清单
├── .cursor-plugin/      # Cursor 市场清单（marketplace.json）
├── hooks.json           # Antigravity 根目录钩子声明（SessionStart + PreToolUse）
├── hooks/               # 双宿主钩子脚本 + ZCode hooks/hooks.json
├── rules/               # Antigravity 常驻规则（AGENTS.md）
├── assets/              # 插件图标（logo.svg）
├── skills/              # 40 个 skill，完整索引见 docs/skills.md
├── agents/              # 3 个子代理：审查、验证、worker
├── evals/               # 触发 eval + fixture 行为 eval
├── install.sh           # antigravity 原生插件 / codex 跨宿主安装器
├── agents-digest/       # 一页速查，给不装插件的 agent
├── docs/                # 生成的 skill 索引 + 跨宿主支持矩阵
├── kelin-policy.json    # 自动化边界与预算
├── guards.json          # bug → 防再犯记录
├── ratchet.json         # 只减不增质量棘轮基线
├── neat.json            # 文档一致性配置
└── .github/             # CI 门禁
```

## 许可

MIT。设计灵感来自 pstack（Cursor，MIT）与 open-pstack（Eric Litman，MIT），详见 [NOTICE](NOTICE)。本仓库的文本、脚本和验证器实现均为 ZCode 版本，未逐字复制上游源码。

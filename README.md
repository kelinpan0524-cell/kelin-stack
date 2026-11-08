# Kelin Stack

**pstack 的 ZCode 版**：把“怎么把活干扎实”从口号变成一套能执行、能检查的流程。

pstack 是为 Claude Code / Codex 写的。ZCode 的 skill、斜杠命令和插件模型都不一样，直接搬会水土不服：命令会撞名、依赖 bun、无头会话的接法也不同。所以这里是重写，不是 fork。

## 一个命令跑完：`/kelin-mode`

`/kelin-mode` 是编排层。它先判断任务类型，再按阶段调用 skill；五个模式：`light`、`feature`、`fix`、`legacy`、`audit`。状态存在 `.kelin/state.json`，用 `mode.mjs` 推进，每个阶段有产物门禁。阶段顺序、命令和门禁规则见 [kelin-mode](skills/kelin-mode/SKILL.md)。

**24GB 内存的硬限制**：最多 2 个子代理（1 写 1 读），不并行跑构建和测试，不整仓读文件，Node 脚本加 `--max-old-space-size=2048`；起代理前先跑 `node skills/kelin-mode/scripts/budget.mjs`，按它给的 `maxAgents` 决定并发。

## 一条链路，三十二个命令

按阶段分组；每个命令的用途、是否有脚本、是否有 live 检查，见生成索引 [docs/skills.md](docs/skills.md)。

- **想清楚**：`kelin-mode`、`kelin-goal`、`kelin-product`、`kelin-plan`、`kelin-architect`、`kelin-blast-radius`、`kelin-map`、`kelin-legacy`、`kelin-multirepo`、`kelin-ci`
- **做扎实**：`kelin-tdd`、`kelin-correctness`、`kelin-verify`、`kelin-loop`
- **交出去**：`kelin-review`、`kelin-ui`、`kelin-audit`、`kelin-refine`、`kelin-unslop`、`kelin-decision-log`、`kelin-guard`、`kelin-ship`、`kelin-release`、`kelin-watch`
- **接得住**：`kelin-recall`、`kelin-agents`、`kelin-neat`、`kelin-reflect`、`kelin-principles`
- **验证自己**：`kelin-verify-stack`、`kelin-evals`、`kelin-docs`

命令统一带 `kelin-` 前缀，避免和 ZCode 内置命令、已装 skill 冲突。

## 两个子代理

- `kelin-reviewer`：只报能证明的问题，每条带位置、触发条件、后果、改法；
- `kelin-verifier`：只认命令输出和文件证据，不接受“理论上没问题”。

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

直接从 GitHub（推荐，安装的是仓库里的文件，不含 `.git`）：

```sh
zcode plugins marketplace add kelinpan0524-cell/kelin-stack
zcode plugins install kelin-stack@kelin-stack-market
```

本地开发时可用目录安装；注意它会把整个目录（含 `.git`）拷进插件缓存：

```sh
zcode plugins marketplace add ./kelin-stack
zcode plugins install kelin-stack@kelin-stack-market
```

装完重启 ZCode，输入 `/kelin-plan` 就能看到。

## 给 WorkBuddy 用

WorkBuddy 支持标准 `SKILL.md`。分三种情况：

- **纯指令类 skill**（plan、review、principles 等）：把 `skills/<名字>/` 整个目录拷到 `~/.workbuddy/skills/`（全局）或项目的 `.workbuddy/skills/` 即可；
- **带脚本的 skill**（map、verify、agents、guard、ci 等）：脚本是 Node，无外部依赖；但命令里的 `skills/kelin-*/scripts/...` 是相对仓库根目录的，建议保留仓库 checkout，在仓库根目录执行；
- **插件安装**：WorkBuddy 支持插件 ZIP / 自定义 marketplace，但清单格式和 ZCode 不同；本仓库目前只有 `.zcode-plugin` / `.claude-plugin` / `.cursor-plugin` 三份清单。需要的话可以补一份 WorkBuddy 清单，告诉我它的 manifest 路径和字段即可。

注意：`kelin-verify-stack` 的 live 检查依赖 ZCode 的 `zcode` CLI，WorkBuddy 里只能跑静态检查；`/kelin-*` 斜杠命令名也可能随运行时不同。

## 开发

```sh
node --test skills/kelin-verify-stack/tests/*.test.mjs
node skills/kelin-verify-stack/scripts/offline-check.mjs
node skills/kelin-agents/scripts/agents-check.mjs AGENTS.md
node skills/kelin-guard/scripts/guard-check.mjs guards.json
node skills/kelin-neat/scripts/neat-check.mjs neat.json
node skills/kelin-evals/scripts/skill-eval.mjs --root .
node skills/kelin-docs/scripts/gen-docs.mjs --check
node skills/kelin-mode/scripts/policy-check.mjs kelin-policy.json
```

CI 每次 push 跑八类：单元测试、离线结构检查、AGENTS.md 预算、guards 完整性、文档一致性、skill 结构与触发检查、生成文档 drift、策略文件校验（不需要 ZCode 登录，不消耗模型）。

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

## 和 pstack 的差异

| pstack | kelin-stack | 原因 |
| --- | --- | --- |
| 46 个 skill | 32 个 | 每个都对应一个会真实发生的错误，不凑数 |
| poteto-mode 编排 | `kelin-mode` | 同样的“自动跑完整流程”，但加了 24GB 内存上限和老仓库模式 |
| SessionStart hook、多 provider runner、T3 | 不做 | 会改全局会话行为或与 ZCode 自身的模型调度冲突 |
| 多代理并行编排（swarm/arena） | 最多 2 个，1 写 1 读 | 24GB 内存，3 个以上会话会把机器拖进 swap |
| 20+ 条 principle-* | 合并成一页 `kelin-principles` | 原则多了没人读，十条能记住 |

明确没做：跨 provider 编排、自动开 PR、自动合并、自动部署。这些不是“还没写”，是刻意不做——它们需要人拍板。

## 目录

```
kelin-stack/
├── skills/            # 32 个 skill，完整索引见 docs/skills.md
├── agents/            # 2 个子代理：审查、验证
├── evals/             # 触发 eval
├── agents-digest/     # 一页速查，给不装插件的 agent
├── docs/              # 生成的 skill 索引
├── kelin-policy.json  # 自动化边界与预算
├── guards.json        # bug → 防再犯记录
├── neat.json          # 文档一致性配置
└── .github/           # CI 门禁
```

## 许可

MIT。设计灵感来自 pstack（Cursor，MIT）与 open-pstack（Eric Litman，MIT），详见 [NOTICE](NOTICE)。本仓库的文本、脚本和验证器实现均为 ZCode 版本，未逐字复制上游源码。

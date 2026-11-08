# Kelin Stack

**pstack 的 ZCode 版**：把“怎么把活干扎实”从口号变成一套能执行、能检查的流程。

pstack 是为 Claude Code / Codex 写的。ZCode 的 skill、斜杠命令和插件模型都不一样，直接搬会水土不服：命令会撞名、依赖 bun、无头会话的接法也不同。所以这里是重写，不是 fork。

## 一个命令跑完：`/kelin-mode`

`/kelin-mode` 是编排层。它先判断任务类型，再按阶段调用对应 skill，每个阶段有产物和退出条件，缺一个就不能前进：

| 模式 | 适用 | 主链路 |
| --- | --- | --- |
| `feature` | 加功能、改行为 | goal → plan → architect → map → tdd → verify → review → refine → ship |
| `fix` | 修 bug、回归 | correctness（复现测试）→ tdd → verify → review → ship |
| `legacy` | 老仓库改造 | legacy（基线+地图+热点）→ plan → tdd（切片）→ verify → review → refine → ship |
| `audit` | 只审不改 | audit → map → plan（修复清单） |

状态存在 `.kelin/state.json`，用脚本推进，不靠记忆：

```sh
node skills/kelin-mode/scripts/mode.mjs init --mode feature
node skills/kelin-mode/scripts/mode.mjs status
node skills/kelin-mode/scripts/mode.mjs advance
```

`advance` 检查当前阶段产物；`verify` 阶段还要求 `acceptance.json` 里 `ok: true`。手改 `state.json` 绕过检查没有意义——下一步照样会被门禁拦住。

**24GB 内存的硬限制**：最多 2 个子代理（1 写 1 读），不并行跑构建和测试，不整仓读文件，Node 脚本加 `--max-old-space-size=2048`；起代理前先跑 `node skills/kelin-mode/scripts/budget.mjs`，按它给的 `maxAgents` 决定并发。

## 一条链路，二十四个命令

**想清楚**

| 命令 | 解决什么 | 可执行的检查 |
| --- | --- | --- |
| `/kelin-mode` | 不知道该做什么、下一步是什么 | 状态机 + 每阶段产物门禁 |
| `/kelin-goal` | 目标写成愿望 | `goal-check.mjs` 校验完成条件/约束/检查点 |
| `/kelin-plan` | 没想清就写代码 | `check-plan.mjs` 校验计划结构 |
| `/kelin-architect` | 直接写实现，方向错了才发现 | 先出类型、签名、模块边界，停在草图 |
| `/kelin-blast-radius` | 不知道改了会炸到哪 | 调用方/数据/测试/外部/回滚五面表 |
| `/kelin-map` | 改哪该测什么靠猜 | `map-check.mjs` 校验功能地图全覆盖 |
| `/kelin-legacy` | 老仓库不敢动 | 基线 + 热点 + 特征测试 + 切片改造 |

**做扎实**

| 命令 | 解决什么 | 可执行的检查 |
| --- | --- | --- |
| `/kelin-tdd` | 先写实现再补测试 | 红-绿-重构，复现测试必须先在旧代码上失败 |
| `/kelin-correctness` | “看着对”当证据 | 证据阶梯：可失败测试、边界矩阵、差分、变异 sanity |
| `/kelin-verify` | “应该可以了”没人敢信 | `run-acceptance.mjs` 跑验收清单 |
| `/kelin-loop` | 无限重试、没有停止条件 | `loop-check.mjs` 校验停止条件/预算/升级线 |

**交出去**

| 命令 | 解决什么 | 可执行的检查 |
| --- | --- | --- |
| `/kelin-review` | 明显的坑自己先踩 | 按 P0-P3 输出可定位问题 |
| `/kelin-ui` | 界面只看代码不看渲染 | 层级/状态/响应式/a11y/文案/性能；装了 impeccable 就调它 |
| `/kelin-audit` | 不知道仓库哪里最容易出事 | 六类问题、最多 20 条、每条四要素 |
| `/kelin-refine` | 代码越写越多 | 必要性阶梯，删重复/猜测性抽象 |
| `/kelin-decision-log` | 事后说不清为什么这么改 | `log.mjs` 追加决策记录并防表格公式注入 |
| `/kelin-ship` | 分支、PR、CI、部署乱 | `preflight.mjs` 拦截 main 直提/真实数据/密钥 |
| `/kelin-release` | 手改版本号、没 CHANGELOG | `release.mjs` 默认 dry-run，发布需 `--confirm` |
| `/kelin-watch` | CI 红了就重跑 | `watch.mjs` 只报新问题并分类失败原因 |

**接得住、学得会**

| 命令 | 解决什么 | 可执行的检查 |
| --- | --- | --- |
| `/kelin-recall` | 隔几天忘了做到哪 | 从 git、任务板、记忆重建状态 |
| `/kelin-agents` | AGENTS.md 越写越长或根本没写 | `agents-check.mjs` 查长度/重复/断链/秘密 |
| `/kelin-reflect` | 同样的问题反复犯 | 结论写回 AGENTS.md 或记忆 |
| `/kelin-principles` | 底线被忘记 | 十条原则，每条带反例 |

**验证这套东西本身**

| 命令 | 解决什么 | 可执行的检查 |
| --- | --- | --- |
| `/kelin-verify-stack` | 插件到底能不能用 | 真开无头会话 + 机器断言 + 哈希回执 |

命令统一带 `kelin-` 前缀，避免和 ZCode 内置命令、你已装的其他 skill 冲突。

## AGENTS.md 的预算

`/kelin-agents` 管仓库的 AGENTS.md：**100-150 行为宜，200 行硬上限**。只写 agent 自己发现不了的约束——反习惯规则、完成标准、成对 don't/do、决策表；不写目录结构、技术栈介绍、项目状态和一次性指令。

`kelin-mode` 的 intake 会先检查它：没有就建，超过 150 行先删，`agents-check` 有失败项先修再开工。收尾只把这次真实踩过的坑写回，不写进度。

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
node skills/kelin-verify-stack/scripts/verify-stack.mjs run --all --no-live --output /tmp/ks-static
node skills/kelin-verify-stack/scripts/verify-stack.mjs run \
  --feature zcode:skill-invocation:kelin-principles --output /tmp/ks-live
```

静态检查不花模型调用；live 检查会真开会话，按需使用。按本机实测：一个 live 功能约 10-20 秒、10 万级输入 token（大部分走缓存）；`--all` 当前跑 7 个 live 功能约 2 分钟，不会并行，内存占用只有一个会话。

`--all` 只跑有配方的 live 功能，数量会打印出来；`--changed` 同理。显式 `--feature` 指定但没有配方时才会报 `missing-recipe`，需要 `--auto` 现场合成一条“正文回读”配方。

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

## 开发

```sh
node --test skills/kelin-verify-stack/tests/*.test.mjs
node skills/kelin-verify-stack/scripts/offline-check.mjs
node skills/kelin-agents/scripts/agents-check.mjs AGENTS.md
```

CI 每次 push 跑这三类：单元测试、离线结构检查、AGENTS.md 预算检查（不需要 ZCode 登录，不消耗模型）。

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
| 46 个 skill | 24 个 | 每个都对应一个会真实发生的错误，不凑数 |
| poteto-mode 编排 | `kelin-mode` | 同样的“自动跑完整流程”，但加了 24GB 内存上限和老仓库模式 |
| SessionStart hook、多 provider runner、T3 | 不做 | 会改全局会话行为或与 ZCode 自身的模型调度冲突 |
| 多代理并行编排（swarm/arena） | 最多 2 个，1 写 1 读 | 24GB 内存，3 个以上会话会把机器拖进 swap |
| 20+ 条 principle-* | 合并成一页 `kelin-principles` | 原则多了没人读，十条能记住 |

明确没做：跨 provider 编排、自动开 PR、自动合并、自动部署。这些不是“还没写”，是刻意不做——它们需要人拍板。

## 目录

```
kelin-stack/
├── .github/workflows/ci.yml
├── .zcode-plugin/plugin.json
├── .claude-plugin/{plugin.json,marketplace.json}
├── .cursor-plugin/marketplace.json
├── agents/
│   ├── kelin-reviewer.md
│   └── kelin-verifier.md
├── skills/
│   ├── kelin-mode/{SKILL.md,scripts/mode.mjs,scripts/budget.mjs}
│   ├── kelin-goal/{SKILL.md,scripts/goal-check.mjs}
│   ├── kelin-plan/{SKILL.md,scripts/check-plan.mjs}
│   ├── kelin-architect/SKILL.md
│   ├── kelin-blast-radius/SKILL.md
│   ├── kelin-map/{SKILL.md,scripts/map-check.mjs}
│   ├── kelin-legacy/SKILL.md
│   ├── kelin-tdd/SKILL.md
│   ├── kelin-correctness/SKILL.md
│   ├── kelin-verify/{SKILL.md,scripts/run-acceptance.mjs}
│   ├── kelin-loop/{SKILL.md,scripts/loop-check.mjs}
│   ├── kelin-review/SKILL.md
│   ├── kelin-ui/SKILL.md
│   ├── kelin-audit/SKILL.md
│   ├── kelin-refine/SKILL.md
│   ├── kelin-decision-log/{SKILL.md,scripts/log.mjs}
│   ├── kelin-ship/{SKILL.md,scripts/preflight.mjs}
│   ├── kelin-release/{SKILL.md,scripts/release.mjs}
│   ├── kelin-watch/{SKILL.md,scripts/watch.mjs}
│   ├── kelin-recall/SKILL.md
│   ├── kelin-agents/{SKILL.md,scripts/agents-check.mjs}
│   ├── kelin-reflect/SKILL.md
│   ├── kelin-principles/SKILL.md
│   └── kelin-verify-stack/
│       ├── SKILL.md
│       ├── features/{registry.json,recipes.json}
│       ├── scripts/*.mjs
│       └── tests/core.test.mjs
├── LICENSE
├── NOTICE
└── README.md
```

## 许可

MIT。设计灵感来自 pstack（Cursor，MIT）与 open-pstack（Eric Litman，MIT），详见 [NOTICE](NOTICE)。本仓库的文本、脚本和验证器实现均为 ZCode 版本，未逐字复制上游源码。

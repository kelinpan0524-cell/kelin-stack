# Kelin Stack

**pstack 的 ZCode 版**：把“怎么把活干扎实”从口号变成一套能执行、能检查的流程。

pstack 是为 Claude Code / Codex 写的。ZCode 的 skill、斜杠命令和插件模型都不一样，直接搬会水土不服：命令会撞名、依赖 bun、无头会话的接法也不同。所以这里是重写，不是 fork。

## 一条链路，十七个命令

**想清楚**

| 命令 | 解决什么 | 可执行的检查 |
| --- | --- | --- |
| `/kelin-goal` | 目标写成愿望 | `goal-check.mjs` 校验完成条件/约束/检查点 |
| `/kelin-plan` | 没想清就写代码 | `check-plan.mjs` 校验计划结构 |
| `/kelin-architect` | 直接写实现，方向错了才发现 | 先出类型、签名、模块边界，停在草图 |
| `/kelin-blast-radius` | 不知道改了会炸到哪 | 调用方/数据/测试/外部/回滚五面表 |
| `/kelin-map` | 改哪该测什么靠猜 | `map-check.mjs` 校验功能地图全覆盖 |

**做扎实**

| 命令 | 解决什么 | 可执行的检查 |
| --- | --- | --- |
| `/kelin-tdd` | 先写实现再补测试 | 红-绿-重构，复现测试必须先在旧代码上失败 |
| `/kelin-verify` | “应该可以了”没人敢信 | `run-acceptance.mjs` 跑验收清单 |
| `/kelin-loop` | 无限重试、没有停止条件 | `loop-check.mjs` 校验停止条件/预算/升级线 |

**交出去**

| 命令 | 解决什么 | 可执行的检查 |
| --- | --- | --- |
| `/kelin-review` | 明显的坑自己先踩 | 按 P0-P3 输出可定位问题 |
| `/kelin-decision-log` | 事后说不清为什么这么改 | `log.mjs` 追加决策记录并防表格公式注入 |
| `/kelin-ship` | 分支、PR、CI、部署乱 | `preflight.mjs` 拦截 main 直提/真实数据/密钥 |
| `/kelin-release` | 手改版本号、没 CHANGELOG | `release.mjs` 默认 dry-run，发布需 `--confirm` |
| `/kelin-watch` | CI 红了就重跑 | `watch.mjs` 只报新问题并分类失败原因 |

**接得住、学得会**

| 命令 | 解决什么 | 可执行的检查 |
| --- | --- | --- |
| `/kelin-recall` | 隔几天忘了做到哪 | 从 git、任务板、记忆重建状态 |
| `/kelin-reflect` | 同样的问题反复犯 | 结论写回 AGENTS.md 或记忆 |
| `/kelin-principles` | 底线被忘记 | 十条原则，每条带反例 |

**验证这套东西本身**

| 命令 | 解决什么 | 可执行的检查 |
| --- | --- | --- |
| `/kelin-verify-stack` | 插件到底能不能用 | 真开无头会话 + 机器断言 + 哈希回执 |

命令统一带 `kelin-` 前缀，避免和 ZCode 内置命令、你已装的其他 skill 冲突。

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

静态检查不花模型调用；live 检查会真开会话，按需使用。

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
node --test skills/kelin-verify-stack/tests/core.test.mjs
node skills/kelin-verify-stack/scripts/offline-check.mjs
```

CI 每次 push 跑这两条：单元测试 + 离线结构检查（不需要 ZCode 登录，不消耗模型）。

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
| 46 个 skill | 17 个 | 每个都对应一个会真实发生的错误，不凑数 |
| SessionStart hook、多 provider runner、T3 | 不做 | 会改全局会话行为或与 ZCode 自身的模型调度冲突 |
| `check-plan`、`watch-pr`、`statechart` | `check-plan`、`watch`、`map-check`、`release`、`run-acceptance`、`preflight`、`goal-check`、`loop-check`、`log` | 优先开发流程里最容易出错的地方，且每个都能被验证器执行 |
| Claude / Codex / T3 三套 harness | ZCode 无头会话一套 | 本机真实存在、可复现 |
| 20+ 条 principle-* | 合并成一页 `kelin-principles` | 原则多了没人读，十条能记住 |
| 多代理并行编排（swarm/arena） | 暂不做 | ZCode 自身的子代理够用，先不引入第二套调度 |

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
│   ├── kelin-goal/{SKILL.md,scripts/goal-check.mjs}
│   ├── kelin-plan/{SKILL.md,scripts/check-plan.mjs}
│   ├── kelin-architect/SKILL.md
│   ├── kelin-blast-radius/SKILL.md
│   ├── kelin-map/{SKILL.md,scripts/map-check.mjs}
│   ├── kelin-tdd/SKILL.md
│   ├── kelin-verify/{SKILL.md,scripts/run-acceptance.mjs}
│   ├── kelin-loop/{SKILL.md,scripts/loop-check.mjs}
│   ├── kelin-review/SKILL.md
│   ├── kelin-decision-log/{SKILL.md,scripts/log.mjs}
│   ├── kelin-ship/{SKILL.md,scripts/preflight.mjs}
│   ├── kelin-release/{SKILL.md,scripts/release.mjs}
│   ├── kelin-watch/{SKILL.md,scripts/watch.mjs}
│   ├── kelin-recall/SKILL.md
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

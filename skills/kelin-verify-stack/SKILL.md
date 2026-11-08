---
name: kelin-verify-stack
description: 验证一个 ZCode 插件是不是真的能用。先体检环境，再按改动路径算出该测哪些功能，然后真的开无头 ZCode 会话调用 skill、跑插件自带脚本，用机器断言和哈希回执给结论。默认验证 kelin-stack 自己。用户说“验证插件”“跑一遍全流程”“这个 skill 真的能加载吗”时使用。
---

# kelin-verify-stack

## 这个 skill 干什么

验证一个 ZCode 插件目录能不能真正工作。不是看文件在不在，而是：

1. 真的启动无头 ZCode 会话；
2. 从 ZCode 自己的会话记录里确认目标 `Skill` 真的被调用（不信模型自述）；
3. 确认会话真的写出了带随机标记的产物；
4. 对插件自带的确定性脚本，真的执行并检查输出；
5. 全程记哈希，最后给一份可复核的回执。

它是 open-pstack 的 `verify-open-pstack` 的 ZCode 对应物：同一套“体检 → 分类 → 固定版本 → 真跑 → 断言 → 回执 → 复核 → 可选发布”的流程，把 Claude/Codex/T3 三个 harness 换成本机真实存在的 ZCode harness。

## 启动

只依赖 Node 18+、git、ZCode CLI（`zcode` 在 PATH，或 macOS 桌面版内置的 `.../glm/zcode.cjs`；也可用 `ZCODE_BIN` 指定）。不需要 bun，不需要额外登录。

在插件根目录执行：

```sh
S=skills/kelin-verify-stack
OUT="$(mktemp -d "${TMPDIR:-/tmp}/verify-stack.XXXXXX")/run"

node "$S/scripts/verify-stack.mjs" doctor --output "$OUT/doctor"
node "$S/scripts/verify-stack.mjs" run --all --no-live --output "$OUT/static"
node "$S/scripts/verify-stack.mjs" run --feature zcode:skill-invocation:kelin-principles --output "$OUT/live"
```

`--output` 必须是尚不存在或空的目录。每次验证用全新目录，不覆盖旧证据。不带 `--plugin` 时默认验证本插件（`kelin-stack`）。

## Doctor

只读，写 `doctor.json`：

- 平台、Node、git；
- ZCode CLI 能否解析、`zcode doctor --json` 是否成功；
- `zcode skills list --json` 是否可读；
- 目标插件目录存在，`zcode plugins validate <目录>` 通过；
- 登录凭据文件存在且结构正确（只看键名，不读值）；
- 输出目录可写且不在被测插件里面。

任何一项失败就退出码非 0，不写回执、不发布。doctor 只证明“具备开跑条件”，不代表插件能用。要严格验证登录，加 `--probe`（会真开一个只回一个 token 的会话）。

## 分类（classify / plan）

`--changed a,b,c`、`--changed-file list.txt` 传相对插件根的改动路径；`--all` 表示全部可测功能。规则在 `features/registry.json`：

| 改动路径 | 触达的功能 |
| --- | --- |
| `skills/<名字>/**` | `zcode:skill-invocation:<名字>` |
| `skills/<名字>/scripts/**` | 上面这条 + `zcode:tools` |
| `.zcode-plugin/**`、`.claude-plugin/**`、`.cursor-plugin/**` | `zcode:manifest`、`zcode:catalog` |
| `agents/**` | `zcode:agents` |
| `assets/**` | `zcode:assets` |
| `hooks/**` | `zcode:hooks` |
| `skills/setup-*/**` | `zcode:setup`（只做静态检查） |
| `docs/**`、`automations/**`、`README.md`、`LICENSE` | 非运行时，不开会话 |
| 其它任何路径 | 直接报错，绝不猜 |

`plan` 会打印本次会开几个无头会话；超过 12 个必须加 `--wide "<理由>"`。`--feature` 必须落在 `--changed` 算出的范围内，否则拒绝并列出可达集合。

## 真跑（run）

每个 live case：

1. 在输出目录下建独立 fixture，写入随机 UUID 标记（模型猜不到）；
2. `zcode -p "<prompt>" --json --cwd <fixture>` 启动无头会话；
3. 从 stdout JSON 拿 `sessionId`；
4. 从 `~/.zcode/cli/rollout/model-io-<sessionId>.jsonl` 读出每次模型调用的 `toolCalls`；
5. 评估断言：`skill_called`、`file_contains`、`file_exists`、`response_equals` 等；
6. 复制会话产物和 rollout 进输出目录并记 sha256。

模型在回复里说“通过了”不算证据。只有“记录里出现 Skill 调用 + fixture 里出现带标记的产物”才算。

**live 前提**：被测插件必须已经安装（`zcode plugins marketplace add <插件目录>` + `zcode plugins install <名字>@<市场名>`），否则 `/skill <插件>:<名字>` 找不到。未安装时 live 功能会被拒绝并给出安装命令；静态功能不受影响。

确定性功能（`catalog`、`manifest`、`agents`、`assets`、`hooks`、`tools`、`setup`）不消耗模型会话，直接调 ZCode CLI 和插件自带脚本。

配方在 `features/recipes.json`。给任何 skill 加“内容回读”配方用 `--auto`：从 SKILL.md 正文挑一句足够长的原句，要求会话原样写回，从而证明正文真的被加载过。

## 证据

输出目录：

- `doctor.json`：体检结果；
- `receipt.json`：逐 case 断言、transcript 哈希、产物哈希、插件树哈希、ZCode 版本、起止时间；
- `report.md`：中文结论（先结论，再失败细节）；
- `gate.md`：可发布的精简证据块；
- `sessions/<case>/`：fixture、产物、`rollout.jsonl`、stdout、stderr；
- `static/<功能>.json`：确定性检查原始结果。

`run` 开始前后各算一次插件树哈希，不一致直接失败——证明验证过程中插件没被改动。报告字段经过净化：只允许可打印 ASCII、≤160 字符、不含反引号和尖括号，不合规整段省略。

## 发布（可选，默认关闭）

```sh
node scripts/verify-stack.mjs publish --run <输出目录> --repo <owner/repo> --pr <号> --sha <40位SHA> --confirm
```

先复核所有哈希，再用 `gh api` 发证据评论并在该 SHA 上设置 `kelin-verify-stack` 状态。没带 `--confirm` 一律拒绝。对外可见，必须由人明确同意；`run` 不会自动发布。

## 清理

fixture、日志、回执都在你指定的输出目录，不散落在插件目录或用户配置里。`setup` 只做静态检查，**不执行安装向导**（它会改写真实配置）。输出目录留给操作者自己删。

## 帮助命令

- `verify-stack.mjs doctor --output <目录> [--plugin <插件目录>] [--probe]`
- `verify-stack.mjs features [--plugin <插件目录>]`
- `verify-stack.mjs classify [--plugin <目录>] (--changed a,b | --changed-file f | --all)`
- `verify-stack.mjs run --output <全新目录> [--plugin <目录>] (--all | --feature <功能>... | --changed ...) [--wide <理由>] [--auto] [--no-live] [--timeout <毫秒>]`
- `verify-stack.mjs self-test --output <全新目录> [--no-live]`
- `node --test tests/`：验证器自身逻辑的单元测试，不证明插件可用

## 边界

- 只支持本机 macOS/Linux 上的 ZCode；找不到 CLI 时直接失败，不降级成“假装验证”。
- 不读、不复制凭据内容；只沿用当前用户已有登录。
- 不做并发；一个 case 跑完再跑下一个，避免会话记录串台。
- 插件根目录之外不写文件；输出目录必须全新。

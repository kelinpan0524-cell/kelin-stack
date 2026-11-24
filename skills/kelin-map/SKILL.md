---
name: kelin-map
description: 给代码库建立“功能地图”：哪些路径归哪个功能、每个功能怎么验证。产出机器可读的 feature-map.json 和人读的 feature-map.md，让“改哪测哪”可计算。用户说“功能地图”“改哪要测什么”“建个 path 到功能的映射”时使用。
---

# 功能地图

> 命令里的 `$SKILL_DIR` 指本 Skill 所在目录的绝对路径，执行前先替换成实际路径。

没有地图时，“这次改动该测什么”靠猜；有地图时，它是一道计算题。

## 快速探索档（陌生仓库摸底，不建地图）

只想"摸清陌生仓库/定位某功能在哪/盘点可复用组件"，不需要持久地图时，不必走建图流程：

- **全程严格只读**：不改不删不装依赖，不跑有副作用的命令；
- 直接检索定位，按行号局部精读（每次 40-100 行），不整仓读；
- 结论附 `文件:行号`，顺手列出**可直接复用的现成组件/函数**和该模块的**局部快测命令**（仓库 AGENTS.md 开发约定里有就以它为准）；
- 大仓库跨多子系统时按互不重叠的目录切片并行只读查，不把强耦合的文件硬拆给多路。

## 产出两样

1. `feature-map.json`：路径模式 → 功能 id，机器读；
2. `feature-map.md`：给新人看，每个功能一句话 + 怎么验证。

## JSON 结构

```json
{
  "roots": ["skills", "agents", "src"],
  "owners": [
    { "pattern": "skills/*/SKILL.md", "feature": "skill-invocation", "verify": "无头会话调用该 skill" },
    { "pattern": "skills/*/scripts/**", "feature": "tools", "verify": "跑脚本自检用例" },
    { "pattern": "src/quote/**", "feature": "quote", "verify": "node --test test/quote" },
    { "pattern": ".github/workflows/**", "feature": "ci", "verify": "查看最近一次 run 结论" }
  ],
  "nonRuntime": ["docs/**", "README.md", "LICENSE"]
}
```

规则：

- `roots` 里每个文件必须命中一个 `owners` 或 `nonRuntime`；
- 一个文件命中两个 owner 视为“归属不清”，必须改到唯一；
- `verify` 必须能被执行，不能写“人工检查”。

## 步骤

1. 列出目录和入口，先按功能分组，不要按文件罗列；
2. 每组写一条 `verify`，写不出就说明这组还没法验证；
3. 跑校验，把未覆盖和归属不清的清零；
4. 项目地图与 `kelin-verify-stack` 自检用的 `features/registry.json` 是两套入口：前者验你的项目，后者验插件自己，结构相似但不通用；改动路径的消费用下面的 `--changed-from`。

## 校验

```sh
node "$SKILL_DIR"/scripts/map-check.mjs feature-map.json
```

退出 0 表示全覆盖；退出 1 会列出未覆盖（unmapped）和归属不清（ambiguous）的文件。

## 改动路径消费（可选，不影响默认校验）

改动落地前想知道"这次该驱动哪条用户路径"时：

```sh
node "$SKILL_DIR"/scripts/map-check.mjs feature-map.json --changed-from HEAD~1
```

取 `git diff --name-only <ref>` 的改动路径（未跟踪文件先 `git add` 才会计入），输出三类：

- `matched`：命中的 feature、命中的 pattern、该 owner 的 `verify` 原文——自然语言也原样输出，**不会被当命令执行**；
- `unmapped`：没有归属的改动路径；
- `nonRuntime`：命中 nonRuntime 的路径。

有 unmapped 退出 1（先补地图，或写明核验依据再继续）；参数或 git 错误退出 2；只改 nonRuntime 或无改动退出 0。一个路径命中多个 owner 不在这里拦，默认校验模式会报 ambiguous。`kelin-mode` 的 verify 阶段消费这里的输出，verify 对 matched 的覆盖要求以 kelin-mode 路由（`references/routing.md`）为准。

## 维护

- 新增目录时同步加 owner，CI 里跑 `map-check`，未覆盖就失败；
- 删除功能时删掉对应 owner，不要留“以后可能用”；
- 地图超过 30 条要合并，说明分组粒度太细。

## 反模式

- 按文件名列一遍，没有功能视角；
- `verify` 写“跑测试”，没说跑哪个；
- 地图写完不接 CI，三个月后完全过期。

## 下游衔接

| 下一步 | 去哪 |
| --- | --- |
| 地图建好要动手 | `kelin-plan` |
| 地图与代码脱节 | `kelin-neat` 对齐 |

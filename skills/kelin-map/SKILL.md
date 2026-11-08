---
name: kelin-map
description: 给代码库建立“功能地图”：哪些路径归哪个功能、每个功能怎么验证。产出机器可读的 feature-map.json 和人读的 feature-map.md，让“改哪测哪”可计算。用户说“功能地图”“改哪要测什么”“建个 path 到功能的映射”时使用。
---

# 功能地图

没有地图时，“这次改动该测什么”靠猜；有地图时，它是一道计算题。

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
4. 把 `feature-map.json` 交给 `kelin-verify-stack`：它的 `features/registry.json` 就是同一套结构，可以直接按改动路径算出该跑哪些检查。

## 校验

```sh
node skills/kelin-map/scripts/map-check.mjs feature-map.json
```

退出 0 表示全覆盖；退出 1 会列出未覆盖（unmapped）和归属不清（ambiguous）的文件。

## 维护

- 新增目录时同步加 owner，CI 里跑 `map-check`，未覆盖就失败；
- 删除功能时删掉对应 owner，不要留“以后可能用”；
- 地图超过 30 条要合并，说明分组粒度太细。

## 反模式

- 按文件名列一遍，没有功能视角；
- `verify` 写“跑测试”，没说跑哪个；
- 地图写完不接 CI，三个月后完全过期。

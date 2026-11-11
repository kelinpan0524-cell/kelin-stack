---
name: kelin-health
description: 质量面板：一次跑完单元测试、结构检查、skill eval、文档漂移、AGENTS 预算和 guards，按检查项报通过/失败，只报不改。用户说“仓库健康吗”“整体检查一下”“质量面板”时使用。
---

# 质量面板

只回答一个问题：**这个仓库现在能不能安全地继续改？** 不修、不部署、不展开。

## 跑

```sh
node skills/kelin-health/scripts/health.mjs --root .
```

输出 JSON：每个检查项的 id、命令、退出码、耗时、摘要；`ok` 和 `failed` 给结论。任一失败退出 1。

检查项按仓库里存在的文件自动裁剪：

- 单元测试；
- `offline-check`；
- `skill-eval`；
- `neat-check`；
- `gen-docs --check`；
- `agents-check`；
- `guard-check`。

## 怎么读

- 先看 `failed`，不看总数；
- 失败项点进对应 skill：结构问题找 `kelin-evals`，文档漂移找 `kelin-docs`，AGENTS 超长找 `kelin-agents`，防再犯记录找 `kelin-guard`；
- 只报不改；要修另开任务，别在面板里顺手改。

## 边界

- 不跑 live skill 验证（花 token）；
- 不跑部署、不碰服务器；
- 检查项多时可能超过一分钟；它是一次性面板，不做常驻进程。

## 验证

```sh
node --test skills/kelin-verify-stack/tests/health.test.mjs
```

本 skill 有脚本和单元测试，没有 live recipe。

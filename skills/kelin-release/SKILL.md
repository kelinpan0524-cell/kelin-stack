---
name: kelin-release
description: 自动化发布：先过发布闸门（CI 绿、验证回执、CHANGELOG），再升版本、打 tag、建 GitHub Release。默认只出计划，真正发布必须显式确认。用户说“发版”“打 tag”“做个 release”“版本号怎么升”时使用。
---

# 发布

发布 = 把“已经验证过的版本”标成一个可回访的点。它不等于部署。

## 闸门

缺一条就不发：

1. CI 绿（不是“重跑后绿”，是当前提交绿）；
2. 有验证回执：`verify-stack` 的报告或验收清单结果；
3. CHANGELOG 写了这次改了什么、影响谁；
4. 版本策略明确：修 bug 走 patch，加功能走 minor，破坏兼容走 major；
5. 工作区干净，在预期分支上。

## 流程

```sh
node skills/kelin-release/scripts/release.mjs --bump patch
```

默认 **dry-run**：打印当前版本、上一个 tag、这次包含的提交、建议版本、将改的文件、将生成的 release notes。不改任何文件、不联网。

确认后再执行：

```sh
node skills/kelin-release/scripts/release.mjs --bump patch --publish --confirm
```

`--publish` 会：升 manifest 版本 → 写 CHANGELOG → 提交 → 打 `vX.Y.Z` → `gh release create`。失败时停在原地并报告已完成的步骤。

## 部署仍然要人点头

发布 GitHub Release 不等于上线。部署按 `kelin-ship` 的闸门走，必须听到明确的“部署”。

## 反模式

- 手动改版本号，两个 manifest 不一致；
- 没有 CHANGELOG，用户不知道改了什么；
- CI 红着打 tag；
- 把发布和部署合并成一步；
- 用 `--force` 覆盖已有 tag。

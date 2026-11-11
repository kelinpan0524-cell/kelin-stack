---
name: kelin-safety
description: 运行时安全钩子：在命令和写入执行前拦下 rm -rf /、强推默认分支、越界编辑等灾难操作；普通递归删除先问，开发目录里的清理放行。和 kelin-guard 不同，这个管“现在这一下”，不管“以后不再犯”。用户说“防误删”“安全钩子”“拦一下危险命令”时使用。
---

# 运行时安全

`kelin-guard` 管“bug 修完怎么防再犯”，这个 skill 管“命令敲下去之前拦一下”。两者互不替代。

## 装了什么

- `hooks/hooks.json`：`PreToolUse`，matcher `Bash|Write|Edit|MultiEdit`；
- `hooks/pre-tool-use.mjs`：读工具输入，调用判定模块；
- `skills/kelin-safety/scripts/check-command.mjs`：命令判定，可单独测；
- `skills/kelin-safety/scripts/freeze-lib.mjs`：编辑范围冻结；
- `skills/kelin-safety/scripts/freeze.mjs`：设置、清除、查看冻结范围。

插件启用时生效；不用时在插件管理里禁用整个插件，不要改 hook 文件。

## 直接拒绝

- `rm -rf /`、`rm -rf /*`、`rm -rf ~`、`rm -rf $HOME`，含 `sudo`、引号和参数换序；
- `find / -delete` 这类在根目录递归删除的写法；
- `git push --force` / `--force-with-lease` 到 `main` / `master`，以及 `+main` refspec；
- `git push --mirror`（可能覆盖远端所有引用）；
- 对根目录 `chmod -R 777 /`；
- 冻结范围外的写入/编辑，以及冻结状态下的 Bash 重定向写文件。

## 先问

- 递归+强制删除开发目录以外的路径；
- `find` 带 `-delete` 或 `-exec rm`，但目标不是根目录；
- `echo ... | xargs rm` 这类动态路径删除；
- 强推非默认分支、`+feature` refspec、`git push --delete`；
- `git reset --hard`、`git clean -fd/-fdx`；
- `docker system prune`、`kubectl delete`、`terraform destroy`。

## 放行

- `rm -rf node_modules`、`.next`、`dist`、`build`、`coverage`、`.cache`、`__pycache__`、`.turbo`、`out`、`tmp`；
- 普通命令、非 Bash 工具、未冻结时的写入。

## 编辑范围冻结

只允许改指定目录时：

```sh
node skills/kelin-safety/scripts/freeze.mjs set src/ docs/
node skills/kelin-safety/scripts/freeze.mjs status
node skills/kelin-safety/scripts/freeze.mjs clear
```

冻结状态写在项目 `.kelin/freeze.json`。写入或编辑目标不在范围内直接拒绝；路径无法解析也拒绝（fail-closed）。符号链接会先解析到真实路径再比较。

## 手工测

```sh
printf '%s\n' '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"rm -rf /"}}' \
  | node hooks/pre-tool-use.mjs
```

输出 `permissionDecision: deny` 和原因。写入冻结测试把 `tool_name` 换成 `Write`，并给 `tool_input.file_path`。

## 边界

- 只看 Bash 命令字符串，不解析 SQL、文件内容、脚本内部；
- JSON 解析失败时放行（fail-open），避免一个坏 hook 把所有命令挡住；硬拒绝规则只匹配明确模式；
- 不替代 ZCode 自己的权限确认；`ask` 仍走宿主确认；
- 冻结只覆盖 Write/Edit/MultiEdit，不覆盖 Bash 里的重定向写文件。

## 验证

```sh
node --test skills/kelin-verify-stack/tests/safety.test.mjs
```

本 skill 有脚本和单元测试，没有 live recipe。

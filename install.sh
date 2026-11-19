#!/usr/bin/env bash
# kelin-stack 跨宿主安装器：把插件或 skills/ 装进 Codex / Antigravity 认的目录。
# 安全底线：幂等；写入前显示全部目标；不覆盖非 kelin 内容；--uninstall 只删自己装的。
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
SRC="$REPO/skills"
MANIFEST_NAME=".kelin-install.json"
PLUGIN_NAME="kelin-stack"
USAGE="用法: ./install.sh --host codex|antigravity|zcode [--scope project|user] [--path DIR] [--subset 'kelin-mode,kelin-plan,...'] [--symlink] [--uninstall] [--dry-run]"

HOST="" SCOPE="project" TARGET="" SUBSET="" LINK=0 UNINSTALL=0 DRY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --scope) SCOPE="$2"; shift 2 ;;
    --path) TARGET="$2"; shift 2 ;;
    --subset) SUBSET="$2"; shift 2 ;;
    --symlink) LINK=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) echo "$USAGE"; exit 0 ;;
    *) echo "未知参数: $1"; echo "$USAGE"; exit 2 ;;
  esac
done

[[ -n "$HOST" ]] || { echo "缺少 --host"; echo "$USAGE"; exit 2; }

if [[ "$HOST" == "zcode" ]]; then
  echo "ZCode 不用本脚本安装，走插件市场："
  echo "  zcode plugins marketplace add kelinpan0524-cell/kelin-stack"
  echo "  zcode plugins install kelin-stack@kelin-stack-market"
  exit 0
fi

# Antigravity 用户级默认安装完整原生插件；指定 --subset 时装进全局 skills 目录
PLUGIN_MODE=0
if [[ "$HOST" == "antigravity" && "$SCOPE" == "user" && -z "$SUBSET" ]]; then
  if [[ $UNINSTALL -eq 1 && ! -f "$HOME/.gemini/config/plugins/$PLUGIN_NAME/$MANIFEST_NAME" && -f "$HOME/.gemini/config/skills/$MANIFEST_NAME" ]]; then
    PLUGIN_MODE=0
  else
    PLUGIN_MODE=1
  fi
fi

if [[ $PLUGIN_MODE -eq 1 ]]; then
  PLUGINS_ROOT="$HOME/.gemini/config/plugins"
  DEST="$PLUGINS_ROOT/$PLUGIN_NAME"

  if [[ $UNINSTALL -eq 1 ]]; then
    if [[ ! -f "$DEST/$MANIFEST_NAME" ]]; then
      echo "未找到安装清单 ${DEST}/${MANIFEST_NAME}，本安装器没装过插件，不动。"
      exit 0
    fi
    echo "将卸载 Antigravity 插件目录: ${DEST}"
    [[ $DRY -eq 1 ]] && { echo "(dry-run，未删除)"; exit 0; }
    python3 - "$PLUGINS_ROOT" "$DEST" "$MANIFEST_NAME" <<'PY'
import json, pathlib, shutil, sys
root = pathlib.Path(sys.argv[1]).resolve()
dest = pathlib.Path(sys.argv[2]).resolve()
mf = dest / sys.argv[3]
if dest.parent != root or dest.name != "kelin-stack":
    sys.exit(f"refuse unexpected target: {dest}")
data = json.loads(mf.read_text(encoding="utf-8"))
if data.get("mode") != "antigravity-plugin":
    sys.exit(f"refuse non-plugin manifest: {mf}")
shutil.rmtree(dest)
print("removed", dest)
PY
    echo "卸载完成。"
    exit 0
  fi

  if [[ $LINK -eq 1 ]]; then
    echo "Antigravity 完整插件模式不支持 --symlink（避免把 .git 和 ZCode 的 hooks/hooks.json 暴露进插件目录）；请去掉 --symlink，或用 --subset / --scope project。"
    exit 2
  fi

  [[ -f "$REPO/.antigravity-plugin/plugin.json" ]] || { echo "找不到 ${REPO}/.antigravity-plugin/plugin.json"; exit 2; }
  [[ -f "$REPO/hooks.json" ]] || { echo "找不到 ${REPO}/hooks.json"; exit 2; }

  SKILL_COUNT=$(find "$SRC" -mindepth 2 -maxdepth 2 -name SKILL.md | wc -l | xargs)
  echo "宿主: ${HOST}  范围: ${SCOPE}（原生插件模式）"
  echo "目标目录: ${DEST}"
  echo "包含组件: manifest(.antigravity-plugin) + ${SKILL_COUNT} skills + agents + rules/AGENTS.md + hooks.json + assets/logo.svg"
  echo "排除项: .git、.kelin、.github、evals、hooks/hooks.json（ZCode 专用）"
  [[ $DRY -eq 1 ]] && { echo "(dry-run，未写入)"; exit 0; }

  if [[ -e "$DEST" && ! -f "$DEST/$MANIFEST_NAME" ]]; then
    echo "跳过安装：${DEST} 已存在且不含 ${MANIFEST_NAME}（非本安装器创建，不覆盖）。如需重装请先手动卸载。"
    exit 1
  fi

  mkdir -p "$PLUGINS_ROOT"
  STAGE="$(mktemp -d "$PLUGINS_ROOT/.kelin-stage.XXXXXX")"
  trap 'rm -rf "$STAGE"' EXIT

  mkdir -p "$STAGE/.antigravity-plugin" "$STAGE/hooks" "$STAGE/rules" "$STAGE/assets" "$STAGE/skills" "$STAGE/agents"
  cp "$REPO/.antigravity-plugin/plugin.json" "$STAGE/.antigravity-plugin/plugin.json"
  cp "$REPO/hooks.json" "$STAGE/hooks.json"
  cp "$REPO/hooks/session-start.mjs" "$STAGE/hooks/session-start.mjs"
  cp "$REPO/hooks/pre-tool-use.mjs" "$STAGE/hooks/pre-tool-use.mjs"
  cp "$REPO/rules/AGENTS.md" "$STAGE/rules/AGENTS.md"
  cp "$REPO/assets/logo.svg" "$STAGE/assets/logo.svg"
  for doc in README.md LICENSE NOTICE; do
    [[ -f "$REPO/$doc" ]] && cp "$REPO/$doc" "$STAGE/$doc"
  done
  for d in "$SRC"/kelin-*/; do
    [[ -d "$d" ]] && cp -R "${d%/}" "$STAGE/skills/"
  done
  for f in "$REPO"/agents/*.md; do
    [[ -f "$f" ]] && cp "$f" "$STAGE/agents/"
  done

  python3 - "$STAGE/$MANIFEST_NAME" "$REPO/.antigravity-plugin/plugin.json" <<'PY'
import datetime, json, pathlib, sys
mf = pathlib.Path(sys.argv[1])
meta = json.loads(pathlib.Path(sys.argv[2]).read_text(encoding="utf-8"))
mf.write_text(json.dumps({
    "installed_at": datetime.date.today().isoformat(),
    "mode": "antigravity-plugin",
    "version": meta.get("version", ""),
    "entries": [".antigravity-plugin", "hooks.json", "hooks", "skills", "agents", "rules", "assets"],
}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY

  rm -rf "$DEST"
  mv "$STAGE" "$DEST"
  trap - EXIT
  echo "已安装 Antigravity 原生插件到: $DEST"
  echo "可运行检查：agy plugin validate \"$DEST\" --strict && agy plugin list"
  exit 0
fi

case "$HOST:$SCOPE" in
  codex:project) [[ -n "$TARGET" ]] || TARGET="$PWD"; DEST="$TARGET/.agents/skills" ;;
  codex:user) DEST="$HOME/.agents/skills" ;;
  antigravity:project) [[ -n "$TARGET" ]] || TARGET="$PWD"; DEST="$TARGET/.agents/skills" ;;
  antigravity:user) DEST="$HOME/.gemini/config/skills" ;;
  *) echo "不支持的组合: host=$HOST scope=$SCOPE"; exit 2 ;;
esac

if [[ $UNINSTALL -eq 1 ]]; then
  if [[ ! -f "$DEST/$MANIFEST_NAME" ]]; then
    echo "未找到安装清单 ${DEST}/${MANIFEST_NAME}，本安装器没装过东西，不动。"
    exit 0
  fi
  echo "将删除以下条目（只删清单记录的 kelin-* 目录）:"
  python3 - "$DEST/$MANIFEST_NAME" <<'PY'
import json, sys, pathlib
m = json.load(open(sys.argv[1]))
for e in m.get("entries", []):
    print("  -", e)
PY
  [[ $DRY -eq 1 ]] && { echo "(dry-run，未删除)"; exit 0; }
  python3 - "$DEST/$MANIFEST_NAME" <<'PY'
import json, sys, shutil, pathlib, os, re
m = json.load(open(sys.argv[1]))
base = pathlib.Path(sys.argv[1]).parent.resolve()
for e in m.get("entries", []):
    if not re.fullmatch(r"kelin-[a-z0-9-]+", e):
        print("skip suspicious entry:", e); continue
    p = (base / e).resolve()
    if base not in p.parents:
        print("skip outside entry:", e); continue
    if p.is_symlink() or p.exists():
        shutil.rmtree(p) if p.is_dir() and not p.is_symlink() else os.remove(p)
        print("removed", e)
os.remove(sys.argv[1])
PY
  echo "卸载完成。"
  exit 0
fi

[[ -d "$SRC" ]] || { echo "找不到 ${SRC}（要在 kelin-stack 仓库根运行）"; exit 2; }

# 选 skill 集合
ALL_DIRS=()
for d in "$SRC"/kelin-*/; do ALL_DIRS+=("$(basename "$d")"); done
SELECTED=()
if [[ -n "$SUBSET" ]]; then
  IFS=',' read -ra WANTED <<< "$SUBSET"
  for w in "${WANTED[@]}"; do
    w="$(echo "$w" | xargs)"
    [[ -d "$SRC/$w" ]] || { echo "subset 里没有这个 skill: $w"; exit 2; }
    SELECTED+=("$w")
  done
else
  SELECTED=("${ALL_DIRS[@]}")
fi

echo "宿主: $HOST  范围: $SCOPE"
echo "目标目录: $DEST"
echo "将安装 ${#SELECTED[@]}/${#ALL_DIRS[@]} 个 skill: ${SELECTED[*]}"
echo "方式: $([[ $LINK -eq 1 ]] && echo symlink || echo copy)"
[[ $DRY -eq 1 ]] && { echo "(dry-run，未写入)"; exit 0; }

mkdir -p "$DEST"
OWNED=""
if [[ -f "$DEST/$MANIFEST_NAME" ]]; then
  OWNED=$(python3 -c "import json,sys;print('\n'.join(json.load(open(sys.argv[1])).get('entries',[])))" "$DEST/$MANIFEST_NAME")
fi
INSTALLED=()
for name in "${SELECTED[@]}"; do
  dst="$DEST/$name"
  if [[ -e "$dst" || -L "$dst" ]] && ! printf '%s\n' "$OWNED" | grep -qx "$name"; then
    echo "跳过 ${name}：目标已存在且不在本安装器清单里（不覆盖他人内容）"
    continue
  fi
  rm -rf "$dst"
  if [[ $LINK -eq 1 ]]; then ln -s "$SRC/$name" "$dst"; else cp -R "$SRC/$name" "$dst"; fi
  INSTALLED+=("$name")
done

python3 - "$DEST/$MANIFEST_NAME" ${INSTALLED[@]+"${INSTALLED[@]}"} <<'PY'
import json, sys, pathlib, datetime
mf = pathlib.Path(sys.argv[1])
m = {"installed_at": datetime.date.today().isoformat(), "entries": sys.argv[2:]}
if mf.exists():
    old = json.load(open(mf))
    merged = list(dict.fromkeys(old.get("entries", []) + m["entries"]))
    m["entries"] = merged
mf.write_text(json.dumps(m, ensure_ascii=False, indent=2) + "\n")
print("manifest:", mf, "entries:", len(m["entries"]))
PY
echo "装好了。可选下一步：把 kelin 路由块写进 AGENTS："
echo "  node \"$SRC/kelin-agents/scripts/ensure-workflow.mjs\" --global $HOST   # 用户级"
echo "  node \"$SRC/kelin-agents/scripts/ensure-workflow.mjs\" \"$TARGET/AGENTS.md\"  # 项目级（如指定了 --path）"

#!/usr/bin/env bash
# kelin-stack 跨宿主安装器：把 skills/ 装进 Codex / Antigravity 认的目录。
# 安全底线：幂等；写入前显示全部目标；不覆盖非 kelin 内容；--uninstall 只删自己装的。
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)/skills"
MANIFEST_NAME=".kelin-install.json"
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

case "$HOST:$SCOPE" in
  codex:project) [[ -n "$TARGET" ]] || TARGET="$PWD"; DEST="$TARGET/.agents/skills" ;;
  codex:user) DEST="$HOME/.agents/skills" ;;
  antigravity:project) [[ -n "$TARGET" ]] || TARGET="$PWD"; DEST="$TARGET/.agents/skills" ;;
  antigravity:user) DEST="$HOME/.gemini/antigravity-cli/skills" ;;
  *) echo "不支持的组合: host=$HOST scope=$SCOPE"; exit 2 ;;
esac

if [[ $UNINSTALL -eq 1 ]]; then
  if [[ ! -f "$DEST/$MANIFEST_NAME" ]]; then
    echo "未找到安装清单 $DEST/$MANIFEST_NAME，本安装器没装过东西，不动。"
    exit 0
  fi
  echo "将删除以下条目（只删清单记录的 kelin-* 目录）:"
  python3 - "$DEST/$MANIFEST_NAME" <<'PY'
import json, sys, shutil, pathlib
m = json.load(open(sys.argv[1]))
base = pathlib.Path(sys.argv[1]).parent
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

[[ -d "$SRC" ]] || { echo "找不到 $SRC（要在 kelin-stack 仓库根运行）"; exit 2; }

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
OWNED=()
if [[ -f "$DEST/$MANIFEST_NAME" ]]; then
  OWNED=$(python3 -c "import json;print('\n'.join(json.load(open('$DEST/$MANIFEST_NAME')).get('entries',[])))")
fi
INSTALLED=()
for name in "${SELECTED[@]}"; do
  dst="$DEST/$name"
  if [[ -e "$dst" ]] && ! printf '%s\n' "$OWNED" | grep -qx "$name"; then
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
mf.write_text(json.dumps(m, ensure_ascii=False, indent=2))
print("manifest:", mf, "entries:", len(m["entries"]))
PY
echo "装好了。可选下一步：把 kelin 路由块写进 AGENTS："
echo "  node \"$SRC/kelin-agents/scripts/ensure-workflow.mjs\" --global $HOST   # 用户级"
echo "  node \"$SRC/kelin-agents/scripts/ensure-workflow.mjs\" \"$TARGET/AGENTS.md\"  # 项目级（如指定了 --path）"

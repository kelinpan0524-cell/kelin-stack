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

uninstall_skills_dir() {
  local dir="$1"
  if [[ ! -f "$dir/$MANIFEST_NAME" ]]; then
    return 1
  fi
  echo "将删除以下条目（只删清单记录的 kelin-* 条目，位置: ${dir}）:"
  python3 - "$dir/$MANIFEST_NAME" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
for e in m.get("entries", []):
    print("  -", e)
PY
  [[ $DRY -eq 1 ]] && { echo "(dry-run，未删除)"; return 0; }
  python3 - "$dir/$MANIFEST_NAME" <<'PY'
import json, os, pathlib, re, shutil, sys
mf = pathlib.Path(sys.argv[1])
base = mf.parent.resolve()
m = json.loads(mf.read_text(encoding="utf-8"))
for e in m.get("entries", []):
    if not isinstance(e, str) or not re.fullmatch(r"kelin-[a-z0-9-]+", e):
        print("skip suspicious entry:", e)
        continue
    p = base / e
    if p.is_symlink():
        p.unlink()
        print("removed symlink", e)
        continue
    if p.exists():
        resolved = p.resolve()
        if resolved.parent != base:
            print("skip outside entry:", e)
            continue
        shutil.rmtree(resolved) if resolved.is_dir() else os.remove(resolved)
        print("removed", e)
mf.unlink()
PY
  return 0
}

verify_plugin_ownership() {
  local plugins_root="$1" dest="$2"
  python3 - "$plugins_root" "$dest" "$MANIFEST_NAME" <<'PY'
import json, os, pathlib, sys
root = pathlib.Path(sys.argv[1]).resolve()
dest = pathlib.Path(sys.argv[2])
mf_name = sys.argv[3]
if not os.path.lexists(dest):
    sys.exit(0)
if dest.is_symlink() or not dest.is_dir():
    sys.exit(f"refuse non-directory or symlink target: {dest}")
if dest.resolve().parent != root or dest.name != "kelin-stack":
    sys.exit(f"refuse unexpected target: {dest}")
mf = dest / mf_name
if not os.path.lexists(mf) or mf.is_symlink() or not mf.is_file():
    sys.exit(f"missing or unsafe manifest: {mf}")
try:
    data = json.loads(mf.read_text(encoding="utf-8"))
except Exception as err:
    sys.exit(f"unreadable manifest {mf}: {err}")
if not isinstance(data, dict) or data.get("mode") != "antigravity-plugin":
    sys.exit(f"refuse non-plugin manifest: {mf}")
PY
}

# Antigravity 用户级默认安装完整原生插件；指定 --subset 时装进全局 skills 目录
PLUGIN_MODE=0
if [[ "$HOST" == "antigravity" && "$SCOPE" == "user" && -z "$SUBSET" ]]; then
  PLUGIN_MODE=1
fi

if [[ $PLUGIN_MODE -eq 1 ]]; then
  PLUGINS_ROOT="$HOME/.gemini/config/plugins"
  DEST="$PLUGINS_ROOT/$PLUGIN_NAME"
  LOCK_DIR="$PLUGINS_ROOT/.kelin-stack.lock"

  if [[ $UNINSTALL -eq 1 ]]; then
    REMOVED_ANY=0
    if [[ -e "$DEST" || -L "$DEST" ]]; then
      if ! verify_plugin_ownership "$PLUGINS_ROOT" "$DEST"; then
        echo "跳过插件目录 ${DEST}（非本安装器所有或清单损坏，未删除）。"
        exit 1
      fi
      echo "将卸载 Antigravity 插件目录: ${DEST}"
      if [[ $DRY -eq 1 ]]; then
        echo "(dry-run，未删除)"
      else
        mkdir -p "$PLUGINS_ROOT"
        mkdir "$LOCK_DIR" 2>/dev/null || { echo "另一个 kelin-stack 安装/卸载正在进行（锁: ${LOCK_DIR}），请稍后重试。"; exit 1; }
        trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT
        verify_plugin_ownership "$PLUGINS_ROOT" "$DEST"
        rm -rf "$DEST"
        echo "removed ${DEST}"
        rmdir "$LOCK_DIR" 2>/dev/null || true
        trap - EXIT
      fi
      REMOVED_ANY=1
    fi
    for skill_dir in "$HOME/.gemini/config/skills" "$HOME/.gemini/antigravity-cli/skills"; do
      if uninstall_skills_dir "$skill_dir"; then
        REMOVED_ANY=1
      fi
    done
    if [[ $REMOVED_ANY -eq 0 ]]; then
      echo "未找到可卸载的 Antigravity 插件或安装清单，不动。"
    else
      echo "卸载完成。"
    fi
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
  echo "包含组件: manifest(.antigravity-plugin) + ${SKILL_COUNT} skills + agents + rules/AGENTS.md + hooks.json + assets/logo.svg + docs"
  echo "排除项: .git、.kelin、.github、evals、hooks/hooks.json（ZCode 专用）"
  if [[ -f "$HOME/.gemini/antigravity-cli/skills/$MANIFEST_NAME" ]]; then
    echo "提示：检测到旧版用户级目录 ${HOME}/.gemini/antigravity-cli/skills 仍有安装清单，可用 --uninstall 清理。"
  fi
  [[ $DRY -eq 1 ]] && { echo "(dry-run，未写入)"; exit 0; }

  mkdir -p "$PLUGINS_ROOT"
  mkdir "$LOCK_DIR" 2>/dev/null || { echo "另一个 kelin-stack 安装/卸载正在进行（锁: ${LOCK_DIR}），请稍后重试。"; exit 1; }

  STAGE=""
  BACKUP=""
  cleanup_plugin_install() {
    [[ -n "$STAGE" ]] && rm -rf "$STAGE" 2>/dev/null || true
    [[ -n "$BACKUP" && -d "$BACKUP" && ! -e "$DEST" ]] && mv "$BACKUP" "$DEST" 2>/dev/null || true
    rmdir "$LOCK_DIR" 2>/dev/null || true
  }
  trap cleanup_plugin_install EXIT

  if [[ -e "$DEST" || -L "$DEST" ]]; then
    if ! verify_plugin_ownership "$PLUGINS_ROOT" "$DEST"; then
      echo "跳过安装：${DEST} 已存在且未通过所有权校验（非本安装器创建、符号链接或清单损坏，不覆盖）。如需重装请先手动卸载。"
      exit 1
    fi
  fi

  STAGE="$(mktemp -d "$PLUGINS_ROOT/.kelin-stage.XXXXXX")"
  mkdir -p "$STAGE/.antigravity-plugin" "$STAGE/hooks" "$STAGE/rules" "$STAGE/assets" "$STAGE/skills" "$STAGE/agents" "$STAGE/docs"
  cp "$REPO/.antigravity-plugin/plugin.json" "$STAGE/.antigravity-plugin/plugin.json"
  cp "$REPO/hooks.json" "$STAGE/hooks.json"
  cp "$REPO/hooks/session-start.mjs" "$STAGE/hooks/session-start.mjs"
  cp "$REPO/hooks/pre-tool-use.mjs" "$STAGE/hooks/pre-tool-use.mjs"
  cp "$REPO/rules/AGENTS.md" "$STAGE/rules/AGENTS.md"
  cp "$REPO/assets/logo.svg" "$STAGE/assets/logo.svg"
  for doc in README.md LICENSE NOTICE; do
    [[ -f "$REPO/$doc" ]] && cp "$REPO/$doc" "$STAGE/$doc"
  done
  for doc in skills.md support-matrix.md; do
    [[ -f "$REPO/docs/$doc" ]] && cp "$REPO/docs/$doc" "$STAGE/docs/$doc"
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
    "entries": [".antigravity-plugin", "hooks.json", "hooks", "skills", "agents", "rules", "assets", "docs"],
}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY

  if [[ -e "$DEST" || -L "$DEST" ]]; then
    verify_plugin_ownership "$PLUGINS_ROOT" "$DEST"
    BACKUP="$(mktemp -d "$PLUGINS_ROOT/.kelin-backup.XXXXXX")"
    rmdir "$BACKUP"
    mv "$DEST" "$BACKUP"
  fi
  mv "$STAGE" "$DEST"
  STAGE=""
  if [[ -n "$BACKUP" ]]; then
    rm -rf "$BACKUP"
    BACKUP=""
  fi
  rmdir "$LOCK_DIR" 2>/dev/null || true
  trap - EXIT
  echo "已安装 Antigravity 原生插件到: ${DEST}"
  echo "可运行检查：agy plugin validate \"${DEST}\" --strict && agy plugin list"
  exit 0
fi

case "$HOST:$SCOPE" in
  codex:project) [[ -n "$TARGET" ]] || TARGET="$PWD"; DEST="$TARGET/.agents/skills" ;;
  codex:user) DEST="$HOME/.agents/skills" ;;
  antigravity:project) [[ -n "$TARGET" ]] || TARGET="$PWD"; DEST="$TARGET/.agents/skills" ;;
  antigravity:user) DEST="$HOME/.gemini/config/skills" ;;
  *) echo "不支持的组合: host=${HOST} scope=${SCOPE}"; exit 2 ;;
esac

if [[ $UNINSTALL -eq 1 ]]; then
  if uninstall_skills_dir "$DEST"; then
    echo "卸载完成。"
  else
    echo "未找到安装清单 ${DEST}/${MANIFEST_NAME}，本安装器没装过东西，不动。"
  fi
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
    [[ -d "$SRC/$w" ]] || { echo "subset 里没有这个 skill: ${w}"; exit 2; }
    SELECTED+=("$w")
  done
else
  SELECTED=("${ALL_DIRS[@]}")
fi

echo "宿主: ${HOST}  范围: ${SCOPE}"
echo "目标目录: ${DEST}"
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

#!/usr/bin/env bash
# kelin-stack 跨宿主安装器：把插件或 skills/ 装进 Codex / Antigravity 认的目录。
# 安全底线：幂等；写入前显示全部目标；不覆盖非 kelin 内容；--uninstall 只删自己装的。
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
SRC="$REPO/skills"
MANIFEST_NAME=".kelin-install.json"
PLUGIN_NAME="kelin-stack"
USAGE="用法: ./install.sh --host codex|antigravity|zcode [--scope project|user] [--path DIR] [--subset 'kelin-mode,kelin-plan,...'] [--symlink] [--uninstall] [--clean-legacy] [--dry-run]"

HOST="" SCOPE="project" TARGET="" SUBSET="" LINK=0 UNINSTALL=0 CLEAN_LEGACY=0 DRY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --scope) SCOPE="$2"; shift 2 ;;
    --path) TARGET="$2"; shift 2 ;;
    --subset) SUBSET="$2"; shift 2 ;;
    --symlink) LINK=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --clean-legacy) CLEAN_LEGACY=1; shift ;;
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

# 退出码：0=已卸载，3=未找到清单（无操作），非0且非3=失败
uninstall_skills_dir() {
  local dir="$1"
  if [[ ! -e "$dir/$MANIFEST_NAME" && ! -L "$dir/$MANIFEST_NAME" ]]; then
    return 3
  fi
  if [[ -L "$dir/$MANIFEST_NAME" || ! -f "$dir/$MANIFEST_NAME" ]]; then
    echo "拒绝卸载：${dir}/${MANIFEST_NAME} 不是常规清单文件。" >&2
    return 1
  fi
  echo "将删除以下条目（只删清单记录的 kelin-* 条目，位置: ${dir}）:"
  python3 - "$dir/$MANIFEST_NAME" <<'PY' || return 1
import json, pathlib, sys
mf = pathlib.Path(sys.argv[1])
data = json.loads(mf.read_text(encoding="utf-8"))
if not isinstance(data, dict) or not isinstance(data.get("entries"), list):
    sys.exit(f"invalid manifest schema: {mf}")
for e in data["entries"]:
    print("  -", e)
PY
  if [[ $DRY -eq 1 ]]; then
    echo "(dry-run，未删除)"
    return 0
  fi
  python3 - "$dir/$MANIFEST_NAME" <<'PY' || return 1
import json, os, pathlib, re, shutil, sys
mf = pathlib.Path(sys.argv[1])
base = mf.parent.resolve()
m = json.loads(mf.read_text(encoding="utf-8"))
if not isinstance(m, dict) or not isinstance(m.get("entries"), list):
    sys.exit(f"invalid manifest schema: {mf}")
for e in m["entries"]:
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

if [[ $CLEAN_LEGACY -eq 1 ]]; then
  if [[ "$HOST" != "antigravity" || "$SCOPE" != "user" ]]; then
    echo "--clean-legacy 仅适用于 --host antigravity --scope user"
    exit 2
  fi
  LEGACY_DIR="$HOME/.gemini/antigravity-cli/skills"
  rc=0
  uninstall_skills_dir "$LEGACY_DIR" || rc=$?
  if [[ $rc -eq 0 ]]; then
    echo "旧版用户级 skills 清理完成（未动原生插件）。"
    exit 0
  elif [[ $rc -eq 3 ]]; then
    echo "未找到旧版安装清单 ${LEGACY_DIR}/${MANIFEST_NAME}，无需清理。"
    exit 0
  else
    exit "$rc"
  fi
fi

# Antigravity 用户级默认安装完整原生插件；指定 --subset 时装进全局 skills 目录
PLUGIN_MODE=0
if [[ "$HOST" == "antigravity" && "$SCOPE" == "user" && -z "$SUBSET" ]]; then
  PLUGIN_MODE=1
fi

if [[ $PLUGIN_MODE -eq 1 ]]; then
  PLUGINS_ROOT="$HOME/.gemini/config/plugins"
  DEST="$PLUGINS_ROOT/$PLUGIN_NAME"
  LOCK_FILE="$PLUGINS_ROOT/.kelin-stack.lock"

  if [[ $UNINSTALL -eq 1 ]]; then
    REMOVED_ANY=0
    if [[ -e "$DEST" || -L "$DEST" ]]; then
      python3 - "$PLUGINS_ROOT" "$DEST" "$MANIFEST_NAME" "$LOCK_FILE" "$DRY" <<'PY'
import fcntl, json, os, pathlib, shutil, stat, sys
root = pathlib.Path(sys.argv[1]).resolve()
dest = pathlib.Path(sys.argv[2])
mf_name = sys.argv[3]
lock_path = pathlib.Path(sys.argv[4])
dry = sys.argv[5] == "1"

def open_lock(path_obj):
    flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path_obj, flags, 0o600)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise OSError(f"refuse non-regular lock file: {path_obj}")
        fcntl.flock(fd, fcntl.LOCK_EX)
        return fd
    except Exception:
        os.close(fd)
        raise

def verify():
    if not os.path.lexists(dest):
        return False
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
    return True

if dry:
    if verify():
        print(f"将卸载 Antigravity 插件目录: {dest}")
        print("(dry-run，未删除)")
    sys.exit(0)

root.mkdir(parents=True, exist_ok=True)
lock_fd = open_lock(lock_path)
try:
    if verify():
        print(f"将卸载 Antigravity 插件目录: {dest}")
        shutil.rmtree(dest)
        print(f"removed {dest}")
finally:
    os.close(lock_fd)
PY
      REMOVED_ANY=1
    fi
    for skill_dir in "$HOME/.gemini/config/skills" "$HOME/.gemini/antigravity-cli/skills"; do
      rc=0
      uninstall_skills_dir "$skill_dir" || rc=$?
      if [[ $rc -eq 0 ]]; then
        REMOVED_ANY=1
      elif [[ $rc -ne 3 ]]; then
        exit "$rc"
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
    echo "提示：检测到旧版用户级目录 ${HOME}/.gemini/antigravity-cli/skills 仍有安装清单，可用 ./install.sh --host antigravity --scope user --clean-legacy 单独清理，不影响新装原生插件。"
  fi
  [[ $DRY -eq 1 ]] && { echo "(dry-run，未写入)"; exit 0; }

  mkdir -p "$PLUGINS_ROOT"
  STAGE="$(mktemp -d "$PLUGINS_ROOT/.kelin-stage.XXXXXX")"
  trap 'rm -rf "$STAGE" 2>/dev/null || true' EXIT

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

  python3 - "$PLUGINS_ROOT" "$DEST" "$STAGE" "$MANIFEST_NAME" "$REPO/.antigravity-plugin/plugin.json" "$LOCK_FILE" <<'PY'
import ctypes, datetime, errno, fcntl, json, os, pathlib, shutil, stat, sys

root = pathlib.Path(sys.argv[1]).resolve()
dest = pathlib.Path(sys.argv[2])
stage = pathlib.Path(sys.argv[3])
mf_name = sys.argv[4]
meta_file = pathlib.Path(sys.argv[5])
lock_path = pathlib.Path(sys.argv[6])

meta = json.loads(meta_file.read_text(encoding="utf-8"))
(stage / mf_name).write_text(json.dumps({
    "installed_at": datetime.date.today().isoformat(),
    "mode": "antigravity-plugin",
    "version": meta.get("version", ""),
    "entries": [".antigravity-plugin", "hooks.json", "hooks", "skills", "agents", "rules", "assets", "docs"],
}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

def open_lock(path_obj):
    flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path_obj, flags, 0o600)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise OSError(f"refuse non-regular lock file: {path_obj}")
        fcntl.flock(fd, fcntl.LOCK_EX)
        return fd
    except Exception:
        os.close(fd)
        raise

def verify_existing():
    if not os.path.lexists(dest):
        return False
    if dest.is_symlink() or not dest.is_dir():
        sys.exit(f"跳过安装：{dest} 已存在且为符号链接或非目录，不覆盖。")
    if dest.resolve().parent != root or dest.name != "kelin-stack":
        sys.exit(f"跳过安装：异常目标路径 {dest}")
    mf = dest / mf_name
    if not os.path.lexists(mf) or mf.is_symlink() or not mf.is_file():
        sys.exit(f"跳过安装：{dest} 缺少有效安装清单 {mf_name}，不覆盖。")
    try:
        data = json.loads(mf.read_text(encoding="utf-8"))
    except Exception as err:
        sys.exit(f"跳过安装：{mf} 无法解析（{err}），不覆盖。")
    if not isinstance(data, dict) or data.get("mode") != "antigravity-plugin":
        sys.exit(f"跳过安装：{mf} 不是 antigravity-plugin 清单，不覆盖。")
    return True

def atomic_exchange(src_path, dst_path):
    if os.environ.get("KELIN_INSTALL_SIMULATE_SWAP_FAIL") == "1":
        raise OSError(errno.EIO, "simulated swap failure")
    src_b = os.fsencode(src_path)
    dst_b = os.fsencode(dst_path)
    if sys.platform == "darwin":
        libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
        libc.renamex_np.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        libc.renamex_np.restype = ctypes.c_int
        RENAME_SWAP = 0x00000002
        if libc.renamex_np(src_b, dst_b, RENAME_SWAP) != 0:
            err = ctypes.get_errno()
            raise OSError(err, os.strerror(err))
        return
    if sys.platform.startswith("linux"):
        libc = ctypes.CDLL("libc.so.6", use_errno=True)
        libc.renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        libc.renameat2.restype = ctypes.c_int
        AT_FDCWD = -100
        RENAME_EXCHANGE = 2
        if libc.renameat2(AT_FDCWD, src_b, AT_FDCWD, dst_b, RENAME_EXCHANGE) != 0:
            err = ctypes.get_errno()
            raise OSError(err, os.strerror(err))
        return
    raise OSError(errno.ENOSYS, "atomic directory exchange unsupported on this platform")

lock_fd = open_lock(lock_path)
try:
    existed = verify_existing()
    if not existed:
        if os.environ.get("KELIN_INSTALL_SIMULATE_SWAP_FAIL") == "1":
            raise OSError(errno.EIO, "simulated swap failure")
        os.rename(stage, dest)
    else:
        atomic_exchange(stage, dest)
        shutil.rmtree(stage, ignore_errors=True)
finally:
    os.close(lock_fd)
PY

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
  rc=0
  uninstall_skills_dir "$DEST" || rc=$?
  if [[ $rc -eq 0 ]]; then
    echo "卸载完成。"
    exit 0
  elif [[ $rc -eq 3 ]]; then
    echo "未找到安装清单 ${DEST}/${MANIFEST_NAME}，本安装器没装过东西，不动。"
    exit 0
  else
    exit "$rc"
  fi
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
if [[ "$HOST" == "codex" ]]; then
  echo "排除项: hooks/hooks.json（ZCode 专用钩子不写入 Codex 目录）"
fi
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

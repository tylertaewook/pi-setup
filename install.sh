#!/usr/bin/env bash
set -euo pipefail
shopt -s nullglob

# Replicates this pi setup on a new machine. Safe to re-run: existing files are
# backed up under ~/.pi/agent/backups/<timestamp>/ before being replaced.

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
SKILLS_DIR="${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}"
MCP_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/mcp"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$AGENT_DIR/backups/$STAMP"

for tool in pi python3 patch; do
  command -v "$tool" >/dev/null || { echo "$tool is required but not installed" >&2; exit 1; }
done

# backups live outside every search path: a copy left beside a skill still
# contains SKILL.md and would register as a duplicate skill
backup() {
  [ -e "$1" ] || return 0
  local dest="$BACKUP_DIR/$(echo "${1#$HOME/}" | tr '/' '_')"
  mkdir -p "$BACKUP_DIR"
  cp -R "$1" "$dest" || { echo "backup of $1 failed; refusing to continue" >&2; exit 1; }
}

# a patch that stops applying because upstream moved must not look like success
apply_patch() {
  local name="$1" dir="$2" file="$3" marker="$4"
  if [ ! -f "$dir/$file" ]; then
    echo "    ! $name: $file not found; run pi install first, then re-run" >&2
    return 0
  fi
  if grep -q "$marker" "$dir/$file"; then
    echo "    $name: already applied"
    return 0
  fi
  if patch -p1 -d "$dir" --forward --batch --fuzz=0 -r - --silent < "$REPO/patches/$name"; then
    grep -q "$marker" "$dir/$file" \
      && echo "    $name: applied" \
      || { echo "    ! $name: applied but marker missing - inspect $dir/$file" >&2; return 1; }
  else
    echo "    ! $name: FAILED to apply (upstream likely changed) - $dir/$file is unpatched" >&2
    return 1
  fi
}

mkdir -p "$AGENT_DIR/extensions" "$SKILLS_DIR" "$MCP_DIR"

echo "==> prompt + instructions"
backup "$AGENT_DIR/SYSTEM.md"
backup "$AGENT_DIR/AGENTS.md"
backup "$AGENT_DIR/greetings.json"
cp "$REPO/prompt/SYSTEM.md" "$AGENT_DIR/SYSTEM.md"
cp "$REPO/agent/AGENTS.md" "$AGENT_DIR/AGENTS.md"
cp "$REPO/agent/greetings.json" "$AGENT_DIR/greetings.json"

echo "==> local extensions"
for file in "$REPO"/extensions/*.ts; do
  backup "$AGENT_DIR/extensions/$(basename "$file")"
  cp "$file" "$AGENT_DIR/extensions/"
done

echo "==> skills"
for dir in "$REPO"/skills/*/; do
  name="$(basename "$dir")"
  backup "$SKILLS_DIR/$name"
  rm -rf "$SKILLS_DIR/$name"
  cp -R "$dir" "$SKILLS_DIR/$name"
done

echo "==> background-bash threshold"
mkdir -p "$HOME/.pi-background-bash"
backup "$HOME/.pi-background-bash/config.json"
cp "$REPO/background-bash/config.json" "$HOME/.pi-background-bash/config.json"

echo "==> shared MCP config"
backup "$MCP_DIR/mcp.json"
cp "$REPO/mcp/mcp.json" "$MCP_DIR/mcp.json"

echo "==> pi packages"
# settings.json is the source of truth for the package list; pi install writes it back
PACKAGES="$(python3 -c 'import json,sys; print("\n".join(json.load(open(sys.argv[1])).get("packages", [])))' "$REPO/agent/settings.json")"
while IFS= read -r pkg; do
  [ -n "$pkg" ] || continue
  echo "    $pkg"
  # </dev/null so a prompting install cannot eat the rest of this list
  pi install "$pkg" >/dev/null </dev/null || echo "    ! failed: $pkg" >&2
done <<< "$PACKAGES"

echo "==> patches"
patch_failures=0
apply_patch pi-pending-compact-row.patch \
  "$AGENT_DIR/git/github.com/mowenroot/pi-background-bash" \
  "node_modules/pi-pending/index.ts" "hug the text" || patch_failures=1
apply_patch powerline-welcome-greeting.patch \
  "$AGENT_DIR/npm/node_modules/pi-powerline-footer" \
  "welcome.ts" "welcomeGreeting" || patch_failures=1

echo "==> settings"
# merge repo settings over whatever is already there, so machine-local keys survive
backup "$AGENT_DIR/settings.json"
python3 - "$REPO/agent/settings.json" "$AGENT_DIR/settings.json" <<'PY'
import json, os, sys

repo, live = sys.argv[1], sys.argv[2]
existing = {}
if os.path.exists(live):
    try:
        existing = json.load(open(live))
    except (json.JSONDecodeError, OSError) as err:
        print(f"    ! existing settings.json unreadable ({err}); keeping repo values only")

def merge(base, overlay):
    for key, value in overlay.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            merge(base[key], value)
        else:
            base[key] = value
    return base

merged = merge(existing, json.load(open(repo)))
tmp = live + ".tmp"
with open(tmp, "w") as handle:
    json.dump(merged, handle, indent=2)
    handle.write("\n")
os.replace(tmp, live)
PY

echo "==> shell aliases"
LINE="source \"$REPO/shell/aliases.sh\""
grep -qsF "$LINE" "$HOME/.zshrc" || printf '\n%s\n' "$LINE" >> "$HOME/.zshrc"

echo
if [ -e "$BACKUP_DIR" ]; then echo "Replaced files backed up to $BACKUP_DIR"; fi
if [ "$patch_failures" -ne 0 ]; then
  echo "WARNING: a patch did not apply - the affected cosmetics are running upstream behavior." >&2
fi
cat <<'EOF'

Not handled here (machine-local, on purpose):
  - provider credentials      run: pi auth
  - Figma MCP                 needs the Figma desktop app running
  - project .mcp.json         lives in each repo, not here

Nothing here is pruned: an extension or skill deleted from the repo stays on a
machine that installed it earlier. Remove those by hand.
EOF

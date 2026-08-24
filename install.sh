#!/usr/bin/env bash
set -euo pipefail

# Replicates this pi setup on a new machine. Safe to re-run: existing files are
# backed up to <file>.bak-<timestamp> before being replaced.

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
SKILLS_DIR="${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}"
MCP_DIR="$HOME/.config/mcp"
STAMP="$(date +%Y%m%d-%H%M%S)"

backup() {
  [ -e "$1" ] && cp -R "$1" "$1.bak-$STAMP" || true
}

command -v pi >/dev/null || {
  echo "pi is not installed. Install it first: npm i -g @earendil-works/pi-coding-agent" >&2
  exit 1
}

mkdir -p "$AGENT_DIR/extensions" "$SKILLS_DIR" "$MCP_DIR"

echo "==> prompt + instructions"
backup "$AGENT_DIR/SYSTEM.md"
backup "$AGENT_DIR/AGENTS.md"
cp "$REPO/prompt/SYSTEM.md" "$AGENT_DIR/SYSTEM.md"
cp "$REPO/agent/AGENTS.md" "$AGENT_DIR/AGENTS.md"

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
  pi install "$pkg" >/dev/null || echo "    ! failed: $pkg" >&2
done <<< "$PACKAGES"

echo "==> settings"
# merge repo settings over whatever is already there, so machine-local keys survive
backup "$AGENT_DIR/settings.json"
python3 - "$REPO/agent/settings.json" "$AGENT_DIR/settings.json" <<'PY'
import json, os, sys
repo, live = sys.argv[1], sys.argv[2]
merged = json.load(open(live)) if os.path.exists(live) else {}
merged.update(json.load(open(repo)))
json.dump(merged, open(live, "w"), indent=2)
open(live, "a").write("\n")
PY

echo "==> shell aliases"
LINE="source $REPO/shell/aliases.sh"
grep -qsF "$LINE" "$HOME/.zshrc" || printf '\n%s\n' "$LINE" >> "$HOME/.zshrc"

cat <<'EOF'

Done. Not handled here (machine-local, on purpose):
  - provider credentials      run: pi auth
  - Figma MCP                 needs the Figma desktop app running
  - project .mcp.json         lives in each repo, not here
EOF

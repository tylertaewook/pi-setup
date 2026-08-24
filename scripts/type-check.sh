#!/usr/bin/env bash
set -euo pipefail

# jiti runs extensions without type checking, which is how three calls to a
# non-existent ctx.exec/ctx.setSessionName shipped and silently did nothing.
# This checks them against the installed pi's own .d.ts files.

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# pi's bin symlinks into <pkg>/dist/bundle/cli.js, so strip at /dist/
PI_BIN_REAL="$(readlink -f "$(command -v pi)" 2>/dev/null || true)"
PI_PKG="${PI_PKG_DIR:-${PI_BIN_REAL%%/dist/*}}"

if [ ! -f "$PI_PKG/dist/index.d.ts" ]; then
  echo "cannot find pi types at $PI_PKG/dist/index.d.ts (set PI_PKG_DIR)" >&2
  exit 1
fi

TSC="${TSC:-}"
if [ -z "$TSC" ] && command -v tsc >/dev/null 2>&1; then
  TSC="$(command -v tsc)"
fi
if [ -z "$TSC" ]; then
  # bun links node_modules/typescript as a symlink, so find needs -L to walk into it
  TSC="$(find -L "$REPO" "$HOME/Documents" -maxdepth 6 -path "*/node_modules/typescript/bin/tsc" -print -quit 2>/dev/null || true)"
fi
if [ -z "$TSC" ] || [ ! -f "$TSC" ]; then
  echo "cannot find a tsc; set TSC=/path/to/node_modules/typescript/bin/tsc" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cp "$REPO"/extensions/*.ts "$WORK/"

cat > "$WORK/tsconfig.json" <<EOF
{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "target": "es2022",
    "module": "esnext",
    "moduleResolution": "bundler",
    "skipLibCheck": true,
    "paths": {
      "@earendil-works/pi-coding-agent": ["$PI_PKG/dist/index.d.ts"],
      "@earendil-works/pi-tui": ["$PI_PKG/node_modules/@earendil-works/pi-tui/dist/index.d.ts"]
    }
  },
  "include": ["*.ts"]
}
EOF

node "$TSC" --project "$WORK/tsconfig.json"
echo "extensions type-check clean against $(pi --version 2>/dev/null || echo pi)"

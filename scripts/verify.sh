#!/usr/bin/env bash
set -euo pipefail

# Run after any pi update, package reinstall, or edit to this repo.
# Each check has been observed failing, not just passing.

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
failures=0

check() {
  if eval "$2" >/dev/null 2>&1; then
    echo "  ok    $1"
  else
    echo "  FAIL  $1" >&2
    failures=$((failures + 1))
  fi
}

echo "extensions"
if "$REPO/scripts/type-check.sh" >/dev/null 2>&1; then
  echo "  ok    type-check against installed pi"
else
  echo "  FAIL  type-check against installed pi (run scripts/type-check.sh)" >&2
  failures=$((failures + 1))
fi
# the dead-API bug: these live on the pi object, never on ctx
check "no ctx.exec / ctx.setSessionName / ctx.appendEntry" \
  "! grep -nE 'ctx\.(exec|setSessionName|appendEntry|getSessionName)' $REPO/extensions/*.ts"

echo "patches"
check "pi-pending compact row applied" \
  "grep -q 'hug the text' '$AGENT_DIR/git/github.com/mowenroot/pi-background-bash/node_modules/pi-pending/index.ts'"
check "powerline greeting applied" \
  "grep -q 'welcomeGreeting' '$AGENT_DIR/npm/node_modules/pi-powerline-footer/welcome.ts'"
check "no patch rejects left behind" \
  "! find '$AGENT_DIR' -name '*.rej' -o -name '*.orig' | grep -q ."

echo "greetings"
python3 - "$REPO/agent/greetings.json" <<'PY' || failures=$((failures + 1))
import json, sys

# powerline renders the greeting into a fixed 26-column left column and
# truncates with an ellipsis past that (welcome.ts, leftCol = 26)
LIMIT = 26
data = json.load(open(sys.argv[1]))
name = data.get("name", "")
bad = []
for bucket in data["buckets"]:
    for key in ("from", "to"):
        if not isinstance(bucket.get(key), int):
            bad.append(f"bucket {bucket} has non-int {key}")
    for variant in bucket["variants"]:
        if not isinstance(variant, str) or not variant:
            bad.append(f"non-string variant in {bucket}")
            continue
        rendered = variant.replace("{name}", name)
        if len(rendered) > LIMIT:
            bad.append(f"{len(rendered)} > {LIMIT}: {rendered}")
hours = {h for bucket in data["buckets"] for h in (
    range(bucket["from"], bucket["to"]) if bucket["from"] <= bucket["to"]
    else list(range(bucket["from"], 24)) + list(range(0, bucket["to"]))
)}
missing = sorted(set(range(24)) - hours)
if missing:
    bad.append(f"hours with no bucket: {missing}")
for problem in bad:
    print(f"  FAIL  {problem}", file=sys.stderr)
if not bad:
    print(f"  ok    {sum(len(b['variants']) for b in data['buckets'])} variants fit {LIMIT} cols, all 24 hours covered")
sys.exit(1 if bad else 0)
PY

echo "config"
check "background-bash threshold present" "grep -q autoBackgroundAfterSeconds '$HOME/.pi-background-bash/config.json'"
check "installer syntax" "bash -n '$REPO/install.sh'"

echo
if [ "$failures" -ne 0 ]; then
  echo "$failures check(s) failed - see QUIRKS.md for what each one means" >&2
  exit 1
fi
echo "all checks passed"

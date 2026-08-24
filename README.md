# pi-setup

My [pi](https://github.com/earendil-works/pi-mono) setup, tracked so a new machine is one script away.

[`QUIRKS.md`](QUIRKS.md) is the companion: why each customization exists, what a pi or package update breaks, and the command that tells you which one broke. Start there when something stops working.

## Install

```bash
git clone https://github.com/tylertaewook/pi-setup.git ~/pi-setup
cd ~/pi-setup && ./install.sh
```

It backs up anything it replaces to `~/.pi/agent/backups/<timestamp>/`, so it is safe to re-run. Then `pi auth` for provider credentials — those are never in here.

```bash
./scripts/verify.sh       # after any pi update: patches still applied, extensions still type-check
./scripts/type-check.sh   # extensions against the installed pi's own .d.ts
```

## What is tracked

| Path | Goes to | What it is |
| --- | --- | --- |
| `prompt/SYSTEM.md` | `~/.pi/agent/SYSTEM.md` | Global system prompt: critical rules, minimal diffs, no comment slop, no phased handoffs |
| `agent/AGENTS.md` | `~/.pi/agent/AGENTS.md` | Cross-repo working rules — verification habits, editing discipline, bun/turbo conventions |
| `agent/greetings.json` | `~/.pi/agent/greetings.json` | Time-of-day startup greetings (edit freely, no reinstall needed) |
| `agent/settings.json` | `~/.pi/agent/settings.json` | Theme, default model, thinking levels, and the package list `install.sh` reads |
| `extensions/*.ts` | `~/.pi/agent/extensions/` | Local extensions (below) |
| `patches/*.patch` | vendored deps | Local fixes to installed packages, reapplied by `install.sh` |
| `scripts/*.sh` | — | `verify.sh` (post-update health check) and `type-check.sh` |
| `skills/*` | `~/.agents/skills/` | Skills, vendored for exact replication |
| `mcp/mcp.json` | `~/.config/mcp/mcp.json` | Shared MCP config (Figma desktop server) |
| `background-bash/config.json` | `~/.pi-background-bash/config.json` | Auto-background threshold (15s instead of the 30s default) |
| `shell/aliases.sh` | sourced from `~/.zshrc` | `pbb` for background-job inspection |

## Extensions

Two local extensions, both reacting to pi's extension API rather than patching pi:

| Extension | What it does |
| --- | --- |
| `auto-session-name.ts` | Names sessions so `/sessions` is readable instead of a wall of first messages. Titles at user turn 2, 15, and 50 via a cheap Haiku subprocess (~1.4s), never overwrites a name you set with `/name`, and falls back to a first-message heuristic on ctrl+c quit. |
| `esc-flush-queue.ts` | `Esc` while the agent is streaming submits your queued messages instead of just aborting. Decorates whichever editor instance ends up installed, because `pi-powerline-footer` replaces the editor wholesale and packages load after `~/.pi/agent/extensions`. |

## Patches

`patches/pi-pending-compact-row.patch` restyles the running-job row that `pi-background-bash` draws through `pi-pending`: upstream pads the line to the full terminal width and reserves a 6-column elapsed field, so the highlighted bar spans the screen and sits out of line with the footer. The patch makes the highlight hug the text with the same one-space inset the footer uses, and sizes the elapsed column to its content.

`node_modules` is gitignored inside the `pi-background-bash` checkout, so a reinstall silently drops this. `install.sh` reapplies it, and `patch --forward` makes that a no-op when it is already in place.

`patches/powerline-welcome-greeting.patch` replaces powerline's hardcoded `Welcome back!` with a time-of-day greeting. Powerline's only knob is `welcome: true|false`, so there is no config hook to use instead. The greeting text lives in `agent/greetings.json` — buckets are `{ from, to, variants }` on a 24-hour clock, `to` is exclusive, and a bucket may wrap midnight (`22 → 5`). `{name}` expands to the `name` field, overridable per machine with `PI_GREET_NAME`, falling back to the home directory's basename. A missing or malformed file still greets, using built-in defaults.

Editing `greetings.json` takes effect on the next start; only changes to the patch itself need `install.sh` re-run.

## Packages

Installed from `agent/settings.json` by `install.sh`:

- [`pi-subagents`](https://www.npmjs.com/package/pi-subagents) — delegation and multi-agent review panels
- [`pi-messenger`](https://www.npmjs.com/package/pi-messenger) — agent coordination and Crew task flow
- [`pi-mcp-adapter`](https://www.npmjs.com/package/pi-mcp-adapter) — MCP servers
- [`pi-observational-memory`](https://www.npmjs.com/package/pi-observational-memory) — cross-session memory
- [`@houndmcp/hound-mcp-pi`](https://www.npmjs.com/package/@houndmcp/hound-mcp-pi) — keyless web search and fetch
- [`pi-powerline-footer`](https://www.npmjs.com/package/pi-powerline-footer) — powerline status bar, editor stash, bash mode
- [`pi-terminal-theme`](https://www.npmjs.com/package/pi-terminal-theme) — terminal-palette themes (installed; `dark` is active)
- [`pi-background-bash`](https://github.com/mowenroot/pi-background-bash) — long commands stop blocking; results come back on their own. Threshold lowered to 15s in `background-bash/config.json`; a project can override it with `.pi/background-bash.json`.

## Not tracked, on purpose

`auth.json`, `models-store.json`, `run-history.jsonl`, and `sessions/` are machine-local or secret. Per-project `.mcp.json` belongs to each repo. Figma's MCP server only answers while the Figma desktop app is running.

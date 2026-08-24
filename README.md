# pi-setup

My [pi](https://github.com/earendil-works/pi-mono) setup, tracked so a new machine is one script away.

## Install

```bash
git clone https://github.com/tylertaewook/pi-setup.git ~/pi-setup
cd ~/pi-setup && ./install.sh
```

It backs up anything it replaces to `<file>.bak-<timestamp>`, so it is safe to re-run. Then `pi auth` for provider credentials — those are never in here.

## What is tracked

| Path | Goes to | What it is |
| --- | --- | --- |
| `prompt/SYSTEM.md` | `~/.pi/agent/SYSTEM.md` | Global system prompt: critical rules, minimal diffs, no comment slop, no phased handoffs |
| `agent/AGENTS.md` | `~/.pi/agent/AGENTS.md` | Cross-repo working rules — verification habits, editing discipline, bun/turbo conventions |
| `agent/settings.json` | `~/.pi/agent/settings.json` | Theme, default model, thinking levels, and the package list `install.sh` reads |
| `extensions/*.ts` | `~/.pi/agent/extensions/` | Local extensions (below) |
| `skills/*` | `~/.agents/skills/` | Skills, vendored for exact replication |
| `mcp/mcp.json` | `~/.config/mcp/mcp.json` | Shared MCP config (Figma desktop server) |
| `background-bash/config.json` | `~/.pi-background-bash/config.json` | Auto-background threshold (15s instead of the 30s default) |
| `shell/aliases.sh` | sourced from `~/.zshrc` | `pbb` for background-job inspection |

## Extensions

Three local extensions, all reacting to pi's extension API rather than patching pi:

| Extension | What it does |
| --- | --- |
| `auto-session-name.ts` | Names sessions so `/sessions` is readable instead of a wall of first messages. Titles at user turn 2, 15, and 50 via a cheap Haiku subprocess (~1.4s), never overwrites a name you set with `/name`, and falls back to a first-message heuristic on ctrl+c quit. |
| `esc-flush-queue.ts` | `Esc` while the agent is streaming submits your queued messages instead of just aborting. Decorates whichever editor instance ends up installed, because `pi-powerline-footer` replaces the editor wholesale and packages load after `~/.pi/agent/extensions`. |
| `pbb-footer.ts` | Shows running background jobs (`⚙ N bg` in the footer, per-job detail below the editor) by reading `pi-background-bash` job state. Counts a job as running only if its pid is actually alive — a job whose process group dies with `/reload` never gets a completion event and otherwise reads as running forever. |

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

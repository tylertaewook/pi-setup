# Quirks

Why each customization exists, what breaks it, and how to tell. Read this first when something stops working after a `pi update`, a `pi install`, or a powerline release.

## The short version

| Symptom after an update | Likely cause | Check |
| --- | --- | --- |
| Welcome says `Welcome back!` again | powerline reinstalled, patch gone | `grep -c welcomeGreeting ~/.pi/agent/npm/node_modules/pi-powerline-footer/welcome.ts` |
| Background-job row spans the whole width again | `pi-pending` reinstalled, patch gone | `grep -c "hug the text" ~/.pi/agent/git/github.com/mowenroot/pi-background-bash/node_modules/pi-pending/index.ts` |
| `Esc` aborts without sending queued messages | powerline editor changed, or the ctx went stale | is the queued text still in the editor after `Esc`? |
| Sessions stop getting names | titler subprocess failing or slow | `pi --model <haiku> --thinking off -ne -ns -np -nc --offline -p "hi"` |
| pi crashes on `Esc` | a captured ctx outlived its session | stack trace naming `esc-flush-queue.ts` |
| Long commands block again | pbb config or install missing | `cat ~/.pi-background-bash/config.json` |

Recovery for all patch-related rows: re-run `./install.sh`. It is idempotent.

## Load order decides who wins

pi loads `~/.pi/agent/extensions/` **before** installed packages (`core/extensions/loader.js:625-631`). Anything a package replaces wholesale, it replaces *after* the local extensions have run.

`pi-powerline-footer` replaces the editor component wholesale and forwards only the autocomplete provider from the previous editor — not input handling. So subclassing `CustomEditor` from a local extension loses the race and its `handleInput` never runs. `esc-flush-queue.ts` works around this by wrapping `ctx.ui.setEditorComponent` and decorating whichever editor instance is ultimately installed.

**What breaks it:** powerline changing how it installs the editor, or another package doing the same trick. **Symptom:** `Esc` aborts and drops queued text, with no error.

## A captured ctx is a landmine

`ctx` is retired by `/reload`, `newSession`, `fork`, and `switchSession`. Any method on a retired ctx throws:

```
Error: This extension ctx is stale after session replacement or reload.
```

This already crashed pi once. The throw came from `ctx.isIdle()` inside the editor's input handler, and an exception escaping a terminal-input handler is an `uncaughtException` that takes the whole process down — not a caught extension error.

Rules that follow, and they are not optional:

- Never capture `ctx` in a closure that outlives the turn. Keep a module-level reference that every `session_start` refreshes.
- Route every ctx read through a helper that catches and degrades.
- In async work, re-check that the ctx identity has not changed after each `await`.

`esc-flush-queue.ts` does all three; its fallback for "is the agent idle?" is `true`, meaning a stale ctx costs that keypress's flush rather than the process.

## Vendored patches are the fragile part

Two patches edit installed packages, and **neither location is under version control**:

| Patch | Target | Wiped by |
| --- | --- | --- |
| `pi-pending-compact-row.patch` | `pi-background-bash/node_modules/pi-pending/index.ts` | any reinstall of that checkout (`node_modules` is gitignored there) |
| `powerline-welcome-greeting.patch` | `~/.pi/agent/npm/node_modules/pi-powerline-footer/welcome.ts` | `pi update`, `pi install pi-powerline-footer` |

`install.sh` reapplies both with `patch --forward`, which no-ops when already applied. The trap: **the "already applied" and "upstream changed" cases print the same message**, so an upstream rewrite looks like success while you silently get the old behavior back. Verify with the `grep` commands in the table above rather than trusting the installer's output.

Neither patch is load-bearing — losing one costs cosmetics, not function.

## pi-background-bash: jobs die with the process

Jobs are children of the pi process, so `/reload` and quit kill the process group. A killed job never writes `job.completed`, so its `jobs/bgNNN.json` **stays `status: "running"` forever**. Anything counting running jobs by that field alone will report phantom jobs — that bug shipped here once and the fix was checking `process.kill(pid, 0)` for liveness.

Also true, and both bit during testing:

- **Job ids restart per instance.** One session can hold two records called `bg002` in different `instances/` directories. Only pid liveness tells them apart.
- **`pbb kill` only resolves jobs in the current instance.** For a job from a previous pi process you need `--instance <id>`, and if the pid is already gone you get `kill ESRCH`; the job file then has to be repaired by hand.
- The auto-background threshold (`~/.pi-background-bash/config.json`, 15s here) is read **per command**, so changing it needs no reload. It is *not* a live timer: promotion is one `setTimeout` fixed at job start, which is why there is no way to promote a running command on demand — a manual `ctrl+b` would need a promote mailbox added upstream, like the kill mailbox it already has.

## Status text placement is by prefix, not by API

`ctx.ui.setStatus(key, value)` placement in the powerline footer depends on the **value**, not the key: a value starting with `[` becomes its own footer line, anything else is merged into the primary line as a compact segment (`powerline-config.ts:415`, `isNotificationExtensionStatus`). There is no "below everything" slot — the bottom line *is* the compact-status line. Widgets are separate (`aboveEditor` / `belowEditor`) and render above the footer block.

## The titler subprocess must be stripped down

`auto-session-name.ts` shells out to pi to generate a title. Run plainly, that subprocess inherits the full user config — MCP servers, skills, and every extension including the titler itself — and took ~90s. With `--thinking off -ne -ns -np -nc --offline` it returns in ~1.4s. **`-ne` is the load-bearing flag**: without it the titler loads itself recursively.

Other constraints worth keeping:

- Titles are generated at user-turn 2, 15, and 50 only.
- A manual `/name` is never overwritten. Ownership is tracked with an `autoSessionName` marker entry; a name with no marker is treated as yours.
- `ctx.getSessionName()` is declared in `types.d.ts` but **is not bound at runtime** — use `ctx.sessionManager.getSessionName()`. `ctx.setSessionName` *is* bound (`runner.js:163-164`).
- `ctx.exec` does not exist outside TUI mode, so the handler must bail when `ctx.mode !== "tui"`.

## Render functions run on every repaint

The welcome greeting picked a random variant inside `buildLeftColumn`, which runs per frame — so it visibly flickered between variants. Anything non-deterministic in a render path has to be memoized outside it. `welcomeGreeting()` caches per process; `resolveGreeting(now, pick)` stays pure for testing.

The related testing lesson: the first test passed a deterministic `pick` and therefore could not have caught the flicker. A test that fixes the randomness cannot detect a randomness bug.

## Settings worth remembering

- `showLastPrompt: false` disables powerline's `↳ <last prompt>` echo under the prompt bar (`index.ts:1703`).
- `MCP: 2 servers enabled` counts **configured** servers, not connected ones — figma (`~/.config/mcp/mcp.json`, only live with the Figma desktop app) and grafana (a project `.mcp.json`). Both connect lazily, so the count is normal.
- The `terminal` theme maps everything to ANSI 0-15, which flattens tool/message background tints. That is why this setup is back on `dark` while `pi-terminal-theme` stays installed.

## Verification habits that actually caught things here

- Drive the real module with a fake theme/tui rather than reading the diff. The `[BG>…<BG]` markers are what proved the background hugged the text.
- Run a PTY harness against real pi for anything involving the TUI; headless `-p` exits before follow-ups and background wake-ups can arrive.
- Test the installer against a throwaway `HOME` with a stub `pi` on `PATH`. That is how the file placement and package ordering were confirmed without touching live config.
- For a patch, prove the round trip: reverse-apply, confirm the original returned, reapply, confirm behavior again.

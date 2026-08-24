# Quirks

Why each customization exists, what breaks it, and how to tell. Read this first when something stops working after a `pi update`, a `pi install`, or a powerline release.

Run `./scripts/verify.sh` first — it checks every item in the table below and exits non-zero with the reason.

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

## The API you want is on `pi`, not `ctx`

`exec`, `appendEntry`, `setSessionName`, and `getSessionName` live on the **`pi`** object passed to the extension factory (`loader.js:295-325`). They are *not* on the per-session `ctx` — `createContext()` (`runner.js:459-536`) exposes only `ui, mode, hasUI, cwd, sessionManager, modelRegistry, model, scopedModels, thinkingLevel, isIdle, isProjectTrusted, signal, abort, hasPendingMessages, shutdown, getContextUsage, compact, getSystemPrompt`. pi's changelog records the move (`ctx.exec()` → `pi.exec()`).

This cost a whole feature: `auto-session-name.ts` shipped calling `ctx.exec`/`ctx.setSessionName`/`ctx.appendEntry`, guarded by `typeof ... !== "function"` checks that turned the mismatch into **permanent silence**. It looked installed and did nothing for its entire life. The tell was that no session ever got an `autoSessionName` marker.

Two defenses, both now in place:

- `scripts/type-check.sh` runs `tsc --strict` against the installed pi's own `.d.ts`. jiti transpiles extensions without checking types, so this is the only thing that catches a renamed API.
- `scripts/verify.sh` greps for `ctx.exec|ctx.setSessionName|ctx.appendEntry|ctx.getSessionName` and fails.

**Never write `typeof ctx.someApi !== "function"` as a guard.** It converts a hard failure into a silent no-op. Let it throw — `runner.emit` catches handler exceptions and surfaces them as extension errors.

## Reload reuses the ui context but re-evaluates the module

This pairing is the trap. On `/reload`:

1. `_resourceLoader.reload()` re-evaluates every extension module (jiti `moduleCache: false`), so module-level state resets and you get a **new module instance**.
2. `session_start` is then emitted with the **stored** `_extensionUIContext` (`agent-session.js:1833, 2156`) — the *same* object as before.

So a `Symbol` stamped on `ctx.ui` to prevent double-patching survives the reload, and the new module instance skips its install and never wires up. Meanwhile the editor that is actually on screen still holds the **old** module's closure, whose state was zeroed by `session_shutdown`. Net effect: the feature goes silently dead until you restart pi.

Fix pattern, and `pi-pending` uses it too (`index.ts:75`): keep shared state on `globalThis[Symbol.for("...")]` so every module instance sees the same object. `esc-flush-queue.ts` does this for its `live`/`flushing` state.

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

Related, and worse: **a floating promise from an input handler can kill pi.** Node's default is `--unhandled-rejections=throw`, so a rejection from `void flush(...)` terminates the process. Every fire-and-forget path started from a keystroke needs `.catch()`.

## Emulating a submit: what pi already does for you

When flushing the queue manually, do not re-do pi's own work:

- **`addToHistory` is already called** by pi's submit path (`interactive-mode.js:2516, 2526, 2538, 2554`). Calling it too duplicates the entry.
- **The queue restore is synchronous** and formatted `queued + "\n\n" + draft` (`restoreQueuedMessagesToEditor`). Snapshot the editor text *immediately* after the interrupt, not after an await — anything typed during the wait otherwise gets folded into the submitted message and then clobbered by the restore.
- **Two interrupts start two flushes.** Both observe the same idle transition and submit the same text twice. Guard with an in-flight flag.
- **`setEditorComponent(undefined)` means "restore pi's default editor"** and powerline's cleanup path relies on it (`index.ts:2387`). A wrapper that turns `undefined` into its own editor breaks that contract; pass `undefined` straight through.

## Vendored patches are the fragile part

Two patches edit installed packages, and **neither location is under version control**:

| Patch | Target | Wiped by |
| --- | --- | --- |
| `pi-pending-compact-row.patch` | `pi-background-bash/node_modules/pi-pending/index.ts` | any reinstall of that checkout (`node_modules` is gitignored there) |
| `powerline-welcome-greeting.patch` | `~/.pi/agent/npm/node_modules/pi-powerline-footer/welcome.ts` | `pi update`, `pi install pi-powerline-footer` |

`install.sh` reapplies both, and each application is **verified by grepping for a marker afterwards** rather than trusting `patch`'s exit code. It runs with `--fuzz=0` (default fuzz can apply a hunk at the wrong offset on a drifted file), `--batch` (otherwise `patch` can sit waiting on a `File to patch:` prompt forever), and `-r -` (no `.rej` litter in `node_modules`). A real failure is reported as a failure and the script exits non-zero.

Neither patch is load-bearing — losing one costs cosmetics, not function.

## The installer will not eat your config

Hard-won behavior, worth not regressing:

- **Backups go to `~/.pi/agent/backups/<stamp>/`, never beside the original.** A backup copy left next to a skill still contains `SKILL.md`, and skill discovery is "any directory containing SKILL.md" — so every re-run used to register duplicate skills.
- **A failed backup aborts the run.** `backup()` used to end in `|| true` while the next line ran `rm -rf`, so a full disk meant deletion with no copy.
- `shopt -s nullglob`, because an empty `extensions/` or `skills/` would otherwise leave the literal glob, fail under `set -e`, and abort **after** the prompt files were already replaced.
- `pi install ... </dev/null`, because anything that reads stdin would otherwise consume the rest of the package list from the here-string.
- The settings merge is **recursive** and written atomically via `os.replace`, so a machine-local key nested inside `modelThinkingLevels` survives. A corrupt existing `settings.json` is reported and skipped, not fatal.
- Nothing is pruned: deleting an extension or skill from the repo does not remove it from a machine that already installed it.

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

- Titles are generated at user-turn 2, 15, and 50 — as *thresholds passed*, not exact matches. Steering can land two user turns in one settle (1 → 3), which an equality check would skip entirely.
- **`agent_settled` is awaited before the session reports idle** (`agent-session.js:330-338`), so blocking it on a 25s subprocess stalls anything waiting on idle. The titler is fired with `void (async () => ...)()` behind a `busy` flag.
- **A killed child reports `code: 0`** (`exec.js` resolves `code ?? 0`), so a timed-out titler would otherwise have its partial output used as the name. Check `result.killed` too.
- A manual `/name` is never overwritten. Ownership is tracked with an `autoSessionName` marker entry; a name with no marker is treated as yours. The marker is validated on read — a malformed one used to pass the gate.
- The conversation excerpt is passed in `argv`, so it is visible in `ps` to any local user for the life of the child. `spawn` uses `shell: false`, so there is no quoting risk, but the exposure is real.
- `session_shutdown` also fires for `reload`, `new`, `resume`, and `fork` — not just quit. The fallback name applies on those too.

## Render functions run on every repaint

The welcome greeting picked a random variant inside `buildLeftColumn`, which runs per frame — so it visibly flickered between variants. Anything non-deterministic in a render path has to be memoized outside it. `welcomeGreeting()` caches per process; `resolveGreeting(now, pick)` stays pure for testing.

The related testing lesson: the first test passed a deterministic `pick` and therefore could not have caught the flicker. A test that fixes the randomness cannot detect a randomness bug.

Two hard limits on that screen:

- **The greeting column is 26 characters** (`welcome.ts`, `leftCol = 26`) and `centerText` truncates with `…` past it. `verify.sh` checks every variant after `{name}` substitution.
- **Anything thrown in a render path blanks the welcome screen.** `greetings.json` is hand-edited, so a non-string variant would reach `variant.replace(...)` and throw. Validation now filters non-strings, and `welcomeGreeting()` falls back to `Welcome back!` rather than propagating.

## The elapsed column grows as a job ages

`formatElapsedDuration` emits `27s` (3 chars), then `1m 0s` (5), then `10m 12s` (7). Because the column is `max(minWidth, actualWidth)`, too small a minimum makes the row shift right the moment a job crosses a minute. Upstream's 6-wide default was stable on purpose; this setup uses `"1m 0s".length` (5) as the compromise — tight, and stable up to an hour.

## Settings worth remembering

- `showLastPrompt: false` disables powerline's `↳ <last prompt>` echo under the prompt bar (`index.ts:1703`).
- `MCP: 2 servers enabled` counts **configured** servers, not connected ones — figma (`~/.config/mcp/mcp.json`, only live with the Figma desktop app) and grafana (a project `.mcp.json`). Both connect lazily, so the count is normal.
- The `terminal` theme maps everything to ANSI 0-15, which flattens tool/message background tints. That is why this setup is back on `dark` while `pi-terminal-theme` stays installed.

## Verification habits that actually caught things here

- Drive the real module with a fake theme/tui rather than reading the diff. The `[BG>…<BG]` markers are what proved the background hugged the text.
- Run a PTY harness against real pi for anything involving the TUI; headless `-p` exits before follow-ups and background wake-ups can arrive.
- Test the installer against a throwaway `HOME` with a stub `pi` on `PATH`. That is how the file placement and package ordering were confirmed without touching live config.
- For a patch, prove the round trip: reverse-apply, confirm the original returned, reapply, confirm behavior again.

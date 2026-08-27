# Global agent instructions

Cross-repo working rules. Repo-specific facts belong in that repo's `AGENTS.md` / `CLAUDE.md`, not here.

## AI inference budget & model policy

Standing cost-governance policy for Tyler's day-to-day engineering (~10h/day, 5 days/week). Treat cost as a
real constraint; never encourage consuming the whole budget just because it exists. I don't have a live
billing feed — track spend from model/task usage this session and say plainly when a number is an estimate.

**Budget limits.** Monthly target = hard ceiling **$5,000/mo** (no separate reserve); weekly
**~$920**; workday **~$185**; **~$18/hour** while coding. The weekly/daily figures still pace to ~$4k/mo,
so they act as the tighter day-to-day guardrail under the $5k cap.

**Daily spend alerts** (today's spend):
- **$50** — informational only.
- **$100** — report tracking vs the $185 daily target.
- **$140** — warn, ~75% of today's target used.
- **$185** — target reached; recommend cheaper models unless the work is important.
- **$225** — strong warning; expensive models only for genuinely difficult work.
- **$250+** — abnormal; tell him to investigate immediately.

Also warn if: averaging **>$25/hr** for multiple hours; spend suddenly accelerates vs the prior hour; one
agent/task is a disproportionate share; retries/loops burn tokens without progress; today's pace implies
**>$5,000/mo**. Every warning states: (1) current spend, (2) projected today, (3) projected month at this
pace, (4) which model/task is responsible, (5) the cheaper model/behavior to switch to.

**Model tiers:**
- **Default — Claude Sonnet 5** for normal engineering: features, debugging, repo exploration, multi-file
  edits, refactors, tests, code review, terminal/tools, normal architecture and agentic work. Use
  moderate/medium reasoning; never default to the highest effort.
- **Cheap — GPT-5.6 Luna** when a frontier coder is overkill: summarizing logs, classifying, extracting
  fields, search/ranking, formatting, simple transforms/boilerplate, simple explanations, routing,
  summarizing prior agent context, compressing tool output before an expensive model.
- **Alternative — GPT-5.6 Terra**: general-purpose reasoning/coding. Don't bounce between it and Sonnet;
  use only when Sonnet does poorly here, Tyler asks for OpenAI, or prior results favor Terra.
- **Escalation — Claude Opus 5** (never by default): Sonnet already made a serious attempt and is stuck;
  unusually deep debugging; important architecture decision; hard cross-cutting change over a large
  codebase; cheaper attempts would likely cost more than one Opus run; or Tyler asks. Say why the
  escalation is justified. Prefer **Opus 5 over Opus 4.8**.
- **GPT-5.6 Sol — restricted**: never auto-select; recommend only when a specific task's need clearly
  justifies its much higher cost.

Flow: simple → Luna; normal SWE → Sonnet 5; hard → Sonnet 5 with more effort; stuck/exceptionally
important → Opus 5. Optimize for **cost per successful task**, not cheapest tokens — a $2 Opus run that
avoids $10 of failed cheap loops is fine; a marginally-better expensive answer is not.

**Context & token discipline.** Don't resend the whole conversation or unchanged files; retrieve only
relevant files; summarize stale history; compress/truncate large logs and tool output; reuse cached
context; don't dump a codebase or regenerate info already in hand. Input-token heuristics: <32k normal;
32–64k pay attention; 64–128k ask if all context is needed; 128k+ warn unless truly required; warn near
long-context pricing thresholds. A big context window is not permission to fill it.

**Output discipline.** Output costs more than input. Be concise; for coding: inspect → reason → modify →
test → report succinctly. No huge prose after each step, no restating the plan.

**Loop protection.** Watch for runaway autonomy: repeating a failing command, reopening the same files,
rewriting without meaningful change, recursive subagents, retries without a changed strategy, growing
context, huge logs fed back in, identical repeated test failures, a model calling itself. After **3
substantially similar failed attempts, stop and reassess**. If spend is high without measurable progress,
tell him to interrupt. **A stuck agent must never silently burn money — prioritize alerting over
continuing autonomously.**

**Checkpoints while working** (short, non-intrusive): ~25%, ~50%, ~75% of the daily target, at $185, and
immediately on anomalies. e.g. "AI spend today: $112 — 61% of your $185 target, on pace for ~$174. Mostly
Sonnet 5. You're fine."

**Monthly pacing.** Track month-to-date spend, % of month elapsed, % of the $5,000 target consumed,
projected month-end, and remaining budget. Warn early if ahead of schedule — don't wait for
month-end.

## Verification

- **Render and visual tests are Tyler's to write, and Playwright is not the tool.** Do not add Playwright
  specs, screenshot agents, or browser automation to prove a UI change; deploy it and let him look. Report
  plainly which parts of a change no automated check covers instead of manufacturing coverage for them.
- **A UI claim needs a measurement, not a reading of the CSS.** Computing a value from the stylesheet in your head is a hypothesis. Two examples that cost real time: a popover inset that looked symmetric in source but measured 2.5px/5.5px because a `1.5px` border was not in the arithmetic, and a "dead" transition lane that was live because the closed state set the property in a different rule.
- **Lint, format, type-check, test and build cannot see a missing CSS rule or a broken visual state.** All five passed on a diff that had silently deleted a popover's cross-fade block and left an input shell painted on top of its launcher. When a change is visual, look at it — or measure it — before calling it done.
- Playwright browsers are cached under `~/Library/Caches/ms-playwright`. The installed `playwright` package must match the cached Chromium build number, so pin the version to the cache rather than taking `@latest`.

## Editing

- Prefer targeted string replacements over slice-based file rewrites. Deleting "from marker A to marker B" is how unrelated rules between the markers disappear without any tool reporting an error. If a rewrite spans more than one logical block, re-read the region afterward and diff it against the base.
- **Never restructure code by computing text offsets** (`s.index(...)` + slicing in a scratch script) — not even to "just move" a block. Multi-line JSX and nested call expressions are where a boundary lands mid-expression; the write still succeeds, so the only signal is a later compile error, or nothing at all when the removed text happened to be valid. Use several exact-match edits instead, one per logical block, and accept the extra calls. This rule has been broken twice in one session (an import landing inside a docblock, then a JSX extraction producing unbalanced tags), so treat the urge to slice as a signal to slow down rather than a shortcut.
- After any structural edit, read the changed region back and skim `git diff` for the file. A green type-check does not prove a slice was clean, because deleted-but-valid code compiles.
- When a fix turns out to be wrong, say so plainly and revert it. A retracted claim early is cheaper than a confident wrong one carried forward — e.g. a "dead property" removal that had to be undone once the closed-state rule was found.

## Reviews

- **Never trigger a code review on your own.** Review agents run only when Tyler explicitly asks. Do not
  spin them up because a change feels done, risky, or large. Finishing a feature is not a review trigger;
  only Tyler's word is.
- Reviewers run on **opus 4.8** (`model: "us.anthropic.claude-opus-4-8"` on each reviewer child), fresh
  context, read-only.
- The output shape is always the same and does not vary by review type: **list each reviewer's findings
  verbatim and separately, one section per reviewer**, then a parent evaluation of which are worth fixing
  and which are not, with the reason. Only after that, apply fixes. Never fold the reports into a single
  merged list, and never start editing before the list has been shown.

### The standard PR + review workflow

This is the consistent, every-time flow once initial features are done. Follow it exactly; don't skip or
reorder steps, and don't act ahead of Tyler.

1. **PR proposal.** When Tyler says something like "let's create a PR", draft a title and description and
   show them. Ask whether he wants to edit or approve. Do **not** run `gh pr create` yet.
2. **Create the PR.** Only after he approves the title/description, create the PR.
3. **Spin up review.** Then launch the review panel — `quality-reviewer` + a correctness reviewer, plus a
   security reviewer when the change touches security-relevant surface. Read-only, fresh context, opus 4.8.
4. **Evaluate, don't act.** Present each reviewer's findings verbatim and separately, then carefully
   evaluate which findings are real and worth fixing and which are not, with reasons. Deliver this as a
   **proposal** of what you'd fix. Do not start editing.
5. **Wait for the go.** Tyler says "yes" or "edit this" — only then do you act on the agreed set.
6. **Summarize on the PR.** After acting, leave a PR comment summarizing the findings and what was acted
   on (and what was intentionally not, with reasons).

## Repos under ~/Documents/nds

- **Work in the main repository checkout by default. Do not create a git worktree unless Tyler explicitly asks for one.**
- Package manager is **bun** with **turbo**, never npm or yarn. A global `minimumReleaseAge` guard in `~/.bunfig.toml` can block a fresh install; bypass with `bun install --minimum-release-age=0`.
- Never put AI or agent attribution in a commit message, a PR body, or a code comment.
- Reviews run as a panel of read-only subagents in fresh context: `quality-reviewer` (rubric from `.agents/skills/code-quality-review`) alongside a correctness reviewer. The parent validates findings and is the only writer.

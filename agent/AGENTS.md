# Global agent instructions

Cross-repo working rules. Repo-specific facts belong in that repo's `AGENTS.md` / `CLAUDE.md`, not here.

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

## Email drafting

When Tyler drafts an email with me, iterate on the wording in chat as normal. When he says he's ready ("copy that", "ready", etc.), copy the final draft straight to his macOS clipboard with `pbcopy`, keeping each paragraph as a single long line (no mid-paragraph newlines) so his mail client soft-wraps it and no terminal line breaks get baked in. Also save a copy to an ephemeral file (e.g. `/tmp/*.txt`). Don't make him select text from the terminal.

## Obsidian

- Tyler's Obsidian vault is at `~/Documents/nds-obsidian`. When he asks to create a doc "in obsidian," write it there.

## Repos under ~/Documents/nds

- **Work in the main repository checkout by default. Do not create a git worktree unless Tyler explicitly asks for one.**
- Package manager is **bun** with **turbo**, never npm or yarn. A global `minimumReleaseAge` guard in `~/.bunfig.toml` can block a fresh install; bypass with `bun install --minimum-release-age=0`.
- Never put AI or agent attribution in a commit message, a PR body, or a code comment.
- Reviews run as a panel of read-only subagents in fresh context: `quality-reviewer` (rubric from `.agents/skills/code-quality-review`) alongside a correctness reviewer. The parent validates findings and is the only writer.

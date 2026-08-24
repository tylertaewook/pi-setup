# Global agent instructions

Cross-repo working rules. Repo-specific facts belong in that repo's `AGENTS.md` / `CLAUDE.md`, not here.

## Verification

- **A UI claim needs a measurement, not a reading of the CSS.** Computing a value from the stylesheet in your head is a hypothesis. Two examples that cost real time: a popover inset that looked symmetric in source but measured 2.5px/5.5px because a `1.5px` border was not in the arithmetic, and a "dead" transition lane that was live because the closed state set the property in a different rule.
- **Lint, format, type-check, test and build cannot see a missing CSS rule or a broken visual state.** All five passed on a diff that had silently deleted a popover's cross-fade block and left an input shell painted on top of its launcher. When a change is visual, look at it — or measure it — before calling it done.
- Playwright browsers are cached under `~/Library/Caches/ms-playwright`. The installed `playwright` package must match the cached Chromium build number, so pin the version to the cache rather than taking `@latest`.

## Editing

- Prefer targeted string replacements over slice-based file rewrites. Deleting "from marker A to marker B" is how unrelated rules between the markers disappear without any tool reporting an error. If a rewrite spans more than one logical block, re-read the region afterward and diff it against the base.
- When a fix turns out to be wrong, say so plainly and revert it. A retracted claim early is cheaper than a confident wrong one carried forward — e.g. a "dead property" removal that had to be undone once the closed-state rule was found.

## Repos under ~/Documents/nds

- Package manager is **bun** with **turbo**, never npm or yarn. A global `minimumReleaseAge` guard in `~/.bunfig.toml` can block a fresh install; bypass with `bun install --minimum-release-age=0`.
- Never put AI or agent attribution in a commit message, a PR body, or a code comment.
- Reviews run as a panel of read-only subagents in fresh context, and code quality is one of the seats: `quality-reviewer` (rubric from `.agents/skills/code-quality-review`) alongside a correctness reviewer and, in DOI repos, `doi-reviewer` for the ATO boundary. The parent validates findings and is the only writer.

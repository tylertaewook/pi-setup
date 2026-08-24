---
name: "address-pr-comments"
description: "Manually triggered workflow to address review comments on a GitHub PR: audit which comments are resolved vs unresolved, plan and implement fixes for unresolved ones, then reply to each comment with the fix or a justification and resolve the conversation. Only use when the user explicitly asks to address/handle/resolve PR comments."
---

# Address PR Comments

Manually-triggered only. Run when the user explicitly asks to address PR review comments.

## Overview

For a given PR: fetch every review comment, determine which are already addressed and which are not, fix all unresolved ones, then reply to each comment thread and resolve it.

## Step 1: Identify the PR

- If the user gave a PR number/URL, use it.
- Otherwise infer from the current branch: `gh pr view --json number,url,headRefName`.
- Capture `OWNER`, `REPO`, `PR_NUMBER`. Get them from `gh repo view --json owner,name` and the PR.

## Step 2: Fetch all review comments + resolution state

Review-thread resolution state is only in the GraphQL API (REST doesn't expose `isResolved`). Fetch threads with their comments:

```bash
gh api graphql -f query='
query($owner:String!,$repo:String!,$pr:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$pr){
      reviewThreads(first:100){
        nodes{
          id
          isResolved
          isOutdated
          path
          line
          comments(first:50){
            nodes{ id databaseId author{login} body path line diffHunk createdAt }
          }
        }
      }
    }
  }
}' -f owner=OWNER -f repo=REPO -F pr=PR_NUMBER
```

Also fetch top-level issue-style comments if relevant:
`gh pr view PR_NUMBER --json comments`.

## Step 3: Triage each thread

For every review thread, classify:

- **Resolved already** (`isResolved: true`) — skip unless the user wants a re-audit.
- **Unresolved** — read the comment, look at `path`/`line`/`diffHunk`, then read the current code at that location to decide:
  - **Already addressed** in code (fix present but thread never resolved) → will reply noting it's addressed + resolve.
  - **Not addressed** → needs a fix.
  - **Not necessary / won't fix** → needs a justification reply.

Build a checklist (todo list) of every unresolved thread and its category before writing code.

## Step 4: Plan and implement fixes

- Group related comments; fix the whole class where applicable.
- Follow repo conventions and the `code-quality-review` skill.
- Make minimal, correct diffs. Read before editing.
- Run relevant tests/lint/type-check after changes.

## Step 5: Reply to each comment and resolve

For each thread, post a reply then resolve. Reply to a review comment thread using the comment's `databaseId` (the first comment in the thread):

```bash
# reply in-thread to a review comment
gh api repos/OWNER/REPO/pulls/PR_NUMBER/comments/COMMENT_DATABASE_ID/replies \
  -f body="Fixed in <commit/short-sha or description>. <what changed>"
```

Then resolve the thread via GraphQL using the thread node `id`:

```bash
gh api graphql -f query='
mutation($threadId:ID!){
  resolveReviewThread(input:{threadId:$threadId}){ thread{ isResolved } }
}' -f threadId=THREAD_NODE_ID
```

Reply content rules:
- If a `create-pr-comment` skill is present in `<available_skills>`, read it before drafting and use its "replying on my own PR" register. Otherwise keep replies to one plain line stating what changed.
- If fixed: state concisely what was changed and where (`file:line`).
- If not necessary: give a clear, respectful justification.
- Never resolve without first replying.

## Step 6: Summarize

Report a compact table: each comment → action taken (fixed / already addressed / won't-fix reason) → resolved yes/no. Mention any comments left unresolved and why (e.g. needs author decision).

## Notes

- Don't commit or push unless the user asked. If fixes need pushing for replies to reference commits, ask first or describe the change instead of a SHA.
- Only reply/resolve on threads you actually handled.
- If a comment is ambiguous or a product decision, ask the user rather than guessing.

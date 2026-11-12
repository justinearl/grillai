# grillai

A purely local tool for reviewing, understanding and questioning changes made by AI agents in my projects. It follows the layout and workflow of GitLab's merge request **Changes** tab (which I'm used to), without GitLab branding, plus an agent I can ask about any part of the diff.

## Core workflow

1. Start the app against one project (one repo at a time).
2. Pick what to review:
   - branch vs branch, or
   - current state (working tree, including uncommitted changes) vs a branch.
3. Read the diff in a GitLab-style Changes view.
4. Select one or more lines and ask the agent a question. The answer appears as a discussion thread anchored to those lines.
5. When done, generate a summary of the review and copy-paste it into whichever agent will do the fixes.

## Features

### Changes view
- File tree of changed files.
- Inline and side-by-side diff.
- "Show more lines" expansion between hunks and at the ends of a file; threads can be started on expanded lines too.
- "Viewed" checkbox per file.
- Single-line and multi-line selection for starting a thread.

### Threads
- Anchored to a line or line range, like GitLab discussions.
- Persistent: still there when the review is reopened.
- I can reply to continue the conversation with the agent.
- Resolvable.
- A thread can also be a plain note of mine, without asking the agent.
- If the underlying lines change, the thread is marked **stale** (kept, not deleted). Detection: each thread stores the content of its selected lines; if that content no longer exists in the file's current diff, the thread is stale. If the same content only moved to other line numbers, the thread follows it.

### Agent
- Model: Claude Opus 5.5 (`claude-opus-5-5`), overridable with `GRILLAI_MODEL`.
- Uses my Claude subscription through the Claude Code CLI I'm already logged into. The app spawns it (`claude -p`) in the repo directory; there is no login flow in the app itself.
- One CLI session per thread, continued with `--resume` when I reply.
- Answer only: it never edits code.
- Has the full repo as context, not just the selected lines.

### AI review
- A button that has the agent review the whole change. It only runs when I click it, never automatically.
- Each finding becomes a thread anchored to the lines it is about, marked as an AI review finding with a severity (high, medium, low). A summary of the review is shown above the files.
- Findings behave like my own threads: I can reply, resolve or delete them, and unresolved ones go into the review summary.
- Running it again replaces the earlier findings I have not replied to.

### Review summary
- Generated manually (a button), not automatically.
- Collects the **unresolved** threads of the review into one text block meant to be pasted into another agent.
- Each entry has: file, line range, the code snippet, and the discussion (or my note).

### Reviews
- A review is identified by its pair of refs: (base ref, target ref or "working tree").
- Reopening the same pair in the same repo brings back its threads and "viewed" state.

## Stack
- Backend: Node.js + TypeScript (local web server, runs git and the `claude` CLI).
- Frontend: React + TypeScript.
- Diff rendering: `diff2html`.
- Storage: SQLite in an app data directory, keyed by repo path. Nothing is written into the reviewed repos.

## Constraints
- Purely local: local web server with a browser UI, no cloud services other than the agent itself.
- One project at a time.

## Non-goals
- Other GitLab MR tabs (Overview, Commits, Pipelines), approvals, merge button.
- The agent making changes or applying suggestions.
- Multi-user, auth, sync.
- Multi-project dashboard.
- GitLab branding or a pixel-exact clone.

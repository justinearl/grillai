# grillai

Review changes made by AI agents in a local, GitLab-style "Changes" view, and ask Claude about any line. Everything runs on your machine. The spec is in [project.md](project.md).

## Requirements

- Node.js 22.13 or newer (uses the built-in `node:sqlite`)
- git
- The [Claude Code CLI](https://claude.com/claude-code) on your `PATH`, logged in (`claude` once in a terminal). grillai asks questions through it, so answers use your Claude subscription. There is no login inside grillai.

## Install

```sh
npm install
npm run build
npm link        # optional: makes the `grillai` command available everywhere
```

## Use

```sh
cd ~/code/my-project
grillai                 # or: node /path/to/grillai/bin/grillai.mjs [repo] [--port 4477] [--no-open]
```

grillai opens http://localhost:4477 in your default browser. Under WSL that is your Windows browser. Pass `--no-open` to skip it.

1. Pick what to review in the top bar: a branch, or **Working tree (current state)**, which includes uncommitted and untracked files, against a base branch. The diff is taken from the merge base, like a GitLab merge request.
2. Read the diff, inline or side-by-side. Between hunks, **Show hidden lines** (or the ↑/↓ 20 lines arrows) reveals the unchanged code around a change. Tick **Viewed** to collapse a file; the tick clears itself if the file's diff changes later.
3. Start a thread: hover a line and click its number (the blue **+**), or drag across line numbers to select several lines. Shift-click extends the selection.
4. **Ask Claude** (Ctrl+Enter) to get an answer in the thread, or **Add note** to leave a comment of your own. Reply to continue the conversation; each thread keeps its own Claude session.
5. **AI review** (top bar) has Claude review the whole change. It runs only when you click it. Each finding becomes a thread on the lines it is about, marked "AI review" with a severity, and a summary appears above the files. Treat findings like any thread: reply to question them, resolve the ones you disagree with. Running it again replaces the earlier findings you have not replied to.
6. **Resolve** threads you are done with. When the code under a thread changes, the thread is marked **Stale** and moves to the top of its file.
7. **Review summary** collects the unresolved threads (file, lines, code, discussion) into one block of text to paste into the agent that will do the fixes.

The diff refreshes when you return to the browser tab, or with **Refresh**.

## What Claude can do

Claude runs in the repository with read-only tools: reading and searching files, and `git log`, `show`, `diff`, `blame` and `status`. It cannot edit files or run other commands.

It can also read Excel files (`.xlsx`), including ones on a branch that is not checked out, through a small bundled reader (`tools/grillai-sheet`).

## Data

Threads and viewed marks are stored in `~/.local/share/grillai/grillai.db` (or `$XDG_DATA_HOME/grillai`), keyed by repository path and the pair of refs. Nothing is written into the repositories you review.

## Settings

| Variable | Meaning |
| --- | --- |
| `GRILLAI_PORT` | Port (default 4477); same as `--port` |
| `GRILLAI_OPEN` | Set to `0` to not open the browser on start; same as `--no-open` |
| `GRILLAI_MODEL` | Model passed to `claude --model` (default: `claude-opus-5-5`) |
| `GRILLAI_CLAUDE_BIN` | Path to the `claude` binary |
| `GRILLAI_DATA_DIR` | Where the database lives |

## Development

```sh
GRILLAI_REPO=~/code/my-project npm run dev   # API on :4477, UI with hot reload on :5173
npm test
npm run typecheck
```

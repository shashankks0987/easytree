<img src="assets/icon.png" alt="" width="96" align="right">

# easytree

I often want to read a pull request's code in my IDE, or move around the code while Claude is changing it in a worktree. But my IDE sits on the main checkout and has no idea which worktree Claude, or each of its subagents, is working in. Finding the right folder and opening it by hand every time got old fast.

easytree takes the simple route: it opens the worktree's code in your IDE, rooted at the same folder you launched your Claude session in. Start Claude in `~/code/app/services/api`, let it work in a worktree, run `/tree-open`, and IntelliJ or VS Code opens `services/api` inside that worktree. It's the same project you're used to, only with the worktree's code.

That works for the worktree the session is in, the ones its subagents work in, and pull requests you check out with `/tree-pr`.

Supports IntelliJ IDEA and VS Code, on macOS.

### How it fits with your IDE's worktree support

IntelliJ IDEA (2026.1 and later) has a Worktrees tab, and VS Code has several worktree extensions. They list worktrees and switch between them, but you have to know which one to pick. easytree adds what they can't know: which worktrees *this Claude session* and its subagents are using, and which folder you launched Claude from. It works fine alongside them; a worktree opened by easytree is an ordinary folder to the IDE.

## Install

At the prompt of a Claude Code session in a terminal:

```
/plugin install easytree --marketplace shashankks0987/easytree
```

Answer `y` to add the marketplace, then pick a scope (user scope makes it available in every project).

From a shell:

```
claude plugin install easytree --marketplace shashankks0987/easytree
```

## Commands

| Command | What it does |
| --- | --- |
| `/tree-open` | Opens the worktree the session is in now, at the folder you launched Claude in (or the worktree's root, if that folder isn't in it). If the session is on the main checkout and has made exactly one worktree, opens that one; if it has made several, opens the `/trees` picker. |
| `/tree-open 2` / `/tree-open feat-login` / `/tree-open ~/some/path` | Opens a worktree by its number in this session's list, its folder name or its branch (again at your launch folder), or any folder as given. |
| `/tree-open … code` / `/tree-open … idea` | Overrides the default IDE for this one call (`intellij`, `vscode` work too). |
| `/trees` | Opens a picker: type to search by name, branch or PR, ↑↓ to move, Enter to open, Esc to close. It lists this session's worktrees first (branch, changed files, where each came from), then the repository's, then subagents'. A button at the bottom switches between IntelliJ and VS Code. |
| `/trees all` | Prints every worktree of the repository with its path. |
| `/tree-pr 123` / `/tree-pr <PR URL>` | Fetches the pull request into branch `pr-123` and a worktree beside the repository, at `<repo>-worktrees/pr-123`, then opens it. Running it again brings a clean checkout up to date with the PR. |

All three run right away, even while Claude is in the middle of a turn, and none of them costs a model call.

You can also just ask Claude, e.g. *"open the PR worktree in IntelliJ"*. The plugin gives Claude an `open_in_ide` tool for that.

## Status line

While the session is in a linked worktree, or has made some, the line under the prompt shows it:

```
⎇ feat-login (feat/login) · +2 worktrees · /tree-open
```

## How it finds the worktrees

- **The session's own:** a session started with `claude --worktree`, and every `EnterWorktree` call.
- **Subagents':** the worktree path an isolated subagent reports when it finishes. Worktrees of subagents still running in the background aren't in the session's list yet, but the `/trees` picker shows them under subagent worktrees, and `/tree-open <name>` opens them.
- **Shell:** any Bash `git worktree add`; the repository's worktrees are compared before and after the call.
- **`/tree-pr`:** the PR checkouts it creates.

Worktrees that have since been removed drop off the list. The list is kept per session, so it survives `--resume`.

## What it runs, reads and sends

easytree runs on your Mac and has no server; it never sends conversation text, file contents or tool output anywhere.

**What it sees of the conversation.** It hooks four tools only: `Bash`, `EnterWorktree`, `ExitWorktree` and `Agent`. Every other tool call never reaches it. It passes each of these calls through unchanged and never blocks or rewrites one. From them it takes:

- the Bash command's text, only to check whether it runs `git worktree add`;
- the `worktreePath` field of an EnterWorktree or Agent result;
- the description of the subagent that ran a `git worktree add`, as the label in `/trees`.

The paths are used only as folders for the local commands below. Nothing it takes from a tool call is passed to `gh` or to the network.

**The one tool it answers itself.** easytree adds one tool of its own, `open_in_ide` (listed as `mcp__easytree__open_in_ide`), which Claude calls when you ask it to open something in your IDE. Its hook answers that tool's calls itself, since there is no other tool behind it: it opens the given folder (or the current worktree at your launch folder) with `/usr/bin/open` and returns a line saying what it opened. easytree stands in for no other tool. Its hooks on `Bash`, `EnterWorktree`, `ExitWorktree` and `Agent` always let the real tool run and return its result unchanged.

**Programs it runs**, each with a fixed name and fixed flags (Claude Code runs them with git hooks turned off):

| Program | Why | Leaves your Mac? |
| --- | --- | --- |
| `git rev-parse`, `git worktree list`, `git status --porcelain`, `git for-each-ref`, `git remote` | Find which worktree a folder belongs to, list the repository's worktrees, count changed files, sort by recent commits, pick the remote. | No |
| `git fetch <remote> pull/<n>/head` | `/tree-pr` only: download PR `<n>` from your repository's own remote (usually `origin` on GitHub), with your git credentials. Downloads only; it never pushes. | Yes: a fetch from your remote |
| `git worktree add <repo>-worktrees/pr-<n> pr-<n>` and `git merge --ff-only FETCH_HEAD` | `/tree-pr` only: create the PR's worktree, or fast-forward a clean one to the PR's latest commit. | No |
| `gh pr view <n> --json title` | `/tree-pr` only, and only if the GitHub CLI is installed: read the PR's title from GitHub, as your `gh` login. It sends the repository and the PR number. | Yes: a GitHub API read |
| `/usr/bin/open -b <app id> <folder>` | Hand the folder to IntelliJ IDEA (`com.jetbrains.intellij`, else `.ce`) or VS Code (`com.microsoft.VSCode`, else Insiders). | No |

**Local data it reads, and where it goes.** It reads the output of the `git` commands above, whether your launch folder exists inside a worktree, your `HOME` path (only to shorten paths to `~/...`), the session's working folder and id, and its own stored list (below). This goes to two places only:

- **Your screen:** the `/trees` picker, the status line, and toasts.
- **Your Claude conversation:** like every slash command, the text a command prints (for example the `/trees` listing or "Opened ... in IntelliJ IDEA") and what `open_in_ide` returns become part of the conversation, which Claude Code sends to Claude as usual. That text holds worktree names, branches, relative paths, changed-file counts, PR numbers and titles; never file contents.

Nothing else leaves your Mac apart from the `git fetch` and `gh pr view` calls in the table.

**Files.** It reads and writes no files itself. The only things created on disk are the PR worktrees and the `pr-<n>` branches that `git` makes for `/tree-pr`.

**What it stores.** Worktree paths, branch names, subagent task descriptions, PR titles and your launch folder, kept in Claude Code's own local storage for the plugin, per session.

## Settings

Run `/config` and find easytree, or set them in `settings.json` under `pluginConfigs.easytree.options`:

| Setting | Default | |
| --- | --- | --- |
| `ide` | `idea` | `idea` (IntelliJ IDEA) or `code` (VS Code) |
| `showStatus` | `true` | Show the worktree in the status line |

## Notes

- IDEs are launched through their macOS app ids, so Toolbox installs and IntelliJ IDEA Community Edition (`com.jetbrains.intellij.ce`), and VS Code Insiders, work without the `idea` or `code` shell commands.
- IntelliJ asks whether to trust each new project folder. To skip that, add your repositories' parent folder under *Settings → Build, Execution, Deployment → Trusted Locations*.
- `/tree-pr` works with GitHub pull requests (`pull/<n>/head`) and fetches from `origin`, or from the only remote. When the [GitHub CLI](https://cli.github.com) is installed and signed in, it also shows the PR's title. Its checkouts live beside the repository, not inside it, so they never show up as untracked files.
- Requires a recent Claude Code (the plugin is a hooks module, an early-access API).

## Develop

```
claude --plugin-dir /path/to/easytree   # load it from a working copy
claude plugin validate /path/to/easytree
claude plugin test /path/to/easytree
```

## License

[Apache-2.0](LICENSE). Created by Shashank ([@shashankks0987](https://github.com/shashankks0987)).

If you fork, copy or build on easytree, keep the [NOTICE](NOTICE) file with it, as the license requires, and credit the original project.

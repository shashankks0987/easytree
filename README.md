# easytree

I often want to read a pull request's code in my IDE, or move around the code while Claude is changing it in a worktree. No IDE handles git worktrees well, and I never found a good way to do either.

easytree takes the simple route: it opens the worktree's code in your IDE, rooted at the same folder you launched your Claude session in. Start Claude in `~/code/app/services/api`, let it work in a worktree, run `/tree-open`, and IntelliJ or VS Code opens `services/api` inside that worktree. It's the same project you're used to, only with the worktree's code.

That works for the worktree the session is in, the ones its subagents work in, and pull requests you check out with `/tree-pr`.

Supports IntelliJ IDEA and VS Code, on macOS.

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
| `/tree-open` | Opens the worktree the session is in now, at the folder you launched Claude in (or the worktree's root, if that folder isn't in it). If the session is on the main checkout and has made exactly one worktree, opens that one; if it has made several, lists them so you can pick. |
| `/tree-open 2` / `/tree-open feat-login` / `/tree-open ~/some/path` | Opens a worktree by its number in `/trees`, its folder name or its branch (again at your launch folder), or any folder as given. |
| `/tree-open … code` / `/tree-open … idea` | Overrides the default IDE for this one call (`intellij`, `vscode` work too). |
| `/trees` | Lists this session's worktrees: branch, path, how each came to be (EnterWorktree, subagent, `git worktree add`, PR), and how many files are changed. Also lists the repository's other worktrees. |
| `/tree-pr 123` / `/tree-pr <PR URL>` | Fetches the pull request into branch `pr-123` and a worktree at `<repo>/.claude/worktrees/pr-123`, then opens it. Running it again brings a clean checkout up to date with the PR. |

All three run right away, even while Claude is in the middle of a turn, and none of them costs a model call.

You can also just ask Claude, e.g. *"open the PR worktree in IntelliJ"*. The plugin gives Claude an `open_in_ide` tool for that.

## Status line

While the session is in a linked worktree, or has made some, the line under the prompt shows it:

```
⎇ feat-login (feat/login) · +2 worktrees · /tree-open
```

## How it finds the worktrees

- **The session's own:** a session started with `claude --worktree`, and every `EnterWorktree` call.
- **Subagents':** the worktree path an isolated Agent call reports, and the working directory of each subagent's first tool call (which covers background subagents too).
- **Shell:** any Bash `git worktree add`; the repository's worktrees are compared before and after the call.
- **`/tree-pr`:** the PR checkouts it creates.

Worktrees that have since been removed drop off the list. The list is kept per session, so it survives `--resume`.

## Settings

Run `/config` and find easytree, or set them in `settings.json` under `pluginConfigs.easytree.options`:

| Setting | Default | |
| --- | --- | --- |
| `ide` | `idea` | `idea` (IntelliJ IDEA) or `code` (VS Code) |
| `showStatus` | `true` | Show the worktree in the status line |

## Notes

- IDEs are launched through their macOS app ids, so Toolbox installs and IntelliJ IDEA Community Edition (`com.jetbrains.intellij.ce`), and VS Code Insiders, work without the `idea` or `code` shell commands.
- IntelliJ asks whether to trust each new project folder. To skip that, add your repositories' parent folder under *Settings → Build, Execution, Deployment → Trusted Locations*.
- `/tree-pr` works with GitHub pull requests (`pull/<n>/head`) and fetches from `origin`, or from the only remote. When the [GitHub CLI](https://cli.github.com) is installed and signed in, it also shows the PR's title. It adds `/.claude/worktrees/` to the repository's `.git/info/exclude`, so the checkouts never show as untracked files.
- Requires a recent Claude Code (the plugin is a hooks module, an early-access API).

## Develop

```
claude --plugin-dir /path/to/easytree   # load it from a working copy
claude plugin validate /path/to/easytree
claude plugin test /path/to/easytree
```

## License

[MIT](LICENSE)

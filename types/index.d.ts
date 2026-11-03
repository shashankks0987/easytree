/** How a worktree came to be tracked for this session. */
export type TreeSource = 'session' | 'enter' | 'agent' | 'bash' | 'pr'

/** A linked git worktree this session (or one of its subagents) worked in. */
export type Tree = {
  /** The worktree's root, absolute. */
  path: string
  branch?: string
  source: TreeSource
  /** A subagent's task, or a PR's number and title. */
  label?: string
  addedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    easytree: { trees: Shaped<Tree[]> }
  }
}

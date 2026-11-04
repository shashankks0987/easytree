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

/** Which group of the /trees picker a worktree is listed under. */
export type PickerSection = 'session' | 'repo' | 'agents'

/** One row of the /trees picker. */
export type PickerItem = {
  path: string
  name: string
  section: PickerSection
  /** What the row says after the name: branch, changes, where it came from. */
  facts: string
  /** Lowercased text the search box matches against. */
  haystack: string
}

declare module 'claude-code' {
  interface PluginState {
    easytree: {
      trees: Shaped<Tree[]>
      pickerItems: Shaped<PickerItem[]>
      pickerQuery: string
      pickerIde: string
    }
  }
}

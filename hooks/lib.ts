import type { Tree, TreeSource } from '../types'

export type Ide = 'idea' | 'code'

export const IDE_NAMES: Record<Ide, string> = {
  idea: 'IntelliJ IDEA',
  code: 'VS Code',
}

/** macOS bundle ids per IDE, tried in order (Ultimate before Community, stable before Insiders). */
export const IDE_BUNDLES: Record<Ide, readonly string[]> = {
  idea: ['com.jetbrains.intellij', 'com.jetbrains.intellij.ce'],
  code: ['com.microsoft.VSCode', 'com.microsoft.VSCodeInsiders'],
}

const IDE_ALIASES: Record<string, Ide> = {
  idea: 'idea',
  intellij: 'idea',
  ij: 'idea',
  code: 'code',
  vscode: 'code',
  vs: 'code',
}

export function parseIde(word: string): Ide | undefined {
  return IDE_ALIASES[word.toLowerCase()]
}

/** Splits a command's arguments into an IDE word (anywhere) and the rest. */
export function splitArgs(args: string): { ide?: Ide; rest: string[] } {
  let ide: Ide | undefined
  const rest: string[] = []
  for (const word of args.trim().split(/\s+/).filter(Boolean)) {
    const asIde = parseIde(word)
    if (asIde && !ide) ide = asIde
    else rest.push(word)
  }
  return { ide, rest }
}

/** `123`, `#123`, `pr-123` or a GitHub pull request URL, to the PR's number. */
export function parsePrRef(arg: string): number | undefined {
  const m =
    arg.match(/\/pull\/(\d+)(?:\/|$|[?#])/) ?? arg.match(/^(?:#|pr-?)?(\d+)$/i)
  const n = m ? Number(m[1]) : NaN
  return Number.isInteger(n) && n > 0 ? n : undefined
}

export type GitWorktree = {
  path: string
  head?: string
  /** The branch's short name; absent when detached. */
  branch?: string
  isMain: boolean
  isBare: boolean
  isPrunable: boolean
}

/** Parses `git worktree list --porcelain`; the first entry is the main worktree. */
export function parseWorktreeList(porcelain: string): GitWorktree[] {
  const out: GitWorktree[] = []
  for (const block of porcelain.split(/\n\s*\n/)) {
    const lines = block.split('\n').filter(Boolean)
    const pathLine = lines.find(l => l.startsWith('worktree '))
    if (!pathLine) continue
    const wt: GitWorktree = {
      path: pathLine.slice('worktree '.length),
      isMain: out.length === 0,
      isBare: false,
      isPrunable: false,
    }
    for (const line of lines) {
      if (line.startsWith('HEAD ')) wt.head = line.slice(5)
      else if (line.startsWith('branch ')) wt.branch = line.slice(7).replace(/^refs\/heads\//, '')
      else if (line === 'bare') wt.isBare = true
      else if (line.startsWith('prunable')) wt.isPrunable = true
    }
    out.push(wt)
  }
  return out
}

/** Adds a tree, or refreshes the one at the same path, keeping its place and first source. */
export function upsertTree(list: readonly Tree[], tree: Tree): Tree[] {
  const at = list.findIndex(t => t.path === tree.path)
  if (at === -1) return [...list, tree]
  const old = list[at]!
  const merged: Tree = {
    ...old,
    branch: tree.branch ?? old.branch,
    label: old.label ?? tree.label,
  }
  return list.map((t, i) => (i === at ? merged : t))
}

export function basename(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() ?? path
}

export function tildify(path: string, home: string | undefined): string {
  return home && (path === home || path.startsWith(home + '/'))
    ? '~' + path.slice(home.length)
    : path
}

export function expandHome(path: string, home: string | undefined): string {
  return home && (path === '~' || path.startsWith('~/')) ? home + path.slice(1) : path
}

type Place = { path: string; branch?: string }

/**
 * Finds what a /tree-open argument names: a 1-based number into `trees`, or a
 * path, worktree name or branch among `trees` then `others`, exactly, then as
 * a unique substring.
 */
export function matchTarget<A extends Place, B extends Place>(
  query: string,
  trees: readonly A[],
  others: readonly B[],
  home?: string,
): { match?: A | B; ambiguous?: (A | B)[] } {
  if (/^\d+$/.test(query)) {
    const t = trees[Number(query) - 1]
    return t ? { match: t } : {}
  }
  const path = expandHome(query, home).replace(/\/+$/, '')
  const pool: (A | B)[] = [...trees, ...others.filter(o => !trees.some(t => t.path === o.path))]
  const exact = pool.find(
    t => t.path === path || basename(t.path) === query || t.branch === query,
  )
  if (exact) return { match: exact }
  const q = query.toLowerCase()
  const fuzzy = pool.filter(
    t =>
      basename(t.path).toLowerCase().includes(q) ||
      (t.branch ?? '').toLowerCase().includes(q),
  )
  if (fuzzy.length === 1) return { match: fuzzy[0] }
  return fuzzy.length > 1 ? { ambiguous: fuzzy } : {}
}

const SOURCE_TEXT: Record<TreeSource, string> = {
  session: 'session started here',
  enter: 'EnterWorktree',
  agent: 'subagent',
  bash: 'git worktree add',
  pr: 'pull request',
}

export function describeSource(tree: Tree): string {
  return tree.label ? `${SOURCE_TEXT[tree.source]}: ${tree.label}` : SOURCE_TEXT[tree.source]
}

/** Lays rows of cells out as left-aligned columns, two spaces apart. */
export function columns(rows: readonly (readonly string[])[]): string[] {
  const widths: number[] = []
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)))
  return rows.map(row =>
    row
      .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]!)))
      .join('  ')
      .trimEnd(),
  )
}

/** Whether a shell command creates a git worktree. */
export function addsWorktree(command: string): boolean {
  return /\bgit\b[^\n;&|]*\bworktree\s+add\b/.test(command)
}

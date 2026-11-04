import type { PickerItem, Tree, TreeSource } from '../types'

export type Ide = 'idea' | 'code'

export const IDE_NAMES: Record<Ide, string> = {
  idea: 'IntelliJ IDEA',
  code: 'VS Code',
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
  pr: 'PR',
}

export function describeSource(tree: Tree): string {
  const text = SOURCE_TEXT[tree.source]
  if (!tree.label) return text
  return truncate(tree.source === 'pr' ? `${text} ${tree.label}` : `${text}: ${tree.label}`, 60)
}

export function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text
}

/** Claude Code names its subagents' worktrees `agent-<id>`. */
export function isAgentWorktree(path: string): boolean {
  return /^agent-/.test(basename(path))
}

/** One of this session's worktrees, as /trees lists it. */
export type ListedTree = {
  name: string
  branch?: string
  changed: number
  isHere: boolean
  note: string
}

/** A worktree of the repository outside this session's list, most recent first. */
export type OtherTree = { name: string; isMain: boolean; isAgent: boolean }

/** How many of the repository's other worktrees /trees names before summing up the rest. */
export const OTHERS_NAMED = 3

/** The branch, when it says more than the folder's name does; `detached` when there is none. */
export function branchFact(name: string, branch: string | undefined): string | undefined {
  if (!branch) return 'detached'
  return branch === name ? undefined : branch
}

/** The /trees listing as compact markdown: one line a worktree, the rest of the repo summed up. */
export function formatListing(input: {
  repo?: string
  mine: readonly ListedTree[]
  others: readonly OtherTree[]
  ideName: string
}): string {
  const { repo, mine, others, ideName } = input
  const inRepo = repo ? ` · repo \`${repo}\`` : ''
  const out: string[] = []

  if (mine.length === 0) {
    out.push(`**No worktrees in this session yet**${inRepo}`)
  } else {
    out.push(`**${mine.length} worktree${mine.length === 1 ? '' : 's'} in this session**${inRepo}`, '')
    mine.forEach((t, i) => {
      const facts = [
        branchFact(t.name, t.branch),
        t.changed ? `${t.changed} changed` : 'clean',
        t.isHere ? '**you are here**' : undefined,
        t.note,
      ].filter(Boolean)
      out.push(`${i + 1}. \`${t.name}\` · ${facts.join(' · ')}`)
    })
  }

  const agents = others.filter(o => o.isAgent && !o.isMain)
  const rest = others.filter(o => !o.isAgent || o.isMain)
  if (others.length > 0) {
    const parts = rest.slice(0, OTHERS_NAMED).map(o => (o.isMain ? `\`${o.name}\` (main)` : `\`${o.name}\``))
    const more = rest.length - parts.length
    if (more > 0) parts.push(`${more} more`)
    if (agents.length > 0) parts.push(`${agents.length} subagent worktree${agents.length === 1 ? '' : 's'}`)
    out.push('', `Also in this repo: ${joinList(parts)}. \`/trees all\` lists them.`)
  }

  out.push('', `Open one: \`/tree-open <number|name> [idea|code]\` (default: ${ideName})`)
  return out.join('\n')
}

/** `/trees all`: every worktree of the repository, with where it is. */
export function formatAll(input: {
  repo?: string
  all: readonly { name: string; branch?: string; isMain: boolean; where: string; mine?: number; isHere: boolean }[]
}): string {
  const { repo, all } = input
  const out = [`**All ${all.length} worktree${all.length === 1 ? '' : 's'}${repo ? ` of repo \`${repo}\`` : ''}**`, '']
  for (const w of all) {
    const facts = [
      w.isMain ? 'main checkout' : undefined,
      branchFact(w.name, w.branch),
      w.mine ? `session #${w.mine}` : undefined,
      w.isHere ? '**you are here**' : undefined,
      `\`${w.where}\``,
    ].filter(Boolean)
    out.push(`- \`${w.name}\` · ${facts.join(' · ')}`)
  }
  out.push('', 'Open one: `/tree-open <name> [idea|code]`')
  return out.join('\n')
}

/** `a`, `a and b`, `a, b and c`. */
export function joinList(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join('')
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/** Where a worktree is, relative to the main checkout when it lies under it. */
export function whereIs(path: string, mainRoot: string | undefined, home: string | undefined): string {
  if (mainRoot && path !== mainRoot && path.startsWith(mainRoot + '/')) return path.slice(mainRoot.length + 1)
  return tildify(path, home)
}

/**
 * The picker rows the search box lets through: every whitespace-separated word
 * of the query must appear in a row's text, in any order and case.
 */
export function filterItems(items: readonly PickerItem[], query: string): PickerItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return [...items]
  return items.filter(item => words.every(w => item.haystack.includes(w)))
}

/** Whether a shell command creates a git worktree. */
export function addsWorktree(command: string): boolean {
  return /\bgit\b[^\n;&|]*\bworktree\s+add\b/.test(command)
}

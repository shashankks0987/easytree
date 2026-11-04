import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PickerItem, PickerSection, Tree, TreeSource } from '../types'
import {
  IDE_BUNDLES,
  IDE_NAMES,
  type GitWorktree,
  type Ide,
  addsWorktree,
  basename,
  branchFact,
  describeSource,
  filterItems,
  formatAll,
  formatListing,
  isAgentWorktree,
  matchTarget,
  parseIde,
  parsePrRef,
  parseWorktreeList,
  splitArgs,
  tildify,
  upsertTree,
  whereIs,
} from './lib'

type $ = EngineInterface

// Change the tag when Tree's fields change: it declines what an earlier
// version stored, which outlives a reload.
const trees = atom({ plugin: 'easytree', key: 'trees' } as const, [], { shape: 'trees-1' })

// The /trees picker: its rows as it opened, the search text, and the IDE a pick opens in.
const PANE = 'trees'
const pickerItems = atom({ plugin: 'easytree', key: 'pickerItems' } as const, [], { shape: 'picker-1' })
const pickerQuery = atom({ plugin: 'easytree', key: 'pickerQuery' } as const, '')
const pickerIde = atom({ plugin: 'easytree', key: 'pickerIde' } as const, '')
const SECTION_TITLES: Record<PickerSection, string> = {
  session: 'This session',
  repo: 'This repository',
  agents: 'Subagent worktrees',
}

const TOOL = 'open_in_ide'
const PR_DIR = '.claude/worktrees'
const MAX_STORED_SESSIONS = 50

let statusTimer: { cancel: () => void } | undefined

/** The person's settings, set as the module registers (each reload included). */
let defaultIde: Ide = 'idea'
let showStatus = true
/** Where the session was launched, relative to its repository's root (`services/api`, or ''). */
let launchPrefix = ''

export const register: Register = (on, options) => {
  defaultIde = parseIde(String(options.ide ?? 'idea')) ?? 'idea'
  showStatus = options.showStatus !== false

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'trees',
      description: 'List the git worktrees this session and its subagents work in',
      argumentHint: '[all]',
      immediate: true,
    })
    await $.command.register({
      name: 'tree-open',
      description: 'Open a worktree of this session in IntelliJ IDEA or VS Code',
      argumentHint: '[number|name|path] [idea|code]',
      immediate: true,
    })
    await $.command.register({
      name: 'tree-pr',
      description: 'Check out a GitHub pull request into a worktree and open it in your IDE',
      argumentHint: '<number|url> [idea|code]',
      immediate: true,
    })
    await $.tool.register({
      name: TOOL,
      description:
        "Opens a folder as the project root in the user's IDE (IntelliJ IDEA or VS Code) on their Mac. " +
        'Use it when the user asks to open, see or inspect code, a worktree or a PR checkout in their IDE or editor. ' +
        'Leave `path` out to open the git worktree you are working in now, at the folder the session was launched in.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path of a folder to open as is, e.g. a worktree root or a folder inside one.',
          },
          ide: {
            type: 'string',
            enum: ['idea', 'code'],
            description: `idea for IntelliJ IDEA, code for VS Code; default ${defaultIde}.`,
          },
        },
      },
    })
    await restore($)
    launchPrefix = await loadLaunchPrefix($)
    await track($, await $.session.cwd(), 'session')
    scheduleStatus($)
    return started
  })

  // Only the four tools that make or move between worktrees are hooked; every
  // other tool call never reaches this plugin. Each hook passes its call on
  // unchanged and only reads where the worktree is.

  // A Bash `git worktree add`: diff the repo's worktrees around the call.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!addsWorktree(e.command)) return next(e)
    const cwd = await $.session.cwd()
    const before = await safe($, () => listWorktrees($, cwd))
    const ran = await next(e)
    await safe($, async () => {
      const after = await listWorktrees($, cwd)
      const known = new Set((before ?? []).map(w => w.path))
      const label = e.agentId ? await agentLabel($, e.agentId) : undefined
      for (const wt of after) if (!known.has(wt.path)) await track($, wt.path, 'bash', label)
    })
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'EnterWorktree' }, async ($, e, next) => {
    const ran = await next(e)
    const path = worktreePathOf(ran)
    if (path) await safe($, () => track($, path, 'enter'))
    scheduleStatus($)
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'ExitWorktree' }, async ($, e, next) => {
    const ran = await next(e)
    scheduleStatus($)
    return ran
  }).catch(($, e, next) => next(e))

  // An isolated subagent that ran in the foreground reports its worktree.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const ran = await next(e)
    const path = worktreePathOf(ran)
    if (path) await safe($, () => track($, path, 'agent', e.description))
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__easytree__open_in_ide' }, async ($, e) => {
    const input = e as unknown as { path?: unknown; ide?: unknown }
    const ide = (typeof input.ide === 'string' && parseIde(input.ide)) || defaultIde
    if (typeof input.path === 'string' && input.path) return { result: await openIn($, ide, input.path) }
    const cwd = await $.session.cwd()
    return { result: await openTree($, ide, (await gitRoot($, cwd)) ?? cwd) }
  }).catch(() => ({ result: 'easytree could not open the IDE; try /tree-open.' }))

  on('command.run', { command: 'trees' }, async ($, e) => {
    if (/^(--)?all$/i.test(e.args.trim())) return { text: await listText($, true) }
    return { text: (await openPicker($)) ?? (await listText($)) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    // Mobile draws no text field: the list shows unfiltered there.
    const Input = 'Input' in elements ? elements.Input : undefined
    const items = await read($, pickerItems)
    const query = await read($, pickerQuery)
    const ide = parseIde(await read($, pickerIde)) ?? defaultIde
    const shown = filterItems(items, query)
    const pick = (path: string) => async () => {
      const text = await openTree($, ide, path)
      await $.ui.close({ id: PANE })
      $.ui.toast(text)
    }
    const groups = (['session', 'repo', 'agents'] as const)
      .map(section => ({ section, rows: shown.filter(item => item.section === section) }))
      .filter(group => group.rows.length > 0)

    return (
      <Box flexDirection="column">
        {Input && (
          <Input
            key="search"
            placeholder="Search by name, branch or PR…"
            value={query}
            autoFocus
            submitLabel="open first"
            onInput={(value: string) => void update($, pickerQuery, () => value)}
            onSubmit={() => void (shown[0] && pick(shown[0].path)())}
          />
        )}
        <Text dimColor>
          {shown.length} of {items.length} · ↑↓ move · Enter opens · Esc closes
        </Text>
        {groups.map(group => (
          <Box key={`section:${group.section}`} flexDirection="column" marginTop={1}>
            <Text bold>
              {SECTION_TITLES[group.section]} ({group.rows.length})
            </Text>
            {group.rows.map(item => (
              <Button key={`tree:${item.path}`} plain onPress={pick(item.path)}>
                {item.name} <Text dimColor>{item.facts}</Text>
              </Button>
            ))}
          </Box>
        ))}
        {shown.length === 0 && <Text dimColor>No worktree matches "{query}".</Text>}
        <Box marginTop={1}>
          <Button key="ide" onPress={() => void update($, pickerIde, () => (ide === 'idea' ? 'code' : 'idea'))}>
            {`Opens in ${IDE_NAMES[ide]} (press to switch)`}
          </Button>
        </Box>
      </Box>
    )
  })

  // Keep the row the focus moves to in view: the pane's body is a window over the list.
  on('ui.focus', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const moved = await next(e)
    if (e.element) await $.ui.scroll({ in: PANE, to: { key: e.element } }).catch(() => undefined)
    return moved
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'tree-open' }, async ($, e) => {
    const { ide = defaultIde, rest } = splitArgs(e.args)
    const home = await $.env.get('HOME')
    const cwd = await $.session.cwd()
    const live = await liveTrees($)

    if (rest.length > 1) return { text: 'Usage: /tree-open [number|name|path] [idea|code]' }
    const query = rest[0]
    if (query) {
      const others = (await safe($, () => listWorktrees($, cwd))) ?? []
      const { match, ambiguous } = matchTarget(query, live, others, home)
      if (match) return { text: await openTree($, ide, match.path) }
      if (ambiguous) {
        const names = ambiguous.map(t => `  ${basename(t.path)}  ${tildify(t.path, home)}`)
        return { text: [`"${query}" matches several worktrees:`, ...names].join('\n') }
      }
      // Any other directory is opened as it is.
      const dir = query.replace(/^~(?=\/|$)/, home ?? '~')
      const stat = await $.fs.stat(dir).catch(() => undefined)
      if (stat?.kind === 'dir') return { text: await openIn($, ide, dir) }
      return { text: `No worktree matches "${query}". Run /trees to see them.` }
    }

    const here = await worktreeAt($, cwd)
    if (here?.isLinked) return { text: await openTree($, ide, here.root) }
    if (live.length === 1) return { text: await openTree($, ide, live[0]!.path) }
    if (live.length > 1) return { text: (await openPicker($)) ?? (await listText($)) }
    return { text: await openTree($, ide, here?.root ?? cwd) }
  })

  on('command.run', { command: 'tree-pr' }, async ($, e) => {
    const { ide = defaultIde, rest } = splitArgs(e.args)
    const pr = rest.length === 1 ? parsePrRef(rest[0]!) : undefined
    if (!pr) return { text: 'Usage: /tree-pr <number|url> [idea|code]' }
    return { text: await checkoutPr($, pr, ide) }
  })
}

async function listText($: $, all = false): Promise<string> {
  const home = await $.env.get('HOME')
  const cwd = await $.session.cwd()
  const here = await worktreeAt($, cwd)
  const live = await liveTrees($)
  const repoTrees = ((await safe($, () => listWorktrees($, cwd))) ?? []).filter(w => !w.isBare)
  const main = repoTrees.find(w => w.isMain)
  const repo = main ? basename(main.path) : undefined

  if (all) {
    return formatAll({
      repo,
      all: repoTrees.map(w => ({
        name: basename(w.path),
        branch: w.branch,
        isMain: w.isMain,
        where: w.isMain ? tildify(w.path, home) : whereIs(w.path, main?.path, home),
        mine: live.findIndex(t => t.path === w.path) + 1 || undefined,
        isHere: w.path === here?.root,
      })),
    })
  }

  const mine = await Promise.all(
    live.map(async t => ({
      name: basename(t.path),
      branch: t.branch,
      changed: await changedFiles($, t.path),
      isHere: t.path === here?.root,
      note: t.source === 'session' && t.path === here?.root ? '' : describeSource(t),
    })),
  )
  const recency = main ? await branchRecency($, main.path) : new Map<string, number>()
  const others = repoTrees
    .filter(w => !live.some(t => t.path === w.path))
    .sort((a, b) => Number(b.isMain) - Number(a.isMain) || (recency.get(b.branch ?? '') ?? 0) - (recency.get(a.branch ?? '') ?? 0))
    .map(w => ({ name: basename(w.path), isMain: w.isMain, isAgent: isAgentWorktree(w.path) }))
  return formatListing({ repo, mine, others, ideName: IDE_NAMES[defaultIde] })
}

/** Opens the /trees picker over a fresh listing; undefined when no surface can place it. */
async function openPicker($: $): Promise<string | undefined> {
  const items = await buildPickerItems($)
  await update($, pickerItems, () => items)
  await update($, pickerQuery, () => '')
  await update($, pickerIde, () => defaultIde)
  const opened = await $.ui.open({
    id: PANE,
    title: 'Worktrees',
    focus: true,
    closeOnEscape: true,
    holdToasts: true,
    rows: Math.min(items.length + 9, 30),
  })
  if (!opened.isPlaced) return undefined
  return `Opened the worktree picker (${items.length} worktree${items.length === 1 ? '' : 's'}). Type to search, Enter to open.`
}

/** The picker's rows: this session's worktrees, then the repository's, then its subagents'. */
async function buildPickerItems($: $): Promise<PickerItem[]> {
  const cwd = await $.session.cwd()
  const here = await worktreeAt($, cwd)
  const live = await liveTrees($)
  const repoTrees = ((await safe($, () => listWorktrees($, cwd))) ?? []).filter(w => !w.isBare)
  const main = repoTrees.find(w => w.isMain)
  const recency = main ? await branchRecency($, main.path) : new Map<string, number>()
  const item = (path: string, section: PickerSection, facts: (string | undefined)[], branch?: string): PickerItem => {
    const name = basename(path)
    const text = facts.filter(Boolean).join(' · ')
    return { path, name, section, facts: text, haystack: [name, branch, text, path].join(' ').toLowerCase() }
  }

  const mine = await Promise.all(
    live.map(async t => {
      const changed = await changedFiles($, t.path)
      const isHere = t.path === here?.root
      return item(t.path, 'session', [
        branchFact(basename(t.path), t.branch),
        changed ? `${changed} changed` : 'clean',
        isHere ? 'you are here' : undefined,
        t.source === 'session' && isHere ? undefined : describeSource(t),
      ], t.branch)
    }),
  )
  const others = repoTrees
    .filter(w => !live.some(t => t.path === w.path))
    .sort((a, b) => Number(b.isMain) - Number(a.isMain) || (recency.get(b.branch ?? '') ?? 0) - (recency.get(a.branch ?? '') ?? 0))
    .map(w =>
      item(w.path, isAgentWorktree(w.path) && !w.isMain ? 'agents' : 'repo', [
        w.isMain ? 'main checkout' : undefined,
        branchFact(basename(w.path), w.branch),
        w.path === here?.root ? 'you are here' : undefined,
      ], w.branch),
    )
  return [...mine, ...others]
}

/** Each local branch's last commit time (unix seconds), to put recent worktrees first. */
async function branchRecency($: $, repo: string): Promise<Map<string, number>> {
  const r = await git($, ['for-each-ref', '--format=%(committerdate:unix) %(refname:short)', 'refs/heads'], repo).catch(() => undefined)
  const out = new Map<string, number>()
  for (const line of r?.exitCode === 0 ? r.stdout.split('\n') : []) {
    const at = line.indexOf(' ')
    if (at > 0) out.set(line.slice(at + 1), Number(line.slice(0, at)))
  }
  return out
}

async function checkoutPr($: $, pr: number, ide: Ide): Promise<string> {
  const home = await $.env.get('HOME')
  const cwd = await $.session.cwd()
  const all = await safe($, () => listWorktrees($, cwd))
  const main = all?.find(w => w.isMain)
  if (!main) return `${tildify(cwd, home)} is not in a git repository.`
  const remote = await pickRemote($, main.path)
  if (!remote) return 'This repository has no remote to fetch the pull request from.'

  const branch = `pr-${pr}`
  const title = await prTitle($, main.path, pr)
  const label = title ? `#${pr} ${title}` : `#${pr}`
  const existing = all!.find(w => w.branch === branch)
  let note = ''

  if (existing) {
    // Bring the worktree up to the PR's head when that is a fast-forward.
    const fetched = await git($, ['fetch', remote, `pull/${pr}/head`], existing.path, 120_000)
    if (fetched.exitCode !== 0) {
      note = ` Could not fetch the latest: ${firstLine(fetched.stderr)}`
    } else if ((await changedFiles($, existing.path)) > 0) {
      note = ' It has local changes, so it was left as it is.'
    } else {
      const ff = await git($, ['merge', '--ff-only', 'FETCH_HEAD'], existing.path)
      note = ff.exitCode === 0 ? ' Updated to the PR head.' : ' It has diverged from the PR head, so it was left as it is.'
    }
    await track($, existing.path, 'pr', label)
    return `PR ${label} is already checked out.${note}\n${await openTree($, ide, existing.path)}`
  }

  const dest = `${main.path}/${PR_DIR}/${branch}`
  const fetched = await git($, ['fetch', remote, `+pull/${pr}/head:${branch}`], main.path, 120_000)
  if (fetched.exitCode !== 0) return `Could not fetch PR #${pr} from ${remote}: ${firstLine(fetched.stderr)}`
  const added = await git($, ['worktree', 'add', dest, branch], main.path, 120_000)
  if (added.exitCode !== 0) return `Could not create the worktree: ${firstLine(added.stderr)}`
  await safe($, () => excludeLocally($, main.path, `/${PR_DIR}/`))
  await track($, dest, 'pr', label)
  return `Checked out PR ${label} into ${tildify(dest, home)} (branch ${branch}).\n${await openTree($, ide, dest)}`
}

/** Records `dir`'s worktree when it is a linked one (not the main checkout). */
async function track($: $, dir: string, source: TreeSource, label?: string): Promise<void> {
  const at = await worktreeAt($, dir)
  if (!at?.isLinked) return
  const tree: Tree = { path: at.root, branch: at.branch, source, label, addedAt: Date.now() }
  await update($, trees, list => upsertTree(list, tree))
  await persist($)
  scheduleStatus($)
}

/** The tracked trees still on disk, their branches refreshed; the rest are dropped. */
async function liveTrees($: $): Promise<Tree[]> {
  const list = await read($, trees)
  const checked = await Promise.all(list.map(async t => ({ t, at: await worktreeAt($, t.path) })))
  const live = checked
    .filter(({ t, at }) => at?.root === t.path)
    .map(({ t, at }) => ({ ...t, branch: at!.branch }))
  if (live.length !== list.length || live.some((t, i) => t.branch !== list[i]?.branch)) {
    await update($, trees, () => live)
    await persist($)
  }
  return live
}

/** Coalesces status refreshes; a timer reads the main session's directory, not a subagent's. */
function scheduleStatus($: $): void {
  statusTimer?.cancel()
  statusTimer = $.clock.after(150, () => void safe($, () => refreshStatus($)))
}

async function refreshStatus($: $): Promise<void> {
  if (!showStatus) return $.ui.status(undefined)
  const here = await worktreeAt($, await $.session.cwd())
  const others = (await liveTrees($)).filter(t => t.path !== here?.root).length
  const parts: string[] = []
  if (here?.isLinked) {
    const name = basename(here.root)
    parts.push(`⎇ ${name}${here.branch && here.branch !== name ? ` (${here.branch})` : ''}`)
  }
  if (others > 0) parts.push(`${parts.length ? '+' : '⎇ '}${others} worktree${others === 1 ? '' : 's'}`)
  $.ui.status(parts.length ? `${parts.join(' · ')} · /tree-open` : undefined)
}

// --- Persistence: $.state is the session's; $.store keeps it for --resume ---

async function storeKey($: $): Promise<string> {
  return `session:${await $.session.id()}`
}

async function persist($: $): Promise<void> {
  await $.store.set(await storeKey($), await read($, trees))
  await pruneStore($, 'session:')
}

/** Keeps the newest MAX_STORED_SESSIONS keys under `prefix`. */
async function pruneStore($: $, prefix: string): Promise<void> {
  const keys = (await $.store.keys()).filter(k => k.startsWith(prefix))
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_STORED_SESSIONS))) await $.store.delete(old)
}

/**
 * The launch folder relative to its repository's root, read once per session
 * and kept: later the session may sit in a worktree, whose prefix is its own.
 */
async function loadLaunchPrefix($: $): Promise<string> {
  const key = `launch:${await $.session.id()}`
  const stored = await $.store.get(key)
  if (typeof stored === 'string') return stored
  const r = await git($, ['rev-parse', '--show-prefix'], await $.session.cwd()).catch(() => undefined)
  const prefix = r?.exitCode === 0 ? r.stdout.trim().replace(/\/+$/, '') : ''
  await $.store.set(key, prefix)
  await pruneStore($, 'launch:')
  return prefix
}

async function restore($: $): Promise<void> {
  if ((await read($, trees)).length > 0) return
  const stored = await $.store.get(await storeKey($))
  if (Array.isArray(stored) && stored.length > 0) await update($, trees, () => stored as Tree[])
}

// --- git and the IDEs ---

async function git($: $, args: string[], cwd: string, timeoutMs = 15_000) {
  return $.process.run(['git', ...args], { cwd, timeoutMs })
}

async function gitRoot($: $, dir: string): Promise<string | undefined> {
  return (await worktreeAt($, dir))?.root
}

/** The worktree holding `dir`: its root, whether it is a linked worktree, and its branch. */
async function worktreeAt(
  $: $,
  dir: string,
): Promise<{ root: string; isLinked: boolean; branch?: string } | undefined> {
  const r = await git(
    $,
    ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir', '--abbrev-ref', 'HEAD'],
    dir,
  ).catch(() => undefined)
  if (!r || r.exitCode !== 0) return undefined
  const [root, gitDir, commonDir, head] = r.stdout.trim().split('\n')
  if (!root) return undefined
  return { root, isLinked: gitDir !== commonDir, branch: head && head !== 'HEAD' ? head : undefined }
}

async function listWorktrees($: $, dir: string): Promise<GitWorktree[]> {
  const r = await git($, ['worktree', 'list', '--porcelain'], dir)
  return r.exitCode === 0 ? parseWorktreeList(r.stdout) : []
}

async function changedFiles($: $, dir: string): Promise<number> {
  const r = await git($, ['status', '--porcelain'], dir).catch(() => undefined)
  return r?.exitCode === 0 ? r.stdout.split('\n').filter(Boolean).length : 0
}

async function pickRemote($: $, dir: string): Promise<string | undefined> {
  const r = await git($, ['remote'], dir)
  const remotes = r.exitCode === 0 ? r.stdout.split('\n').filter(Boolean) : []
  return remotes.includes('origin') ? 'origin' : remotes[0]
}

/** The PR's title through `gh` when it is installed and signed in; undefined otherwise. */
async function prTitle($: $, dir: string, pr: number): Promise<string | undefined> {
  const r = await $.process
    .run(['gh', 'pr', 'view', String(pr), '--json', 'title', '--jq', '.title'], { cwd: dir, timeoutMs: 10_000 })
    .catch(() => undefined)
  return r?.exitCode === 0 ? r.stdout.trim() || undefined : undefined
}

/** Adds a pattern to the repo's .git/info/exclude, so PR worktrees never show as untracked. */
async function excludeLocally($: $, repo: string, pattern: string): Promise<void> {
  const r = await git($, ['rev-parse', '--path-format=absolute', '--git-common-dir'], repo)
  if (r.exitCode !== 0) return
  const file = `${r.stdout.trim()}/info/exclude`
  const text = await $.fs.read(file).catch(() => '')
  if (text.split('\n').includes(pattern)) return
  await $.fs.write(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${pattern}\n`)
}

/** Opens a worktree at the folder the session was launched in, when the worktree has it; else at its root. */
async function openTree($: $, ide: Ide, root: string): Promise<string> {
  if (!launchPrefix) return openIn($, ide, root)
  const dir = `${root}/${launchPrefix}`
  const stat = await $.fs.stat(dir).catch(() => undefined)
  return openIn($, ide, stat?.kind === 'dir' ? dir : root)
}

/** Opens `path` in the IDE through its macOS bundle id; answers what happened, for the person. */
async function openIn($: $, ide: Ide, path: string): Promise<string> {
  const home = await $.env.get('HOME')
  let lastError = ''
  for (const bundle of IDE_BUNDLES[ide]) {
    const r = await $.process.run(['/usr/bin/open', '-b', bundle, path]).catch(() => undefined)
    if (r?.exitCode === 0) return `Opened ${tildify(path, home)} in ${IDE_NAMES[ide]}.`
    lastError = firstLine(r?.stderr ?? '')
  }
  return `Could not open ${IDE_NAMES[ide]} (${lastError || 'not installed?'}). Path: ${tildify(path, home)}`
}

async function agentLabel($: $, agentId: string): Promise<string | undefined> {
  const agents = await $.agent.list().catch(() => [])
  return agents.find(a => a.id === agentId)?.description
}

/** The `worktreePath` an EnterWorktree or Agent result carries, when the call succeeded. */
function worktreePathOf(ran: { deny?: string; isError?: true; result?: unknown }): string | undefined {
  if (ran.deny !== undefined || ran.isError) return undefined
  const path = (ran.result as { worktreePath?: unknown } | undefined)?.worktreePath
  return typeof path === 'string' ? path : undefined
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? ''
}

/** Runs bookkeeping that must never break the call it rides on. */
async function safe<T>($: $, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn()
  } catch (err) {
    $.ui.log(`easytree: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
    return undefined
  }
}

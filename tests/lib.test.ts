import { expect, test } from 'claude-code/testing'

import {
  addsWorktree,
  formatListing,
  matchTarget,
  parsePrRef,
  parseWorktreeList,
  splitArgs,
  tildify,
  upsertTree,
} from '../hooks/lib'

const PORCELAIN = `worktree /Users/me/app
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main

worktree /Users/me/app/.claude/worktrees/feat-login
HEAD 2222222222222222222222222222222222222222
branch refs/heads/feat/login

worktree /Users/me/app/.claude/worktrees/agent-a1b2
HEAD 3333333333333333333333333333333333333333
detached

worktree /Users/me/app/.claude/worktrees/pr-42
HEAD 4444444444444444444444444444444444444444
branch refs/heads/pr-42
prunable gitdir file points to non-existent location
`

test('parses git worktree list --porcelain', async () => {
  const list = parseWorktreeList(PORCELAIN)
  expect(list.map(w => w.path)).toEqual([
    '/Users/me/app',
    '/Users/me/app/.claude/worktrees/feat-login',
    '/Users/me/app/.claude/worktrees/agent-a1b2',
    '/Users/me/app/.claude/worktrees/pr-42',
  ])
  expect(list[0]!.isMain).toBe(true)
  expect(list[1]!.isMain).toBe(false)
  expect(list[1]!.branch).toBe('feat/login')
  expect(list[2]!.branch).toBe(undefined)
  expect(list[3]!.isPrunable).toBe(true)
})

test('reads PR numbers and URLs', async () => {
  expect(parsePrRef('123')).toBe(123)
  expect(parsePrRef('#123')).toBe(123)
  expect(parsePrRef('pr-123')).toBe(123)
  expect(parsePrRef('https://github.com/acme/app/pull/987')).toBe(987)
  expect(parsePrRef('https://github.com/acme/app/pull/987/files')).toBe(987)
  expect(parsePrRef('abc')).toBe(undefined)
  expect(parsePrRef('0')).toBe(undefined)
})

test('splits the IDE word from the target, in any order', async () => {
  expect(splitArgs('2 code')).toEqual({ ide: 'code', rest: ['2'] })
  expect(splitArgs('intellij feat-login')).toEqual({ ide: 'idea', rest: ['feat-login'] })
  expect(splitArgs('  ')).toEqual({ ide: undefined, rest: [] })
})

test('matches a target by number, name, branch, path and unique substring', async () => {
  const all = parseWorktreeList(PORCELAIN)
  const mine = all.slice(1, 3)
  const others = all
  expect(matchTarget('1', mine, others).match?.path).toBe(mine[0]!.path)
  expect(matchTarget('3', mine, others).match).toBe(undefined)
  expect(matchTarget('pr-42', mine, others).match?.path).toBe(all[3]!.path)
  expect(matchTarget('feat/login', mine, others).match?.path).toBe(mine[0]!.path)
  expect(matchTarget('~/app/', mine, others, '/Users/me').match?.path).toBe('/Users/me/app')
  expect(matchTarget('login', mine, others).match?.path).toBe(mine[0]!.path)
  expect(matchTarget('a', mine, others).ambiguous?.length).toBeGreaterThan(1)
  expect(matchTarget('nope', mine, others)).toEqual({})
})

test('upserts a tree by path, keeping its first source and label', async () => {
  const a = { path: '/w/a', source: 'agent' as const, label: 'Refactor', addedAt: 1 }
  const list = upsertTree(upsertTree([], a), { path: '/w/a', branch: 'x', source: 'bash' as const, addedAt: 2 })
  expect(list).toEqual([{ ...a, branch: 'x' }])
  expect(upsertTree(list, { path: '/w/b', source: 'pr' as const, addedAt: 3 }).length).toBe(2)
})

test('spots git worktree add in a shell command', async () => {
  expect(addsWorktree('git worktree add ../x -b x')).toBe(true)
  expect(addsWorktree('cd repo && git -C . worktree add /tmp/y main')).toBe(true)
  expect(addsWorktree('git worktree list')).toBe(false)
  expect(addsWorktree('echo worktree add')).toBe(false)
})

test('shortens paths under home', async () => {
  expect(tildify('/Users/me/app', '/Users/me')).toBe('~/app')
  expect(tildify('/Users/meow', '/Users/me')).toBe('/Users/meow')
})

test('keeps /trees short when the repo has many worktrees', async () => {
  const others = [
    { name: 'app', isMain: true, isAgent: false },
    ...['spike', 'wip', 'old', 'older', 'oldest'].map(name => ({ name, isMain: false, isAgent: false })),
    ...Array.from({ length: 21 }, (_, i) => ({ name: `agent-${i}`, isMain: false, isAgent: true })),
  ]
  const text = formatListing({
    repo: 'app',
    mine: [
      { name: 'feat-login', branch: 'feat/login', changed: 3, isHere: true, note: '' },
      { name: 'pr-42', branch: 'pr-42', changed: 0, isHere: false, note: 'PR #42 Fix login' },
    ],
    others,
    ideName: 'IntelliJ IDEA',
  })
  expect(text.split('\n').length).toBeLessThan(10)
  expect(text).toContain('1. `feat-login` · feat/login · 3 changed · **you are here**')
  expect(text).toContain('2. `pr-42` · clean · PR #42 Fix login')
  expect(text).toContain('Also in this repo: `app` (main), `spike`, `wip`, 3 more and 21 subagent worktrees.')
})

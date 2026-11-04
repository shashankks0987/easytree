import { expect, test } from 'claude-code/testing'

import type { PickerItem } from '../types'

const PANE = {
  plugin: 'easytree',
  component: 'Pane',
  requestId: 'trees',
  props: {
    title: 'Worktrees',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const row = (path: string, section: PickerItem['section'], facts: string): PickerItem => {
  const name = path.split('/').pop()!
  return { path, name, section, facts, haystack: [name, facts, path].join(' ').toLowerCase() }
}

const ITEMS: PickerItem[] = [
  row('/w/feat-login', 'session', 'feat/login · 3 changed · you are here'),
  row('/w/pr-42', 'session', 'clean · PR #42 Fix redirect'),
  row('/w/app', 'repo', 'main checkout · main'),
  row('/w/agent-a1', 'agents', 'detached'),
]

test('the picker lists worktrees by section and filters as you type', async ($, on) => {
  // The rows as /trees stored them; every other value comes from the kit's own state.
  on('state.get', ($, e, next) =>
    e.key === 'pickerItems'
      ? { value: { value: { shape: 'picker-1', value: ITEMS }, version: 1 } }
      : next(e),
  )

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect((await ui.find({ type: 'Text', text: /^This session \(2\)/ }))).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^Subagent worktrees \(1\)/ }))).toBeDefined()
    expect(await ui.find({ key: 'tree:/w/app' })).toBeDefined()

    await ui.input({ key: 'search', text: 'pr 42', kind: 'change' })
    expect(await ui.find({ key: 'tree:/w/pr-42' })).toBeDefined()
    expect(await ui.find({ key: 'tree:/w/feat-login' })).toBe(undefined)
    expect((await ui.find({ type: 'Text', text: /^1 of 4/ }))).toBeDefined()

    await ui.input({ key: 'search', text: 'nothing-matches', kind: 'change' })
    expect((await ui.find({ type: 'Text', text: /No worktree matches/ }))).toBeDefined()

    await ui.input({ key: 'search', text: '', kind: 'change' })
    await ui.unmount()
  }
})

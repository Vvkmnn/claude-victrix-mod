import { expect, test } from 'claude-code/testing'

import { arrange, assumptionKey, fit, itemKey, itemNamed, nowItem, outline, parsePlan, sectionKey, tally } from './plan'

const PLAN = [
  '# Vada: follow the plan live',
  '',
  '**Progress: 2/14 done** | Active: V1',
  '',
  '## Summary',
  '',
  'Plans get too big to read. Vada walks them live. The scary part is confidence without accuracy.',
  '',
  '## Done',
  '',
  '- [x] **V0 Repo** — files in place',
  '- [x] ~~**A5 Lens**~~ — moved up as V1',
  '',
  '## In Progress',
  '',
  '- [ ] **V1 The live lens** — port the pane · why: plans are hard to follow · trade: fullscreen to dock · judge: a 30 KB plan reads in one screen',
  '  - Context, owner words (not a checkbox, ignored)',
  '  - [x] **Parser** — reads tags',
  '  - [ ] **Panel** — promos should never exceed the price · assume: prices are in cents',
  '    - [ ] deeper step',
  '',
  '## Up Next',
  '',
  '- [ ] **V2 Bench** — probably needs node and python',
  '',
  '---',
  '',
  '## Detail: V1',
  '',
  'Prose only, no checkboxes.',
].join('\n')

test('reads title, progress, summary and only the sections that hold checkboxes', () => {
  const tree = parsePlan(PLAN)

  expect(tree.title).toBe('Vada: follow the plan live')
  expect(tree.progress).toBe('2/14 done')
  expect(tree.summary).toBe('Plans get too big to read. Vada walks them live. The scary part is confidence without accuracy.')
  expect(tree.sections.map(section => section.title)).toEqual(['Done', 'In Progress', 'Up Next'])
})

test('falls back to Context for the summary, and to none', () => {
  expect(parsePlan('## Context\n\nFix the race.\n\n## Up Next\n- [ ] **a**').summary).toBe('Fix the race.')
  expect(parsePlan('## Up Next\n- [ ] **a**').summary).toBeUndefined()
})

test('splits the bold name from the note and marks done and abandoned', () => {
  const [first, second] = parsePlan(PLAN).sections[0]?.items ?? []

  expect(first).toMatchObject({ name: 'V0 Repo', note: 'files in place', isDone: true, isAbandoned: false, line: 11 })
  expect(second).toMatchObject({ name: 'A5 Lens', note: 'moved up as V1', isDone: true, isAbandoned: true })
})

test('reads why, trade and judge tags out of the note and leaves the plain words', () => {
  const [lens] = parsePlan(PLAN).sections[1]?.items ?? []

  expect(lens).toMatchObject({
    name: 'V1 The live lens',
    note: 'port the pane',
    why: 'plans are hard to follow',
    trade: 'fullscreen to dock',
    judge: 'a 30 KB plan reads in one screen',
    assumptions: [],
  })
})

test('an assume: tag and wording that assumes become that step\'s assumptions', () => {
  const panel = parsePlan(PLAN).sections[1]?.items[0]?.children[1]
  const bench = parsePlan(PLAN).sections[2]?.items[0]

  expect(panel?.assumptions).toEqual(['prices are in cents', 'promos should never exceed the price'])
  expect(panel?.note).toBe('promos should never exceed the price')
  expect(bench?.assumptions).toEqual(['probably needs node and python'])
})

test('nests checkbox children by indent and skips plain bullets', () => {
  const [lens] = parsePlan(PLAN).sections[1]?.items ?? []

  expect(lens?.children.map(child => child.name)).toEqual(['Parser', 'Panel'])
  expect(lens?.children[1]?.children.map(child => child.name)).toEqual(['deeper step'])
})

test('now is the first open item under In Progress', () => {
  expect(nowItem(parsePlan(PLAN))?.name).toBe('V1 The live lens')
})

test('now falls back to the first open item anywhere when In Progress is missing or done', () => {
  const plan = ['## Done', '- [x] **a**', '## Up Next', '- [ ] **b** — next'].join('\n')

  expect(nowItem(parsePlan(plan))?.name).toBe('b')
})

test('now is undefined when every item is done or abandoned', () => {
  const plan = ['## Done', '- [x] **a**', '- [x] ~~**b**~~ — dropped'].join('\n')

  expect(nowItem(parsePlan(plan))).toBeUndefined()
})

test('tally counts every depth: done, open, abandoned, and assumptions on open steps only', () => {
  expect(tally(parsePlan(PLAN))).toEqual({ done: 2, open: 4, abandoned: 1, assumed: 3 })
})

test('itemNamed finds a step at any depth, or nothing', () => {
  const tree = parsePlan(PLAN)

  expect(itemNamed(tree, 'deeper step')?.line).toBe(20)
  expect(itemNamed(tree, 'nope')).toBeUndefined()
})

test('a plan without title, progress or sections parses empty, never throws', () => {
  expect(parsePlan('')).toEqual({ title: undefined, progress: undefined, summary: undefined, sections: [] })
  expect(parsePlan('- [ ] **orphan** before any heading')).toEqual({ title: undefined, progress: undefined, summary: undefined, sections: [] })
})

test('accepts CRLF, tabs, star bullets, capital X and unbolded items', () => {
  const plan = '## In Progress\r\n* [X] plain done\r\n* [ ] **b**\r\n\t- [ ] tabbed child\r\n'
  const items = parsePlan(plan).sections[0]?.items ?? []

  expect(items.map(item => [item.name, item.isDone])).toEqual([['plain done', true], ['b', false]])
  expect(items[1]?.children.map(child => child.name)).toEqual(['tabbed child'])
})

test('a child indented deeper than its section start still nests under the shallowest item', () => {
  const plan = ['## In Progress', '  - [ ] **indented top**', '      - [ ] **far child**'].join('\n')
  const [top] = parsePlan(plan).sections[0]?.items ?? []

  expect(top?.name).toBe('indented top')
  expect(top?.children.map(child => child.name)).toEqual(['far child'])
})

test('a bold name written with a trailing colon drops the colon', () => {
  const [item] = parsePlan('## Up Next\n- [ ] **2a Outline:** parse the plan').sections[0]?.items ?? []

  expect(item).toMatchObject({ name: '2a Outline', note: 'parse the plan' })
})

const labels = (toggled: readonly string[] = []) =>
  outline(parsePlan(PLAN), toggled).map(row => `${'.'.repeat(row.depth)}${row.label}${row.isOpen ? ' -' : row.isFoldable ? ' +' : ''}`)

test('outline opens In Progress and the item being worked, folds the rest to one line', () => {
  expect(labels()).toEqual([
    'Done +',
    'In Progress -',
    '.V1 The live lens -',
    '..Parser',
    '..Panel +',
    'Up Next +',
  ])
})

test('the assumptions of the step being worked show under it as rows tied to that step', () => {
  const plan = ['## In Progress', '- [ ] **Panel** — promos should never exceed the price · assume: prices are in cents'].join('\n')
  const tree = parsePlan(plan)
  const rows = outline(tree, [])
  const panel = tree.sections[0]?.items[0]

  expect(rows.map(row => [row.kind, row.label, row.step])).toEqual([
    ['section', 'In Progress', 'In Progress'],
    ['item', 'Panel', 'Panel'],
    ['assumption', 'prices are in cents', 'Panel'],
    ['assumption', 'promos should never exceed the price', 'Panel'],
  ])
  expect(rows[2]?.key).toBe(panel ? assumptionKey(panel, 0) : '')
  expect(rows[1]).toMatchObject({ mark: 'now', isFoldable: true, isOpen: true })
})

test('a step not being worked keeps its assumptions out of the outline', () => {
  const rows = outline(parsePlan(PLAN), [sectionKey('Up Next')])

  expect(rows.filter(row => row.kind === 'assumption')).toEqual([])
})

test('outline marks the item being worked and counts what a folded row holds', () => {
  const rows = outline(parsePlan(PLAN), [])

  expect(rows.filter(row => row.isNow).map(row => row.label)).toEqual(['V1 The live lens'])
  expect(rows.find(row => row.label === 'Done')).toMatchObject({ kind: 'section', count: 2, isOpen: false })
  expect(rows.find(row => row.label === 'Parser')).toMatchObject({ mark: 'done' })
  expect(rows.find(row => row.label === 'Panel')).toMatchObject({ mark: 'open' })
})

test('a toggled key flips its default: folded opens, open folds', () => {
  const tree = parsePlan(PLAN)
  const panel = tree.sections[1]?.items[0]?.children[1]
  const toggled = [sectionKey('Done'), sectionKey('In Progress'), ...(panel ? [itemKey(panel)] : [])]

  expect(labels(toggled)).toEqual([
    'Done -',
    '.V0 Repo',
    '.A5 Lens',
    'In Progress +',
    'Up Next +',
  ])
  expect(labels([sectionKey('Up Next')]).slice(-2)).toEqual(['Up Next -', '.V2 Bench'])
})

test('an item opened inside a folded parent stays hidden until the parent opens', () => {
  const tree = parsePlan(PLAN)
  const lens = tree.sections[1]?.items[0]
  const panel = lens?.children[1]
  const both = [...(lens ? [itemKey(lens)] : []), ...(panel ? [itemKey(panel)] : [])]

  expect(labels(both)).toEqual(['Done +', 'In Progress -', '.V1 The live lens +', 'Up Next +'])
})

test('arrange puts open sections first and gathers folded section heads onto the tray', () => {
  const { body, tray } = arrange(outline(parsePlan(PLAN), []))

  expect(body.map(row => row.label)).toEqual(['In Progress', 'V1 The live lens', 'Parser', 'Panel'])
  expect(tray.map(row => row.label)).toEqual(['Done', 'Up Next'])
})

test('fit keeps a line that fits and cuts a longer one to the cell count with an ellipsis', () => {
  expect(fit('short', 10)).toBe('short')
  expect(fit('exactly10!', 10)).toBe('exactly10!')
  expect(fit('a much longer line', 10)).toBe('a much lo…')
  expect(fit('▾ ◉ Lens and more', 8)).toBe('▾ ◉ Len…')
  expect(fit('anything', 0)).toBe('…')
})

test('outline of an empty plan is empty', () => {
  expect(outline(parsePlan(''), [])).toEqual([])
})

test('a 40 KB plan parses every item', () => {
  const rows = Array.from({ length: 800 }, (_, n) => `- [ ] **item ${n}** — ${'x'.repeat(40)}`)
  const tree = parsePlan(['## Up Next', ...rows].join('\n'))

  expect(tree.sections[0]?.items).toHaveLength(800)
  expect(tree.sections[0]?.items[799]?.name).toBe('item 799')
})

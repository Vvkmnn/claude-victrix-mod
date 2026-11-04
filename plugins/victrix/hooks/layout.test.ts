import { expect, test } from 'claude-code/testing'

import type { Activity, Claim } from '../types'
import { EMPTY_ACTIVITY } from './activity'
import { isInDictionary, layout, meetLine, rowWidth, statusWord, unit } from './layout'
import { parsePlan } from './plan'

const PLAN = parsePlan(
  [
    '# Brave otter',
    '## Done',
    '- [x] **Crab** — band',
    '- [x] **Gull** — wing',
    '## In Progress',
    '- [ ] **Lens** — the outline · facts: claude: prices are in cents · facts: code: ids are dense · verify: bun test',
    '## Up Next',
    '- [ ] **Gaits**',
    '- [ ] **Ship**',
    '- [ ] **Bench**',
  ].join('\n'),
)

const NOW = 1_700_000_000_000

const spent: Activity = {
  ...EMPTY_ACTIVITY,
  doing: 'edit lens.tsx',
  stepNow: 'Lens',
  steps: { Crab: { calls: 3, fails: 0, tokens: 1200, enteredAt: 0, ms: 8000 }, Lens: { calls: 92, fails: 2, tokens: 12400, enteredAt: NOW - 47 * 60_000, ms: 0 } },
  last: [
    { text: 'edit lens.tsx', isOk: true, at: NOW - 1000, ms: 7000 },
    { text: 'run bun test', isOk: false, at: NOW - 2000 },
    { text: 'exitplanmode', isOk: false, isDeclined: true, at: NOW - 3000 },
    { text: 'read tape.tsx', isOk: true, at: NOW - 4000 },
  ],
}

const claims: Claim[] = [{ step: 'Lens', says: 'ids are dense', status: 'checked', source: 'tool', at: NOW, evidence: { kind: 'test', command: 'bun test', exitCode: 0, ms: 3000, tail: '' } }]

const input = (columns: number, rows: number) => ({ columns, rows, tree: PLAN, claims, spent, now: NOW, tick: 3, isCalling: true, isWorking: true, recent: [] })

const text = (rows: ReturnType<typeof layout>) => rows.map(one => one.spans.map(part => part.text).join('')).join('\n')

for (const columns of [10, 12, 24, 30, 40, 50, 60, 66, 100]) {
  test(`layout at ${columns} columns: no row wider than the pane, the box and the live step always there, every glyph in the dictionary`, () => {
    const rows = layout(input(columns, 30))
    for (const one of rows) expect(rowWidth(one)).toBeLessThanOrEqual(columns)
    expect(rows.length).toBeLessThanOrEqual(30)
    const drawn = text(rows)
    expect(drawn).toContain('╭─────╮')
    expect(drawn).toContain('│ -_- ')
    expect(drawn).toContain('╰──┰──╯')
    expect(drawn).toContain('▶')
    expect(drawn).toContain('47m')
    expect(isInDictionary(rows)).toBe(true)
  })
}

test('the box joints exist only with their lines: no ┝ without a bar after it', () => {
  const narrow = text(layout(input(10, 30)))
  expect(narrow).toContain('│ -_- │')
  expect(narrow).not.toContain('┝')
  const wide = text(layout(input(66, 30)))
  expect(wide).toContain('│ -_- ┝━')
})

test('the spine is green through done steps, orange at the live one, and absent below it', () => {
  const rows = layout(input(66, 30))
  const done = rows.find(one => one.key === 'step:Crab')
  const live = rows.find(one => one.key === 'step:Lens')
  const open = rows.find(one => one.key === 'step:Gaits')
  expect(done?.spans.find(part => part.text === '┃')?.paint).toBe('good')
  expect(live?.spans.find(part => part.text === '┃')?.paint).toBe('live')
  expect(open?.spans.some(part => part.text === '┃')).toBe(false)
})

test('the live bar is a progress bar when the step has facts, labelled in words, and an effort bar when it has none', () => {
  const withFacts = text(layout(input(66, 30)))
  expect(withFacts).toContain('1/2 checked')
  expect(withFacts).toContain('92 calls · 2 failed')
  const bare = parsePlan(['## In Progress', '- [ ] **Lens** — the outline'].join('\n'))
  const effort = layout({ ...input(66, 30), tree: bare, claims: [] })
  const bar = effort.find(one => one.key === 'live:bar')
  expect(bar?.spans[1]?.text).toBe('┗')
  expect(text([bar!])).toContain('92 calls · 2 failed')
  expect(text([bar!])).not.toContain('/')
})

test('every number carries a unit, short when narrow and a word when wide', () => {
  expect(unit(92, 'c', 'call', 24)).toBe('92c')
  expect(unit(92, 'c', 'call', 40)).toBe('92 calls')
  const narrow = text(layout(input(24, 30)))
  expect(narrow).toContain('92c')
  expect(narrow).not.toMatch(/ 92\b(?!c)/)
})

test('proof draws the meet in notation and each fact with its glyph and one word', () => {
  const drawn = text(layout(input(66, 30)))
  expect(drawn).toContain('Lens ⊑ ⊓ {')
  expect(drawn).toContain('} = △')
  expect(drawn).toContain('△ prices are in cents')
  expect(drawn).toContain('unchecked')
  expect(drawn).toContain('■ ids are dense')
  expect(drawn).toContain('⊢ bun test')
  expect(statusWord(claims[0]!)).toBe('⊢ bun test')
  expect(meetLine('Lens', [], 66)).toBe('Lens ⊑ ⊓ { ∅ } = △')
})

test('doing shows the live call first, then the newest actions, and a decline as a decline, never red', () => {
  const rows = layout(input(66, 30))
  const now = rows.find(one => one.key === 'doing:now')
  expect(text([now!])).toContain('edit lens.tsx')
  expect(now?.spans.at(-1)?.paint).toBe('live')
  const declined = rows.find(one => text([one]).includes('exitplanmode'))
  expect(text([declined!])).toContain('declined by you')
  expect(declined?.spans.every(part => part.paint !== 'bad')).toBe(true)
  const failed = rows.find(one => text([one]).includes('run bun test'))
  expect(failed?.spans.some(part => part.paint === 'bad')).toBe(true)
})

test('no plan: the box says so, the recent plans are offered, the footer stays', () => {
  const rows = layout({ ...input(40, 20), tree: null, claims: [], recent: [{ title: 'Brave otter', path: '/p/brave-otter.md' }] })
  const drawn = text(rows)
  expect(drawn).toContain('no plan yet')
  expect(drawn).toContain('○ Brave otter')
  expect(rows.at(-1)?.press?.kind).toBe('help')
  expect(isInDictionary(rows)).toBe(true)
})

// The owner's law (2026-11-05): a smaller view never holds more data or elements than a larger sibling, in width or in
// height; views evolve, they never jump. Measured on element keys: a fold row (`…more`) stands for less, not more.
const BIG = parsePlan(
  [
    '# A forty-step plan',
    '## Done',
    ...Array.from({ length: 12 }, (_, n) => `- [x] **Step ${n + 1}** — done`),
    '## In Progress',
    '- [ ] **Step 13** — live · facts: claude: the cache is warm · facts: data: the seed has rows · facts: claude: ids are dense · facts: code: prices in cents · verify: bun test',
    '## Up Next',
    ...Array.from({ length: 27 }, (_, n) => `- [ ] **Step ${n + 14}** — later`),
  ].join('\n'),
)
const bigInput = (columns: number, rows: number) => ({ ...input(columns, rows), tree: BIG, spent: { ...spent, stepNow: 'Step 13', steps: { 'Step 13': spent.steps.Lens! } } })
const elements = (rows: ReturnType<typeof layout>) => new Set(rows.map(one => one.key).filter(key => !key.endsWith(':more') && !key.startsWith('pad:') && !key.startsWith('gap:')))
const isSubset = (small: Set<string>, large: Set<string>) => [...small].every(key => large.has(key))

test('a narrower pane never shows an element a wider one lacks, at every height', () => {
  for (const rows of [8, 12, 20, 30, 50]) {
    const widths = [10, 12, 24, 30, 40, 50, 60, 100]
    for (let index = 1; index < widths.length; index += 1) {
      const small = elements(layout(bigInput(widths[index - 1]!, rows)))
      const large = elements(layout(bigInput(widths[index]!, rows)))
      expect([widths[index - 1], widths[index], rows, [...small].filter(key => !large.has(key))]).toEqual([widths[index - 1], widths[index], rows, []])
      expect(isSubset(small, large)).toBe(true)
    }
  }
})

test('a shorter pane never shows an element a taller one lacks, at every width', () => {
  for (const columns of [10, 24, 40, 50, 60]) {
    const heights = [6, 8, 10, 12, 16, 20, 24, 30, 40, 50, 60]
    for (let index = 1; index < heights.length; index += 1) {
      const small = elements(layout(bigInput(columns, heights[index - 1]!)))
      const large = elements(layout(bigInput(columns, heights[index]!)))
      expect([columns, heights[index - 1], heights[index], [...small].filter(key => !large.has(key))]).toEqual([columns, heights[index - 1], heights[index], []])
    }
  }
})

test('a short pane keeps the live step and at least three doing rows, folding done steps into a count', () => {
  const rows = layout(input(40, 12))
  const drawn = text(rows)
  expect(rows.length).toBeLessThanOrEqual(12)
  expect(drawn).toContain('▶ Lens')
  expect(rows.filter(one => one.key.startsWith('doing:')).length).toBeGreaterThanOrEqual(3)
})

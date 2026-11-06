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

// The step the plan itself names on its progress line wins (most plans keep no In Progress heading). The lines below
// are shaped like the owner's real plans of 2026-11-06.
const activePlan = (progress: string) =>
  [
    '# A plan',
    progress,
    '## Rolling builds',
    '- [x] **L0 Land** — done',
    '- [ ] **L1 Meet reality** — the Mac list',
    '- [ ] **L4f The face, integrated (owner, 2026-11-05)** — next demo',
    '- [ ] **Her space on the Mac, second pass (owner, 2026-11-06)** — goal: double-click her',
    '- [ ] **W9 The guard only blocks a Claude that is really running elsewhere** — fix',
    '- [ ] **V Closed verification loop** — frames',
    '- [ ] **Hermes notes** — later',
  ].join('\n')

test('now is the open step the progress line names Active, even with no In Progress heading', () => {
  const named = (progress: string) => nowItem(parsePlan(activePlan(progress)))?.name
  // A bold name the step's own name starts with.
  expect(named('**Progress: 3/9 done** | Active: **Her space on the Mac, second pass** (research pending)')).toBe('Her space on the Mac, second pass (owner, 2026-11-06)')
  // The same step code, the words after it differing.
  expect(named('**Progress: 13/15 done** | Active: **W9 the guard blocked its own pane** (failed 20:07), then W7')).toBe('W9 The guard only blocks a Claude that is really running elsewhere')
  // No bold: the words up to the first bracket, comma, semicolon or bar.
  expect(named('**Progress: 3/9 done** | Active: L4f the Mac face demo (next), then L9 iPhone')).toBe('L4f The face, integrated (owner, 2026-11-05)')
  expect(named('**Progress: 1/9 done** | Active: **V the verification loop**, then **D one design system**')).toBe('V Closed verification loop')
  // A numbered step: `14 verify…` is `14. On arrival…`, the dot aside.
  const numbered = ['**Progress: 13/15 done** | Active: 14 verify the M5 on arrival, 15 sell the M3', '## Steps', '- [x] **13. Outcome**', '- [ ] **6. (Later) Watch mode**', '- [ ] **14. On arrival: verify the M5**'].join('\n')
  expect(nowItem(parsePlan(numbered))?.name).toBe('14. On arrival: verify the M5')
  // The exact name, case aside.
  expect(named('**Progress: 1/7 done** | Active: **l1 meet reality**')).toBe('L1 Meet reality')
})

test('a word is not a step code: Active "Her…" never picks another step that merely starts with Her', () => {
  expect(nowItem(parsePlan(activePlan('**Progress: 1/7 done** | Active: **Hermes is next**')))?.name).toBe('L1 Meet reality')
})

test('an Active step that is done, or names nothing in the plan, falls back to the old rule', () => {
  expect(nowItem(parsePlan(activePlan('**Progress: 1/7 done** | Active: **L0 Land**')))?.name).toBe('L1 Meet reality')
  expect(nowItem(parsePlan(activePlan('**Progress: 1/7 done** | Active: **Z9 nothing like it**')))?.name).toBe('L1 Meet reality')
  expect(nowItem(parsePlan(activePlan('**Progress: 1/7 done**')))?.name).toBe('L1 Meet reality')
  expect(parsePlan(activePlan('**Progress: 1/7 done** | Active: **W9 x**')).active).toBe('W9 x')
  expect(parsePlan(activePlan('**Progress: 1/7 done**')).active).toBeUndefined()
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
  expect(fit('anything', 0)).toBe('')
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

test('the push tags parse: because, facts with sources, guard, options, verify and slow', () => {
  const tree = parsePlan(
    [
      '# T',
      '## In Progress',
      '- [ ] **Feed** — read the last 20 rows · because: ids are dense, so the tail is the newest, over sorting every row · facts: data: ids are dense 1..n · facts: you: time never decreases · assume: promos never exceed the price · guard: check the last id = count, else fall back to SQL, 1 compare · options: cache promo lookups (2×) · option: skip the JSON parse (3×) · verify: bun test · slow: sort all rows then take 20',
    ].join('\n'),
  )
  const feed = tree.sections[0]?.items[0]
  expect(feed?.why).toBe('ids are dense, so the tail is the newest, over sorting every row')
  expect(feed?.facts).toEqual([
    { text: 'ids are dense 1..n', source: 'data' },
    { text: 'time never decreases', source: 'you' },
    { text: 'promos never exceed the price', source: 'claude' },
  ])
  expect(feed?.assumptions).toEqual(['ids are dense 1..n', 'time never decreases', 'promos never exceed the price'])
  expect(feed?.guard).toBe('check the last id = count, else fall back to SQL, 1 compare')
  expect(feed?.options).toEqual(['cache promo lookups (2×)', 'skip the JSON parse (3×)'])
  expect(feed?.judge).toBe('bun test')
  expect(feed?.slow).toBe('sort all rows then take 20')
  expect(feed?.note).toBe('read the last 20 rows')
})

test('the old tags still parse the same way, and wording that assumes stays a fact from the wording', () => {
  const tree = parsePlan(['# T', '## In Progress', '- [ ] **Panel** — the pane should fit · why: plans are long · judge: one screen · assume: prices are in cents'].join('\n'))
  const panel = tree.sections[0]?.items[0]
  expect(panel?.why).toBe('plans are long')
  expect(panel?.judge).toBe('one screen')
  expect(panel?.facts).toEqual([
    { text: 'prices are in cents', source: 'claude' },
    { text: 'the pane should fit', source: 'wording' },
  ])
  expect(panel?.guard).toBe('')
  expect(panel?.options).toEqual([])
  expect(panel?.slow).toBe('')
})

// The demo fixture's plan, verbatim, through the real parser: the three planted claims must be found where the demo expects them.
const FIXTURE_PLAN = "# Discount codes for the shop\n\n**Progress: 1/6 done** | Active: Apply promos\n\nGoal: add stackable discount codes without ever charging below zero. Effort: as much as it takes; money is involved. Verify: every total checked against the obvious slow version (sum the lines, subtract each promo) on generated carts including the extremes.\n\n## Summary\n\nAdd stackable discount codes to the shop. The scary part is a total that goes negative when two codes stack; the slow version in cart.ts is the spec.\n\n## Done\n\n- [x] **Cart total** \u2014 sum of price \u00d7 qty over the lines \u00b7 facts: code: applyPromosSlow in cart.ts floors the total at zero \u00b7 verify: bun test\n\n## In Progress\n\n- [ ] **Apply promos** \u2014 subtract each promo from the cart total \u00b7 because: one rule in one place, chosen over capping each promo at its line \u00b7 facts: data: prices in the seed are integers in cents \u00b7 facts: claude: promos never exceed the price \u00b7 guard: if total < 0 then clamp to 0 and log the cart, 1 compare per cart \u00b7 options: cache promo lookups per request (2\u00d7 on the hot path) \u00b7 verify: bun test \u00b7 slow: sum every line, then subtract every promo in order\n\n## Up Next\n\n- [ ] **Stacking rules** \u2014 which codes may stack \u00b7 facts: claude: a code is used at most once per cart \u00b7 verify: property test over random code lists\n- [ ] **Refunds** \u2014 refund the promo share proportionally \u00b7 facts: claude: refunds are rare, so the slow path is fine \u00b7 slow: recompute the whole cart\n- [ ] **Show the total** \u2014 in the cart view, with the promos listed\n- [ ] **Ship** \u2014 behind a flag, 10% of carts first\n\n---\n\n## Detail: Apply promos\n\nProse only, no checkboxes. The clamp is the guard; the differential against applyPromosSlow is the check.\n"

test('the discount-shop fixture plan parses: the lit step, its tags, and the three planted claude facts', () => {
  const tree = parsePlan(FIXTURE_PLAN)
  const now = nowItem(tree)
  expect(now?.name).toBe('Apply promos')
  expect(now?.why).toContain('one rule in one place')
  expect(now?.guard).toContain('clamp to 0')
  expect(now?.options).toEqual(['cache promo lookups per request (2× on the hot path)'])
  expect(now?.judge).toBe('bun test')
  expect(now?.slow).toContain('subtract every promo')
  expect(now?.facts).toEqual(expect.arrayContaining([
    { text: 'prices in the seed are integers in cents', source: 'data' },
    { text: 'promos never exceed the price', source: 'claude' },
  ]))
  const planted = tree.sections.flatMap(section => section.items).flatMap(item => item.facts.filter(fact => fact.source === 'claude').map(fact => fact.text))
  expect(planted).toEqual(['promos never exceed the price', 'a code is used at most once per cart', 'refunds are rare, so the slow path is fine'])
  expect(itemNamed(tree, 'Cart total')?.facts).toEqual([{ text: 'applyPromosSlow in cart.ts floors the total at zero', source: 'code' }])
  expect(itemNamed(tree, 'Cart total')?.isDone).toBe(true)
})

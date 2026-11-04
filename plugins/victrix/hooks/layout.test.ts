import { expect, test } from 'claude-code/testing'

import type { Activity, Claim } from '../types'
import { EMPTY_ACTIVITY } from './activity'
import { EFFORT_HALF, PROOF_CAP } from './board'
import { isInDictionary, layout, meetLine, pickLog, rowWidth, statusWord, unit } from './layout'
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
    expect(drawn).toContain('   ┏━')
    expect(drawn).not.toContain('-_-')
    expect(drawn).toContain('[ ]')
    if (columns >= 24) expect(drawn).toContain('47m')
    expect(isInDictionary(rows)).toBe(true)
  })
}

test('the tail runs along the top row from the corner to the right edge once a plan exists, and the plan name and count sit beside the spine', () => {
  for (const columns of [10, 24, 50, 100]) {
    const rows = layout(input(columns, 30))
    const top = rows.find(one => one.key === 'box:top')!
    expect(rowWidth(top)).toBe(columns)
    expect(text([top]).startsWith('   ┏━')).toBe(true)
    expect(text([top]).endsWith('━')).toBe(true)
    expect(text([rows.find(one => one.key === 'box:face')!]).startsWith('   ┃')).toBe(true)
    expect(text([rows.find(one => one.key === 'box:face')!])).toContain('2/6')
  }
})

test('the snake is the person’s colour and the spine runs through done and live rows; the tasks ahead have food, not spine', () => {
  const rows = layout(input(66, 30))
  const done = rows.find(one => one.key === 'step:Crab')
  const live = rows.find(one => one.key === 'step:Lens')
  const open = rows.find(one => one.key === 'step:Gaits')
  expect(done?.spans.find(part => part.text === '┃')?.paint).toBe('text')
  expect(live?.spans.find(part => part.text === '┃')?.paint).toBe('text')
  expect(open?.spans.some(part => part.text === '┃')).toBe(false)
  expect(text([open!]).startsWith('   ▫ [ ] Gaits')).toBe(true)
})

test('the head sits at headFraction of its row', () => {
  const bare = parsePlan(['## In Progress', '- [ ] **Lens** — the outline'].join('\n'))
  const at = (calls: number, columns: number) => {
    const spend = { calls, fails: 0, tokens: 0, enteredAt: NOW, ms: 0 }
    const bar = layout({ ...input(columns, 30), tree: bare, claims: [], spent: { ...spent, steps: { Lens: spend } } }).find(one => one.key === 'live:bar')!
    return { plain: text([bar]), width: rowWidth(bar) }
  }
  for (const columns of [24, 50, 80]) {
    const none = at(0, columns)
    expect(none.plain.indexOf('◘')).toBe(4)
    expect(none.width).toBeLessThanOrEqual(columns)
    // Half the effort puts the head half way round the hairpin: past the top row's corner when the loop has a body.
    const half = at(EFFORT_HALF, columns)
    expect(half.plain.indexOf('◘') === -1 || half.plain.indexOf('◘') > 4).toBe(true)
    expect(half.plain.startsWith('   ┗')).toBe(true)
    expect(half.plain).not.toContain('/')
  }
})

test('done rows read checkbox, name, rung, time and tokens in columns, the rung ∅ for a step that rested on nothing, and crop the name first', () => {
  const rows = layout(input(50, 30))
  const crab = text([rows.find(one => one.key === 'step:Crab')!])
  expect(crab).toBe('   ┃ [✓] Crab · ∅ ·  8s · 1.2k')
  // Gull's rung repeats Crab's, so its cell is blank; it has no spend, so the row ends at the name.
  expect(text([rows.find(one => one.key === 'step:Gull')!])).toBe('   ┃ [✓] Gull')
  // The live row sits in the same columns, its clock right-aligned under the times.
  expect(text([rows.find(one => one.key === 'step:Lens')!])).toBe('   ┃ [ ] Lens     · 47m')
  const long = parsePlan(['## Done', '- [x] **Crab with a very long and winding name** — band', '## In Progress', '- [ ] **Lens**'].join('\n'))
  const cropped = text([layout({ ...input(30, 30), tree: long }).find(one => one.key.startsWith('step:Crab'))!])
  expect(cropped.endsWith(' · ∅')).toBe(true)
  expect(cropped).toContain('…')
  expect(Array.from(cropped).length).toBeLessThanOrEqual(30)
})

test('a done step with facts shows its whole meet from 60 columns and the result glyph below, and a repeated rung is left blank', () => {
  const plan = parsePlan(['## Done', '- [x] **Crab** — band · facts: code: a', '- [x] **Gull** — wing · facts: code: b', '- [x] **Tern** — tail', '## In Progress', '- [ ] **Lens**'].join('\n'))
  const claims: Claim[] = [{ step: 'Crab', says: 'a', status: 'checked', source: 'tool', at: NOW }, { step: 'Gull', says: 'b', status: 'checked', source: 'tool', at: NOW }]
  const wide = layout({ ...input(66, 30), tree: plan, claims })
  expect(text([wide.find(one => one.key === 'step:Crab')!])).toContain('Crab · ⊓ { ■ } = ■')
  expect(text([wide.find(one => one.key === 'step:Gull')!])).not.toContain('⊓')
  expect(text([wide.find(one => one.key === 'step:Tern')!])).toContain('Tern · ∅')
  const narrow = layout({ ...input(50, 30), tree: plan, claims })
  expect(text([narrow.find(one => one.key === 'step:Crab')!])).toContain('Crab · ■')
  expect(text([narrow.find(one => one.key === 'step:Crab')!])).not.toContain('⊓')
})

test('every number carries a unit, short when narrow and a word when wide', () => {
  expect(unit(92, 'c', 'call', 24)).toBe('92c')
  expect(unit(92, 'c', 'call', 40)).toBe('92 calls')
})

test('proof draws the meet in notation, then each fact as its words and its rung, then the check', () => {
  const drawn = text(layout(input(66, 30)))
  expect(drawn).toContain('Lens ⊑ ⊓ {')
  expect(drawn).toContain('} = △')
  expect(drawn).toContain('prices are in cents')
  expect(drawn).toContain('Claude assumes this; nobody checked it')
  expect(drawn).toContain('△ prices are in cents')
  // The evidence sits in its own column, so the claim is padded to the widest claim before the ` · `.
  expect(drawn).toMatch(/■ ids are dense\s+· ⊢ bun test/)
  expect(drawn).toContain('⊢ bun test')
  expect(statusWord(claims[0]!)).toBe('⊢ bun test')
  expect(meetLine('Lens', [], 66)).toBe('Lens ⊑ ⊓ { ∅ } = △')
})

test('process shows the live call first, then the newest earned actions, and a decline as a decline, never red', () => {
  const rows = layout(input(66, 30))
  const now = rows.find(one => one.key === 'process:now')
  expect(text([now!])).toContain('edit lens.tsx')
  // The row's own text is orange and so is its dot at the hairpin's edge: the call in flight, hollow.
  expect(now?.spans.find(part => part.text.includes('edit lens.tsx'))?.paint).toBe('live')
  expect([now?.spans.at(-1)?.text, now?.spans.at(-1)?.paint]).toEqual(['◦', 'live'])
  const declined = rows.find(one => text([one]).includes('exitplanmode'))
  expect(text([declined!])).toContain('declined by you')
  expect(declined?.spans.every(part => part.paint !== 'bad')).toBe(true)
  const failed = rows.find(one => text([one]).includes('run bun test'))
  expect(failed?.spans.some(part => part.paint === 'bad')).toBe(true)
  // Reads show too (owner: anything Claude is doing for this plan), filled once done.
  expect(text(rows)).toContain('✓ read tape.tsx')
})

test('the food of the tasks ahead sits in column 3 before the state box', () => {
  for (const columns of [24, 50]) {
    const rows = layout(input(columns, 30)).filter(one => one.key === 'step:Gaits' || one.key === 'step:Ship')
    expect(rows.length).toBe(2)
    for (const one of rows) {
      const plain = text([one])
      expect(Array.from(plain)[3]).toBe('▫')
      expect(plain.indexOf('[ ]')).toBe(5)
    }
  }
  const broken = { ...claims[0]!, step: 'Gaits', says: 'x', status: 'broken' as const }
  const food = (list: Claim[]) => layout({ ...input(50, 30), claims: list }).find(one => one.key === 'step:Gaits')!.spans.find(part => part.text === '▫')?.paint
  expect(food([])).toBe('dim')
  expect(food([broken])).toBe('bad')
})

test('the footer’s ? is the last cell and its parts drop whole', () => {
  for (const columns of [10, 24, 40, 60, 100]) {
    const math = layout(input(columns, 30)).find(one => one.key === 'footer:math')!
    expect(rowWidth(math)).toBe(columns)
    expect(math.spans.at(-1)?.text).toBe('?')
    expect(math.press?.kind).toBe('help')
  }
  const at = (columns: number) => text([layout(input(columns, 30)).find(one => one.key === 'footer:math')!])
  expect(at(60)).toContain('⊓')
  expect(at(24)).toContain('Σ')
  expect(at(24)).toContain('t 47m')
  expect(at(24)).not.toContain('⊓')
  expect(at(10)).not.toContain('t 47m')
  expect(at(10)).toMatch(/^Σ \S+ +\?$/)
})

test('no plan: the bare face says so, the recent plans are offered as food, the footer stays', () => {
  const rows = layout({ ...input(40, 20), tree: null, claims: [], recent: [{ title: 'Brave otter', path: '/p/brave-otter.md' }] })
  const drawn = text(rows)
  expect(drawn).toContain('no plan yet')
  expect(drawn).toContain('▫ [ ] Brave otter')
  expect(drawn).toContain('plan this: shift+tab')
  expect(rows.find(one => one.key === 'box:top')?.spans.length).toBe(0)
  expect(rows.at(-1)?.press?.kind).toBe('help')
  expect(isInDictionary(rows)).toBe(true)
})

test('planning: the tail creeps in from the right ending in the head, and the name row reads planning', () => {
  const calls = Array.from({ length: 20 }, (_, n) => ({ text: `edit f${n}.ts`, isOk: true, at: NOW - n * 1000 }))
  const rows = layout({ ...input(50, 20), tree: null, claims: [], isPlanning: true, spent: { ...spent, last: calls, steps: {} } })
  const top = text([rows.find(one => one.key === 'box:top')!])
  expect(top).toContain('◘━')
  expect(top.endsWith('━')).toBe(true)
  expect(Array.from(top).length).toBe(50)
  expect(text(rows)).toMatch(/planning · \d+s/)
  expect(rows.some(one => one.key === 'live:bar')).toBe(false)
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
const elements = (rows: ReturnType<typeof layout>) => new Set(rows.map(one => one.key).filter(key => !key.includes(':more') && !key.startsWith('pad:') && !key.startsWith('gap:')))
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

test('a short pane keeps the live step and its process, folding done steps into a count', () => {
  const rows = layout(input(40, 12))
  const drawn = text(rows)
  expect(rows.length).toBeLessThanOrEqual(12)
  expect(drawn).toContain('[ ] Lens')
  expect(rows.some(one => one.key === 'process:now')).toBe(true)
})

test('the pane never has more rows than it is given, at any size', () => {
  for (const columns of [10, 24, 44, 80]) for (const rows of [4, 6, 12, 24, 50]) expect(layout(bigInput(columns, rows)).length).toBeLessThanOrEqual(rows)
})

// The hairpin's right edge (owner, 2026-11-05: the loop should act like food as the task progresses, and nothing may
// fall off the board at any width). A step with eight facts and a check, more than the proof ever shows at once.
const MANY = parsePlan(
  [
    '## In Progress',
    `- [ ] **Lens** — the outline · ${Array.from({ length: 8 }, (_, n) => `facts: claude: fact number ${n + 1} holds`).join(' · ')} · verify: bun test`,
    '## Up Next',
    '- [ ] **Ship**',
  ].join('\n'),
)
const checkedFacts = (count: number): Claim[] =>
  Array.from({ length: count }, (_, n) => ({ step: 'Lens', says: `fact number ${n + 1} holds`, status: 'checked' as const, source: 'tool' as const, at: NOW, evidence: { kind: 'test' as const, command: 'bun test', exitCode: 0, ms: 1000, tail: '' } }))
const manyInput = (columns: number, rows: number, checked = 0) => ({ ...input(columns, rows), tree: MANY, claims: checkedFacts(checked) })
type Row = ReturnType<typeof layout>[number]
// What a row inside the loop ends with ahead of the head: its own food (a fact, the check, an action), else the faint trail.
const TRAIL = { text: '·', paint: 'faint' }
const edgeOf = (one: Row) => (one.food ? { text: one.food.text, paint: one.food.paint } : TRAIL)
const insideLoop = (rows: ReturnType<typeof layout>) => {
  const start = rows.findIndex(one => one.key === 'live:bar')
  const end = rows.findIndex(one => one.key === 'live:return')
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return rows.slice(start + 1, end)
}

const lastSpan = (one: Row) => ({ text: one.spans.at(-1)?.text, paint: one.spans.at(-1)?.paint })
const isFoodKey = (key: string) => /^(proof:fact:\d+|proof:check|process:now|process:\d+)$/.test(key)

test('before the head comes down, every row inside the hairpin ends at the last column: the block\'s food in colour on facts, the check and actions, the faint trail elsewhere', () => {
  for (const columns of [10, 11, 12, 13, 24, 25, 44, 50, 80, 100]) {
    const rows = layout(manyInput(columns, 50))
    for (const one of rows) expect(rowWidth(one)).toBeLessThanOrEqual(columns)
    for (const one of insideLoop(rows)) {
      expect([columns, one.key, rowWidth(one), lastSpan(one)]).toEqual([columns, one.key, columns, edgeOf(one)])
      expect([columns, one.key, one.food !== undefined]).toEqual([columns, one.key, isFoodKey(one.key)])
      expect(rowWidth({ ...one, spans: one.spans.slice(0, -2) })).toBeLessThanOrEqual(columns - 2)
    }
  }
})

test('the dots say what each row is: hollow for an assumed fact, a check not run or the running call, filled for checked facts, a passed check and done actions, the error colour on failures, dim on declines', () => {
  const rows = layout(manyInput(50, 60, 4))
  const dot = (key: string) => {
    const one = rows.find(row => row.key === key)
    return one?.food ? [one.food.text, one.food.paint] : undefined
  }
  expect(dot('proof:fact:7')).toEqual(['◦', 'text'])
  expect(dot('proof:fact:4')).toEqual(['◦', 'text'])
  expect(dot('proof:check')).toEqual(['◦', 'text'])
  expect(dot('proof:meet')).toBeUndefined()
  expect(dot('proof:more')).toBeUndefined()
  expect(dot('process:title')).toBeUndefined()
  expect(dot('process:now')).toEqual(['◦', 'live'])
  const withChecked = layout({ ...manyInput(50, 60, 8), claims: [...checkedFacts(7), { step: 'Lens', says: 'fact number 8 holds', status: 'broken', source: 'tool', at: NOW, counterexample: '-1' }] })
  const dotOf = (rows: Row[], key: string) => {
    const food = rows.find(row => row.key === key)?.food
    return food ? [food.text, food.paint] : undefined
  }
  expect(dotOf(withChecked, 'proof:fact:6')).toEqual(['●', 'math'])
  expect(dotOf(withChecked, 'proof:fact:7')).toEqual(['◦', 'bad'])
  const passed = layout({ ...manyInput(50, 60), claims: [{ step: 'Lens', says: 'bun test', status: 'checked', source: 'tool', at: NOW, evidence: { kind: 'test', command: 'bun test', exitCode: 0, ms: 3000, tail: '' } }] })
  expect(dotOf(passed, 'proof:check')).toEqual(['●', 'math'])
  // The fixture's log: a passed edit, a failed run, a decline.
  const log = layout(input(66, 40))
  const foods = log.filter(row => /^process:\d+$/.test(row.key)).map(row => [text([row]).trim().slice(0, 1), row.food?.text, row.food?.paint])
  expect(foods).toContainEqual(['✓', '●', 'text'])
  expect(foods).toContainEqual(['✗', '◦', 'bad'])
  expect(foods).toContainEqual(['⊘', '◦', 'dim'])
})

test('the path ahead is faint food every other cell along the top and bottom rows, anchored at the right corners, exact to the width', () => {
  for (const columns of [10, 11, 24, 25, 50, 51, 80]) {
    const rows = layout(manyInput(columns, 50))
    const top = rows.find(one => one.key === 'live:bar')!
    const bottom = rows.find(one => one.key === 'live:return')!
    for (const one of [top, bottom]) {
      const plain = text([one])
      expect([columns, one.key, rowWidth(one)]).toEqual([columns, one.key, columns])
      expect(plain.at(-1)).toBe('·')
      // Dots every other cell from the right corner inward; the cells between are spaces.
      for (let col = columns - 1; col > 5; col -= 2) {
        expect([columns, one.key, col, plain[col]]).toEqual([columns, one.key, col, '·'])
        expect([columns, one.key, col - 1, plain[col - 1]]).toEqual([columns, one.key, col - 1, ' '])
      }
      for (const part of one.spans.filter(part => part.text === '·')) expect(part.paint).toBe('faint')
    }
    expect(text([top]).startsWith('   ┗◘')).toBe(true)
  }
})

test('as the head comes down the right edge it eats the food: body above it, the head, food below, every row ending at the last column', () => {
  const rows = layout(manyInput(50, 60, 4))
  const inner = insideLoop(rows)
  const headAt = inner.findIndex(one => text([one]).endsWith('◘'))
  expect(headAt).toBeGreaterThan(0)
  expect(headAt).toBeLessThan(inner.length - 1)
  for (const [index, one] of inner.entries()) {
    const plain = text([one])
    if (index < headAt) expect([one.key, rowWidth(one), plain.at(-1)]).toEqual([one.key, 50, '┃'])
    else if (index > headAt) expect([one.key, rowWidth(one), lastSpan(one)]).toEqual([one.key, 50, edgeOf(one)])
  }
  // The body on the top row, the trail still ahead on the bottom row.
  expect(text([rows.find(one => one.key === 'live:bar')!])).toMatch(/^   ┗━+┓$/)
  expect(text([rows.find(one => one.key === 'live:return')!])).toMatch(/^   ( ?·)+$/)
})

test('the proof shows the newest facts behind a fold that counts the older ones, never more than PROOF_CAP, and a shorter pane only loses facts', () => {
  const tall = layout(manyInput(50, 60))
  const keys = tall.map(one => one.key)
  expect(keys.filter(key => /^proof:fact:\d+$/.test(key)).length).toBe(PROOF_CAP)
  expect(text([tall.find(one => one.key === 'proof:more')!])).toContain(`… ${8 - PROOF_CAP} more facts`)
  expect(text([tall.find(one => one.key === 'proof:more:en')!])).toContain(`${8 - PROOF_CAP} older facts are folded`)
  expect(keys).toContain('proof:fact:7')
  expect(keys).not.toContain('proof:fact:0')
  expect(keys.indexOf('proof:meet')).toBeLessThan(keys.indexOf('proof:more'))
  expect(keys.indexOf('proof:more')).toBeLessThan(keys.indexOf(`proof:fact:${8 - PROOF_CAP}`))
  expect(keys.indexOf('proof:fact:7')).toBeLessThan(keys.indexOf('proof:check'))
  const wide = layout(manyInput(100, 60)).map(one => one.key)
  expect(wide.filter(key => /^proof:fact:\d+$/.test(key)).length).toBe(PROOF_CAP)
  for (const rows of [8, 12, 16, 20, 30]) {
    const shorter = layout(manyInput(50, rows)).map(one => one.key).filter(key => key.startsWith('proof:fact'))
    for (const key of shorter) expect([rows, key, keys.includes(key)]).toEqual([rows, key, true])
  }
})

test('process lines up: the detail, the time and the fold count each in a column, a helper\'s call behind its tag, a running helper hollow orange with no spinner', () => {
  const last: Activity['last'] = [
    { text: 'read layout.ts', isOk: true, isRunning: true, helper: 'scan glyphs', at: NOW },
    { text: 'edit layout.ts', isOk: true, at: NOW, ms: 200, detail: '+3 −1' },
    { text: 'read board.ts', isOk: true, at: NOW, ms: 40, helper: 'scan glyphs', detail: '92–135' },
    { text: 'run bun test', isOk: false, at: NOW, ms: 5000, detail: 'exit 1' },
    { text: 'run bun test', isOk: false, at: NOW, ms: 5000, detail: 'exit 1' },
    { text: 'search isFood', isOk: true, at: NOW, ms: 100, detail: '4 hits' },
  ]
  const rows = layout({ ...input(66, 40), spent: { ...spent, last } })
  const process = rows.filter(one => /^process:\d+$/.test(one.key)).map(one => text([one]))
  const running = rows.find(one => text([one]).includes('scan glyphs · read layout.ts'))!
  expect(running.spans.find(part => part.text.includes('read layout.ts'))?.paint).toBe('live')
  expect(running.spans[1]?.text).toBe('·')
  expect(running.food).toMatchObject({ text: '◦', paint: 'live' })
  expect(process.some(line => /✓ edit layout\.ts\s+· \+3 −1/.test(line))).toBe(true)
  expect(process.some(line => /✓ scan glyphs · read board\.ts\s+· 92–135/.test(line))).toBe(true)
  expect(process.some(line => /✗ run bun test\s+· exit 1\s+· 5s\s+· ×2/.test(line))).toBe(true)
  // Every ` · ` of one column sits at one cell: the details start at the same column on every row that has one.
  const detailCol = process.filter(line => / · (\+3|92|exit|4 hits)/.test(line)).map(line => line.search(/ · (\+3|92|exit|4 hits)/))
  expect(new Set(detailCol).size).toBe(1)
  for (const line of process) expect([...line].length).toBeLessThanOrEqual(66)
})

test('pickLog keeps the main loop\'s two newest calls when helpers flood the log, the oldest helper rows giving way, time order kept', () => {
  const events = [
    { id: 'h1', isHelper: true },
    { id: 'h2', isHelper: true },
    { id: 'h3', isHelper: true },
    { id: 'm1', isHelper: false },
    { id: 'h4', isHelper: true },
    { id: 'm2', isHelper: false },
    { id: 'm3', isHelper: false },
  ]
  expect(pickLog(events, 3).map(one => one.id)).toEqual(['h1', 'm1', 'm2'])
  expect(pickLog(events, 5).map(one => one.id)).toEqual(['h1', 'h2', 'h3', 'm1', 'm2'])
  expect(pickLog(events, 7).map(one => one.id)).toEqual(events.map(one => one.id))
  expect(pickLog(events.filter(one => one.isHelper), 2).map(one => one.id)).toEqual(['h1', 'h2'])
  expect(pickLog(events.filter(one => !one.isHelper), 1).map(one => one.id)).toEqual(['m1'])
})

test('a step with one or two facts shows them all with no fold', () => {
  const rows = layout(input(50, 40)).map(one => one.key)
  expect(rows.some(key => key.startsWith('proof:more'))).toBe(false)
})

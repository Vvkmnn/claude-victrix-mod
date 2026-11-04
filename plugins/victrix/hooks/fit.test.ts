import { expect, test } from 'claude-code/testing'

import type { Claim } from '../types'
import { fitRows, stepKey } from './fit'
import { parsePlan } from './plan'

const PLAN = [
  '# Shop',
  '**Progress: 2/14 done**',
  '## Summary',
  'Add discount codes to the shop without ever charging below zero.',
  '## Done',
  '- [x] **Schema** — promos table',
  '- [x] ~~**Coupons v1**~~ — abandoned: replaced by promos',
  '## In Progress',
  '- [ ] **Apply promos** — subtract each promo · because: one rule in one place, over capping each promo · facts: claude: promos never exceed the price · facts: you: prices are integers in cents · guard: total < 0 → clamp and log, 1 compare · options: cache promo lookups (2×) · verify: bun test · slow: sum then subtract',
  '- [ ] **Show the total** — in the cart view · verify: snapshot test',
  '## Up Next',
  '- [ ] **Stacking rules** — assume: two codes never share a prefix',
  '- [ ] **Receipts**',
  '- [ ] **Refunds**',
  '- [ ] **Audit log**',
  '- [ ] **Admin screen**',
  '- [ ] **Docs**',
  '- [ ] **Ship**',
].join('\n')

const tree = parsePlan(PLAN)
const broken: Claim = { step: 'Apply promos', says: 'promos never exceed the price', status: 'broken', source: 'tool', counterexample: 'SAVE50 + SAVE60 on $10 = −$1', at: 1 }

test('at a generous budget every open step carries its detail and the done steps are their own rows (L0)', () => {
  const fitted = fitRows({ rows: 80, tree, claims: [] })
  expect(fitted.level).toBe(0)
  expect(fitted.isOverflowing).toBe(false)
  const texts = fitted.rows.map(row => row.text)
  expect(texts[0]).toBe('Add discount codes to the shop without ever charging below zero.')
  expect(texts).toContain('Schema')
  // The because line is the map's `now` zone, not a trunk row, unless every detail is asked for.
  expect(texts).not.toContain('one rule in one place, over capping each promo')
  expect(fitRows({ rows: 80, tree, claims: [], details: 'all' }).rows.map(row => row.text)).toContain('one rule in one place, over capping each promo')
  expect(texts).toContain('promos never exceed the price')
  expect(texts).toContain('two codes never share a prefix')
  expect(fitted.rows.find(row => row.text === 'Apply promos')?.right).toBe('now')
  expect(fitted.rows.find(row => row.text === 'Stacking rules')?.right).toBe('△1')
})

test('the detail under the step being worked branches off the trunk and closes the branch', () => {
  const fitted = fitRows({ rows: 80, tree, claims: [broken], details: 'all' })
  const detail = fitted.rows.filter(row => row.step === 'Apply promos' && row.kind !== 'step')
  expect(detail.map(row => row.kind)).toEqual(['because', 'fact', 'fact', 'guard', 'option', 'verify'])
  expect(detail.map(row => row.trunk)).toEqual(['detail', 'detail', 'detail', 'detail', 'detail', 'detailLast'])
  expect(detail[1]?.glyph).toBe('✗')
  expect(detail[1]?.right).toBe('weakest')
  expect(detail[2]?.glyph).toBe('△')
  // By default the tree carries the facts alone; the rest of the detail is the map's `now` zone.
  const factsOnly = fitRows({ rows: 80, tree, claims: [broken] }).rows.filter(row => row.step === 'Apply promos' && row.kind !== 'step')
  expect(factsOnly.map(row => row.kind)).toEqual(['fact', 'fact'])
  expect(factsOnly.map(row => row.trunk)).toEqual(['detail', 'detailLast'])
  expect(fitted.rows.find(row => row.text === 'Apply promos')?.status).toBe('broken')
  expect(fitted.rows.find(row => row.text === 'Apply promos')?.glyph).toBe('◉')
})

test('as the budget shrinks the ladder folds from the least important part first and never exceeds it', () => {
  let lastLevel = -1
  for (const rows of [80, 40, 20, 14, 10, 6]) {
    const fitted = fitRows({ rows, tree, claims: [] })
    expect(fitted.rows.length).toBeLessThanOrEqual(Math.max(rows, fitted.isOverflowing ? fitted.rows.length : 0))
    expect(fitted.level).toBeGreaterThanOrEqual(lastLevel)
    lastLevel = fitted.level
    expect(fitted.rows.some(row => row.isNow && row.kind === 'step')).toBe(true)
  }
  const twenty = fitRows({ rows: 10, tree, claims: [] })
  expect(twenty.level).toBeGreaterThanOrEqual(2)
  expect(twenty.rows.find(row => row.kind === 'chips')?.text).toBe('✓ Schema ⋅ ~ Coupons v1')
  expect(twenty.rows.find(row => row.kind === 'chips')?.right).toBe('done 1')
})

test('next steps truncate to a more row, and the cursor row is never folded away', () => {
  const tight = fitRows({ rows: 12, tree, claims: [] })
  expect(tight.rows.some(row => row.kind === 'more')).toBe(true)
  const key = stepKey({ name: 'Docs', note: '', why: '', trade: '', judge: '', assumptions: [], facts: [], guard: '', options: [], slow: '', isDone: false, isAbandoned: false, line: 0, children: [] })
  const kept = fitRows({ rows: 12, tree, claims: [], cursorKey: key })
  expect(kept.rows.some(row => row.key === key)).toBe(true)
})

test('an impossible budget overflows at the leanest level instead of hiding the step being worked', () => {
  const fitted = fitRows({ rows: 2, tree, claims: [] })
  expect(fitted.isOverflowing).toBe(true)
  expect(fitted.level).toBe(4)
  expect(fitted.rows.some(row => row.isNow && row.kind === 'step')).toBe(true)
})

test('an empty plan fits in no rows', () => {
  const fitted = fitRows({ rows: 10, tree: parsePlan(''), claims: [] })
  expect(fitted.rows).toEqual([])
  expect(fitted.level).toBe(0)
})

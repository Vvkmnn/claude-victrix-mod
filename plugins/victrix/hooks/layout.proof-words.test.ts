import { expect, test } from 'claude-code/testing'

import type { Activity, Claim, ClaimSource, Status } from '../types'
import { EMPTY_ACTIVITY } from './activity'
import { layout, statusWord } from './layout'
import { parsePlan } from './plan'

const NOW = 1_700_000_000_000

const planOf = (verify: boolean) =>
  parsePlan(['# Brave otter', '## In Progress', `- [ ] **Lens** — the outline${verify ? ' · verify: bun test' : ''}`, '## Up Next', '- [ ] **Ship**'].join('\n'))

const spent: Activity = { ...EMPTY_ACTIVITY, doing: 'edit lens.tsx', stepNow: 'Lens' }

const fact = (status: Status, source: ClaimSource, more: Partial<Claim> = {}): Claim => ({ step: 'Lens', says: 'x is int', status, source, at: NOW, ...more })

const input = (claims: Claim[], columns = 50, rows = 30, verify = false) => ({
  columns,
  rows,
  tree: planOf(verify),
  claims,
  spent,
  now: NOW,
  tick: 3,
  isCalling: true,
  isWorking: true,
  recent: [],
})

const text = (rows: ReturnType<typeof layout>) => rows.map(one => one.spans.map(part => part.text).join('')).join('\n')
const drawn = (claims: Claim[], columns = 50, rows = 30, verify = false) => text(layout(input(claims, columns, rows, verify)))
const test_ = (command: string, more: Partial<Claim> = {}) => fact('checked', 'tool', { evidence: { kind: 'test', command, exitCode: 0, ms: 3000, tail: '' }, ...more })

// Every fact is two lines: plain English above (who said it, whether anything checked it), the notation below (the
// glyph, the claim, the evidence after ` · ` when there is any).
test('an open claim you made reads "you said so" above the claim, and saying is not a rung', () => {
  const out = drawn([fact('open', 'you')])
  expect(out).toContain('you said so; nothing has checked it')
  expect(out).toContain('△ x is int')
  expect(out).not.toContain('◇')
})

test('an open claim you doubted says so', () => {
  expect(drawn([fact('open', 'doubt')])).toContain('you doubted this; nothing has checked it')
})

test('an open claim from Claude or the data says who said it and that nothing checked it', () => {
  expect(drawn([fact('open', 'claude')])).toContain('Claude assumes this; nobody checked it')
  expect(drawn([fact('open', 'data')])).toContain('seen in the data; no test has checked it')
  expect(drawn([fact('open', 'data')])).toContain('△ x is int')
})

test('a checked claim names the command that checked it after the claim', () => {
  const out = drawn([test_('bun test cart.spec.ts')])
  expect(out).toContain('a test checked this')
  expect(out).toContain('■ x is int · ⊢ bun test')
})

test('a checked claim whose files moved says stale', () => {
  const out = drawn([test_('bun test cart.spec.ts', { stale: true })])
  expect(out).toContain('the files moved since')
  expect(out).toContain('■ x is int · ⊢ bun test · stale')
})

test('a checked claim with an empty command reads "checked"', () => {
  expect(drawn([test_('')])).toContain('■ x is int · checked')
})

test('a proved claim names its theorem', () => {
  const proved = fact('proved', 'lean', { evidence: { kind: 'lean', command: 'lake build', exitCode: 0, ms: 900, tail: '', theorem: 'feedPlan_eq' } })
  expect(drawn([proved])).toContain('◆ x is int · ⊢ feedPlan_eq')
  expect(drawn([proved])).toContain('proved in the model')
})

test('a proved claim whose files moved says stale after the theorem', () => {
  const proved = fact('proved', 'lean', { stale: true, evidence: { kind: 'lean', command: 'lake build', exitCode: 0, ms: 900, tail: '', theorem: 'feedPlan_eq' } })
  expect(drawn([proved])).toContain('◆ x is int · ⊢ feedPlan_eq · stale')
})

test('a proved claim without a theorem reads "proved"', () => {
  expect(drawn([fact('proved', 'lean')])).toContain('◆ x is int · proved')
})

test('a broken claim carries its counterexample', () => {
  const out = drawn([fact('broken', 'tool', { counterexample: 'SAVE50+SAVE60' })])
  expect(out).toContain('a case breaks this: SAVE50+SAVE60')
  expect(out).toContain('✗ x is int · broken: SAVE50+SAVE60')
})

test('a broken claim without a counterexample reads "broken"', () => {
  expect(drawn([fact('broken', 'tool')])).toContain('✗ x is int · broken')
})

test('a claim being checked says so in English', () => {
  expect(drawn([fact('open', 'claude', { isChecking: true })])).toContain('a check is running on this now')
})

test('the check unit before any run says it has not run and names the key', () => {
  expect(drawn([], 50, 30, true)).toContain('⊢ bun test · c')
  expect(drawn([], 50, 30, true)).toContain("the step's test has not run yet")
})

test('the check row after a passing run reads "passed" with the time', () => {
  const ran = test_('bun test', { says: 'bun test' })
  expect(drawn([ran], 50, 30, true)).toContain('⊢ bun test · ✓ passed 3s')
})

test('the check row after a failing run reads the exit code', () => {
  const ran = fact('broken', 'tool', { says: 'bun test', evidence: { kind: 'test', command: 'bun test', exitCode: 1, ms: 3000, tail: '' } })
  expect(drawn([ran], 50, 30, true)).toContain('⊢ bun test · ✗ exit 1')
})

test('the check row after a failure with no evidence reads "failed"', () => {
  const ran = fact('broken', 'tool', { says: 'bun test' })
  expect(drawn([ran], 50, 30, true)).toContain('⊢ bun test · ✗ failed')
})

test('a live step with no facts and no check draws no proof section; with a check and no facts the meet says the step rests on nothing', () => {
  expect(layout(input([], 50, 30)).some(one => one.key.startsWith('proof:'))).toBe(false)
  const rows = layout(input([], 50, 30, true))
  const en = rows.find(one => one.key === 'proof:meet:en')
  expect(text([en!])).toContain('no facts yet; the step rests on nothing')
  expect(text([rows.find(one => one.key === 'proof:meet')!])).toContain('⊓ ∅ = △')
  expect(rows.find(one => one.key === 'proof:meet')!.press).toEqual({ kind: 'step', step: 'Lens' })
  expect(layout(input([], 30, 30, true)).some(one => one.key === 'proof:meet:en')).toBe(false)
})

test('at 24 columns the words drop and the meet still ends in a status glyph', () => {
  const rows = layout(input([fact('open', 'you')], 24, 30))
  for (const one of rows.filter(r => r.key.startsWith('proof:fact'))) expect(text([one])).not.toContain(' · ')
  const meet = rows.find(one => one.key === 'proof:meet')
  expect(meet).toBeDefined()
  // The row ends with the hairpin's edge after the glyph: the faint path dot, the body or the head.
  expect(text([meet!])).toMatch(/= [✗△■◆]\s*[·┃◘]?$/)
})

test('statusWord of an open claim you made is "you said so", never "you"', () => {
  expect(statusWord({ step: 'Lens', says: 'x is int', status: 'open', source: 'you', at: NOW })).toBe('you said so')
})

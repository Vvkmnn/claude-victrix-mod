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

test('an open claim you made reads "you said so", and saying is not a rung', () => {
  const out = drawn([fact('open', 'you')])
  expect(out).toContain('△ x is int · you said so')
  expect(out).not.toContain('◇')
})

test('an open claim you doubted reads "you doubted it"', () => {
  expect(drawn([fact('open', 'doubt')])).toContain('△ x is int · you doubted it')
})

test('an open claim from Claude or the data reads "unchecked"', () => {
  expect(drawn([fact('open', 'claude')])).toContain('△ x is int · unchecked')
  expect(drawn([fact('open', 'data')])).toContain('△ x is int · unchecked')
})

test('a checked claim names the command that checked it', () => {
  expect(drawn([test_('bun test cart.spec.ts')])).toContain('■ x is int · ⊢ bun test')
})

test('a checked claim whose files moved says stale', () => {
  expect(drawn([test_('bun test cart.spec.ts', { stale: true })])).toContain('■ x is int · ⊢ bun test · stale')
})

test('a checked claim with an empty command reads "checked"', () => {
  expect(drawn([test_('')])).toContain('■ x is int · checked')
})

test('a proved claim names its theorem', () => {
  const proved = fact('proved', 'lean', { evidence: { kind: 'lean', command: 'lake build', exitCode: 0, ms: 900, tail: '', theorem: 'feedPlan_eq' } })
  expect(drawn([proved])).toContain('◆ x is int · ⊢ feedPlan_eq')
})

test('a proved claim whose files moved says stale after the theorem', () => {
  const proved = fact('proved', 'lean', { stale: true, evidence: { kind: 'lean', command: 'lake build', exitCode: 0, ms: 900, tail: '', theorem: 'feedPlan_eq' } })
  expect(drawn([proved])).toContain('· ⊢ feedPlan_eq · stale')
})

test('a proved claim without a theorem reads "proved"', () => {
  expect(drawn([fact('proved', 'lean')])).toContain('◆ x is int · proved')
})

test('a broken claim carries its counterexample', () => {
  expect(drawn([fact('broken', 'tool', { counterexample: 'SAVE50+SAVE60' })])).toContain('✗ x is int · broken: SAVE50+SAVE60')
})

test('a broken claim without a counterexample reads "broken"', () => {
  expect(drawn([fact('broken', 'tool')])).toContain('✗ x is int · broken')
})

test('a claim being checked reads "checking"', () => {
  expect(drawn([fact('open', 'claude', { isChecking: true })])).toContain('· checking')
})

test('the check row before any run reads "not run" and names the key', () => {
  expect(drawn([], 50, 30, true)).toContain('⊢ bun test · not run · press c')
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

test('a live step with no facts and no check says so, and pressing it opens the step', () => {
  const wide = layout(input([], 50, 30)).find(one => one.key === 'proof:none')
  expect(wide).toBeDefined()
  expect(text([wide!])).toContain('nothing assumed or checked yet')
  expect(wide!.press).toEqual({ kind: 'step', step: 'Lens' })
  const narrow = layout(input([], 30, 30)).find(one => one.key === 'proof:none')
  expect(text([narrow!])).toContain('no facts, no check')
})

test('at 24 columns the words drop and the meet still ends in a status glyph', () => {
  const rows = layout(input([fact('open', 'you')], 24, 30))
  for (const one of rows.filter(r => r.key.startsWith('proof:fact'))) expect(text([one])).not.toContain(' · ')
  const meet = rows.find(one => one.key === 'proof:meet')
  expect(meet).toBeDefined()
  expect(text([meet!])).toMatch(/= [✗△■◆]\s*$/)
})

test('statusWord of an open claim you made is "you said so", never "you"', () => {
  expect(statusWord({ step: 'Lens', says: 'x is int', status: 'open', source: 'you', at: NOW })).toBe('you said so')
})

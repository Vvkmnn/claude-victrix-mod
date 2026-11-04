import { expect, test } from 'claude-code/testing'

import type { Claim, Evidence, Status } from '../types'
import { counterexampleOf, GLYPH, RANK, STATUSES, checked, claimOf, combine, isStandardAxioms, label, meet, proved, sameClaim, stepStatus, weakest } from './lattice'

// Every list of premises of length 0 to 3 over the four statuses: 1 + 4 + 16 + 64 lists.
const lists = (): Status[][] => {
  const out: Status[][] = [[]]
  for (let length = 1; length <= 3; length += 1) {
    const grow = (prefix: Status[]): Status[][] => (prefix.length === length ? [prefix] : STATUSES.flatMap(s => grow([...prefix, s])))
    out.push(...grow([]))
  }
  return out
}

test('combine_le_own: a conclusion is never stronger than its own check (T1, exhaustive to length 3)', () => {
  for (const own of STATUSES) for (const ps of lists()) expect(RANK[combine(own, ps)]).toBeLessThanOrEqual(RANK[own])
})

test('combine_le_premise: a conclusion is never stronger than any premise (T1, exhaustive to length 3)', () => {
  for (const own of STATUSES) for (const ps of lists()) for (const p of ps) expect(RANK[combine(own, ps)]).toBeLessThanOrEqual(RANK[p])
})

test('meet is the weaker of two and is commutative', () => {
  for (const a of STATUSES) for (const b of STATUSES) {
    expect(meet(a, b)).toBe(meet(b, a))
    expect(RANK[meet(a, b)]).toBe(Math.min(RANK[a], RANK[b]))
  }
  expect(meet('proved', 'open')).toBe('open')
  expect(meet('broken', 'proved')).toBe('broken')
})

const at = 1_700_000_000_000

test('a step is open until something checks it, and held down by its weakest claim', () => {
  expect(stepStatus([])).toBe('open')
  const a = claimOf('V1', 'ids are dense', 'data', at)
  const b: Claim = { ...claimOf('V1', 'time only goes up', 'claude', at), status: 'checked' }
  const c: Claim = { ...claimOf('V1', 'promos never exceed the price', 'claude', at), status: 'broken', counterexample: 'SAVE50 + SAVE60 on $10 = −$1' }
  expect(stepStatus([a, b])).toBe('open')
  expect(stepStatus([b])).toBe('open')
  expect(stepStatus([b], 'checked')).toBe('checked')
  expect(stepStatus([a, b], 'checked')).toBe('open')
  expect(stepStatus([b], 'proved')).toBe('checked')
  expect(stepStatus([a, b, c], 'proved')).toBe('broken')
  expect(weakest([b, a])?.says).toBe('ids are dense')
  expect(weakest([a, b, c])?.says).toBe('promos never exceed the price')
  expect(weakest([])).toBeUndefined()
})

test('labels come from status and source, never from the model, and name the human as evidence to verify', () => {
  expect(label(claimOf('V1', 'x', 'wording', at))).toBe('I assumed this; nobody checked')
  expect(label(claimOf('V1', 'x', 'claude', at))).toBe('Claude says · not checked')
  expect(label(claimOf('V1', 'x', 'you', at))).toBe('you said so · not checked yet')
  expect(label(claimOf('V1', 'x', 'data', at))).toBe('seen in the data · not checked')
  expect(label({ ...claimOf('V1', 'x', 'tool', at), isChecking: true })).toBe('checking…')
  const run: Evidence = { kind: 'test', command: 'bun test', exitCode: 0, cases: 2000, ms: 800, tail: '2000 pass' }
  expect(label(checked(claimOf('V1', 'x', 'claude', at), run, at))).toBe('ran 2,000 cases · tool ran')
  expect(label({ ...checked(claimOf('V1', 'x', 'claude', at), run, at), stale: true })).toBe('ran 2,000 cases · tool ran · stale: the file changed since')
})

test('a failing run makes a claim broken with the last output line as its case; a passing one checked, never proved', () => {
  const fail: Evidence = { kind: 'test', command: 'bun test', exitCode: 1, ms: 800, tail: 'expected total ≥ 0\nSAVE50 + SAVE60 on $10 = −$1' }
  const broken = checked(claimOf('V1', 'promos never exceed the price', 'claude', at), fail, at + 1)
  expect(broken.status).toBe('broken')
  expect(broken.counterexample).toBe('SAVE50 + SAVE60 on $10 = −$1')
  expect(label(broken)).toBe('SAVE50 + SAVE60 on $10 = −$1 · tool ran')
  const pass: Evidence = { kind: 'differential', command: 'diff', exitCode: 0, cases: 12, ms: 10, tail: '' }
  expect(checked(broken, pass, at + 2).status).toBe('checked')
  expect(checked(broken, pass, at + 2).counterexample).toBeUndefined()
})

test('proved needs a green build, the three standard axioms, no sorry, and the English accepted', () => {
  const green: Evidence = { kind: 'lean', command: 'lake build', exitCode: 0, ms: 1700, tail: 'Build completed successfully', theorem: 'combine_le_own', axioms: ['propext', 'Classical.choice', 'Quot.sound'] }
  const claim = claimOf('A2', 'a conclusion is never stronger than its premises', 'claude', at)
  expect(proved(claim, green, true, at).status).toBe('proved')
  expect(label(proved(claim, green, true, at))).toBe('by combine_le_own · lake build green')
  expect(proved(claim, green, false, at).status).toBe('checked')
  expect(proved(claim, { ...green, hasSorry: true }, true, at).status).toBe('broken')
  expect(proved(claim, { ...green, axioms: ['propext', 'myAxiom'] }, true, at).status).toBe('broken')
  expect(proved(claim, { ...green, exitCode: 1, tail: 'error: unsolved goals' }, true, at).counterexample).toBe('error: unsolved goals')
  expect(isStandardAxioms([])).toBe(true)
  expect(isStandardAxioms(['Quot.sound', 'sorryAx'])).toBe(false)
})

test('sameClaim matches by step and words, and glyphs cover every status', () => {
  expect(sameClaim({ step: 'V1', says: 'x' }, { step: 'V1', says: 'x' })).toBe(true)
  expect(sameClaim({ step: 'V1', says: 'x' }, { step: 'V2', says: 'x' })).toBe(false)
  for (const status of STATUSES) expect(GLYPH[status].length).toBeGreaterThan(0)
})

test('the counterexample is the last line that names a failure, never the runner\'s summary count', () => {
  expect(counterexampleOf('cart.spec.ts:\n✗ SAVE50 + SAVE60 on $10 must not go below $0\n  expected ≥ 0, got -10000\n 1 pass\n 2 fail')).toBe('expected ≥ 0, got -10000')
  expect(counterexampleOf('all good\nexit 1')).toBe('exit 1')
  expect(counterexampleOf('')).toBe('a case fails')
  expect(counterexampleOf('"" → slow: "0" fast: "-1"')).toBe('"" → slow: "0" fast: "-1"')
})

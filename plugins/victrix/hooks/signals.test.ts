import { expect, test } from 'claude-code/testing'

import type { ActivityLine, Claim } from '../types'
import { isInhibited, needWords, signalsOf, worst } from './signals'
import type { SignalInput } from './signals'

const NOW = 1_700_000_000_000
const call = (text: string, isOk = true, extra: Partial<ActivityLine> = {}): ActivityLine => ({ text, isOk, at: NOW, ...extra })
const claim = (status: Claim['status'], source: Claim['source'], extra: Partial<Claim> = {}): Claim => ({ step: 'Lens', says: 'x is int', status, source, at: NOW, ...extra })
const quiet: SignalInput = { spoken: [], calls: [], stepCalls: [], claims: [claim('checked', 'tool')], hasJudge: true, openOptions: 0, unsure: 0, offPlanTurns: 0 }

test('a quiet, checked step raises nothing', () => {
  expect(signalsOf(quiet)).toEqual([])
})

test('unbacked: Claude says the tests pass and no test ran this turn, a caution', () => {
  const signals = signalsOf({ ...quiet, spoken: ['All tests pass now, moving on.'], calls: [call('edit lens.tsx')] })
  expect(signals.map(one => one.kind)).toEqual(['unbacked'])
  expect(signals[0]?.level).toBe('caution')
  expect(signals[0]?.words).toBe('says all tests pass · no test ran')
})

test('contradicted: Claude says verified and the test that ran failed, a warning at once', () => {
  const signals = signalsOf({ ...quiet, spoken: ['Verified.'], calls: [call('run bun test', false)] })
  expect(signals[0]).toEqual({ kind: 'contradicted', needs: 'claude', level: 'warning', words: 'says verified · bun test failed' })
})

test('a passing run backs the words: no signal', () => {
  expect(signalsOf({ ...quiet, spoken: ['tests pass'], calls: [call('run bun test', true)] })).toEqual([])
})

test('the mod’s own check tool counts as a verifying call', () => {
  expect(signalsOf({ ...quiet, spoken: ['confirmed'], calls: [call('victrix check', true)] })).toEqual([])
})

test('a declined run is neither a pass nor a failure: the words stay unbacked', () => {
  const signals = signalsOf({ ...quiet, spoken: ['it works'], calls: [call('run bun test', false, { isDeclined: true })] })
  expect(signals.map(one => one.kind)).toEqual([])
})

test('repeating: the same command failing twice is a caution, three times a warning', () => {
  const twice = signalsOf({ ...quiet, stepCalls: [call('run bun test', false), call('edit a.ts'), call('run bun test', false)] })
  expect(twice[0]).toEqual({ kind: 'repeating', needs: 'claude', level: 'caution', words: '2nd run of bun test, still failing' })
  const thrice = signalsOf({ ...quiet, stepCalls: [call('run bun test', false), call('run bun test', false), call('run bun test', false)] })
  expect(thrice[0]).toEqual({ kind: 'repeating', needs: 'claude', level: 'warning', words: '3rd run of bun test, still failing' })
})

test('repeating: the same file edited four times in one step', () => {
  const signals = signalsOf({ ...quiet, stepCalls: Array.from({ length: 4 }, () => call('edit lens.tsx')) })
  expect(signals[0]?.words).toBe('4th edit lens.tsx this step')
})

test('unchecked: a fact assumed by Claude that nothing checked is an advisory, counted when several', () => {
  expect(signalsOf({ ...quiet, claims: [claim('open', 'claude')] })[0]).toEqual({ kind: 'unchecked', needs: 'maths', level: 'advisory', words: 'assumed by Claude · nobody checked' })
  expect(signalsOf({ ...quiet, claims: [claim('open', 'claude'), claim('open', 'claude')] })[0]?.words).toBe('2 assumed by Claude · nobody checked')
  expect(signalsOf({ ...quiet, claims: [claim('open', 'you')] })).toEqual([])
})

test('missing: no facts and no check; options worth 2× left open; answers still not sure', () => {
  expect(signalsOf({ ...quiet, claims: [], hasJudge: false })[0]).toEqual({ kind: 'missing', needs: 'maths', level: 'advisory', words: 'no facts, no check' })
  expect(signalsOf({ ...quiet, openOptions: 2 })[0]).toEqual({ kind: 'missing', needs: 'maths', level: 'caution', words: '2 options worth 2× · neither built nor declined' })
  expect(signalsOf({ ...quiet, unsure: 1 })[0]?.words).toBe('1 answer still not sure')
})

test('stale and off-plan', () => {
  expect(signalsOf({ ...quiet, claims: [claim('checked', 'tool', { stale: true })] })[0]?.kind).toBe('stale')
  expect(signalsOf({ ...quiet, offPlanTurns: 3 })[0]).toEqual({ kind: 'off-plan', needs: 'claude', level: 'advisory', words: 'off-plan · 3 turns' })
  expect(signalsOf({ ...quiet, offPlanTurns: 6 })[0]?.level).toBe('caution')
})

test('the worst signal comes first and is the one the line above the prompt carries', () => {
  const signals = signalsOf({ ...quiet, spoken: ['fixed it'], calls: [call('run bun test', false)], claims: [claim('open', 'claude')], unsure: 1 })
  expect(signals.map(one => one.level)).toEqual(['warning', 'advisory', 'advisory'])
  expect(worst(signals)?.kind).toBe('contradicted')
})

test('needWords says which side needs more: the maths, Claude, or both', () => {
  expect(needWords(signalsOf({ ...quiet, claims: [claim('open', 'claude')] }))).toBe('the maths needs more')
  expect(needWords(signalsOf({ ...quiet, spoken: ['tests pass'], calls: [call('edit a.ts')] }))).toBe('Claude needs a steer')
  expect(needWords(signalsOf({ ...quiet, spoken: ['tests pass'], calls: [call('edit a.ts')], claims: [claim('open', 'claude')] }))).toBe('the maths and Claude both need more')
  expect(needWords([])).toBe('')
})

test('inhibit: cautions hold while typing, under a dialog or just after a verb; warnings pass through', () => {
  const caution = { kind: 'unbacked', needs: 'claude', level: 'caution', words: '' } as const
  const warning = { kind: 'contradicted', needs: 'claude', level: 'warning', words: '' } as const
  expect(isInhibited(caution, { isTyping: true, isDialogUp: false, msSinceVerb: 60_000 })).toBe(true)
  expect(isInhibited(caution, { isTyping: false, isDialogUp: false, msSinceVerb: 1000 })).toBe(true)
  expect(isInhibited(caution, { isTyping: false, isDialogUp: false, msSinceVerb: 60_000 })).toBe(false)
  expect(isInhibited(warning, { isTyping: true, isDialogUp: true, msSinceVerb: 0 })).toBe(false)
})

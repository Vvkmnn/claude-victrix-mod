import { expect, test } from 'claude-code/testing'

import { EMPTY_ACTIVITY, LAST_KEPT, describeCall, describeResult, formatTokens, reduceActivity, timeOn } from './activity'
import type { ActivityEvent } from './activity'

const run = (events: readonly ActivityEvent[]) => events.reduce(reduceActivity, EMPTY_ACTIVITY)

test('describeCall says what a call did and to what', () => {
  const cases: readonly [string, Record<string, unknown>, string][] = [
    ['Read', { file_path: '/repo/hooks/plan.ts' }, 'read plan.ts'],
    ['Edit', { file_path: '/repo/hooks/lens.tsx', old_string: 'a', new_string: 'b' }, 'edit lens.tsx'],
    ['Write', { file_path: '/repo/a.md', content: '' }, 'write a.md'],
    ['NotebookEdit', { notebook_path: '/repo/n.ipynb' }, 'edit n.ipynb'],
    ['Bash', { command: 'claude plugin test plugins/victrix' }, 'run claude plugin test plugins/victrix'],
    ['Bash', { command: 'cd /x &&\n  ' + 'y'.repeat(80) }, `run cd /x && ${'y'.repeat(30)}…`],
    ['Grep', { pattern: 'ui.render' }, 'search ui.render'],
    ['Glob', { pattern: '**/*.ts' }, 'search **/*.ts'],
    ['Agent', { description: 'Find auth patterns', prompt: 'x' }, 'helper: Find auth patterns'],
    ['WebFetch', { url: 'https://code.claude.com/docs/en/plugins/mods/troubleshoot', prompt: 'x' }, 'fetch code.claude.com/docs/en/plugins/mod…'],
    ['mcp__reddit__search_reddit', { query: 'x' }, 'reddit search_reddit'],
    ['TodoWrite', {}, 'todowrite'],
    ['Read', {}, 'read'],
  ]

  for (const [tool, input, expected] of cases) expect(describeCall(tool, input)).toBe(expected)
})

test('a turn starts thinking, shows the running call, then logs it newest first', () => {
  const state = run([
    { kind: 'turn-start' },
    { kind: 'call-start', text: 'read plan.ts' },
  ])
  expect(state.doing).toBe('read plan.ts')

  const after = reduceActivity(state, { kind: 'call-end', text: 'read plan.ts', isOk: true })
  expect(after.doing).toBe('thinking')
  expect(after.last).toEqual([{ text: 'read plan.ts', isOk: true }])
})

test('the log keeps only the newest LAST_KEPT calls, newest first, and a failure is kept as such', () => {
  const ends = Array.from({ length: LAST_KEPT + 2 }, (_, n): ActivityEvent => ({ kind: 'call-end', text: `call ${n}`, isOk: n !== LAST_KEPT + 1 }))
  const state = run(ends)

  expect(state.last).toHaveLength(LAST_KEPT)
  expect(state.last[0]?.text).toBe(`call ${LAST_KEPT + 1}`)
  expect(state.last[LAST_KEPT - 1]?.text).toBe('call 2')
  expect(state.last[0]?.isOk).toBe(false)
})

test('a call carries its time, its length, its step and what Claude said before it; the words are spent on one call', () => {
  const state = run([
    { kind: 'step-enter', name: 'Lens', at: 1000 },
    { kind: 'turn-start' },
    { kind: 'said', text: 'The clamp belongs in one place. Then run the tests.' },
    { kind: 'call-start', text: 'edit cart.ts', at: 2000 },
    { kind: 'call-end', text: 'edit cart.ts', isOk: true, at: 2000, ms: 300 },
    { kind: 'call-start', text: 'run bun test', at: 3000 },
    { kind: 'call-end', text: 'run bun test', isOk: false, at: 3000, ms: 800 },
  ])

  expect(state.last[1]).toEqual({ text: 'edit cart.ts', isOk: true, at: 2000, ms: 300, step: 'Lens', said: 'The clamp belongs in one place.', saidBy: 'claude' })
  expect(state.last[0]).toEqual({ text: 'run bun test', isOk: false, at: 3000, ms: 800, step: 'Lens', said: undefined, saidBy: undefined })

  // The person's verb, delivered before a call, is that call's reason and outlives Claude's thinking until the call.
  const yours = run([
    { kind: 'said', text: 'thinking about caching', by: 'claude' },
    { kind: 'said', text: 'doubt · Lens', by: 'you' },
    { kind: 'said', text: 'more thinking', by: 'claude' },
    { kind: 'turn-start' },
    { kind: 'call-end', text: 'read cart.ts', isOk: true },
    { kind: 'call-end', text: 'edit cart.ts', isOk: true },
  ])
  expect(yours.last[1]).toMatchObject({ said: 'doubt · Lens', saidBy: 'you' })
  expect(yours.last[0]?.said).toBeUndefined()
  expect(state.steps.Lens).toMatchObject({ calls: 2, fails: 1, enteredAt: 1000 })
})

test('entering a step starts its clock, leaving it keeps the time, and spend lands on the lit step only', () => {
  const usage = { input_tokens: 100, output_tokens: 50 }
  const entered = run([{ kind: 'step-enter', name: 'A', at: 1000 }, { kind: 'usage', usage }])
  expect(entered.steps.A).toMatchObject({ tokens: 150, enteredAt: 1000, ms: 0 })
  expect(timeOn(entered, 'A', 4000)).toBe(3000)

  const moved = reduceActivity(entered, { kind: 'step-enter', name: 'B', at: 5000 })
  expect(moved.steps.A).toMatchObject({ tokens: 150, enteredAt: 0, ms: 4000 })
  expect(timeOn(moved, 'A', 9000)).toBe(4000)
  expect(moved.stepNow).toBe('B')

  const back = reduceActivity(moved, { kind: 'step-enter', name: 'A', at: 6000 })
  expect(timeOn(back, 'A', 7000)).toBe(5000)
  expect(timeOn(back, 'missing', 7000)).toBe(0)

  const noStep = run([{ kind: 'usage', usage }, { kind: 'call-end', text: 'x', isOk: false }])
  expect(noStep.steps).toEqual({})
  expect(noStep.last[0]?.step).toBeUndefined()
})

test('usage adds to the session and to this turn; a new turn resets only the turn', () => {
  const usage = { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, output_tokens: 50 }
  const state = run([{ kind: 'turn-start' }, { kind: 'usage', usage }, { kind: 'usage', usage }, { kind: 'turn-end' }, { kind: 'turn-start' }, { kind: 'usage', usage }])

  // Fresh tokens only: the 900 cache reads per request are the context re-sent, not what the step cost.
  expect(state).toMatchObject({ tokensIn: 300, tokensOut: 150, turnIn: 100, turnOut: 50 })
})

test('missing usage fields count as zero; the turn ends idle', () => {
  const state = run([{ kind: 'turn-start' }, { kind: 'usage', usage: {} }, { kind: 'turn-end' }])

  expect(state).toMatchObject({ doing: null, tokensIn: 0, tokensOut: 0 })
})

test('the reducer never mutates the state it is given', () => {
  const before = run([{ kind: 'call-end', text: 'a', isOk: true }])
  const frozen = JSON.stringify(before)
  reduceActivity(before, { kind: 'call-end', text: 'b', isOk: true })

  expect(JSON.stringify(before)).toBe(frozen)
})

test('describeResult gives the lowest level the engine had: lines added and removed, lines written, the range read, the hits, the exit code; nothing when it had none', () => {
  expect(describeResult('Edit', { old_string: 'a', new_string: 'a\nb\nc' }, { result: 'ok' })).toBe('+3 −1')
  expect(describeResult('Edit', { old_string: '', new_string: 'x' }, {})).toBe('+1 −0')
  expect(describeResult('Write', { content: 'one\ntwo' }, {})).toBe('2 lines')
  expect(describeResult('Read', { file_path: '/a.ts', offset: 92, limit: 44 }, {})).toBe('92–135')
  expect(describeResult('Read', { file_path: '/a.ts', offset: 10 }, {})).toBe('from 10')
  expect(describeResult('Read', { file_path: '/a.ts' }, { result: '1\tx\n2\ty\n3\tz' })).toBe('3 lines')
  expect(describeResult('Read', { file_path: '/a.ts' }, { result: '' })).toBeUndefined()
  expect(describeResult('Read', { file_path: '/a.ts' }, { result: '1\tx' })).toBe('1 line')
  expect(describeResult('Write', { content: 'x' }, {})).toBe('1 line')
  expect(describeResult('Grep', { pattern: 'x' }, { result: 'Found 4 files\na\nb\nc\nd' })).toBe('4 files')
  expect(describeResult('Grep', { pattern: 'x' }, { result: 'a:1:x\nb:2:x' })).toBe('2 hits')
  expect(describeResult('Grep', { pattern: 'x' }, { result: 'a:1:x' })).toBe('1 hit')
  expect(describeResult('Grep', { pattern: 'x' }, { result: '' })).toBe('nothing')
  expect(describeResult('Glob', { pattern: '*.ts' }, { result: '/a.ts\n/b.ts' })).toBe('2 files')
  expect(describeResult('Bash', { command: 'bun test' }, { isError: true, result: 'Exit code 1\nboom' })).toBe('exit 1')
  expect(describeResult('Bash', { command: 'bun test' }, { result: 'all good' })).toBeUndefined()
  expect(describeResult('WebFetch', { url: 'https://x.y' }, { result: 'page' })).toBeUndefined()
  expect(describeResult('Agent', { description: 'scan' }, { result: 'done' })).toBeUndefined()
})

test("a helper's call is a running line while it runs, then its own done line with its tag; the head row stays the main loop's", () => {
  let state = reduceActivity(EMPTY_ACTIVITY, { kind: 'turn-start' })
  state = reduceActivity(state, { kind: 'call-start', text: 'edit lens.tsx', at: 1000 })
  state = reduceActivity(state, { kind: 'call-start', text: 'read layout.ts', at: 1100, helper: 'scan glyphs' })
  expect(state.doing).toBe('edit lens.tsx')
  expect(state.last[0]).toMatchObject({ text: 'read layout.ts', helper: 'scan glyphs', isRunning: true })
  state = reduceActivity(state, { kind: 'call-end', text: 'read layout.ts', isOk: true, at: 1100, ms: 40, helper: 'scan glyphs', detail: '12 lines' })
  expect(state.doing).toBe('edit lens.tsx')
  expect(state.last.filter(one => one.isRunning)).toHaveLength(0)
  expect(state.last[0]).toMatchObject({ text: 'read layout.ts', helper: 'scan glyphs', isOk: true, detail: '12 lines' })
  expect(state.last[0]?.said).toBeUndefined()
  state = reduceActivity(state, { kind: 'call-end', text: 'edit lens.tsx', isOk: true, at: 1000, ms: 300, detail: '+3 −1' })
  expect(state.doing).toBe('thinking')
  expect(state.last[0]).toMatchObject({ text: 'edit lens.tsx', detail: '+3 −1' })
  expect(state.last[0]?.helper).toBeUndefined()
})

test('formatTokens reads at a glance', () => {
  expect([0, 950, 1000, 12_400, 999_499, 1_000_000, 1_250_000].map(formatTokens)).toEqual(['0', '950', '1k', '12k', '999k', '1.0M', '1.3M'])
})

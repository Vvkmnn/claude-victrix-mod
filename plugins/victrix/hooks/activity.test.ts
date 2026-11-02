import { expect, test } from 'claude-code/testing'

import { EMPTY_ACTIVITY, LAST_KEPT, describeCall, formatTokens, reduceActivity } from './activity'
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

test('the log keeps only the newest five, and a failure is kept as such', () => {
  const ends = Array.from({ length: 7 }, (_, n): ActivityEvent => ({ kind: 'call-end', text: `call ${n}`, isOk: n !== 6 }))
  const state = run(ends)

  expect(state.last).toHaveLength(LAST_KEPT)
  expect(state.last.map(line => line.text)).toEqual(['call 6', 'call 5', 'call 4', 'call 3', 'call 2'])
  expect(state.last[0]?.isOk).toBe(false)
})

test('usage adds to the session and to this turn; a new turn resets only the turn', () => {
  const usage = { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, output_tokens: 50 }
  const state = run([{ kind: 'turn-start' }, { kind: 'usage', usage }, { kind: 'usage', usage }, { kind: 'turn-end' }, { kind: 'turn-start' }, { kind: 'usage', usage }])

  expect(state).toMatchObject({ tokensIn: 3000, tokensOut: 150, turnIn: 1000, turnOut: 50 })
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

test('formatTokens reads at a glance', () => {
  expect([0, 950, 1000, 12_400, 999_499, 1_000_000, 1_250_000].map(formatTokens)).toEqual(['0', '950', '1k', '12k', '999k', '1.0M', '1.3M'])
})

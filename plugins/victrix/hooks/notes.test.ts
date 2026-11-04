import { expect, test } from 'claude-code/testing'

import type { Note } from '../types'
import { LOG_KEPT, VERBS, appendLog, deliveryText, describeNote, logLine } from './notes'

const AT = Date.UTC(2026, 10, 3, 1, 2, 3)

const doubt: Note = { kind: 'doubt', step: 'V1 The live lens', text: '', at: AT }
const wrong: Note = { kind: 'wrong', step: 'A6 Proof packs', text: '', at: AT }
const add: Note = { kind: 'add', step: 'Panel', text: 'prices are integers in cents', at: AT }

test('every verb has a lowercase key and a visible label', () => {
  expect(VERBS.map(verb => [verb.kind, verb.hotkey, verb.label])).toEqual([
    ['doubt', 'd', 'doubt'],
    ['add', 'a', 'add a fact'],
    ['wrong', 'w', 'wrong path'],
  ])
  for (const verb of VERBS) expect(verb.hotkey).toMatch(/^[a-z]$/)
})

test('describeNote names the verb and the step, and the fact when there is one', () => {
  expect(describeNote(doubt)).toBe('doubt · V1 The live lens')
  expect(describeNote(add)).toBe('add a fact · Panel · prices are integers in cents')
})

test('deliveryText tells Claude to act at its next step, one imperative line per note, never a question back', () => {
  const text = deliveryText([doubt, wrong, add])

  expect(text.split('\n')[0]).toContain('Act on each at your next step')
  expect(text).toContain('- DOUBT on step "V1 The live lens": the person doubts what this step rests on. Before relying on it, re-check it with a tool')
  expect(text).toContain('- WRONG PATH on step "A6 Proof packs": the person says this branch is wrong. Stop it')
  expect(text).toContain('- ADD DATA for step "Panel": prices are integers in cents. Fold this fact into the plan; replan only the steps it changes.')
  expect(text).not.toMatch(/\?/)
})

test('logLine is an ISO time and the note', () => {
  expect(logLine(add)).toBe('2026-11-03T01:02:03.000Z add a fact · Panel · prices are integers in cents')
})

test('appendLog keeps the newest LOG_KEPT lines, newest last, and never mutates', () => {
  const log = Array.from({ length: LOG_KEPT }, (_, n) => `line ${n}`)
  const frozen = JSON.stringify(log)
  const after = appendLog(log, 'newest')

  expect(after).toHaveLength(LOG_KEPT)
  expect(after[0]).toBe('line 1')
  expect(after.at(-1)).toBe('newest')
  expect(JSON.stringify(log)).toBe(frozen)
})

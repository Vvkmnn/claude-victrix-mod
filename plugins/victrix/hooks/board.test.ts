import { expect, test } from 'claude-code/testing'

import type { ActivityLine, Claim, PlanItem } from '../types'
import { EFFORT_HALF, LOG_CAP, LOG_FLOOR, budget, creepCells, foldLog, headFraction } from './board'

const step = (children: readonly PlanItem[] = []): PlanItem =>
  ({ name: 'Lens', note: '', why: '', trade: '', judge: '', assumptions: [], facts: [], guard: '', options: [], slow: '', isDone: false, isAbandoned: false, line: 1, children }) as PlanItem
const child = (isDone: boolean, isAbandoned = false): PlanItem => ({ ...step(), name: 'sub', isDone, isAbandoned })
const claim = (status: Claim['status']): Claim => ({ step: 'Lens', says: 'x', status, source: 'claude', at: 0 })
const call = (text: string, isOk = true, isDeclined?: boolean): ActivityLine => ({ text, isOk, ...(isDeclined ? { isDeclined } : {}) })

test('headFraction is a true fraction with sub-steps or facts, and never counts an abandoned sub-step', () => {
  expect(headFraction(step([child(true), child(false)]), [], 99)).toBe(0.5)
  expect(headFraction(step([child(true), child(false, true)]), [claim('checked'), claim('open')], 0)).toBe(2 / 3)
  expect(headFraction(step(), [claim('proved')], 0)).toBe(1)
})

test('headFraction by effort climbs fast, then slows, and never reaches one', () => {
  expect(headFraction(step(), [], 0)).toBe(0)
  expect(headFraction(step(), [], EFFORT_HALF)).toBe(0.5)
  expect(headFraction(step(), [], 1000)).toBeLessThan(1)
  expect(headFraction(step(), [], 1000)).toBeGreaterThan(0.97)
})

test('creepCells covers more of the distance with effort and never the last cell', () => {
  expect(creepCells(0, 37)).toBe(0)
  expect(creepCells(EFFORT_HALF, 37)).toBe(18)
  expect(creepCells(100000, 37)).toBe(36)
  expect(creepCells(100000, 1)).toBe(0)
})

test('foldLog folds identical consecutive calls with a count and keeps a failure apart from a pass', () => {
  const rows = foldLog([call('edit a.ts'), call('edit a.ts'), call('read b.ts'), call('edit a.ts'), call('run bun test', false), call('run bun test', true)])
  // Reads and searches show too (owner: "anything Claude is doing for this plan"); only identical neighbours fold.
  expect(rows.map(row => [row.line.text, row.line.isOk, row.count])).toEqual([
    ['edit a.ts', true, 2],
    ['read b.ts', true, 1],
    ['edit a.ts', true, 1],
    ['run bun test', false, 1],
    ['run bun test', true, 1],
  ])
})

const full = { rows: 50, hasLive: true, doneCount: 12, openCount: 27, proofUnits: 3, logRows: 20, hasProblem: false }

test('budget at fifty rows: footer with its rule, every proof unit, all open steps, all done steps, the log capped at eight', () => {
  const got = budget(full)
  expect(got.footer).toBe(3)
  expect(got.proofUnits).toBe(3)
  expect(got.done).toBe(12)
  expect(got.doneFolded).toBe(0)
  expect(got.open + got.openFolded).toBe(27)
  expect(got.log).toBeLessThanOrEqual(LOG_CAP)
  expect(got.log).toBeGreaterThanOrEqual(LOG_FLOOR)
})

test('the log gets its floor of rows before the done rows fill the horizon, and never more rows than it has', () => {
  // At twenty rows the floor is not reached: the pane is handed out before it (footer, head, proof, the open base).
  expect(budget({ ...full, rows: 20 }).log).toBe(6)
  for (const rows of [24, 30, 40]) expect([rows, budget({ ...full, rows }).log >= LOG_FLOOR]).toEqual([rows, true])
  expect(budget({ ...full, rows: 30, logRows: 3 }).log).toBe(3)
})

test('budget at twelve rows keeps the box, the live step, the footer without its rule, the log head and two rows, one proof unit', () => {
  const got = budget({ ...full, rows: 12 })
  expect(got.footer).toBe(2)
  expect(got.logHead).toBe(1)
  expect(got.log).toBe(2)
  expect(got.proofUnits).toBe(1)
  expect(got.done + got.open).toBe(0)
  expect(got.doneFoldRow).toBe(false)
  expect(got.openFoldRow).toBe(false)
})

test('budget keeps the live step at the horizon: done rows above it stop near 45% until everything else is shown', () => {
  const got = budget({ rows: 40, hasLive: true, doneCount: 30, openCount: 27, proofUnits: 3, logRows: 20, hasProblem: false })
  expect(got.done).toBeLessThan(30)
  expect(got.doneFoldRow).toBe(true)
  expect(got.proofUnits).toBe(3)
  expect(got.log).toBeGreaterThanOrEqual(2)
  expect(got.log).toBeLessThanOrEqual(LOG_CAP)
})

test('budget is monotone in height: no count shrinks as rows grow', () => {
  const keys = ['footer', 'logHead', 'proofUnits', 'open', 'done', 'log'] as const
  for (let rows = 6; rows < 60; rows += 1) {
    const small = budget({ ...full, rows })
    const large = budget({ ...full, rows: rows + 1 })
    for (const key of keys) expect([rows, key, small[key], large[key]]).toEqual([rows, key, small[key], Math.max(small[key], large[key])])
  }
})

test('budget never hands out more rows than it has', () => {
  for (const rows of [4, 6, 8, 10, 12, 16, 24, 30, 50]) {
    const got = budget({ ...full, rows })
    const used = 3 + 2 + got.footer + got.logHead + got.proofUnits * 2 + got.open + (got.openFoldRow ? 1 : 0) + got.done + (got.doneFoldRow ? 1 : 0) + got.log + got.padding
    expect([rows, used]).toEqual([rows, Math.max(rows, 5)])
  }
})

test('the log takes rows past its cap only when nothing else is left to show', () => {
  const quiet = budget({ rows: 50, hasLive: true, doneCount: 1, openCount: 1, proofUnits: 0, logRows: 30, hasProblem: false })
  expect(quiet.log).toBeGreaterThan(LOG_CAP)
  const busy = budget({ rows: 50, hasLive: true, doneCount: 12, openCount: 27, proofUnits: 3, logRows: 30, hasProblem: false })
  expect(busy.log).toBe(LOG_CAP)
})

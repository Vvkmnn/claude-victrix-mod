import { expect, test } from 'claude-code/testing'

import { DOCK_SHARE, chooseSize, dockColumns, nextSize } from './form'

const base = { choice: 'auto' as const, isPlanMode: false, isDialogUp: false }

test('the pane, the largest, in every mode and under every dialog, whatever the width: the row and hidden only when chosen', () => {
  expect(chooseSize(base)).toBe('pane')
  expect(chooseSize({ ...base, isPlanMode: true })).toBe('pane')
  expect(chooseSize({ ...base, isDialogUp: true })).toBe('pane')
  expect(chooseSize({ ...base, isPlanMode: true, isDialogUp: true })).toBe('pane')
  expect(chooseSize({ ...base, choice: 'pane' })).toBe('pane')
  expect(chooseSize({ ...base, choice: 'row' })).toBe('row')
  expect(chooseSize({ ...base, choice: 'hidden' })).toBe('hidden')
})

test('s cycles pane, row, hidden and back to the pane', () => {
  expect(nextSize('pane')).toBe('row')
  expect(nextSize('row')).toBe('hidden')
  expect(nextSize('hidden')).toBe('pane')
})

test('the dock asks for 27% of the terminal, inside the engine floor of 24 and ceiling of 45%', () => {
  expect(DOCK_SHARE).toBe(0.27)
  expect(dockColumns(200)).toBe(54)
  expect(dockColumns(60)).toBe(24)
  expect(dockColumns(40)).toBe(24)
  expect(dockColumns(1000)).toBe(270)
})

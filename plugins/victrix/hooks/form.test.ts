import { expect, test } from 'claude-code/testing'

import { DOCK_SHARE, chooseSize, dockColumns, nextSize, sizeChoiceOf } from './form'

const base = { choice: 'auto' as const, isPlanMode: false, isDialogUp: false, canDock: true }

test('the pane whenever a dock can seat, in every mode and under every dialog; the row only when none can', () => {
  expect(chooseSize(base)).toBe('pane')
  expect(chooseSize({ ...base, isPlanMode: true })).toBe('pane')
  expect(chooseSize({ ...base, isDialogUp: true })).toBe('pane')
  expect(chooseSize({ ...base, isPlanMode: true, isDialogUp: true })).toBe('pane')
  expect(chooseSize({ ...base, canDock: false })).toBe('row')
  expect(chooseSize({ ...base, choice: 'pane', canDock: false })).toBe('row')
})

test('a standing choice is kept: the row where a dock could seat, hidden at any width', () => {
  expect(chooseSize({ ...base, choice: 'row' })).toBe('row')
  expect(chooseSize({ ...base, choice: 'pane' })).toBe('pane')
  expect(chooseSize({ ...base, choice: 'hidden' })).toBe('hidden')
  expect(chooseSize({ ...base, choice: 'hidden', canDock: false })).toBe('hidden')
})

test('s cycles pane, row, hidden and back to the pane', () => {
  expect(nextSize('pane')).toBe('row')
  expect(nextSize('row')).toBe('hidden')
  expect(nextSize('hidden')).toBe('pane')
})

test('a stored choice from before the rename reads as its new name; anything else is no choice', () => {
  expect(sizeChoiceOf('third')).toBe('pane')
  expect(sizeChoiceOf('tape')).toBe('row')
  expect(sizeChoiceOf('pane')).toBe('pane')
  expect(sizeChoiceOf('row')).toBe('row')
  expect(sizeChoiceOf('hidden')).toBe('hidden')
  expect(sizeChoiceOf('auto')).toBe('auto')
  expect(sizeChoiceOf('strip')).toBeUndefined()
  expect(sizeChoiceOf(undefined)).toBeUndefined()
  expect(sizeChoiceOf(3)).toBeUndefined()
})

test('the dock asks for 27% of the terminal, inside the engine floor of 24 and ceiling of 45%', () => {
  expect(DOCK_SHARE).toBe(0.27)
  expect(dockColumns(200)).toBe(54)
  expect(dockColumns(60)).toBe(24)
  expect(dockColumns(40)).toBe(24)
  expect(dockColumns(1000)).toBe(270)
})

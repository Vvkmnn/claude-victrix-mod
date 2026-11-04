import { expect, test } from 'claude-code/testing'

import { DOCK_SHARE, chooseForm, dockColumns } from './form'

const base = { choice: 'auto' as const, isPlanMode: false, isDialogUp: false, canDock: true }

test('the map whenever a dock can seat, in every mode and under every dialog; the tape only when none can', () => {
  expect(chooseForm(base)).toBe('third')
  expect(chooseForm({ ...base, isPlanMode: true })).toBe('third')
  expect(chooseForm({ ...base, isDialogUp: true })).toBe('third')
  expect(chooseForm({ ...base, isPlanMode: true, isDialogUp: true })).toBe('third')
  expect(chooseForm({ ...base, canDock: false })).toBe('tape')
  expect(chooseForm({ ...base, choice: 'third', canDock: false })).toBe('tape')
})

test('a standing choice of the tape is kept where a dock could seat', () => {
  expect(chooseForm({ ...base, choice: 'tape' })).toBe('tape')
  expect(chooseForm({ ...base, choice: 'third' })).toBe('third')
})

test('the dock asks for 27% of the terminal, inside the engine floor of 24 and ceiling of 45%', () => {
  expect(DOCK_SHARE).toBe(0.27)
  expect(dockColumns('third', 200)).toBe(54)
  expect(dockColumns('third', 60)).toBe(24)
  expect(dockColumns('third', 40)).toBe(24)
  expect(dockColumns('third', 1000)).toBe(270)
})

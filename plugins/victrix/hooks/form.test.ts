import { expect, test } from 'claude-code/testing'

import { chooseForm, choiceLabel, dockColumns, nextChoice } from './form'

const base = { choice: 'auto', isPlanMode: false, isDialogUp: false, canDock: true } as const

test('auto picks the map whenever a dock can seat, in and out of plan mode', () => {
  expect(chooseForm({ ...base, isPlanMode: true })).toBe('third')
  expect(chooseForm({ ...base, isPlanMode: false })).toBe('third')
})

test('a dialog shrinks the third to the strip, and no dock means the tape whatever was chosen', () => {
  expect(chooseForm({ ...base, isPlanMode: true, isDialogUp: true })).toBe('strip')
  expect(chooseForm({ ...base, choice: 'third', isDialogUp: true })).toBe('strip')
  expect(chooseForm({ ...base, choice: 'strip', isDialogUp: true })).toBe('strip')
  expect(chooseForm({ ...base, choice: 'third', canDock: false })).toBe('tape')
  expect(chooseForm({ ...base, isPlanMode: true, canDock: false })).toBe('tape')
})

test('a standing choice wins over the moment', () => {
  expect(chooseForm({ ...base, choice: 'tape', isPlanMode: true })).toBe('tape')
  expect(chooseForm({ ...base, choice: 'third', isPlanMode: false })).toBe('third')
  expect(chooseForm({ ...base, choice: 'strip', isPlanMode: true })).toBe('strip')
})

test('the form button cycles tape, map, strip, auto', () => {
  expect(nextChoice('auto')).toBe('tape')
  expect(nextChoice('tape')).toBe('third')
  expect(nextChoice('third')).toBe('strip')
  expect(nextChoice('strip')).toBe('auto')
  expect(choiceLabel('third')).toBe('map')
  expect(choiceLabel('auto')).toBe('auto')
})

test('dock widths are a third or 13% of the terminal, inside the engine floor and ceiling', () => {
  expect(dockColumns('third', 200)).toBe(50)
  expect(dockColumns('strip', 200)).toBe(26)
  expect(dockColumns('strip', 120)).toBe(24)
  expect(dockColumns('third', 60)).toBe(24)
  expect(dockColumns('third', 0)).toBe(24)
})

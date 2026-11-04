import { expect, test } from 'claude-code/testing'

import { FACE_CELLS, SEP, cells, chips, face, fit, flow, ink, line, pad, pulse, spark, spinner, litIndex, tally, toAscii, trunk, twoEnded, wrap } from './draw'

const WIDTHS = [0, 1, 5, 26, 66] as const

test('cells counts code points, so every glyph the kit uses is one cell', () => {
  expect(cells('')).toBe(0)
  expect(cells('✓ V0 repo')).toBe(9)
  expect(cells('╭─[-_-]━━╸━━')).toBe(12)
})

test('fit never returns more cells than asked, and marks a cut with an ellipsis', () => {
  for (const width of WIDTHS) {
    expect(cells(fit('the quick brown fox jumps over the lazy dog, twice over, and again', width))).toBeLessThanOrEqual(width)
  }
  expect(fit('abc', 3)).toBe('abc')
  expect(fit('abcd', 3)).toBe('ab…')
  expect(fit('abcd', 1)).toBe('…')
  expect(fit('abcd', 0)).toBe('')
  expect(fit('✓ promos ✗', 4)).toBe('✓ p…')
})

test('pad fits then fills to exactly the width', () => {
  for (const width of WIDTHS) {
    expect(cells(pad('short', width))).toBe(width)
    expect(cells(pad('a very long row that must be cut down to size', width))).toBe(width)
  }
})

test('line splits the width into filled, half and rest, always adding up', () => {
  for (const width of WIDTHS) {
    for (const [done, total] of [[0, 10], [5, 10], [10, 10], [1, 3], [7, 0], [-2, 4], [12, 10]] as const) {
      const bar = line(done, total, width)
      expect(cells(bar.filled) + cells(bar.half) + cells(bar.rest)).toBe(width)
    }
  }
  expect(line(5, 10, 10)).toEqual({ filled: '━━━━━', half: '', rest: '━━━━━' })
  expect(line(1, 4, 10)).toEqual({ filled: '━━', half: '╸', rest: '━━━━━━━' })
  expect(line(10, 10, 4)).toEqual({ filled: '━━━━', half: '', rest: '' })
  expect(line(3, 0, 4)).toEqual({ filled: '', half: '', rest: '━━━━' })
})

test('pulse moves a bright window along the line and wraps', () => {
  for (const width of WIDTHS) {
    for (const tick of [0, 3, 25, 400, -1]) {
      const run = pulse(width, tick)
      expect(cells(run.before) + cells(run.bright) + cells(run.after)).toBe(width)
    }
  }
  expect(pulse(10, 0)).toEqual({ before: '', bright: '━━━━━━', after: '━━━━' })
  expect(pulse(10, 7)).toEqual({ before: '━━━━━━━', bright: '━━━', after: '' })
  expect(pulse(10, 10)).toEqual(pulse(10, 0))
})

test('spark keeps the last width values on the eight-step ramp', () => {
  expect(spark([], 8)).toBe('')
  expect(spark([1, 2, 3, 4, 5, 6, 7, 8], 8)).toBe('▁▂▃▄▅▆▇█')
  expect(spark([1, 2, 3, 4, 5, 6, 7, 8], 3)).toBe('▆▇█')
  expect(spark([0, 0], 2)).toBe('▁▁')
  expect(spark([NaN, -4, 9], 3)).toBe('▁▁█')
  for (const width of WIDTHS) expect(cells(spark([3, 1, 4, 1, 5, 9, 2, 6], width))).toBeLessThanOrEqual(width)
})

test('spinner cycles its ten braille frames in both directions of tick', () => {
  expect(spinner(0)).toBe('⠋')
  expect(spinner(9)).toBe('⠏')
  expect(spinner(10)).toBe('⠋')
  expect(spinner(-1)).toBe('⠏')
})

test('the face has three states and a fixed width', () => {
  expect(face('idle')).toBe('[-_-]')
  expect(face('working')).toBe('[o_o]')
  expect(face('worried')).toBe('[o_O]')
  expect(FACE_CELLS).toBe(5)
})

test('flow reads oldest first, marks failures, spins the running call, and drops the oldest to fit', () => {
  const calls = [
    { text: 'search', isOk: true },
    { text: 'run tsc', isOk: false },
    { text: 'read lens.tsx', isOk: true },
    { text: 'edit lens.tsx', isOk: true, isRunning: true },
  ]
  expect(flow(calls, 80, '⠹')).toBe('search ▸ run tsc ✗ ▸ read lens.tsx ▸ ⠹ edit lens.tsx')
  expect(flow(calls, 40, '⠹')).toBe('read lens.tsx ▸ ⠹ edit lens.tsx')
  expect(flow(calls, 10, '⠹')).toBe('⠹ edit le…')
  expect(flow([], 10)).toBe('')
  for (const width of WIDTHS) expect(cells(flow(calls, width, '⠹'))).toBeLessThanOrEqual(width)
})

test('twoEnded keeps the right end whole and cuts the left, never wider than the row', () => {
  expect(twoEnded('left', 'right', 12)).toBe('left   right')
  expect(twoEnded('a long left side', 'right', 12)).toBe('a lon… right')
  expect(twoEnded('left', 'a right side too long for the row', 12)).toBe('a right sid…')
  expect(twoEnded('', 'right', 12)).toBe('       right')
  expect(twoEnded('left', '', 12)).toBe('left')
  for (const width of WIDTHS) {
    expect(cells(twoEnded('the left side of the row', 'the right side', width))).toBeLessThanOrEqual(width)
  }
})

test('chips joins with the separator and fits', () => {
  expect(chips(['✓ V0', '✓ V0a', '~ A5'], 40)).toBe(`✓ V0 ${SEP} ✓ V0a ${SEP} ~ A5`)
  expect(cells(chips(['✓ V0 repo', '✓ V0a research tools', '✓ V0b Boris'], 20))).toBe(20)
})

test('ink sizes a run to the name and never past the width', () => {
  expect(ink(9, 20, 'done')).toBe('━━━')
  expect(ink(9, 20, 'open')).toBe('╌╌╌')
  expect(ink(0, 20, 'now')).toBe('━')
  expect(ink(90, 5, 'done')).toBe('━━━━━')
  expect(ink(9, 0, 'done')).toBe('')
})

test('the trunk prefixes are the one tree, rising into the face', () => {
  expect(trunk('root')).toBe('╭─')
  expect(trunk('step')).toBe('├ ')
  expect(trunk('last')).toBe('╰ ')
  expect(trunk('detail')).toBe('│  ├ ')
  expect(trunk('detailLast')).toBe('│  ╰ ')
  expect(trunk('under')).toBe('│  │  ')
  expect(trunk('gap')).toBe('│  ')
})

test('toAscii keeps a row readable without the glyphs', () => {
  expect(toAscii('╭─[-_-]━━╸━━ 6/15')).toBe('+-[-_-]==-== 6/15')
  expect(toAscii('├ ✓ V0 ⋅ ○ V1 … ▸ ⠹ edit')).toBe('|-v V0 . o V1 ... > * edit')
  expect(toAscii('▁▂▃')).toBe('###')
})

test('wrap breaks on words, never past the width, and cuts a word longer than a row', () => {
  expect(wrap('', 10)).toEqual([])
  expect(wrap('one two three', 0)).toEqual([])
  expect(wrap('one two three', 7)).toEqual(['one two', 'three'])
  expect(wrap('one two three', 100)).toEqual(['one two three'])
  expect(wrap('abcdefghij xy', 5)).toEqual(['abcd…', 'xy'])
  for (const width of [1, 5, 26, 66]) for (const row of wrap('the quick brown fox jumps over the lazy dog, twice', width)) expect(cells(row)).toBeLessThanOrEqual(width)
})

test('tally grows one cell per call, keeps failures apart, marks the running call, and never exceeds its width', () => {
  expect(tally(0, 0, 8)).toEqual({ ok: '', bad: '', running: '', rest: '        ' })
  expect(tally(3, 1, 8)).toEqual({ ok: '━━', bad: '━', running: '', rest: '     ' })
  expect(tally(3, 0, 8, true)).toEqual({ ok: '━━━', bad: '', running: '╸', rest: '    ' })
  expect(tally(20, 2, 8, true)).toEqual({ ok: '━━━━━━', bad: '━━', running: '', rest: '' })
  expect(tally(5, 9, 8)).toEqual({ ok: '', bad: '━━━━━', running: '', rest: '   ' })
  for (const [calls, fails, width] of [[0, 0, 0], [3, 1, 1], [100, 50, 26], [7, 0, 66]] as const) {
    const bar = tally(calls, fails, width, true)
    expect(cells(bar.ok + bar.bad + bar.running + bar.rest)).toBe(width)
  }
})

test('the light travels row by row from the old lit step to the new one and rests there', () => {
  expect(litIndex(undefined, 7, 0, 500)).toBe(7)
  expect(litIndex(3, 3, 100, 500)).toBe(3)
  expect(litIndex(3, 7, 0, 500)).toBe(3)
  expect(litIndex(3, 7, 250, 500)).toBe(5)
  expect(litIndex(3, 7, 500, 500)).toBe(7)
  expect(litIndex(3, 7, 9000, 500)).toBe(7)
  expect(litIndex(7, 3, 125, 500)).toBe(6)
  expect(litIndex(3, 7, 250, 0)).toBe(7)
})

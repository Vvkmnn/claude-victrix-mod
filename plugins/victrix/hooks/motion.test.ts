import { expect, test } from 'claude-code/testing'

import { cells } from './draw'
import { pickTicker, rolled, tickerOffset, tickerPriority, type TickerCandidate } from './motion'

const row = (key: string, text: string, room: number, priority: number, since = 0): TickerCandidate => ({
  key,
  text,
  room,
  priority,
  since,
})

test('pickTicker returns undefined when every candidate fits', () => {
  expect(pickTicker([row('a', 'short', 10, 0), row('b', 'exact', 5, 1)])).toBe(undefined)
  expect(pickTicker([])).toBe(undefined)
})

test('pickTicker prefers the lowest priority among the overflowing ones even if a higher-priority candidate fits', () => {
  const fits = row('call', 'ok', 10, tickerPriority.call)
  const title = row('title', 'a title that is far too long', 10, tickerPriority.title)
  const log = row('log', 'a log row that is far too long', 10, tickerPriority.log)
  expect(pickTicker([log, fits, title])?.key).toBe('title')
})

test('pickTicker breaks a priority tie by the most recent since, then by key order', () => {
  const long = 'this text overflows its room'
  expect(pickTicker([row('a', long, 5, 1, 100), row('b', long, 5, 1, 300), row('c', long, 5, 1, 200)])?.key).toBe('b')
  expect(pickTicker([row('z', long, 5, 1, 100), row('m', long, 5, 1, 100), row('q', long, 5, 1, 100)])?.key).toBe('m')
})

test('tickerOffset rests 2000 ms, rolls a cell per 400 ms, holds at the end for 2000 ms, then wraps to 0', () => {
  expect(tickerOffset(20, 10, 0)).toBe(0)
  expect(tickerOffset(20, 10, 1999)).toBe(0)
  expect(tickerOffset(20, 10, 2000)).toBe(0)
  expect(tickerOffset(20, 10, 2399)).toBe(0)
  expect(tickerOffset(20, 10, 2400)).toBe(1)
  expect(tickerOffset(20, 10, 2800)).toBe(2)
  expect(tickerOffset(20, 10, 5999)).toBe(9)
  expect(tickerOffset(20, 10, 6000)).toBe(10)
  expect(tickerOffset(20, 10, 7999)).toBe(10)
  expect(tickerOffset(20, 10, 8000)).toBe(0)
  expect(tickerOffset(20, 10, 10400)).toBe(1)
})

test('tickerOffset is 0 whenever the text fits', () => {
  expect(tickerOffset(10, 10, 5000)).toBe(0)
  expect(tickerOffset(4, 10, 123456)).toBe(0)
  expect(tickerOffset(0, 0, 3000)).toBe(0)
})

test('rolled returns the right window, never wider than room, and never splits a wide character', () => {
  expect(rolled('abcdefghij', 4, 3)).toBe('defg')
  expect(rolled('abcdefghij', 4, 8)).toBe('ij')
  const text = 'a計画b'
  expect(cells(text)).toBe(6)
  expect(rolled(text, 2, 1)).toBe('計')
  expect(rolled(text, 2, 2)).toBe('画')
  expect(rolled(text, 3, 1)).toBe('計')
  expect(rolled(text, 3, 2)).toBe('画b')
  for (let offset = 0; offset <= 6; offset += 1) expect(cells(rolled(text, 3, offset)) <= 3).toBe(true)
})

test('rolled with offset 0 returns the first room cells without an ellipsis', () => {
  expect(rolled('abcdefghij', 4, 0)).toBe('abcd')
  expect(rolled('abcdefghij', 4, 0).includes('…')).toBe(false)
  expect(rolled('short', 10, 0)).toBe('short')
})

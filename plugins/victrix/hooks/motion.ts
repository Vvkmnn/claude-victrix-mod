// Motion: text the pane has to cut rolls as a ticker, one ticker at a time, the most active one winning.
// Pure helpers over strings and numbers; the caller owns the clock and passes elapsed milliseconds in.

import { cells } from './draw'

/** A ticker rests this long at its start and at its end, so the eye can read the head and the tail. */
export const PAUSE_MS = 2000
/** One cell of travel per step: slow enough to read while it moves. */
export const STEP_MS = 400

/** The owner's order of importance when two rows overflow at once: lower wins. */
export const tickerPriority = { call: 0, step: 1, ask: 2, title: 3, fact: 4, log: 5 } as const

/** A row whose text may not fit `room` cells; `since` is the ms timestamp of its last change (its activity). */
export type TickerCandidate = {
  readonly key: string
  readonly text: string
  readonly room: number
  readonly priority: number
  readonly since: number
}

/**
 * The one candidate allowed to move: among those whose text is wider than its room, the lowest priority,
 * then the most recent activity, then key order so the same input always picks the same row.
 */
export const pickTicker = (candidates: readonly TickerCandidate[]): TickerCandidate | undefined =>
  candidates
    .filter((candidate) => cells(candidate.text) > candidate.room)
    .reduce<TickerCandidate | undefined>((best, candidate) => {
      if (best === undefined) return candidate
      if (candidate.priority !== best.priority) return candidate.priority < best.priority ? candidate : best
      if (candidate.since !== best.since) return candidate.since > best.since ? candidate : best
      return candidate.key < best.key ? candidate : best
    }, undefined)

/**
 * Cells scrolled off the left `elapsedMs` after the ticker started: rest, roll one cell per step to the end,
 * rest, then start over. Text that fits never moves.
 */
export const tickerOffset = (textCells: number, room: number, elapsedMs: number): number => {
  const max = Math.max(0, textCells - Math.max(0, room))
  if (max === 0) return 0
  const period = PAUSE_MS + STEP_MS * max + PAUSE_MS
  const t = Math.max(0, elapsedMs) % period
  if (t < PAUSE_MS) return 0
  return Math.min(max, Math.floor((t - PAUSE_MS) / STEP_MS))
}

/**
 * The window of `text` that starts `offset` cells in and is at most `room` cells wide. A wide character is never
 * split: one that starts before the offset is dropped, one that would cross the right edge is left out. No `…`
 * is added, since a ticker shows the true text; rows that do not roll use `draw.fit`.
 */
export const rolled = (text: string, room: number, offset: number): string => {
  const width = Math.max(0, Math.floor(room))
  let position = 0
  let used = 0
  const kept: string[] = []
  for (const char of Array.from(text)) {
    const size = cells(char)
    const start = position
    position += size
    if (start < offset) continue
    if (used + size > width) break
    kept.push(char)
    used += size
  }
  return kept.join('')
}

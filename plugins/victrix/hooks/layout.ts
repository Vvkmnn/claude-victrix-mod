// The pane as rows of painted spans: the board (owner's drawings, 2026-11-05). Pure, no `$`: the lens paints the spans,
// the kit measures every rung. One snake: born at the right edge of the top row, it boxes the plan's name, comes
// down column 3 through the done steps, and ends as the current step's bar, whose head `▶` is Claude. Under it
// `proof` (the maths, each unit an English line then its notation) and `process` (what Claude just did) sit inside the
// hairpin, each fact, check and action a smaller food on its right edge (`◦` hollow while assumed or pending, `●`
// filled once checked or done) over a faint trail `·` round the whole loop; then the tasks ahead, each a food `○` the
// snake has yet to eat, and a two-line footer.
//
// The arithmetic (how far the head is, the log's folds, the one order in which a pane of any height hands out its
// rows) lives in board.ts. Everything that matters sits at the left: the real rungs are 48 to 60 columns wide and
// about 50 rows tall at the fresh-install share, half that quartered; 24 and 40 are a dragged-narrow dock; 10 to 12
// is the engine's own narrowing under a dialog.
//
// Colour is meaning: the snake's body and the marks are the person's own colour; orange (live) is where Claude is;
// red is a failure or the person needed; the maths (operators, `≤ min`, `Σ`) share one calm accent from the
// theme; sections, counts, times and tokens are dim.
import type { Activity, ActivityLine, Claim, PlanItem, PlanTree, Signal, Status } from '../types'
import { LOG_CAP, PROOF_CAP, budget, creepCells, foldLog, headFraction } from './board'
import { needWords, worst } from './signals'
import type { Budget } from './board'
import * as draw from './draw'
import { factsOf } from './fit'
import { GLYPH, meet, stepStatus } from './lattice'
import { nowItem } from './plan'

/** What a span means; the lens maps each to a colour: live is Anthropic's orange, math the theme's calm accent, the rest the person's theme. */
export type Paint = 'live' | 'math' | 'good' | 'bad' | 'text' | 'dim' | 'faint'
export type Span = { readonly text: string; readonly paint: Paint; readonly bold?: boolean }
export type Press =
  | { readonly kind: 'step'; readonly step: string }
  | { readonly kind: 'fact'; readonly step: string; readonly index: number }
  | { readonly kind: 'check'; readonly step: string }
  | { readonly kind: 'plan'; readonly path: string }
  | { readonly kind: 'help' }
/** A row; `food` is the dot it ends with on the hairpin's edge when the snake has not reached it (facts, the check, actions), absent on rows merely passed. */
export type LayoutRow = { readonly key: string; readonly spans: readonly Span[]; readonly press?: Press; readonly food?: Span }

export type LayoutInput = {
  readonly columns: number
  readonly rows: number
  readonly tree: PlanTree | null
  readonly claims: readonly Claim[]
  readonly spent: Activity
  readonly now: number
  readonly tick: number
  readonly isCalling: boolean
  readonly isWorking: boolean
  /** Plan mode is on and no plan exists yet: the snake creeps in from the right as the plan is written. */
  readonly isPlanning?: boolean
  /** Plans to pick from when none is followed. */
  readonly recent: readonly { readonly title: string; readonly path: string }[]
  /** The ledger: `HH:MM what` lines of what changed (a flip, a verb, a review, a drift, a plan switch), newest first. */
  readonly ledger?: readonly string[]
  /** One plain line when something is wrong with the mod itself; drawn, never hidden. */
  readonly problem?: string
  /** The trust signals the lens computed for the live step, worst first; the footer's English line reads from them. */
  readonly signals?: readonly Signal[]
}

const FACE = '-_-'
/** The snake comes down this column; the box's bottom edge turns down at it. */
const SPINE_COL = 3
/** Where a task's mark `[ ]` starts, and where its name starts. */
const MARK_COL = 5
const NAME_COL = 9
/** The box is seven cells wide; the tail runs from the cell after it. */
const BOX_CELLS = 7
/** Below this many rows the footer and the log go before the box and the live step. */
export const MIN_ROWS = 10

/** Claude Code's own `claude` token in its dark preset, rgb(215,119,87), kept whatever theme the person runs (owner: "Claude respects Anthropic orange, for fun"). */
export const LIVE_COLOUR = 'rgb(215,119,87)'

const cells = draw.cells
const span = (text: string, paint: Paint = 'text', bold = false): Span => ({ text, paint, bold })
const widthOf = (spans: readonly Span[]) => spans.reduce((sum, one) => sum + cells(one.text), 0)
const width = widthOf
const gapSpan = (n: number): Span => span(' '.repeat(Math.max(0, n)), 'text')

/** Cut a row's spans from the right so it never exceeds the columns; the last span that fits is cut with `…`. */
const crop = (spans: readonly Span[], columns: number): Span[] => {
  const out: Span[] = []
  let used = 0
  for (const one of spans) {
    const room = columns - used
    if (room <= 0) break
    const text = cells(one.text) <= room ? one.text : draw.fit(one.text, room)
    out.push({ ...one, text })
    used += cells(text)
  }
  return out
}

const row = (key: string, spans: readonly Span[], columns: number, press?: Press): LayoutRow => ({ key, spans: crop(spans, columns), ...(press ? { press } : {}) })
const blank = (key: string): LayoutRow => ({ key, spans: [] })

/** A cell of an aligned section: its spans, right-aligned when it is a number. No spans is a blank cell that keeps its column. */
type Cell = { readonly spans: readonly Span[]; readonly right?: boolean }

/** Spans without their trailing blank: padding is never drawn past the last thing on a row. */
const trimRight = (spans: readonly Span[]): Span[] => {
  const out = [...spans]
  while (out.length > 0) {
    const last = out[out.length - 1]!
    const text = last.text.replace(/\s+$/, '')
    if (text !== '') return [...out.slice(0, -1), { ...last, text }]
    out.pop()
  }
  return out
}

/**
 * Lines a section up (owner, 2026-11-05: "neat, pixel perfect, no ragged anything; in all text on the board"): every
 * row has the same columns at the same cells, each column as wide as its widest cell, ` · ` between two filled cells
 * and blank where a cell is empty. A column that does not fit is dropped for the whole section from the right, never
 * for one row; the first column (the name) is cut last, to `nameMax` at most, and keeps at least four cells when any
 * other column is shown. `used` is what the row already holds before the first column.
 */
const table = (rows: readonly (readonly Cell[])[], width: number, used: number, nameMax = Infinity): Span[][] => {
  if (rows.length === 0) return []
  const count = Math.max(...rows.map(cells => cells.length))
  const cellWidth = (cell: Cell | undefined) => (cell ? widthOf(cell.spans) : 0)
  const widths = Array.from({ length: count }, (_, index) => Math.max(0, ...rows.map(cells => cellWidth(cells[index]))))
  widths[0] = Math.min(widths[0] ?? 0, nameMax)
  const restOf = (kept: number) => widths.slice(1, kept).reduce((sum, one) => sum + (one > 0 ? 3 + one : 0), 0)
  let kept = count
  while (kept > 1 && used + Math.min(widths[0]!, 4) + restOf(kept) > width) kept -= 1
  const nameWidth = Math.max(1, Math.min(widths[0]!, width - used - restOf(kept)))
  return rows.map(cells => {
    const name = crop(cells[0]?.spans ?? [], nameWidth)
    const out: Span[] = [...name, gapSpan(nameWidth - widthOf(name))]
    for (let index = 1; index < kept; index += 1) {
      const column = widths[index]!
      if (column === 0) continue
      const cell = cells[index]
      if (!cell || widthOf(cell.spans) === 0) {
        out.push(gapSpan(3 + column))
        continue
      }
      const pad = gapSpan(column - widthOf(cell.spans))
      out.push(span(' · ', 'dim'), ...(cell.right ? [pad, ...cell.spans] : [...cell.spans, pad]))
    }
    return trimRight(out)
  })
}

const walk = (items: readonly PlanItem[]): PlanItem[] => items.flatMap(item => [item, ...walk(item.children)])

/** A number never stands bare: unit letter when narrow, word when there is room (owner). */
export const unit = (n: number, letter: string, word: string, columns: number): string => (columns >= 40 ? `${n} ${word}${n === 1 ? '' : 's'}` : `${n}${letter}`)

/** Tokens as `812`, `9.9k`, `12k`; the word when there is room. */
export const tokensText = (n: number, columns: number): string => {
  const thousands = n / 1000
  const figure = n < 1000 ? String(n) : thousands >= 9.95 ? `${Math.round(thousands)}k` : `${thousands.toFixed(1).replace(/\.0$/, '')}k`
  return `${figure}${columns >= 40 ? ' tokens' : ''}`
}

/**
 * The words after a claim, the glyph already saying the status: `by <what established it>` for evidence, `· stale`
 * whenever its files moved since, and for an open claim who said it. An open claim from the person reads `you said
 * so`, never `you` alone: saying is not checking, and `checked by you` is a rung only when they say they ran it.
 */
export const statusWord = (claim: Claim): string => {
  if (claim.isChecking) return 'checking'
  const stale = claim.stale ? ' · stale' : ''
  if (claim.status === 'broken') return claim.counterexample ? `broken: ${claim.counterexample}` : 'broken'
  if (claim.status === 'proved') return `${claim.evidence?.theorem ? `by ${claim.evidence.theorem}` : 'proved'}${stale}`
  if (claim.status === 'checked') {
    const by = claim.evidence?.command.split(' ').filter(Boolean).slice(0, 2).join(' ') ?? ''
    return `${by ? `by ${by}` : 'checked'}${stale}`
  }
  if (claim.source === 'you') return 'you said so'
  if (claim.source === 'doubt') return 'you doubted it'
  return 'unchecked'
}

/** A fact's standing as a status for painting. */
export const paintOf = (status: Status): Paint => (status === 'broken' ? 'bad' : status === 'open' ? 'text' : 'good')

/** The plain-English row above a fact: who said it and whether anything checked it, for someone who knows no glyph. */
export const factSentence = (claim: Claim): string => {
  if (claim.isChecking) return 'a check is running on this now'
  if (claim.status === 'broken') return claim.counterexample ? `a case breaks this: ${claim.counterexample}` : 'a case breaks this'
  if (claim.status === 'proved') return 'proved in the model, and you accepted the English'
  if (claim.status === 'checked') return claim.stale ? 'checked once; the files moved since' : 'a test checked this; the next case is open'
  switch (claim.source) {
    case 'you':
      return 'you said so; nothing has checked it'
    case 'doubt':
      return 'you doubted this; nothing has checked it'
    case 'data':
      return 'seen in the data; no test has checked it'
    case 'code':
      return 'read in the code; no test has checked it'
    default:
      return 'Claude assumes this; nobody checked it'
  }
}

/**
 * The meet of a step's facts in notation, as spans: `H6 ≤ min { ○ cents, ■ dense } = ○` (theorem T1 drawn), operators
 * in the maths colour, glyphs by status. The result after `=` is the point of the line, so it always fits: the names
 * inside the braces shorten (14 cells, 8, then glyphs alone) until the whole line fits `room`.
 */
export const meetSpans = (step: string, facts: readonly Claim[], room: number): Span[] => {
  const name = step.split(' ')[0] ?? step
  const result = stepStatus(facts)
  const resultSpan = span(GLYPH[result], paintOf(result), true)
  // An empty set reads `min { } = ○`: the opening brace already carries its space, so the close drops its own.
  const tail: Span[] = [span(facts.length === 0 ? '} = ' : ' } = ', 'math'), resultSpan]
  const inner = (nameCells: number): Span[] =>
    facts.length === 0
      ? []
      : facts.flatMap((claim, index) => [
          ...(index > 0 ? [span(', ', 'math')] : []),
          span(GLYPH[claim.status], paintOf(claim.status)),
          ...(nameCells > 0 ? [span(` ${draw.fit(claim.says, nameCells)}`, 'dim')] : []),
        ])
  // The ladder: names at 14 cells, at 8, glyphs alone, then without the step's name (it is the live step, named
  // just above), then the bare `min = ○`: the meet and its result are the last to go.
  const named: Span[] = [span(name, 'text'), span(` ${draw.MARK.atMost} ${draw.MARK.weakest} { `, 'math')]
  const unnamed: Span[] = [span(`${draw.MARK.weakest} { `, 'math')]
  const candidates: Span[][] = [
    [...named, ...inner(14), ...tail],
    [...named, ...inner(8), ...tail],
    [...named, ...inner(0), ...tail],
    [...unnamed, ...inner(0), ...tail],
    [span(`${draw.MARK.weakest} = `, 'math'), resultSpan],
  ]
  return candidates.find(parts => width(parts) <= room) ?? candidates[candidates.length - 1]!
}

/** The meet as one string, for the card and the tests; `room` is the cells it may take. */
export const meetLine = (step: string, facts: readonly Claim[], room: number): string => meetSpans(step, facts, room).map(part => part.text).join('')

/** A clock for a column: seconds under a minute, minutes under an hour, then hours and minutes; never seconds beside minutes. */
export const shortClock = (ms: number): string => {
  if (!Number.isFinite(ms)) return ''
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/** A name cut hard so the tail after it always shows: the first tail (fullest first) that leaves the name `min(its length, 4)` cells. */
/** The food of a task ahead: dim when it rests on nothing and has no check, red when a fact is broken, else the person's colour. */
const foodPaint = (item: PlanItem, facts: readonly Claim[]): Paint => (facts.some(claim => claim.status === 'broken') ? 'bad' : facts.length === 0 && !item.judge ? 'dim' : 'text')

/** The run result of a step's verify line, if a tool has run it. */
const checkResult = (live: PlanItem, claims: readonly Claim[]): Claim | undefined => claims.find(claim => claim.step === live.name && claim.source === 'tool' && claim.says === live.judge)

/** A minute of the day from a clock stamp or a time, so calls and ledger lines sort on one scale; an unstamped line is newest. */
const minuteOf = (at: number | undefined): number => (at === undefined ? Infinity : new Date(at).getHours() * 60 + new Date(at).getMinutes())
const minuteOfStamp = (stamp: string): number => Number(stamp.slice(0, 2)) * 60 + Number(stamp.slice(3, 5))

/** One row of the log before alignment: its mark, what it says, then the columns the table lines up: the detail, the time, the fold count, the words before it. */
type LogEvent = { readonly minute: number; readonly isHelper: boolean; readonly mark: Span; readonly body: readonly Span[]; readonly detail?: Span; readonly time?: Span; readonly count?: Span; readonly reason?: Span; readonly food: Span }

/**
 * The call the log row says: a decline as a decline, a failure red, a helper's call behind its tag, the lowest level
 * the engine gave (lines added, the range read, the hits, the exit code) in its own column, the time, `×N` for a
 * folded run, the words said before it when wide. Its dot: hollow orange while it runs, filled once done, hollow in
 * the error colour on a failure, dim on a decline.
 */
const callEvent = (line: ActivityLine, count: number, columns: number): LogEvent => {
  const minute = minuteOf(line.at)
  const isHelper = line.helper !== undefined
  const tag = line.helper ? `${line.helper} · ` : ''
  const counted = count > 1 ? { count: span(`×${count}`, 'dim') } : {}
  if (line.isDeclined) return { minute, isHelper, mark: span('×', 'dim'), body: [span(`${columns >= 40 ? 'declined by you' : 'declined'} · ${tag}${line.text}`, 'dim')], ...counted, food: hollow('dim') }
  if (line.isRunning) return { minute, isHelper, mark: span('·', 'live'), body: [span(`${tag}${line.text}`, 'live')], food: hollow('live') }
  const paint: Paint = line.isOk ? 'dim' : 'bad'
  const time = line.ms !== undefined && line.ms >= 1000 ? { time: span(shortClock(line.ms), 'dim') } : {}
  const detail = line.detail ? { detail: span(line.detail, paint) } : {}
  const reason = columns >= 60 && line.said ? { reason: span(draw.fit(`${line.saidBy === 'you' ? 'you said' : 'Claude said'}: ${line.said}`, 32), 'faint') } : {}
  return { minute, isHelper, mark: span(line.isOk ? '✓' : '✗', paint), body: [span(`${tag}${line.text}`, paint)], ...detail, ...time, ...counted, ...reason, food: line.isOk ? filled('text') : hollow('bad') }
}

/** The log: the earned calls (folded) and the ledger's lines (a flip, a verb, a review, a drift, a switch) on one timeline, newest first. */
const logEvents = (input: LayoutInput, columns: number): LogEvent[] => {
  const calls = foldLog(input.spent.last).map(one => callEvent(one.line, one.count, columns))
  const notes: LogEvent[] = (input.ledger ?? []).map(line => {
    const stamped = /^\d\d:\d\d /.test(line)
    const what = stamped ? line.slice(6) : line
    const isBad = what.startsWith('✗') || what.startsWith('drift')
    const isGood = what.includes('→ done') || what.startsWith('■') || what.startsWith(draw.MARK.proved)
    return { minute: stamped ? minuteOfStamp(line) : Infinity, isHelper: false, mark: span('·', 'dim'), body: [span(what, isBad ? 'bad' : isGood ? 'good' : 'dim')], food: filled('text') }
  })
  // Ledger lines first on a tie of the minute: a flip, a review or a drift is rarer than a call and must not fall
  // off. The ledger carries clock stamps, not dates, so across midnight an old line can sort as new once.
  return [...notes, ...calls].toSorted((a, b) => b.minute - a.minute)
}

/**
 * The rows the log shows of `events` (newest first) when it has room for `count`: the newest, except that the main
 * loop's two newest calls are always among them, the oldest helper rows giving way (owner: helpers at engine speed,
 * but never pushing your own calls off the block). Order by time is kept.
 */
export const pickLog = <T extends { readonly isHelper: boolean }>(events: readonly T[], count: number): T[] => {
  if (count >= events.length) return [...events]
  const reserved = events.filter(one => !one.isHelper).slice(0, 2)
  const chosen = new Set<T>(events.slice(0, count))
  for (const must of reserved) {
    if (chosen.has(must)) continue
    const victim = [...chosen].reverse().find(one => one.isHelper)
    if (!victim) break
    chosen.delete(victim)
    chosen.add(must)
  }
  return events.filter(one => chosen.has(one))
}

const idleText = (input: LayoutInput) => {
  const last = input.spent.last[0]
  if (!last || last.at === undefined) return 'idle'
  return `idle ${shortClock(Math.max(0, input.now - last.at))} · last: ${last.text}`
}

/** The process section: gap, name, the head row (a spinner and the running call, `thinking`, or the idle line), then the log rows the budget allows. */
const processRows = (input: LayoutInput, columns: number, events: readonly LogEvent[], logCount: number): LayoutRow[] => {
  const head = input.isCalling && input.spent.doing ? `${draw.spinner(input.tick)} ${input.spent.doing}` : input.isWorking ? `${draw.spinner(input.tick)} thinking` : idleText(input)
  // Inside the hairpin: the name at the spine's column, the rows two cells in, like proof's units, lined up as one
  // table: the mark and the call, the detail, the time, the fold count, the words before it. The head row is the
  // table's first row so its text starts where the calls' do.
  const shown = pickLog(events, logCount)
  const cell = (part: Span | undefined, right = false): Cell => ({ spans: part ? [part] : [], right })
  const headCells: Cell[] = [{ spans: [span(head, input.isWorking ? 'live' : 'dim')] }]
  const lined = table([headCells, ...shown.map(event => [{ spans: [event.mark, gapSpan(1), ...event.body] }, cell(event.detail), cell(event.time, true), cell(event.count, true), cell(event.reason)])], columns - 2, MARK_COL)
  return [
    row('process:title', [gapSpan(SPINE_COL), span('process', 'dim')], columns),
    { ...row('process:now', [gapSpan(MARK_COL), ...lined[0]!], columns), ...(input.isWorking ? { food: hollow('live') } : {}) },
    ...shown.map((event, index) => ({ ...row(`process:${index}`, [gapSpan(MARK_COL), ...lined[index + 1]!], columns), food: event.food })),
  ]
}

/** What Claude needs, in plain English, for the footer's first line. */
/**
 * What Claude needs, in plain English: the worst trust signal with which side needs more when the lens has computed
 * any; else what the live step itself says (a check not run, facts still assumed); else that nothing is needed.
 */
const needsText = (input: LayoutInput, live: PlanItem | undefined, facts: readonly Claim[]): string => {
  const top = worst(input.signals ?? [])
  if (top && top.level !== 'advisory') return `${needWords([top])} · ${top.words}`
  if (live?.judge && !checkResult(live, input.claims)) return `Claude needs the check run on ${live.name.split(' ')[0] ?? live.name}`
  const assumed = facts.filter(claim => claim.status === 'open').length
  if (assumed > 0) return `${assumed} ${assumed === 1 ? 'fact is' : 'facts are'} still assumed`
  if (top) return `${needWords([top])} · ${top.words}`
  return `nothing needed; ${input.isWorking ? 'working' : 'idle'}`
}

/** `min { } = ○` or `min { ○ ■ } = ○`: the meet of a list of statuses, glyphs only; `name ≤` in front when a name is given. */
const footerMeet = (statuses: readonly Status[], name?: string): Span[] => {
  // The result is the meet of exactly what the braces show (honest notation): the weakest of them, `○` of nothing.
  const result = statuses.length === 0 ? 'open' : statuses.reduce(meet)
  const inner: Span[] = statuses.length === 0 ? [span('{ }', 'math')] : [span('{ ', 'math'), ...statuses.flatMap((status, index) => [...(index > 0 ? [span(' ', 'text')] : []), span(GLYPH[status], paintOf(status))]), span(' }', 'math')]
  return [...(name ? [span(`${name} `, 'text'), span(`${draw.MARK.atMost} `, 'math')] : []), span(`${draw.MARK.weakest} `, 'math'), ...inner, span(' = ', 'math'), span(GLYPH[result], paintOf(result), true)]
}

/**
 * The footer: a rule (only when the budget gave it three rows), what Claude needs in words, then `Σ tokens · t clock ·
 * meet` with `?` in the last cell. A part that does not fit is left out whole, the meet first, then `t`. With no live
 * step and every task done, the meet is the plan's: every step's rung together.
 */
const footerRows = (count: number, input: LayoutInput, columns: number, live: PlanItem | undefined, facts: readonly Claim[]): LayoutRow[] => {
  const sigma: Span[] = [span('Σ ', 'math'), span(tokensText(input.spent.tokensIn + input.spent.tokensOut, 0), 'dim')]
  const liveSpend = live ? input.spent.steps[live.name] : undefined
  const clock = live ? shortClock(Math.max(0, input.now - (liveSpend?.enteredAt || input.now)) + (liveSpend?.ms ?? 0)) : ''
  const steps = input.tree ? input.tree.sections.flatMap(section => section.items).filter(item => !item.isAbandoned) : []
  const landed = live === undefined && steps.length > 0 && steps.every(item => item.isDone)
  // The live step's meet holds its facts and, when it has a verify line, its check (open until it ran).
  const liveStatuses: Status[] = [...facts.map(claim => claim.status), ...(live?.judge ? [checkResult(live, input.claims)?.status ?? 'open'] : [])]
  const meet = landed ? footerMeet(steps.map(item => stepStatus(factsOf(item, input.claims))), 'plan') : footerMeet(liveStatuses)
  const parts: Span[][] = [sigma, ...(clock ? [[span('t ', 'dim'), span(clock, 'dim')]] : []), meet]
  const joined = (take: number): Span[] => parts.slice(0, take).flatMap((part, index) => (index > 0 ? [span(' · ', 'dim'), ...part] : part))
  // The one key every size shows, drawn the way the engine draws a plain button: `h: ? keys` (the `?` itself cannot
  // be a hotkey). Under 30 columns it shortens to `h: ?`, never wraps.
  const keysHint: Span[] = columns >= 30 ? [span('h', 'math'), span(': ? keys', 'dim')] : [span('h', 'math'), span(': ?', 'dim')]
  const fitting = [3, 2, 1, 0].find(take => width(joined(take)) <= columns - 1 - width(keysHint)) ?? 0
  const body = joined(fitting)
  const math = row('footer:math', [...body, gapSpan(columns - width(body) - width(keysHint)), ...keysHint], columns, { kind: 'help' })
  const en = row('footer:en', [span(needsText(input, live, facts), 'text')], columns)
  const rule = row('footer:rule', [span('─'.repeat(columns), 'dim')], columns)
  return count >= 3 ? [rule, en, math] : count === 2 ? [en, math] : count === 1 ? [math] : []
}

/** The box rows once a plan exists: `┏━━━━━┓  plan · title`, the tail to the right edge, `┗━━┓   3/10 steps`. */
const boxRows = (input: LayoutInput, columns: number, done: number, counted: number): LayoutRow[] => {
  // No face (owner, 2026-11-05: "it's only snake now"): the snake is born at the right edge of the top row, runs
  // left, and turns down at the spine's column into the list; the plan's name and count sit beside the spine.
  // One header line, count then title, and a breathing row under it (owner: "breathable, easy to read always").
  const title = input.tree?.title
  const count = `${done}/${counted}${columns >= 40 ? ' steps' : ''}`
  const titleRoom = columns - SPINE_COL - 3 - cells(count) - 3
  return [
    row('box:top', [gapSpan(SPINE_COL), span('┏', 'text'), span('━'.repeat(Math.max(0, columns - SPINE_COL - 1)), 'text')], columns),
    row('box:face', [gapSpan(SPINE_COL), span('┃', 'text'), span(`  ${count}`, 'dim'), ...(title && titleRoom >= 10 ? [span(' · ', 'faint'), span(draw.fit(title, titleRoom), 'text', true)] : [])], columns),
    row('box:bottom', [gapSpan(SPINE_COL), span('┃', 'text')], columns),
  ]
}

/**
 * The dot a row ends with on the hairpin's edge, three sizes for three meanings: the faint trail `·` on rows merely
 * passed, `◦` hollow for a fact still assumed, a check not run or a call in flight, `●` filled once checked, proved or
 * done; the error colour where the row is a failure (the one thing to see), the maths accent on the proof's filled
 * dots, Claude's orange on the running call, the person's colour otherwise.
 */
const hollow = (paint: Paint): Span => span('◦', paint)
const filled = (paint: Paint): Span => span('●', paint)
const foodOfStatus = (status: Status): Span => (status === 'broken' ? hollow('bad') : status === 'checked' || status === 'proved' ? filled('math') : hollow('text'))

/**
 * The hairpin (owner, 2026-11-05): the current task's block (proof, process) sits inside a loop the snake runs round
 * as the task progresses, out along the top, down the right edge, back along the bottom to the spine, where at 100%
 * the head sits above the next task's food and drops onto it. The head's place on that loop is `headFraction`; the
 * body is drawn from `┗` to the head. Ahead of the head the loop is a faint, evenly spaced trail `·`, and on the
 * right edge the block's own food in colour: every fact, check and action ends its row with its dot (smaller than a
 * task's `○`) the head eats as it comes down, so the loop fills with what happened instead of standing empty. Every
 * inner row is cut two cells short of the edge and ends at the last column exactly, whether body, head or food is
 * there, so nothing moves when the head arrives and nothing falls off the board at any width.
 */
const loopRows = (live: PlanItem, facts: readonly Claim[], calls: number, columns: number, inner: readonly LayoutRow[]): LayoutRow[] => {
  const right = columns - 1
  const topLen = Math.max(1, right - SPINE_COL)
  const bottomLen = Math.max(1, right - SPINE_COL + 1)
  const total = topLen + inner.length + bottomLen
  const at = Math.min(total - 1, Math.floor(headFraction(live, facts, calls) * (total - 1)))
  const cell = (index: number, body: string): Span | null => (index < at ? span(body, 'live') : index === at ? span(draw.MARK.head, 'live', true) : null)
  // Ahead of the head the whole loop is marked with faint food (owner: around the entire hairpin, subtly, equidistant):
  // every other cell along the top and bottom rows and every row down the side, which the eye reads as one spacing
  // since a cell is about twice as tall as it is wide; anchored at the right corners so the two rows' dots line up.
  const pathFood = span('·', 'faint')
  // The cell right after the head stays clear along the rows, so the head never looks jammed against the trail.
  const onPath = (col: number, index: number): Span => ((right - col) % 2 === 0 && index !== at + 1 ? pathFood : gapSpan(1))
  const topCells = Array.from({ length: right - SPINE_COL }, (_, offset) => {
    const col = SPINE_COL + 1 + offset
    return cell(offset, col === right ? '┓' : '━') ?? onPath(col, offset)
  })
  const top = row('live:bar', [gapSpan(SPINE_COL), span('┗', 'text'), ...topCells], columns)
  // The rows the snake only passes (titles, the meet, folds, gaps) carry the faint trail dot.
  const sides = inner.map((one, index) => {
    const side = cell(topLen + index, '┃') ?? one.food ?? pathFood
    const body = crop(one.spans, columns - 2)
    return { ...one, spans: [...body, gapSpan(right - width(body)), side] }
  })
  const bottomCells = Array.from({ length: right - SPINE_COL + 1 }, (_, offset) => {
    const col = SPINE_COL + offset
    const index = topLen + inner.length + (right - col)
    return cell(index, col === right ? '┛' : col === SPINE_COL ? '┏' : '━') ?? onPath(col, index)
  })
  const bottom = row('live:return', [gapSpan(SPINE_COL), ...bottomCells], columns)
  return [top, ...sides, bottom]
}

type Unit = { readonly en: LayoutRow; readonly math: LayoutRow }
/** The live step's proof before the budget picks: the meet, every fact in the order the step gathered them, the check, and a fold for the facts a budget hides. */
type Proof = { readonly meet: Unit; readonly facts: readonly Unit[]; readonly check: readonly Unit[]; readonly fold: (hidden: number) => Unit }

/** How many units the proof asks the budget for: the meet, at most PROOF_CAP facts, the check, and the fold when facts are hidden. */
const proofUnitCount = (proof: Proof | undefined): number =>
  proof ? 1 + Math.min(proof.facts.length, PROOF_CAP) + proof.check.length + (proof.facts.length > PROOF_CAP ? 1 : 0) : 0

/**
 * The units a budget of `count` shows: the meet first and the check last whenever they fit; between them the newest
 * facts, behind one fold unit that counts the older ones. The newest are a suffix of the facts, so a taller pane only
 * adds facts and never swaps one for another (the monotone law); the fold stands for less, as the task folds do.
 */
const pickUnits = (proof: Proof, count: number): Unit[] => {
  const fixed = 1 + proof.check.length
  if (count <= fixed) return [proof.meet, ...proof.check].slice(0, count)
  if (count >= fixed + proof.facts.length) return [proof.meet, ...proof.facts, ...proof.check]
  const slots = count - fixed - 1
  return [proof.meet, proof.fold(proof.facts.length - slots), ...proof.facts.slice(proof.facts.length - slots), ...proof.check]
}

/**
 * `proof`: the units the live step has, each an English line at column 3 then its notation at column 5: the meet
 * first, then the facts as gathered (the plan file's first, the session's after), then the check. Absent when the step
 * has neither facts nor a check.
 */
const proofUnits = (live: PlanItem, facts: readonly Claim[], columns: number, input: LayoutInput): Proof | undefined => {
  if (facts.length === 0 && !live.judge) return undefined
  // Inside the hairpin the units sit two cells in from the name, English at MARK_COL and notation two further, and
  // their text stops two cells short of the edge where the loop's right side runs.
  const hasWords = columns >= 40
  const room = columns - MARK_COL - 4
  const english = (key: string, text: string, paint: Paint, press: Press): LayoutRow => row(`${key}:en`, [gapSpan(MARK_COL), span(text, paint)], columns, press)
  const notation = (key: string, spans: readonly Span[], press: Press, food?: Span): LayoutRow => ({ ...row(key, [gapSpan(MARK_COL + 2), ...spans], columns, press), ...(food ? { food } : {}) })
  const onStep: Press = { kind: 'step', step: live.name }
  const meet: Unit =
    facts.length > 0
      ? { en: english('proof:meet', 'the step is as sure as its weakest fact', 'text', onStep), math: notation('proof:meet', meetSpans(live.name, facts, room), onStep) }
      : { en: english('proof:meet', 'no facts yet; the step rests on nothing', 'text', onStep), math: notation('proof:meet', footerMeet([]), onStep) }
  // A fact's unit: the English row says who said it and whether anything checked it; the notation row is the glyph,
  // the claim itself, and the evidence in its own column. Facts and the check line up as one table (owner: nothing
  // ragged), the claims in one column and the evidence words in the next, dropped whole when they do not fit.
  const factCells: Cell[][] = facts.map(claim => {
    const paint = paintOf(claim.status)
    return [{ spans: [span(`${GLYPH[claim.status]} `, paint), span(claim.says, claim.status === 'open' ? 'text' : paint)] }, { spans: claim.status === 'open' ? [] : [span(statusWord(claim), paint)] }]
  })
  const checkResultOf = live.judge ? checkResult(live, input.claims) : undefined
  const checkBroken = checkResultOf?.status === 'broken'
  const checkWord = checkResultOf
    ? checkBroken
      ? hasWords ? (checkResultOf.evidence?.exitCode !== undefined ? `✗ exit ${checkResultOf.evidence.exitCode}` : '✗ failed') : '✗'
      : hasWords ? `✓ passed${checkResultOf.evidence ? ` ${shortClock(checkResultOf.evidence.ms)}` : ''}` : '✓'
    : 'c'
  const checkCells: Cell[][] = live.judge ? [[{ spans: [span('check ', 'math'), span(live.judge, 'text')] }, { spans: [span(checkWord, checkResultOf ? (checkBroken ? 'bad' : 'good') : 'dim')] }]] : []
  const lined = table([...factCells, ...checkCells], columns - 2, MARK_COL + 2)
  const factUnits: Unit[] = facts.map((claim, index) => {
    const press: Press = { kind: 'fact', step: live.name, index }
    return { en: english(`proof:fact:${index}`, factSentence(claim), claim.status === 'broken' ? 'bad' : 'text', press), math: notation(`proof:fact:${index}`, lined[index]!, press, foodOfStatus(claim.status)) }
  })
  const check: Unit[] = (() => {
    if (!live.judge) return []
    const press: Press = { kind: 'check', step: live.name }
    const sentence = checkResultOf ? (checkBroken ? "the step's test failed" : "the step's test passed") : "the step's test has not run yet"
    const food = checkResultOf ? (checkBroken ? hollow('bad') : filled('math')) : hollow('text')
    return [{ en: english('proof:check', sentence, checkBroken ? 'bad' : 'text', press), math: notation('proof:check', lined[facts.length]!, press, food) }]
  })()
  const fold = (hidden: number): Unit => ({
    en: english('proof:more', `${hidden} older ${hidden === 1 ? 'fact is' : 'facts are'} folded`, 'dim', onStep),
    math: notation('proof:more', [span(`… ${hidden} more ${hidden === 1 ? 'fact' : 'facts'}`, 'dim')], onStep),
  })
  return { meet, facts: factUnits, check, fold }
}

/** The tasks ahead: food at column 3, `[ ]` at 5, the name at 9; the fold row names how many are hidden, and the last task is always shown after it. */
const openRows = (open: readonly PlanItem[], b: Budget, input: LayoutInput, columns: number): LayoutRow[] => {
  const task = (item: PlanItem): LayoutRow => {
    const facts = factsOf(item, input.claims)
    return row(`step:${item.name}`, [gapSpan(SPINE_COL), span(draw.MARK.ahead, foodPaint(item, facts)), gapSpan(1), span('[ ]', 'text'), gapSpan(1), span(item.name, 'text')], columns, { kind: 'step', step: item.name })
  }
  const last = open[open.length - 1]
  if (b.open <= 0 || !last) return []
  if (b.openFolded === 0) return open.slice(0, b.open).map(task)
  const fold = row('open:more', [gapSpan(SPINE_COL), span(columns >= 24 ? `… ${b.openFolded} more steps` : `… ${b.openFolded}`, 'dim')], columns)
  return [...open.slice(0, b.open - 1).map(task), ...(b.openFoldRow ? [fold] : []), task(last)]
}

/** Clamp the board to the pane: never wider than `columns` (rows are cropped on creation), never taller than `height`. */
const settle = (body: LayoutRow[], tail: LayoutRow[], height: number): LayoutRow[] => {
  const padding = Array.from({ length: Math.max(0, height - body.length - tail.length) }, (_, index) => blank(`pad:${index}`))
  return [...body, ...padding, ...tail].slice(0, height)
}

/** No plan yet, or one being written: the bare face, the process, the plans to pick, the way in. */
const bareBoard = (input: LayoutInput, columns: number, height: number): LayoutRow[] => {
  const events = logEvents(input, columns)
  let left = Math.max(0, height - 3)
  const take = (want: number): number => {
    const got = Math.max(0, Math.min(want, left))
    left -= got
    return got
  }
  const footerCount = take(height >= 16 ? 3 : 2)
  const problemCount = take(input.problem ? 1 : 0)
  const planningRow = input.isPlanning ? take(1) : 0
  const hasProcess = take(3) === 3
  if (!hasProcess) left = 0
  const hintCount = input.isPlanning ? 0 : take(1)
  const picks = input.isPlanning ? 0 : Math.min(input.recent.length, 4)
  const picksShown = Math.max(0, take(picks > 0 ? 1 + picks : 0) - 1)
  const logCount = hasProcess ? take(Math.min(events.length, LOG_CAP)) : 0

  const calls = Math.max(input.spent.last.length, Object.values(input.spent.steps).reduce((sum, spend) => sum + spend.calls, 0))
  // No face: while a plan is written the snake creeps in from the right edge along the top row toward its corner;
  // with no plan at all the top row is empty and the second says so.
  const creep = input.isPlanning ? creepCells(calls, columns - SPINE_COL - 1) : 0
  const tail: Span[] = creep > 0 ? [gapSpan(columns - creep), span(draw.MARK.head, 'live', true), span('━'.repeat(creep - 1), 'text')] : []
  const first = input.spent.last.reduce<number | undefined>((least, line) => (line.at === undefined ? least : Math.min(least ?? line.at, line.at)), undefined)
  const body: LayoutRow[] = [
    tail.length > 0 ? row('box:top', tail, columns) : blank('box:top'),
    input.isPlanning ? blank('box:face') : row('box:face', [gapSpan(SPINE_COL), span('no plan yet', 'dim')], columns),
    blank('box:bottom'),
    ...(planningRow > 0 ? [row('plan:now', [gapSpan(SPINE_COL), span(`planning · ${shortClock(first === undefined ? 0 : input.now - first)}`, 'live')], columns)] : []),
    ...(hasProcess ? processRows(input, columns, events, logCount) : []),
    ...(picksShown > 0 ? [blank('gap:plans')] : []),
    ...input.recent.slice(0, picksShown).map(pick => row(`plan:${pick.path}`, [gapSpan(SPINE_COL), span(draw.MARK.ahead, 'dim'), gapSpan(1), span('[ ]', 'text'), gapSpan(1), span(pick.title, 'text')], columns, { kind: 'plan', path: pick.path })),
    ...(hintCount > 0 ? [row('hint', [gapSpan(SPINE_COL), span('plan this: shift+tab', 'dim')], columns)] : []),
  ]
  const trailer = [...(problemCount > 0 && input.problem ? [row('problem', [span(`   ${input.problem}`, 'bad')], columns)] : []), ...footerRows(footerCount, input, columns, undefined, [])]
  return settle(body, trailer, height)
}

/** The whole pane, top to bottom, at most `rows` rows, no row wider than `columns`. */
export const layout = (input: LayoutInput): LayoutRow[] => {
  const columns = Math.max(8, input.columns)
  const height = Math.max(4, input.rows)
  const tree = input.tree
  // The plan's steps are its top-level items; a step's own sub-steps feed its progress bar, never the count.
  const all = tree ? tree.sections.flatMap(section => section.items) : []
  const counted = all.filter(item => !item.isAbandoned)
  if (!tree || counted.length === 0) return bareBoard(input, columns, height)

  const done = counted.filter(item => item.isDone)
  const liveDeep = nowItem(tree)
  const live = liveDeep === undefined ? undefined : (counted.find(item => item === liveDeep || walk(item.children).includes(liveDeep)) ?? liveDeep)
  const open = counted.filter(item => !item.isDone && item !== live)
  const liveFacts = live ? factsOf(live, input.claims) : []
  const liveSpend = live ? input.spent.steps[live.name] : undefined
  const proof = live ? proofUnits(live, liveFacts, columns, input) : undefined
  const events = logEvents(input, columns)

  // The plan's list as one table (owner: lined up, never ragged): the name, the rung, the time, the tokens, each in
  // its column. A done step's rung is its lattice value: `{ }` when it rested on nothing (no facts, no check), the
  // whole meet from 60 columns, the result glyph alone below; shown only where it differs from the row above (owner:
  // "if it is on the row above don't repeat; if unique leave it"), the first shown row always carrying one. Tokens
  // drop under 40 columns, times under 24. The live row sits in the same columns with its clock where the rung goes.
  // What a step's rung meets: every fact's status and, when it has a verify line, its check's (open until it ran), so
  // the braces hold everything the result is made of.
  const rungStatuses = (item: PlanItem): Status[] => [...factsOf(item, input.claims).map(claim => claim.status), ...(item.judge ? [checkResult(item, input.claims)?.status ?? 'open'] : [])]
  const rungCell = (item: PlanItem): Cell => {
    const statuses = rungStatuses(item)
    if (statuses.length === 0) return { spans: [span('{ }', 'math')] }
    const status = statuses.reduce(meet)
    return { spans: columns >= 60 ? footerMeet(statuses) : [span(GLYPH[status], paintOf(status))] }
  }
  const plainOf = (cell: Cell) => cell.spans.map(part => part.text).join('')
  const planRows = (shown: readonly PlanItem[], liveItem: PlanItem | undefined): LayoutRow[] => {
    const items = [...shown, ...(liveItem ? [liveItem] : [])]
    const rungs = shown.map(rungCell)
    const cellsOf = (item: PlanItem, index: number): Cell[] => {
      if (item === liveItem) {
        const clock = shortClock(Math.max(0, input.now - (liveSpend?.enteredAt || input.now)) + (liveSpend?.ms ?? 0))
        return [{ spans: [span(item.name, 'live', true)] }, { spans: [] }, { spans: [span(clock, 'live')], right: true }]
      }
      const spend = input.spent.steps[item.name]
      const rung = rungs[index]!
      const repeated = index > 0 && plainOf(rung) === plainOf(rungs[index - 1]!)
      const time = columns >= 24 && spend && spend.ms > 0 ? [span(shortClock(spend.ms), 'dim')] : []
      const tokens = columns >= 40 && spend && spend.tokens > 0 ? [span(tokensText(spend.tokens, 0), 'dim')] : []
      return [{ spans: [span(item.name, 'text')] }, repeated ? { spans: [] } : rung, { spans: time, right: true }, { spans: tokens, right: true }]
    }
    const lined = table(items.map(cellsOf), columns, NAME_COL, 28)
    return items.map((item, index) => {
      const facts = factsOf(item, input.claims)
      const status = stepStatus(facts)
      const unproven = status === 'open' && (facts.length > 0 || Boolean(item.judge))
      const mark = item === liveItem ? '[ ]' : status === 'broken' ? '[✗]' : unproven ? '[?]' : '[✓]'
      return row(`step:${item.name}`, [gapSpan(SPINE_COL), span('┃', 'text'), gapSpan(1), span(mark, status === 'broken' ? 'bad' : 'text'), gapSpan(1), ...lined[index]!], columns, { kind: 'step', step: item.name })
    })
  }

  const build = (b: Budget): { readonly body: LayoutRow[]; readonly trailer: LayoutRow[] } => {
    const shownUnits = proof ? pickUnits(proof, b.proofUnits) : []
    // One list, never split (owner): the done tasks, the current task and its bar, the tasks ahead right under it;
    // proof and process come after the whole plan. At landing the head rests under the last done task.
    const landed = live === undefined && done.length > 0 && open.length === 0
    // The current task's block, proof then process, sits inside the hairpin; with no live task it stands on its own.
    const proofBlock = shownUnits.length > 0 ? [row('proof:title', [gapSpan(SPINE_COL), span('proof', 'dim')], columns), ...shownUnits.flatMap(one => (columns >= 40 ? [one.en, one.math] : [one.math]))] : []
    const processBlock = b.logHead > 0 ? processRows(input, columns, events, b.log) : []
    const inner = [...proofBlock, ...(proofBlock.length > 0 && processBlock.length > 0 ? [blank('gap:process')] : []), ...processBlock]
    const body: LayoutRow[] = [
      ...boxRows(input, columns, done.length, counted.length),
      ...(b.doneFoldRow ? [row('done:more', [gapSpan(SPINE_COL), span('┃', 'text'), span(`   … ${b.doneFolded}${columns >= 24 ? ' done' : ''}`, 'dim')], columns)] : []),
      ...planRows(done.slice(done.length - b.done), live),
      ...(live ? loopRows(live, liveFacts, liveSpend?.calls ?? 0, columns, inner) : []),
      ...(landed ? [row('live:rest', [gapSpan(SPINE_COL), span(draw.MARK.head, 'live', true)], columns)] : []),
      ...(b.open > 0 ? openRows(open, b, input, columns) : []),
      ...(live ? [] : inner.length > 0 ? [blank('gap:proof'), ...inner] : []),
    ]
    const trailer = [...(input.problem ? [row('problem', [span(`   ${input.problem}`, 'bad')], columns)] : []), ...footerRows(b.footer, input, columns, live, liveFacts)]
    return { body, trailer }
  }

  // The budget hands out rows but not the gaps and section names it does not know of; take the largest share it can
  // be given such that what is drawn still fits the pane. Growing the share only ever adds elements, so the largest
  // fit is monotone in the pane's height (the owner's law: a taller pane only ever adds).
  const budgetFor = (rows: number): Budget =>
    budget({ rows, hasLive: live !== undefined, doneCount: done.length, openCount: open.length, proofUnits: proofUnitCount(proof), logRows: events.length, hasProblem: input.problem !== undefined })
  let share = height
  let drawn = build(budgetFor(share))
  // The English rows that narrow widths drop still count against the fit, so the share never depends on the width.
  const dropped = () => (columns >= 40 ? 0 : Math.min(proofUnitCount(proof), drawn.body.filter(one => one.key.startsWith('proof:') && !one.key.endsWith(':en') && one.key !== 'proof:title').length))
  while (share > 0 && drawn.body.length + dropped() + drawn.trailer.length > height) {
    share -= 1
    drawn = build(budgetFor(share))
  }
  return settle(drawn.body, drawn.trailer, height)
}

/** Every non-ASCII glyph the layout may draw; a kit test fails the build on any other. */
export const GLYPHS = new Set([...'╭╮╰╯│─┃┗┏┓┛━╸◦●○✓▶~■✗≤≥Σ…·•→×−–', ...draw.SPINNER])

/** True when every character of every span is ASCII or in the dictionary. */
export const isInDictionary = (rows: readonly LayoutRow[]): boolean =>
  rows.every(one => one.spans.every(part => [...part.text].every(char => char.charCodeAt(0) < 128 || GLYPHS.has(char))))

export const rowWidth = (one: LayoutRow): number => width(one.spans)

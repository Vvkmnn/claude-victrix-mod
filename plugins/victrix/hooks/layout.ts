// The pane as rows of painted spans: one drawing at every width, cropped from the right and never re-laid (owner,
// 2026-11-05). Pure, no `$`: the lens paints the spans, the kit measures every rung. The order is the plan's order:
// the boxed face as the hub; the plan bar out of its right wall; the spine out of its bottom, green through the
// done steps, turning orange at the live step and ending as that step's own bar; the open steps with no line;
// `proof` (the maths, in notation with its words) and `doing` (the live log) with room between; one footer row.
//
// Everything that matters sits at the left (owner, 2026-11-05: "text on the far right is hard to see, and you may
// not have that width"): a status word follows its claim after ` · `, the `?` follows the footer's words, the bars
// are capped so their labels stay near the box. The real rungs, measured (SF Mono 12.3 on a 13" Air gives 186
// columns full-screen; a 16" about 220; Terminal.app opens at 80×24): at the fresh-install 27% a MacBook pane is
// 48 to 60 columns wide and about 50 rows tall full-screen, half that quartered; below 110 terminal columns (any
// half-screen window, any tmux split) no dock seats and the ribbon carries the plan. So 48 and 60 are the widths
// every line is written for; 24 and 40 are a dragged-narrow dock; 10 to 12 is the engine's own narrowing under a
// dialog; 66 and up is luxury.
//
// Colour is meaning, and each line carries one (owner, 2026-11-05: "bars and lines are focal points; colours should
// mean something"): the spine is green behind Claude and orange where Claude is, nothing ahead, and an abandoned
// step does not break the green (the plan went past it; its `~` says abandoned); a bar is one colour of fill and a
// faint remainder, green for the plan, orange for the live step; red is a failure or the person needed; the maths
// (operators, `⊢`, `Σ`) and the face share one calm accent from the person's theme, so the notation reads as one
// voice; the lattice glyphs `✗ △ ■ ◆` are painted by the status they state.
import type { Activity, ActivityLine, Claim, PlanItem, PlanTree, Status } from '../types'
import * as draw from './draw'
import { factsOf } from './fit'
import { GLYPH, stepStatus } from './lattice'
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
export type LayoutRow = { readonly key: string; readonly spans: readonly Span[]; readonly press?: Press }

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
  /** Plans to pick from when none is followed. */
  readonly recent: readonly { readonly title: string; readonly path: string }[]
  /** The ledger: `HH:MM what` lines of what changed (a flip, a verb, a review, a drift, a plan switch), newest first. */
  readonly ledger?: readonly string[]
  /** One plain line when something is wrong with the mod itself; drawn, never hidden. */
  readonly problem?: string
}

const FACE = '-_-'
/** The spine hangs from the box's `┰`, the fourth cell of `╰──┰──╯`, at every width. */
const SPINE_COL = 3
const TIME_CELLS = 6
/** Both bars are capped at this many cells, so their labels stay beside the box where the eye is. */
const BAR_CELLS = 16
/** The margin label column: four cells of indent, the word, two cells of air. */
const LABEL = 4 + 'proof'.length + 2
/** Below this many rows the footer and the log go before the box and the live step, the cockpit's declutter order. */
export const MIN_ROWS = 10

/** Claude Code's own `claude` token in its dark preset, rgb(215,119,87), kept whatever theme the person runs (owner: "Claude respects Anthropic orange, for fun"). */
export const LIVE_COLOUR = 'rgb(215,119,87)'

const cells = draw.cells
const span = (text: string, paint: Paint = 'text', bold = false): Span => ({ text, paint, bold })
const width = (spans: readonly Span[]) => spans.reduce((sum, one) => sum + cells(one.text), 0)

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

const walk = (items: readonly PlanItem[]): PlanItem[] => items.flatMap(item => [item, ...walk(item.children)])

/** A number never stands bare: unit letter when narrow, word when there is room (owner). */
export const unit = (n: number, letter: string, word: string, columns: number): string => (columns >= 40 ? `${n} ${word}${n === 1 ? '' : 's'}` : `${n}${letter}`)

/** Tokens as `812`, `9.9k`, `12k`; the word when there is room. */
export const tokensText = (n: number, columns: number): string => {
  const thousands = n / 1000
  const figure = n < 1000 ? String(n) : thousands >= 9.95 ? `${Math.round(thousands)}k` : `${thousands.toFixed(1)}k`
  return `${figure}${columns >= 40 ? ' tokens' : ''}`
}

/**
 * The words after a claim, the glyph already saying the status: `⊢ <what established it>` for evidence, `· stale`
 * whenever its files moved since, and for an open claim who said it. An open claim from the person reads `you said
 * so`, never `you` alone: saying is not checking, and `checked by you` is a rung only when they say they ran it.
 */
export const statusWord = (claim: Claim): string => {
  if (claim.isChecking) return 'checking'
  const stale = claim.stale ? ' · stale' : ''
  if (claim.status === 'broken') return claim.counterexample ? `broken: ${claim.counterexample}` : 'broken'
  if (claim.status === 'proved') return `${claim.evidence?.theorem ? `⊢ ${claim.evidence.theorem}` : 'proved'}${stale}`
  if (claim.status === 'checked') {
    const by = claim.evidence?.command.split(' ').filter(Boolean).slice(0, 2).join(' ') ?? ''
    return `${by ? `⊢ ${by}` : 'checked'}${stale}`
  }
  if (claim.source === 'you') return 'you said so'
  if (claim.source === 'doubt') return 'you doubted it'
  return 'unchecked'
}

/** A fact's standing as a status for painting. */
export const paintOf = (status: Status): Paint => (status === 'broken' ? 'bad' : status === 'open' ? 'text' : 'good')

/**
 * The meet of a step's facts in notation, as spans: `H6 ⊑ ⊓ { △ cents, ■ dense } = △` (theorem T1 drawn), operators
 * in the maths colour, glyphs by status. The result after `=` is the point of the line, so it always fits: the names
 * inside the braces shorten (14 cells, 8, then glyphs alone) until the whole line fits `room`.
 */
export const meetSpans = (step: string, facts: readonly Claim[], room: number): Span[] => {
  const name = step.split(' ')[0] ?? step
  const result = stepStatus(facts)
  const resultSpan = span(GLYPH[result], paintOf(result), true)
  const tail: Span[] = [span(' } = ', 'math'), resultSpan]
  const inner = (nameCells: number): Span[] =>
    facts.length === 0
      ? [span('∅', 'math')]
      : facts.flatMap((claim, index) => [
          ...(index > 0 ? [span(', ', 'math')] : []),
          span(GLYPH[claim.status], paintOf(claim.status)),
          ...(nameCells > 0 ? [span(` ${draw.fit(claim.says, nameCells)}`, 'dim')] : []),
        ])
  // The ladder: names at 14 cells, at 8, glyphs alone, then without the step's name (it is the live step, named
  // just above), then the bare `⊓ = △`: the meet and its result are the last to go.
  const named: Span[] = [span(name, 'text'), span(' ⊑ ⊓ { ', 'math')]
  const unnamed: Span[] = [span('⊓ { ', 'math')]
  const candidates: Span[][] = [
    [...named, ...inner(14), ...tail],
    [...named, ...inner(8), ...tail],
    [...named, ...inner(0), ...tail],
    [...unnamed, ...inner(0), ...tail],
    [span('⊓ = ', 'math'), resultSpan],
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

const doneCells = (ms: number) => (ms > 0 ? shortClock(ms) : '')

/** The margin label: the word and its air where there is room, a bare indent under 24 columns (words drop first). */
const marginLabel = (text: string, columns: number): Span => (columns >= 24 ? span(`    ${text.padEnd(LABEL - 4)}`, 'dim') : span('  ', 'text'))
const marginCells = (columns: number) => (columns >= 24 ? LABEL : 2)
const marginIndent = (columns: number) => (columns >= 24 ? '    ' : '  ')

/** The whole pane, top to bottom, at most `rows` rows, no row wider than `columns`. */
export const layout = (input: LayoutInput): LayoutRow[] => {
  const columns = Math.max(8, input.columns)
  const height = Math.max(4, input.rows)
  const tree = input.tree
  // The plan's steps are its top-level items; a step's own sub-steps feed its progress bar, never the count.
  const all = tree ? tree.sections.flatMap(section => section.items) : []
  const counted = all.filter(item => !item.isAbandoned)
  const done = counted.filter(item => item.isDone)
  const abandoned = all.filter(item => item.isAbandoned)
  const liveDeep = tree ? nowItem(tree) : undefined
  const live = liveDeep === undefined ? undefined : (counted.find(item => item === liveDeep || walk(item.children).includes(liveDeep)) ?? liveDeep)
  const open = counted.filter(item => !item.isDone && item !== live)
  const liveFacts = live ? factsOf(live, input.claims) : []
  const liveSpend = live ? input.spent.steps[live.name] : undefined
  const problemRows = input.problem ? 1 : 0
  const out: LayoutRow[] = []

  // The hub: the box, the plan bar out of its right wall when at least three cells of it fit, the count, the title.
  // At the narrowest rung the count does not fit beside the box and moves to the footer (the owner's 10-column mock).
  const hasPlan = tree !== null && counted.length > 0
  const count = hasPlan ? `${done.length}/${counted.length}` : ''
  const countText = hasPlan ? `${count}${columns >= 40 ? ' steps' : ''}` : ''
  const countFits = columns - 7 >= cells(countText) + 1
  const barRoom = columns - 7 - cells(countText) - 1
  const hasBar = hasPlan && barRoom >= 3
  const barCells = hasBar ? Math.min(barRoom, BAR_CELLS) : 0
  const bar = hasBar ? draw.line(done.length, counted.length, barCells) : undefined
  // The plan's title sits on the box's floor row, under the bar's start, where the eye already is (owner: "too far
  // to look" at the end of the bar); it is cut from the right and left out under eight cells.
  const titleRoom = columns - 8
  const title = hasPlan && tree?.title && titleRoom >= 8 ? draw.fit(tree.title, titleRoom) : ''
  out.push(row('box:top', [span('╭─────╮', 'dim')], columns))
  out.push(
    row(
      'box:face',
      [
        span('│ ', 'dim'),
        span(FACE, 'math', true),
        span(hasBar ? ' ┝' : ' │', 'dim'),
        ...(bar
          ? [span(bar.filled + bar.half, 'good'), span(bar.rest, 'faint'), span(` ${countText}`, 'dim')]
          : hasPlan
            ? countFits
              ? [span(` ${countText}`, 'dim')]
              : []
            : [span(` ${tree ? 'every step done' : 'no plan yet'}`, 'dim')]),
      ],
      columns,
    ),
  )
  out.push(row('box:bottom', [span(hasPlan ? '╰──┰──╯' : '╰─────╯', 'dim'), ...(title ? [span(` ${title}`, 'text', true)] : [])], columns))

  // The footer: the only numbers row, left-packed, `?` right after its words: `Σ 12k tokens · t 47m  ?`. A part
  // that would be cut is left out whole (a `Σ` with nothing after it says nothing): the spend goes first, the count
  // (only here at the narrowest rung) and the `?` stay.
  const footer = (): LayoutRow => {
    const onStep = live && liveSpend ? `${tokensText(liveSpend.tokens, columns)} · t ${shortClock(Math.max(0, input.now - (liveSpend.enteredAt || input.now)) + liveSpend.ms)}` : input.isWorking ? `${tokensText(input.spent.turnIn + input.spent.turnOut, columns)} this turn` : ''
    const countPart: Span[] = !countFits && count ? [span(count, 'dim')] : []
    const spendPart: Span[] = onStep ? [span('Σ ', 'math'), span(onStep, 'dim')] : []
    const join = (parts: Span[][]) => parts.filter(part => part.length > 0).flatMap((part, index) => (index > 0 ? [span(' · ', 'faint'), ...part] : part))
    const help = [span('  ?', 'dim')]
    const whole = [span(marginIndent(columns), 'text'), ...join([countPart, spendPart]), ...help]
    const spans = width(whole) <= columns ? whole : [span(marginIndent(columns), 'text'), ...join([countPart]), ...help]
    return row('footer', spans, columns, { kind: 'help' })
  }

  // No plan: what Claude is doing, the recent plans to pick, the way in.
  if (!hasPlan) {
    const picks = Math.min(input.recent.length, 4)
    const fixed = 3 + (picks > 0 ? 1 + picks : 0) + problemRows + 2 + 1
    out.push(...doingRows(input, columns, Math.max(1, height - fixed)))
    if (picks > 0) {
      out.push(blank('gap:plans'))
      input.recent.slice(0, picks).forEach(pick => out.push(row(`plan:${pick.path}`, [span('    ○ ', 'faint'), span(pick.title, 'text')], columns, { kind: 'plan', path: pick.path })))
    }
    if (input.problem) out.push(row('problem', [span(`    ${input.problem}`, 'bad')], columns))
    out.push(blank('gap:hint'))
    out.push(row('hint', [span(`    ${picks > 0 ? 'press one to follow it · ' : ''}plan this: shift+tab`, 'dim')], columns))
    out.push(footer())
    return out.slice(0, height)
  }

  // Rows are handed out in one fixed order of wishes, each wish taking what is left, so a taller pane only ever adds
  // (owner's law, 2026-11-05: a smaller view never holds more than a larger sibling; views evolve, never jump; and a
  // tall pane uses its rows). The order: the fixed rows (box 3, live step and bar 2, the one abandoned row, the gap
  // before doing, the footer, the problem line); the log's head and two events; proof with its gap (the meet, two
  // facts, the check); the next two open steps; every done step, newest nearest the live row; the rest of the facts;
  // the rest of the open steps; the rest of the log; blank rows last. Under MIN_ROWS the cut comes from the bottom:
  // the footer and the log go before the spine, the cockpit's declutter order.
  const hasTimes = columns >= 40
  const hasNames = columns >= 24
  const indent = SPINE_COL
  const liveRows = live ? 2 : 0
  const abandonedRows = Math.min(1, abandoned.length)
  // The gap before the open steps is counted with their base rows below.
  const fixed = 3 + liveRows + abandonedRows + 1 + 1 + problemRows
  let left = height - fixed
  const take = (want: number): number => {
    const got = Math.max(0, Math.min(want, left))
    left -= got
    return got
  }
  const eventCount = 1 + input.spent.last.length + (input.ledger?.length ?? 0)
  const doingBase = take(Math.min(eventCount, 3))
  const proofBase = live ? proofRows(live, liveFacts, columns, input, 2) : []
  // Proof takes its gap and its rows together; one row alone would be a gap with nothing under it, so it is given back.
  let proofGot = proofBase.length > 0 ? take(proofBase.length + 1) : 0
  if (proofGot === 1) {
    left += 1
    proofGot = 0
  }
  // The open steps take their gap with their rows; a gap alone is given back.
  let openBase = open.length > 0 ? take(1 + Math.min(open.length, 2) + (open.length > 2 ? 1 : 0)) : 0
  if (openBase === 1) {
    left += 1
    openBase = 0
  }
  openBase = Math.max(0, openBase - 1)
  // The live row is the horizon (owner: "the centre line, like a horizon meter"): done steps fill the rows above it
  // only down to the pane's upper half, then fold into `… N done` so the live step, its block and the tape of open
  // steps below keep their place; what no other wish takes goes to the done steps last.
  const horizon = Math.max(0, Math.floor(height * 0.45) - 3 - abandonedRows)
  const doneBase = take(Math.min(done.length, horizon))
  // The log is the heart (owner: "I want to watch things happen and fill"): the rest of it comes before the rest of
  // the facts and the far-off open steps. Open steps past the next two are shown only where their names are, since
  // a column of bare `○` says nothing more than `+N more` does.
  const doingExtra = take(Math.max(0, eventCount - doingBase))
  const doingCount = doingBase + doingExtra
  const extraFacts = proofGot > 0 ? take(Math.max(0, liveFacts.length - 2)) : 0
  const openExtra = openBase > 0 && hasNames ? take(Math.max(0, open.length - 2)) : 0
  const doneGot = doneBase + take(done.length - doneBase)
  const proofAll = extraFacts > 0 && live ? proofRows(live, liveFacts, columns, input, 2 + extraFacts) : proofBase
  const proofLines = proofGot > 0 ? proofAll.slice(0, proofGot - 1 + extraFacts) : []
  // Open steps: the rows taken less one for `+N more` while any stay folded.
  const openWant = openBase + openExtra
  const openShown = Math.max(0, Math.min(open.length, openWant - (open.length > openWant ? 1 : 0)))
  const openRows = openShown + (open.length > openShown && openWant > openShown ? 1 : 0)
  // Done steps: all when they fit, else one row says how many are folded; with no row at all the bar's count carries them.
  const doneRoom = doneGot >= done.length ? done.length : Math.max(0, doneGot - 1)
  const doneHidden = Math.max(0, done.length - doneRoom)
  const hasMoreRow = doneHidden > 0 && doneGot >= 1
  const doneShown = done.slice(doneHidden)
  /** The column of the marks `✓ ▶ ○`, where a folded count also sits. */
  const markCol = indent + 1 + (hasTimes ? 2 + TIME_CELLS + 2 : 1)

  const stepRow = (item: PlanItem, mark: '✓' | '▶' | '○' | '~', paint: Paint) => {
    // The line runs unbroken and green from the box to the live step, through an abandoned step too: the plan went past it.
    const spine = mark === '○' ? ' ' : '┃'
    const spinePaint: Paint = mark === '▶' ? 'live' : 'good'
    const time = mark === '✓' ? doneCells(input.spent.steps[item.name]?.ms ?? 0) : mark === '▶' ? shortClock(Math.max(0, input.now - (liveSpend?.enteredAt || input.now)) + (liveSpend?.ms ?? 0)) : ''
    const spans: Span[] = [span(' '.repeat(indent), 'text'), span(spine, spinePaint)]
    if (hasTimes) spans.push(span(`  ${time.padStart(TIME_CELLS)}  `, mark === '▶' ? 'live' : 'dim'))
    else if (mark === '▶' && !hasNames) spans.push(span(` ▶ ${time}`, 'live', true))
    else spans.push(span(' ', 'text'))
    if (hasNames || mark !== '▶') spans.push(span(`${mark} `, paint, mark === '▶'))
    if (hasNames) spans.push(span(item.name, mark === '▶' ? 'live' : mark === '✓' ? 'dim' : 'text', mark === '▶'))
    return row(`step:${item.name}`, spans, columns, { kind: 'step', step: item.name })
  }

  // Folded done steps: `… 7 done` with room, `… 7 ✓` without (a letter would read as a unit: `7d` is seven days).
  if (hasMoreRow) out.push(row('done:more', [span(' '.repeat(indent), 'text'), span('┃', 'good'), span(`  … ${doneHidden} ${columns >= 40 ? 'done' : '✓'}`, 'dim')], columns))
  doneShown.forEach(item => out.push(stepRow(item, '✓', 'good')))
  abandoned.slice(0, abandonedRows).forEach(item => out.push(stepRow(item, '~', 'faint')))

  if (live) {
    out.push(stepRow(live, '▶', 'live'))
    out.push(liveBar(live, liveFacts, liveSpend, input.isCalling, columns))
  }
  // Proof and doing are the live step's own, so they hang under its bar, and the open steps follow below them: as
  // steps finish, the block travels down the spine until the last step is at the bottom and the bar is full (owner,
  // 2026-11-05: "the steps scroll by until it's finally at the bottom and the progress bar completes").
  if (proofLines.length > 0) {
    out.push(blank('gap:proof'))
    out.push(...proofLines)
  }
  out.push(blank('gap:doing'))
  out.push(...doingRows(input, columns, Math.max(1, doingCount)))
  if (input.problem) out.push(row('problem', [span(`    ${input.problem}`, 'bad')], columns))
  if (openRows > 0) out.push(blank('gap:open'))
  open.slice(0, openShown).forEach(item => out.push(stepRow(item, '○', 'faint')))
  if (openRows > openShown) out.push(row('open:more', [span(' '.repeat(markCol), 'text'), span(`+${open.length - openShown}${hasNames ? ' more' : ''}`, 'faint')], columns))
  // The footer anchors the bottom row, as a status bar does; the rows between stay empty rather than invent.
  const padding = Array.from({ length: Math.max(0, height - out.length - 1) }, (_, index) => blank(`pad:${index}`))
  out.push(...padding, footer())
  return out.slice(0, height)
}

/** The live step's bar: a true progress bar when the step has a denominator (sub-steps, facts), the growing effort bar otherwise. */
const liveBar = (live: PlanItem, facts: readonly Claim[], spend: Activity['steps'][string] | undefined, isCalling: boolean, columns: number): LayoutRow => {
  const calls = spend?.calls ?? 0
  const fails = spend?.fails ?? 0
  const children = live.children.filter(child => !child.isAbandoned)
  const denominator = children.length + facts.length
  const indent = SPINE_COL
  // The bar comes before its words: the label is written in words where the bar still gets eight cells, in unit
  // letters otherwise, and the bar is dropped only when not even three cells of it fit.
  const labelFor = (wide: boolean): string => {
    const callsText = wide ? `${calls} calls${fails > 0 ? ` · ${fails} failed` : ''}` : `${calls}c${fails > 0 ? ` · ${fails}✗` : ''}`
    if (denominator === 0) return callsText
    const doneText = children.length > 0 ? `${children.filter(child => child.isDone).length}/${children.length} ${wide ? 'done' : 'd'}` : ''
    const checkedText = facts.length > 0 ? `${facts.filter(claim => claim.status === 'checked' || claim.status === 'proved').length}/${facts.length} ${wide ? 'checked' : '✓'}` : ''
    return [doneText, checkedText].filter(Boolean).join(' · ') + (calls > 0 ? ` · ${callsText}` : '')
  }
  const roomFor = (label: string) => columns - indent - 1 - cells(label) - 1
  const label = roomFor(labelFor(columns >= 40)) >= 8 ? labelFor(columns >= 40) : labelFor(false)
  const barRoom = roomFor(label)
  if (denominator > 0) {
    const numerator = children.filter(child => child.isDone).length + facts.filter(claim => claim.status === 'checked' || claim.status === 'proved').length
    if (barRoom < 3) return row('live:bar', [span(' '.repeat(indent), 'text'), span('┃', 'live'), span(` ${label}`, 'dim')], columns)
    const bar = draw.line(numerator, denominator, Math.min(barRoom, BAR_CELLS))
    return row('live:bar', [span(' '.repeat(indent), 'text'), span('┗', 'live'), span(bar.filled + bar.half, 'live'), span(bar.rest, 'faint'), span(` ${label}`, 'dim')], columns)
  }
  if (calls === 0 || barRoom < 3) return row('live:bar', [span(' '.repeat(indent), 'text'), span('┃', 'live'), span(calls === 0 ? '  no calls yet' : ` ${label}`, 'dim')], columns)
  const tally = draw.tally(calls, fails, Math.min(barRoom, BAR_CELLS), isCalling)
  return row('live:bar', [span(' '.repeat(indent), 'text'), span('┗', 'live'), span(tally.ok, 'live'), span(tally.bad, 'bad'), span(tally.running, 'live'), span(` ${label}`, 'dim')], columns)
}

/**
 * `proof`: the meet in notation, each fact with its glyph and one word after it (`△ prices ∈ cents · unchecked`),
 * the check line (`⊢ bun test · not run · c`); absent when the step has none. Left-packed: the word follows the
 * claim, the claim is cut so the word always shows; under 40 columns the glyph alone says the status.
 */
const proofRows = (live: PlanItem, facts: readonly Claim[], columns: number, input: LayoutInput, maxFacts: number): LayoutRow[] => {
  const label = (text: string) => marginLabel(text, columns)
  const room = columns - marginCells(columns) - 2
  const hasWords = columns >= 40
  // A step with nothing assumed and nothing to run says so once, dim, no glyph: the absence is the information
  // (the `missing` signal of U7 grows from this row).
  if (facts.length === 0 && !live.judge) return [row('proof:none', [label('proof'), span(hasWords ? 'nothing assumed or checked yet' : 'no facts, no check', 'dim')], columns, { kind: 'step', step: live.name })]
  const rows: LayoutRow[] = []
  const shown = facts.slice(0, Math.max(0, maxFacts))
  if (facts.length > 0) rows.push(row('proof:meet', [label('proof'), ...meetSpans(live.name, facts, room + 2)], columns, { kind: 'step', step: live.name }))
  shown.forEach((claim, index) => {
    const paint = paintOf(claim.status)
    const word = statusWord(claim)
    const says = draw.fit(claim.says, hasWords ? Math.max(8, room - cells(word) - 3) : room)
    const tail: Span[] = hasWords ? [span(' · ', 'faint'), span(word, claim.status === 'open' ? 'dim' : paint)] : []
    rows.push(row(`proof:fact:${index}`, [label(''), span(`${GLYPH[claim.status]} `, paint), span(says, claim.status === 'open' ? 'text' : paint), ...tail], columns, { kind: 'fact', step: live.name, index }))
  })
  if (facts.length > shown.length) rows.push(row('proof:more', [label(''), span(`+${facts.length - shown.length} more`, 'faint')], columns))
  if (live.judge) {
    const result = input.claims.find(claim => claim.step === live.name && claim.source === 'tool' && claim.says === live.judge)
    const word = result
      ? result.status === 'broken'
        ? result.evidence?.exitCode !== undefined ? `✗ exit ${result.evidence.exitCode}` : '✗ failed'
        : `✓ passed${result.evidence ? ` ${shortClock(result.evidence.ms)}` : ''}`
      : 'not run · press c'
    const says = draw.fit(live.judge, hasWords ? Math.max(8, room - cells(word) - 3) : room)
    const tail: Span[] = hasWords ? [span(' · ', 'faint'), span(word, result ? (result.status === 'broken' ? 'bad' : 'good') : 'dim')] : []
    rows.push(row('proof:check', [label(facts.length === 0 ? 'proof' : ''), span('⊢ ', 'math'), span(says, 'text'), ...tail], columns, { kind: 'check', step: live.name }))
  }
  return rows
}

/** A minute of the day from a clock stamp or a time, so calls and ledger lines sort on one scale; an unstamped line is newest. */
const minuteOf = (at: number | undefined): number => (at === undefined ? Infinity : new Date(at).getHours() * 60 + new Date(at).getMinutes())
const minuteOfStamp = (stamp: string): number => Number(stamp.slice(0, 2)) * 60 + Number(stamp.slice(3, 5))

/**
 * `doing`: what Claude does this second, then the newest events first: calls (declines as declines, failures red)
 * and the ledger's lines (a step flipping, a verb, a review, a drift, a plan switch), one timeline; the reason by
 * source after a call when there is room. Fills the rows it is given.
 */
const doingRows = (input: LayoutInput, columns: number, count: number): LayoutRow[] => {
  const label = (text: string) => marginLabel(text, columns)
  const rows: LayoutRow[] = []
  const head = input.isCalling && input.spent.doing ? `${draw.spinner(input.tick)} ${input.spent.doing}` : input.isWorking ? `${draw.spinner(input.tick)} thinking` : idleText(input)
  rows.push(row('doing:now', [label('doing'), span(head, input.isWorking ? 'live' : 'dim')], columns))
  type Event = { readonly minute: number; readonly spans: readonly Span[] }
  const calls: Event[] = input.spent.last.map(line => ({ minute: minuteOf(line.at), spans: actionSpans(line, columns) }))
  const notes: Event[] = (input.ledger ?? []).map(line => {
    const stamped = /^\d\d:\d\d /.test(line)
    const what = stamped ? line.slice(6) : line
    const isBad = what.startsWith('✗') || what.startsWith('drift')
    const isGood = what.includes('→ done') || what.startsWith('■') || what.startsWith('◆')
    return { minute: stamped ? minuteOfStamp(line) : Infinity, spans: [span('· ', 'dim'), span(what, isBad ? 'bad' : isGood ? 'good' : 'dim')] }
  })
  // Ledger lines first on a tie of the minute: a flip, a review or a drift is rarer than a call and must not fall
  // off. The ledger carries clock stamps, not dates, so across midnight an old line can sort as new once.
  const merged = [...notes, ...calls].toSorted((a, b) => b.minute - a.minute).slice(0, Math.max(0, count - 1))
  merged.forEach((event, index) => rows.push(row(`doing:${index}`, [label(''), ...event.spans], columns)))
  return rows
}

const idleText = (input: LayoutInput) => {
  const last = input.spent.last[0]
  if (!last || last.at === undefined) return 'idle'
  return `idle ${shortClock(Math.max(0, input.now - last.at))} · last: ${last.text}`
}

const actionSpans = (line: ActivityLine, columns: number): Span[] => {
  if (line.isDeclined) return [span('⊘ ', 'dim'), span(`${columns >= 40 ? 'declined by you' : 'declined'}  ${line.text}`, 'dim')]
  const mark = line.isOk ? '✓ ' : '✗ '
  const time = line.ms !== undefined && line.ms >= 1000 ? ` ${shortClock(line.ms)}` : ''
  const reason = columns >= 60 && line.said ? `   ${line.saidBy === 'you' ? 'you said' : 'Claude said'}: ${line.said}` : ''
  return [span(mark, line.isOk ? 'dim' : 'bad'), span(`${line.text}${time}`, line.isOk ? 'dim' : 'bad'), ...(reason ? [span(reason, 'faint')] : [])]
}

/** Every non-ASCII glyph the layout may draw; a kit test fails the build on any other. */
export const GLYPHS = new Set([...'╭╮╰╯│─┝┰┃┗━╸✓▶○~△◇■◆✗⊑⊓⊢∀∃∈≥≤≠¬⇒∴Σ…·⊘∅╶→×', ...draw.SPINNER])

/** True when every character of every span is ASCII or in the dictionary. */
export const isInDictionary = (rows: readonly LayoutRow[]): boolean =>
  rows.every(one => one.spans.every(part => [...part.text].every(char => char.charCodeAt(0) < 128 || GLYPHS.has(char))))

export const rowWidth = (one: LayoutRow): number => width(one.spans)

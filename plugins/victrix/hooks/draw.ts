// The drawing kit: pure helpers over strings and numbers. Every helper takes a width in cells and never
// returns more cells than asked, because a Text inside a Button ignores wrap (docs/MODS.md) and the owner's
// rule is that nothing on the instrument ever overflows. Cells are counted as code points (`Array.from`),
// which is right for every glyph the kit uses (all single-cell in a monospace terminal; no combining marks).

// One dot on the whole screen: the middle dot separates facts in words (`92 calls · 2 failed`) and parts of a ledger line.
export const SEP = '·'

// East Asian wide and emoji ranges take two cells; a combining mark takes none. The person's own words reach the
// pane (a plan title, a claim, a file name), so the count must hold for them, not only for the kit's glyphs.
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1F300}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{20000}-\u{3FFFD}]/u
const cellsOfChar = (char: string): number => (/\p{M}/u.test(char) ? 0 : WIDE.test(char) ? 2 : 1)

/** Cells a string takes on the terminal: one per code point, two for a wide character, none for a combining mark. */
export const cells = (text: string): number => Array.from(text).reduce((sum, char) => sum + cellsOfChar(char), 0)

/**
 * A line cut to `columns` cells with an ellipsis; the one place every row is cut. Width 0 draws nothing,
 * width 1 draws `…` for anything longer than one cell.
 */
export const fit = (text: string, columns: number): string => {
  const room = Math.max(0, Math.floor(columns))
  if (room === 0) return ''
  if (cells(text) <= room) return text
  if (room === 1) return '…'
  let used = 0
  const kept: string[] = []
  for (const char of Array.from(text)) {
    const next = used + cellsOfChar(char)
    if (next > room - 1) break
    kept.push(char)
    used = next
  }
  return `${kept.join('')}…`
}

export type Tally = { readonly ok: string; readonly bad: string; readonly running: string; readonly rest: string }

/**
 * A step's call tally as a bar: one `━` per call made (`ok`), the failed ones separately (`bad`, drawn red by the
 * caller), `╸` for the call running now, the rest of `width` empty. No denominator: it grows, it never "completes".
 * Past `width` calls the bar is full and the count beside it carries the number.
 */
export const tally = (calls: number, fails: number, width: number, isRunning = false): Tally => {
  const room = Math.max(0, Math.floor(width))
  const made = Math.max(0, Math.floor(calls))
  const failed = Math.min(made, Math.max(0, Math.floor(fails)))
  const shown = Math.min(made, room)
  const badShown = Math.min(failed, shown)
  const okShown = shown - badShown
  const runningCell = isRunning && shown < room ? '╸' : ''
  const rest = Math.max(0, room - shown - runningCell.length)
  return { ok: '━'.repeat(okShown), bad: '━'.repeat(badShown), running: runningCell, rest: ' '.repeat(rest) }
}

/**
 * Where the light is while it travels from row `from` to row `to` over `span` ms: at `elapsed` ms it sits on the
 * row the straight line has reached, `to` once the time is up; with no `from` it is already there.
 */
export const litIndex = (from: number | undefined, to: number, elapsed: number, span: number): number => {
  if (from === undefined || from === to || span <= 0) return to
  const share = Math.min(1, Math.max(0, elapsed / span))
  return Math.round(from + (to - from) * share)
}

/** A zone rule: `─ now ─────` across `columns`, the label one word; width too small for the word → bare rule. */
export const rule = (label: string, columns: number): string => {
  const room = Math.max(0, Math.floor(columns))
  const head = `─ ${label} `
  if (cells(head) + 1 > room) return '─'.repeat(room)
  return `${head}${'─'.repeat(room - cells(head))}`
}

/** A duration as a reader scans it: 48s, 3m 12s, 1h 04m. */
export const clock = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/** Word-wrap `text` into rows of at most `columns` cells; a word longer than a row is cut with `…`. Width 0 → []. */
export const wrap = (text: string, columns: number): string[] => {
  const room = Math.max(0, Math.floor(columns))
  if (room === 0) return []
  const rows: string[] = []
  let current = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const piece = cells(word) > room ? fit(word, room) : word
    if (current === '') current = piece
    else if (cells(current) + 1 + cells(piece) <= room) current = `${current} ${piece}`
    else {
      rows.push(current)
      current = piece
    }
  }
  if (current !== '') rows.push(current)
  return rows
}

/** `fit`, then padded with spaces to exactly `columns` cells, so columns stay aligned. */
export const pad = (text: string, columns: number): string => {
  const cut = fit(text, columns)
  return cut + ' '.repeat(Math.max(0, Math.floor(columns) - cells(cut)))
}

export type Line = { readonly filled: string; readonly half: string; readonly rest: string }

const BAR = '━'
const HALF = '╸'

/**
 * Rich's progress bar: `done/total` of `width` as filled heavy cells, one half cell when the fraction past
 * the last whole cell is at least a half, and the rest as the same heavy line to be drawn dim. The three
 * runs always add up to `width` cells so the caller can colour them and nothing moves.
 */
export const line = (done: number, total: number, width: number): Line => {
  const room = Math.max(0, Math.floor(width))
  if (room === 0) return { filled: '', half: '', rest: '' }
  const share = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0
  const exact = share * room
  const whole = Math.min(room, Math.floor(exact))
  const hasHalf = whole < room && exact - whole >= 0.5
  const filled = BAR.repeat(whole)
  const half = hasHalf ? HALF : ''
  const rest = BAR.repeat(room - whole - (hasHalf ? 1 : 0))
  return { filled, half, rest }
}

export type Pulse = { readonly before: string; readonly bright: string; readonly after: string }

const PULSE_CELLS = 6

/**
 * Rich's indeterminate pulse in two tones: a bright window of six cells travelling along a dim heavy line,
 * one cell per tick, wrapping at the end. The three runs add up to `width`.
 */
export const pulse = (width: number, tick: number): Pulse => {
  const room = Math.max(0, Math.floor(width))
  if (room === 0) return { before: '', bright: '', after: '' }
  const size = Math.min(PULSE_CELLS, room)
  const start = ((Math.floor(tick) % room) + room) % room
  const end = Math.min(room, start + size)
  return { before: BAR.repeat(start), bright: BAR.repeat(end - start), after: BAR.repeat(room - end) }
}

const RAMP = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const

/** The last `width` values on the eight-step block ramp, scaled to the largest of them; an empty list draws nothing. */
export const spark = (values: readonly number[], width: number): string => {
  const room = Math.max(0, Math.floor(width))
  const tail = (room === 0 ? [] : values.slice(-room)).map(value => (Number.isFinite(value) && value > 0 ? value : 0))
  const top = Math.max(0, ...tail)
  return tail
    .map(value => (top === 0 ? RAMP[0] : RAMP[Math.min(RAMP.length - 1, Math.floor((value / top) * (RAMP.length - 1)))]))
    .join('')
}

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

/** One braille frame per tick, round and round. */
export const spinner = (tick: number): string => SPINNER[((Math.floor(tick) % SPINNER.length) + SPINNER.length) % SPINNER.length] ?? SPINNER[0]

export type FaceState = 'idle' | 'working' | 'worried'

const FACES: Readonly<Record<FaceState, string>> = { idle: '[-_-]', working: '[o_o]', worried: '[o_O]' }

/** The face: `[-_-]` by default, `[o_o]` only while a call runs, `[o_O]` only when something needs you or broke. */
export const face = (state: FaceState): string => FACES[state]

/** Cells the face takes, so rows can line up under its bracket. */
export const FACE_CELLS = cells(FACES.idle)

export type FlowCall = { readonly text: string; readonly isOk: boolean; readonly isRunning?: boolean }

const ARROW = ' ▸ '

const flowWord = (call: FlowCall, frame: string) =>
  call.isRunning ? `${frame} ${call.text}`.trim() : call.isOk ? call.text : `${call.text} ✗`

/**
 * The flow of calls as words joined by `▸`, oldest first, the running one last with its spinner frame; the
 * oldest words are dropped until the row fits, and the last word alone is cut if even it does not.
 */
export const flow = (calls: readonly FlowCall[], width: number, frame = ''): string => {
  const room = Math.max(0, Math.floor(width))
  const words = calls.map(call => flowWord(call, frame))
  for (let from = 0; from < words.length; from += 1) {
    const text = words.slice(from).join(ARROW)
    if (cells(text) <= room) return text
  }
  return fit(words[words.length - 1] ?? '', room)
}

/**
 * A left text and a right text on one row of `width` cells, the right kept whole when it fits and the left cut
 * to the room that remains (one space between them at least); never wider than `width`.
 */
export const twoEnded = (left: string, right: string, width: number): string => {
  const room = Math.max(0, Math.floor(width))
  if (room === 0) return ''
  const rightCut = fit(right, room)
  const rightCells = cells(rightCut)
  if (rightCells === 0) return fit(left, room)
  const leftRoom = room - rightCells - 1
  if (leftRoom <= 0) return pad('', Math.max(0, room - rightCells)) + rightCut
  const leftCut = fit(left, leftRoom)
  return leftCut + ' '.repeat(room - cells(leftCut) - rightCells) + rightCut
}

/** Items joined by ` · `, cut to the row. */
export const chips = (items: readonly string[], width: number): string => fit(items.join(` ${SEP} `), width)

export type InkMark = 'done' | 'now' | 'open'

/** A minimap ink run sized to a step's name: heavy for done and now, dashed for open; at most `width` cells. */
export const ink = (nameCells: number, width: number, mark: InkMark): string => {
  const room = Math.max(0, Math.floor(width))
  const length = Math.min(room, Math.max(1, Math.ceil(Math.max(0, nameCells) / 3)))
  if (room === 0) return ''
  return (mark === 'open' ? '╌' : BAR).repeat(length)
}

export type TrunkKind = 'root' | 'step' | 'last' | 'detail' | 'detailLast' | 'under' | 'gap'

const TRUNK: Readonly<Record<TrunkKind, string>> = {
  root: '╭─',
  step: '├ ',
  last: '╰ ',
  detail: '│  ├ ',
  detailLast: '│  ╰ ',
  under: '│  │  ',
  gap: '│  ',
}

/** The one tree's prefixes: the trunk rises into the face, branches are steps, details branch under the lit step. */
export const trunk = (kind: TrunkKind): string => TRUNK[kind]

const ASCII_MAP: ReadonlyArray<readonly [string, string]> = [
  ['╭─', '+-'],
  ['├ ', '|-'],
  ['╰ ', '+-'],
  ['│', '|'],
  ['━', '='],
  ['╸', '-'],
  ['╌', '-'],
  ['▸', '>'],
  ['◉', '*'],
  ['✓', 'v'],
  ['✗', 'x'],
  ['△', '^'],
  ['■', '#'],
  ['◆', '<>'],
  ['○', 'o'],
  ['·', '.'],
  ['…', '...'],
  ['→', '->'],
]

/** The same row in ASCII, for `NO_COLOR` or a terminal without the glyphs. Spinner and ramp glyphs become `*` and `#`. */
export const toAscii = (text: string): string => {
  const swapped = ASCII_MAP.reduce((acc, [from, to]) => acc.split(from).join(to), text)
  return Array.from(swapped)
    .map(char => (SPINNER.includes(char as (typeof SPINNER)[number]) ? '*' : (RAMP as readonly string[]).includes(char) ? '#' : char))
    .join('')
}

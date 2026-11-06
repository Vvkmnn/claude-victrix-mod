// Which size Victrix takes, and how wide the pane asks to be. Three sizes of one drawing (owner, 2026-11-07): the
// pane beside the chat, the row above the prompt, and hidden, which is still one short snake row naming its key, so
// Victrix never disappears for good. `s` moves through them in that order. Pure; no `$`.

export type Size = 'pane' | 'row' | 'hidden'

/** The person's standing choice: a size, or `auto` to let the moment decide (the pane where it seats, else the row). */
export type SizeChoice = Size | 'auto'

export const SIZES: readonly Size[] = ['pane', 'row', 'hidden']

export type Moment = {
  readonly choice: SizeChoice
  readonly isPlanMode: boolean
  /** An engine dialog (plan approval, a question) is up: the engine narrows the pane itself; the pane stays the pane. */
  readonly isDialogUp: boolean
  /** The surface can seat a pane at all (wide enough, fullscreen); false gives the row. */
  readonly canDock: boolean
}

/** Hidden whenever chosen; otherwise the pane where one can seat, unless the row was chosen; the row when none can. */
export const chooseSize = (moment: Moment): Size => {
  if (moment.choice === 'hidden') return 'hidden'
  if (!moment.canDock) return 'row'
  return moment.choice === 'row' ? 'row' : 'pane'
}

/** The size `s` moves to: pane, row, hidden, then the pane again. */
export const nextSize = (size: Size): Size => SIZES[(SIZES.indexOf(size) + 1) % SIZES.length] ?? 'pane'

/** Names kept by versions before the rename (0.3.0 and earlier stored `third` and `tape`). */
const LEGACY: Readonly<Record<string, SizeChoice>> = { third: 'pane', tape: 'row' }

/** A stored value as a size choice: today's names, the old names read as their new ones, anything else undefined. */
export const sizeChoiceOf = (value: unknown): SizeChoice | undefined => {
  if (typeof value !== 'string') return undefined
  if (value === 'auto' || (SIZES as readonly string[]).includes(value)) return value as SizeChoice
  return LEGACY[value]
}

/** The engine seats an unasked pane from 144 columns (110 once asked); a docked body is at least 24 and at most 45% wide. */
export const DOCK_MIN_COLUMNS = 110
const DOCK_FLOOR = 24
const DOCK_CEILING = 0.45

/**
 * The fresh-install share of the terminal (owner, 2026-11-05: 27%); the engine keeps a dragged width over any request.
 * What that comes to on MacBooks, measured and estimated (2026-11-05; SF Mono 12.3 in Ghostty on a 13" Air is 186
 * columns full-screen, the owner's own; Terminal.app's default window is 80×24 and its Menlo 11 gives about 220
 * full-screen; the Claude app's panel is a narrow rung of its own):
 *   full screen, 13"/14"  ~186–200 cols → a 50–54-column pane, about 50 rows
 *   full screen, 15"/16"  ~218–240 cols → 59–65
 *   half screen, or any tmux split      ~92–120 → under 110 no pane seats: the row; at 110–120 a 30–32-column pane
 *   quarter screen                      the half's columns, ~25 rows
 *   a fresh Terminal.app window          80×24 → the row, until the person maximises
 */
export const DOCK_SHARE = 0.27

/** Columns the pane asks the engine for, inside the engine's floor and ceiling. */
export const dockColumns = (terminalColumns: number): number => {
  const asked = Math.round(Math.max(0, terminalColumns) * DOCK_SHARE)
  return Math.max(DOCK_FLOOR, Math.min(asked, Math.floor(terminalColumns * DOCK_CEILING)))
}

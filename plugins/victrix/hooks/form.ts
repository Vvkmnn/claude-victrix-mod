// Which size Victrix takes, and how wide the pane asks to be. Three sizes of one drawing (owner, 2026-11-07): the
// pane beside the chat (inline above the prompt where the surface is narrow), the row above the prompt, and hidden,
// one short snake row that still names its key, so Victrix never disappears for good. `s` moves through them in that
// order, for the session only: every session starts at the pane, the largest. Pure; no `$`.

export type Size = 'pane' | 'row' | 'hidden'

/** The person's choice this session: a size, or `auto` (the pane, until they press `s` or close it). */
export type SizeChoice = Size | 'auto'

export const SIZES: readonly Size[] = ['pane', 'row', 'hidden']

export type Moment = {
  readonly choice: SizeChoice
  readonly isPlanMode: boolean
  /** An engine dialog (plan approval, a question) is up: the engine narrows the pane itself; the pane stays the pane. */
  readonly isDialogUp: boolean
}

/**
 * Always the full pane unless the person chose the row or hidden with `s` (owner, 2026-11-07: "always start in full
 * mode, small only when I ask for it"). Width never picks the row: a narrow surface seats the pane inline above the
 * prompt, and only an engine that seats no pane at all leaves the row, as its fallback (the band draws while no pane
 * of ours is placed).
 */
export const chooseSize = (moment: Moment): Size => (moment.choice === 'hidden' ? 'hidden' : moment.choice === 'row' ? 'row' : 'pane')

/** The size `s` moves to: pane, row, hidden, then the pane again. */
export const nextSize = (size: Size): Size => SIZES[(SIZES.indexOf(size) + 1) % SIZES.length] ?? 'pane'

// The engine docks an unasked pane from 144 columns (110 once asked) and seats it inline above the prompt below
// that; a docked body is at least 24 and at most 45% wide.
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

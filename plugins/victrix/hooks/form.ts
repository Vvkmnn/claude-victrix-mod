// Which form the instrument takes, and how wide a docked form asks to be. One drawing: the map whenever a dock can
// seat, the one-row band above the prompt when none can. The strip form and the ink rows are gone (owner, 2026-11-05:
// a dash the length of a word you cannot read is a lie). Pure; no `$`.

export type Form = 'tape' | 'third'

/** The person's standing choice: a form, or `auto` to let the moment decide. Kept for the config menu; the pane shows no button for it. */
export type FormChoice = Form | 'auto'

export const FORMS: readonly Form[] = ['tape', 'third']

export type Moment = {
  readonly choice: FormChoice
  readonly isPlanMode: boolean
  /** An engine dialog (plan approval, a question) is up: the engine narrows the dock itself; the map stays the map. */
  readonly isDialogUp: boolean
  /** The surface can seat a dock at all (wide enough, fullscreen); false forces the tape. */
  readonly canDock: boolean
}

/** The map whenever a dock can seat, in every mode and under every dialog; the tape only when no dock can seat. */
export const chooseForm = (moment: Moment): Form => {
  if (!moment.canDock) return 'tape'
  return moment.choice === 'tape' ? 'tape' : 'third'
}

/** The engine seats an unasked dock from 144 columns (110 once asked); a docked body is at least 24 and at most 45% wide. */
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
 *   half screen, or any tmux split      ~92–120 → under 110 no dock seats: the ribbon; at 110–120 a 30–32-column pane
 *   quarter screen                      the half's columns, ~25 rows
 *   a fresh Terminal.app window          80×24 → the ribbon, until the person maximises
 */
export const DOCK_SHARE = 0.27

/** Columns the map asks the engine for, inside the engine's floor and ceiling. */
export const dockColumns = (_form: 'third', terminalColumns: number): number => {
  const asked = Math.round(Math.max(0, terminalColumns) * DOCK_SHARE)
  return Math.max(DOCK_FLOOR, Math.min(asked, Math.floor(terminalColumns * DOCK_CEILING)))
}

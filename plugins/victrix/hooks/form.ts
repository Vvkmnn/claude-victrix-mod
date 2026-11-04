// Which of the three forms the instrument takes, and how wide a docked form asks to be. One instrument, never
// two forms at once (owner): the tape above the prompt, the third-of-screen map, or the 13% strip. Pure; no `$`.

export type Form = 'tape' | 'third' | 'strip'

/** The person's standing choice: a form, or `auto` to let the moment decide. */
export type FormChoice = Form | 'auto'

export const FORMS: readonly Form[] = ['tape', 'third', 'strip']

export type Moment = {
  readonly choice: FormChoice
  readonly isPlanMode: boolean
  /** An engine dialog (plan approval, a question) is up: the dock must get out of its way. */
  readonly isDialogUp: boolean
  /** The surface can seat a dock at all (wide enough, fullscreen); false forces the tape. */
  readonly canDock: boolean
}

/**
 * Vertical whenever it fits (owner): the third-of-screen map whenever a dock can seat, in every mode, since the
 * engine's own full-screen plan view hides panes anyway and the map's home is watching Claude work through the plan
 * (owner, 2026-11-04); the strip under an engine dialog; the tape only when no dock can seat. A standing choice
 * wins, except that a dialog still shrinks a third to a strip and no dock means the tape whatever was chosen.
 */
export const chooseForm = (moment: Moment): Form => {
  if (!moment.canDock) return 'tape'
  const wanted: Form = moment.choice === 'auto' ? 'third' : moment.choice
  if (moment.isDialogUp && wanted === 'third') return 'strip'
  return wanted
}

/** The next standing choice after one press of the `form` button: tape → third → strip → auto → tape. */
export const nextChoice = (choice: FormChoice): FormChoice => {
  const cycle: readonly FormChoice[] = ['tape', 'third', 'strip', 'auto']
  return cycle[(cycle.indexOf(choice) + 1) % cycle.length] ?? 'auto'
}

/** The engine seats an unasked dock from 144 columns (110 once asked); a docked body is at least 24 and at most 45% wide. */
export const DOCK_MIN_COLUMNS = 110
const DOCK_FLOOR = 24
const DOCK_CEILING = 0.45

/** Columns a docked form asks the engine for: a third or 13% of the terminal, inside the engine's floor and ceiling. */
export const dockColumns = (form: Exclude<Form, 'tape'>, terminalColumns: number): number => {
  // A quarter of the terminal for the map (owner, 2026-11-04: "aim for where my 26 is", about 77 of 308 columns); the
  // engine honours it only where nobody has dragged the dock, and keeps a dragged width over any request.
  const share = form === 'third' ? 0.25 : 0.13
  const asked = Math.round(Math.max(0, terminalColumns) * share)
  return Math.max(DOCK_FLOOR, Math.min(asked, Math.floor(terminalColumns * DOCK_CEILING)))
}

/** The one-word label the `form` button shows for the choice it will move to next. */
export const choiceLabel = (choice: FormChoice): string => ({ tape: 'tape', third: 'map', strip: 'strip', auto: 'auto' })[choice]

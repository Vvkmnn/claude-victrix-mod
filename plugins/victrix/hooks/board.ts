// The board's arithmetic, pure and small: how far the head is along its task, how far the snake has crept while a
// plan is written, which calls earn a log row and how runs of them fold, and the one order in which a pane of any
// height hands out its rows. `layout.ts` draws from these; the kit measures them. Every function here is total over
// its inputs and monotone where the owner's law demands it: a shorter pane never gets a row a taller one lacks.
import type { ActivityLine, Claim, PlanItem } from '../types'

/** Calls that make an effort bar read as half done; past it the head slows and never arrives. */
export const EFFORT_HALF = 20

/**
 * How far along its row the head is, 0 to 1. A true fraction when the step has a denominator (sub-steps done, facts
 * checked), effort otherwise: `calls / (calls + EFFORT_HALF)`, which climbs fast, then slows, and reaches 1 only when
 * the step flips (the caller draws the flip, not this).
 */
export const headFraction = (step: PlanItem, facts: readonly Claim[], calls: number): number => {
  const children = step.children.filter(child => !child.isAbandoned)
  const denominator = children.length + facts.length
  if (denominator > 0) {
    const done = children.filter(child => child.isDone).length + facts.filter(claim => claim.status === 'checked' || claim.status === 'proved').length
    return Math.min(1, Math.max(0, done / denominator))
  }
  const made = Math.max(0, calls)
  return made / (made + EFFORT_HALF)
}

/** Cells from the right edge the creeping head has covered while a plan is written: by effort, never the whole way. */
export const creepCells = (calls: number, distance: number): number => Math.min(Math.max(0, distance - 1), Math.floor(headFraction({ children: [] } as unknown as PlanItem, [], calls) * distance))

/** One row of the process log after folding: the line as the log keeps it and how many identical calls it stands for. */
export type LogRow = { readonly line: ActivityLine; readonly count: number }

/** The rows the log shows, newest first: everything Claude did for the plan (owner: "anything"), identical consecutive calls folded into one with a count. */
export const foldLog = (lines: readonly ActivityLine[]): LogRow[] =>
  lines.reduce<LogRow[]>((rows, line) => {
    const last = rows[rows.length - 1]
    const same = last && last.line.text === line.text && last.line.isOk === line.isOk && (last.line.isDeclined ?? false) === (line.isDeclined ?? false)
    if (same && last.line.helper === line.helper && last.line.detail === line.detail && !line.isRunning && !last.line.isRunning) {
      return [...rows.slice(0, -1), { line: last.line, count: last.count + 1 }]
    }
    return [...rows, { line, count: 1 }]
  }, [])

export type BudgetInput = {
  readonly rows: number
  /** The live step exists (its name row and its bar). */
  readonly hasLive: boolean
  readonly doneCount: number
  readonly openCount: number
  /** Two-line proof units the live step has (facts and its check), and process rows after folding (the head row not counted). */
  readonly proofUnits: number
  readonly logRows: number
  readonly hasProblem: boolean
}

export type Budget = {
  readonly footer: number
  readonly logHead: number
  readonly proofUnits: number
  readonly open: number
  /** Open steps folded behind `… N more steps`, and whether that row is drawn (it is not when no open row fits at all). */
  readonly openFolded: number
  readonly openFoldRow: boolean
  readonly done: number
  readonly doneFolded: number
  readonly doneFoldRow: boolean
  readonly log: number
  readonly padding: number
}

/** The log never takes more than this unless nothing else is left to show (owner: "just a log for no reason"). */
export const LOG_CAP = 8
/** The log gets this many rows before the done rows fill the horizon (owner: "at least 7 rows; anything Claude is doing for this plan"). */
export const LOG_FLOOR = 7
/** The proof shows at most this many facts, the newest, behind one fold that counts the older ones (owner: incremental, never overflowing). */
export const PROOF_CAP = 4
/** The live step keeps the middle: done rows fill the rows above it only down to this share of the pane at first. */
export const HORIZON = 0.45

/**
 * Rows handed out in one fixed order, each wish taking what is left, so a taller pane only ever adds. The order:
 * the box (3, always), the live step's name row and bar (2), the footer (a rule and two lines; the rule goes under
 * 16 rows), the problem line, the log's head row and two rows, the first proof unit (2 rows), the next two open
 * steps with their fold row, the log up to its floor, the done steps newest first down to the horizon with their
 * fold row, the rest of the proof units, the rest of the log up to its cap, the rest of the open steps, the rest of
 * the done steps, the rest of the log past the cap, blank rows last.
 */
export const budget = (input: BudgetInput): Budget => {
  const rows = Math.max(0, input.rows)
  let left = Math.max(0, rows - 3 - (input.hasLive ? 2 : 0))
  const take = (want: number): number => {
    const got = Math.max(0, Math.min(want, left))
    left -= got
    return got
  }
  const footer = take(rows >= 16 ? 3 : 2)
  if (input.hasProblem) take(1)
  const logHead = take(input.hasLive || input.logRows > 0 ? 1 : 0)
  const logBase = take(Math.min(input.logRows, 2))
  let proofUnits = 0
  if (input.proofUnits > 0) {
    const got = take(2)
    if (got === 2) proofUnits = 1
    else left += got
  }
  const openBase = take(input.openCount === 0 ? 0 : Math.min(input.openCount, 2) + (input.openCount > 2 ? 1 : 0))
  const logFloor = take(Math.max(0, Math.min(input.logRows, LOG_FLOOR) - logBase))
  const horizon = Math.max(0, Math.floor(rows * HORIZON) - 3)
  const doneBase = take(Math.min(input.doneCount, horizon))
  // A proof unit is two rows; a lone odd row is left blank rather than handed on, else one more row of height could
  // complete a unit and take a log row back, which the monotone law forbids.
  const proofMoreRows = take(Math.max(0, input.proofUnits - proofUnits) * 2)
  proofUnits += Math.floor(proofMoreRows / 2)
  const wasted = proofMoreRows % 2
  const logMore = take(Math.max(0, Math.min(input.logRows, LOG_CAP) - logBase - logFloor))
  const openMore = openBase > 0 ? take(Math.max(0, input.openCount - 2)) : 0
  const doneGot = doneBase + take(input.doneCount - doneBase)
  const logPast = take(Math.max(0, input.logRows - Math.max(logBase + logFloor + logMore, LOG_CAP)))
  const padding = left + wasted
  // Open steps: of the rows taken, one is the fold row while any stay folded; the last task is always among the shown.
  const openWant = openBase + openMore
  const open = Math.max(0, Math.min(input.openCount, openWant - (input.openCount > openWant ? 1 : 0)))
  const openFolded = Math.max(0, input.openCount - open)
  const done = doneGot >= input.doneCount ? input.doneCount : Math.max(0, doneGot - 1)
  const doneFolded = Math.max(0, input.doneCount - done)
  return {
    footer,
    logHead,
    proofUnits,
    open,
    openFolded,
    openFoldRow: openFolded > 0 && openWant > 0,
    done,
    doneFolded,
    doneFoldRow: doneFolded > 0 && doneGot > 0,
    log: logBase + logFloor + logMore + logPast,
    padding,
  }
}

// Vada's state contract. The lens code began as the plan lens of github.com/Vvkmnn/claude-emporium
// (plugins/emporium, Oct 2026, same author) and is carried on here.

export type PlanItem = {
  readonly name: string
  /** The plain note after the bold name, tags removed. */
  readonly note: string
  /** The `why:` tag of the note: why this step exists. Empty when the plan gives none. */
  readonly why: string
  /** The `trade:` tag: what the step gives up. */
  readonly trade: string
  /** The `judge:` tag: what proves the step done. */
  readonly judge: string
  /** Wording in the note that assumes something (assume, should, probably, likely…), each one line. */
  readonly assumptions: readonly string[]
  readonly isDone: boolean
  readonly isAbandoned: boolean
  readonly line: number
  readonly children: readonly PlanItem[]
}

export type PlanSection = { readonly title: string; readonly items: readonly PlanItem[] }

export type PlanTree = {
  readonly title: string | undefined
  readonly progress: string | undefined
  /** The first paragraph under `## Summary` (or `## Context`): what the plan is for, in the plan's words. */
  readonly summary: string | undefined
  readonly sections: readonly PlanSection[]
}

/** The plan the lens follows: its path, and its tree, or null while the file cannot be read. */
export type PlanView = { readonly path: string; readonly tree: PlanTree | null }

/** A plan file offered when none is followed yet: newest first. */
export type RecentPlan = { readonly path: string; readonly title: string; readonly mtimeMs: number }

export type ActivityLine = { readonly text: string; readonly isOk: boolean }

/** What the main loop is doing and has done, and the tokens the session and this turn have spent. */
export type Activity = {
  readonly doing: string | null
  readonly last: readonly ActivityLine[]
  readonly tokensIn: number
  readonly tokensOut: number
  readonly turnIn: number
  readonly turnOut: number
}

/** The three verbs a person presses on a plan line. */
export type NoteKind = 'doubt' | 'add' | 'wrong'

/** One pressed verb, tied to the step it was pressed on; `text` is the fact typed for `add`. */
export type Note = {
  readonly kind: NoteKind
  readonly step: string
  readonly text: string
  readonly at: number
}

declare module 'claude-code' {
  interface PluginState {
    victrix: {
      plan: PlanView | null
      cursor: number
      toggled: readonly string[]
      cwd: string
      recent: readonly RecentPlan[]
      activity: Activity
      /** Notes pressed and not yet delivered to Claude. */
      notes: readonly Note[]
      /** The step an `add data` press is waiting on: the next typed prompt is that fact. */
      pendingAdd: string | null
      /** True while the main loop's turn runs: notes wait for its next step. */
      isWorking: boolean
      /** `?` pressed: the selected step's why, trade and judge are shown in full. */
      showWhy: boolean
    }
  }
}

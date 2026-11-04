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
  /** Wording in the note that assumes something (assume, should, probably, likely…), each one line; the texts of `facts`. */
  readonly assumptions: readonly string[]
  /** The facts the step leans on, each with where it came from (`facts:`/`assume:` tags, source prefixes `data: code: you: claude:`). */
  readonly facts: readonly PlanFact[]
  /** The `guard:` tag: what the fast path checks at runtime, its fallback and its cost. */
  readonly guard: string
  /** The `options:` tag: ideas worth 2× to build and measure, or for the person to decline. */
  readonly options: readonly string[]
  /** The `slow:` tag: the obvious reference version a shortcut is measured against. */
  readonly slow: string
  readonly isDone: boolean
  readonly isAbandoned: boolean
  readonly line: number
  readonly children: readonly PlanItem[]
}

/** One fact a step leans on and where it came from. */
export type PlanFact = { readonly text: string; readonly source: ClaimSource }

/** broken < open < checked < proved: formal/Anka.lean's `Status`. */
export type Status = 'broken' | 'open' | 'checked' | 'proved'

/** Where a claim came from: the plan's wording, the data, the code, the person, Claude, a doubt, a tool run, or Lean. */
export type ClaimSource = 'wording' | 'data' | 'code' | 'you' | 'claude' | 'doubt' | 'tool' | 'lean'

/** What a tool run left behind: the command, its exit code, how many cases, how long, the last lines, and for Lean the theorem and axioms. */
export type Evidence = {
  readonly kind: 'test' | 'differential' | 'fuzz' | 'lean'
  readonly command: string
  readonly exitCode: number
  readonly cases?: number
  readonly ms: number
  readonly tail: string
  readonly theorem?: string
  readonly axioms?: readonly string[]
  readonly hasSorry?: boolean
  /** The theorem's statement in plain English by a model that never saw the claim's words; a person's `right` lifts the claim to proved. */
  readonly english?: string
  /** Files the check named, with their mtimes, so a later edit marks the claim stale. */
  readonly files?: readonly { readonly path: string; readonly mtimeMs: number }[]
}

/** One claim under a plan step: what it says, how sure, and the evidence; the label is derived, never stored. */
export type Claim = {
  readonly step: string
  readonly says: string
  readonly status: Status
  readonly source: ClaimSource
  readonly evidence?: Evidence
  readonly counterexample?: string
  readonly at: number
  readonly stale?: true
  readonly isChecking?: true
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

/** One call Claude made: what, whether it worked, when, how long, under which step, and what Claude said just before it (its own words, labelled so). */
export type ActivityLine = {
  readonly text: string
  readonly isOk: boolean
  /** The person (or the permission system) declined the call: drawn as a decline, never as a failure. */
  readonly isDeclined?: boolean
  readonly at?: number
  readonly ms?: number
  readonly step?: string
  readonly said?: string
  /** Who said `said`: Claude's thinking words, or the person's verb delivered just before the call. */
  readonly saidBy?: 'claude' | 'you'
}

/** What one plan step cost so far: calls, failures, tokens, and the time Claude has been on it. */
export type StepSpend = {
  readonly calls: number
  readonly fails: number
  readonly tokens: number
  readonly enteredAt: number
  readonly ms: number
}

/** What the main loop is doing and has done, and the tokens the session, this turn and each step have spent. */
export type Activity = {
  readonly doing: string | null
  readonly last: readonly ActivityLine[]
  readonly tokensIn: number
  readonly tokensOut: number
  readonly turnIn: number
  readonly turnOut: number
  readonly stepNow: string | null
  readonly steps: Readonly<Record<string, StepSpend>>
  /** The latest words before the next call, kept short: Claude's thinking, or the person's verb; attached to that call as `said`. */
  readonly said: string
  readonly saidBy: 'claude' | 'you'
}

/** A one-row question the tape asks, answered by a digit or a click; `kind` says what the answer becomes. */
export type Question = {
  readonly kind: 'feel' | 'build'
  readonly step: string
  readonly says: string
  readonly at: number
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
      /** Every claim under every step, keyed by step and words; checks and answers replace in place. */
      claims: readonly Claim[]
      /** The person's standing choice of form: tape, third, strip, or auto. */
      formChoice: 'tape' | 'third' | 'auto'
      /** Counts up while a call runs on the terminal: spinner frame and pulse position. */
      tick: number
      /** The questions an AskUserQuestion in flight asks, until it returns. */
      asking: readonly string[]
      /** True while ExitPlanMode or AskUserQuestion is in flight on the main loop. */
      isDialogUp: boolean
      isPlanMode: boolean
      /** The terminal's columns as the last render saw them; 0 before any. */
      viewportColumns: number
      /** Whether the surface placed the dock when it was last opened. */
      isPlaced: boolean
      /** Gut-check questions the tape asks, oldest first. */
      questions: readonly Question[]
      /** What changed because of the person or a check, newest first, this session. */
      changed: readonly string[]
      /** The row key whose card is open, or null. */
      openedCard: string | null
      /** The surface the session started on. */
      surface: string
      /** The context window's fill as last reported, 0 to 100. */
      contextPercent: number
      /** Tokens spent per step this session. */
      stepTokens: readonly number[]
      /** Context percent at the end of each turn, newest last, so the gauge shows the delta per turn. */
      ctxHistory: readonly number[]
      /** The trust signals the evidence supports for the live step, worst first; the pane shows them in words. */
      signals: readonly Signal[]
      /** The one signal the line above the prompt carries until answered: a warning at once, a caution at the turn's end. */
      alert: Signal | null
    }
  }
}

/** A trust signal (see hooks/signals.ts): what the evidence says about Claude's words, graded as a cockpit grades alerts. */
export type Signal = {
  readonly kind: 'unbacked' | 'contradicted' | 'unchecked' | 'repeating' | 'off-plan' | 'missing' | 'stale'
  readonly level: 'advisory' | 'caution' | 'warning'
  readonly words: string
  /** Which side needs more: the maths (a fact, a check, a verify line) or Claude (its words, its path). */
  readonly needs: 'maths' | 'claude'
}

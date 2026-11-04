// The trust signals: what the pane can say about Claude's words from evidence it holds, never from the words alone
// (owner, 2026-11-05: "what Claude is lying to me, faking, hallucinating, confused or missing about"). Each signal
// is derived from calls and their exit codes, the plan step, the claims ledger and the text Claude spoke before a
// call; each is graded as a cockpit grades alerts: advisory (a dim word, never interrupts), caution (orange, one
// line above the prompt at the turn's end), warning (red, at once). Pure; the lens feeds it and paints it.
import type { ActivityLine, Claim, Signal } from '../types'

export type SignalKind = Signal['kind']
export type Level = Signal['level']
export type { Signal }

export type SignalInput = {
  /** What Claude said this turn, before and between calls (the `said` of each call line and the words since the last). */
  readonly spoken: readonly string[]
  /** The calls of this turn, newest first, as the log keeps them. */
  readonly calls: readonly ActivityLine[]
  /** The calls of the live step so far, newest first, for repetition across turns. */
  readonly stepCalls: readonly ActivityLine[]
  readonly claims: readonly Claim[]
  /** The live step has a `verify:` line. */
  readonly hasJudge: boolean
  /** Options worth 2× that nobody built or declined, and `not sure` answers still open. */
  readonly openOptions: number
  readonly unsure: number
  readonly offPlanTurns: number
}

const LEVEL_RANK: Readonly<Record<Level, number>> = { advisory: 0, caution: 1, warning: 2 }

/** Claude's words that claim a check happened or a thing holds. */
const CLAIM_WORDS = /\b(tests? (now )?pass(es|ed)?|all (tests )?(pass|green)|verified|confirmed|it works|now works|is fixed|fixed it|passes now|green now)\b/i

/** A call that could back such a claim: a test runner, a build, or the mod's own check tool. */
const VERIFYING = /^(run (bun|npm|pnpm|yarn|node|deno|pytest|python3? -m pytest|go|cargo|make|lake)\b|victrix check\b|check\b)/

const isVerifying = (line: ActivityLine): boolean => VERIFYING.test(line.text)
const commandOf = (line: ActivityLine): string => line.text.replace(/^run /, '')
const ordinal = (n: number): string => (n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`)

/**
 * Every signal the evidence supports, worst first. Words are the shortest that still say the so-what; they name
 * what was said and what ran, never an intent (`says`, `assumed`, `contradicted`, `repeating`, never `lying`).
 */
export const signalsOf = (input: SignalInput): Signal[] => {
  const out: Signal[] = []
  const said = input.spoken.find(text => CLAIM_WORDS.test(text))
  const verifying = input.calls.filter(isVerifying)
  const failed = verifying.find(line => !line.isOk && !line.isDeclined)
  const passed = verifying.find(line => line.isOk)
  if (said !== undefined) {
    const claim = CLAIM_WORDS.exec(said)?.[0]?.toLowerCase() ?? 'it holds'
    if (failed !== undefined && passed === undefined) out.push({ kind: 'contradicted', needs: 'claude', level: 'warning', words: `says ${claim} · ${commandOf(failed)} failed` })
    else if (verifying.length === 0) out.push({ kind: 'unbacked', needs: 'claude', level: 'caution', words: `says ${claim} · no test ran` })
  }

  // The same command failing again, the third time a warning; the same file edited four times in one step.
  const failures = new Map<string, number>()
  for (const line of input.stepCalls) if (isVerifying(line) && !line.isOk && !line.isDeclined) failures.set(commandOf(line), (failures.get(commandOf(line)) ?? 0) + 1)
  for (const [command, count] of failures) if (count >= 2) out.push({ kind: 'repeating', needs: 'claude', level: count >= 3 ? 'warning' : 'caution', words: `${ordinal(count)} run of ${command}, still failing` })
  const edits = new Map<string, number>()
  for (const line of input.stepCalls) if (/^(edit|write) /.test(line.text)) edits.set(line.text, (edits.get(line.text) ?? 0) + 1)
  for (const [text, count] of edits) if (count >= 4) out.push({ kind: 'repeating', needs: 'claude', level: 'caution', words: `${ordinal(count)} ${text} this step` })

  if (input.offPlanTurns >= 3) out.push({ kind: 'off-plan', needs: 'claude', level: input.offPlanTurns >= 6 ? 'caution' : 'advisory', words: `off-plan · ${input.offPlanTurns} turns` })

  const assumed = input.claims.filter(claim => claim.status === 'open' && claim.source === 'claude')
  if (assumed.length > 0) out.push({ kind: 'unchecked', needs: 'maths', level: 'advisory', words: assumed.length === 1 ? 'assumed by Claude · nobody checked' : `${assumed.length} assumed by Claude · nobody checked` })
  if (input.claims.some(claim => claim.stale)) out.push({ kind: 'stale', needs: 'maths', level: 'advisory', words: 'checked before the last edit · run it again' })

  if (input.claims.length === 0 && !input.hasJudge) out.push({ kind: 'missing', needs: 'maths', level: 'advisory', words: 'no facts, no check' })
  if (input.openOptions > 0) out.push({ kind: 'missing', needs: 'maths', level: 'caution', words: `${input.openOptions} option${input.openOptions === 1 ? '' : 's'} worth 2× · neither built nor declined` })
  if (input.unsure > 0) out.push({ kind: 'missing', needs: 'maths', level: 'advisory', words: `${input.unsure} answer${input.unsure === 1 ? '' : 's'} still not sure` })

  return out.toSorted((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level])
}

/** The one signal the line above the prompt may carry: the worst, a caution waiting behind a warning. */
export const worst = (signals: readonly Signal[]): Signal | undefined => signals[0]

/** Which side needs more right now, in words the person can act on (owner: "if the maths needs more or the AI needs more or both"). */
export const needWords = (signals: readonly Signal[]): string => {
  const maths = signals.some(one => one.needs === 'maths')
  const claude = signals.some(one => one.needs === 'claude')
  return maths && claude ? 'the maths and Claude both need more' : maths ? 'the maths needs more' : claude ? 'Claude needs a steer' : ''
}

/** Cautions and advisories hold while the person is busy; warnings pass through (the cockpit's inhibit rule). */
export const isInhibited = (signal: Signal, busy: { readonly isTyping: boolean; readonly isDialogUp: boolean; readonly msSinceVerb: number }): boolean =>
  signal.level !== 'warning' && (busy.isTyping || busy.isDialogUp || busy.msSinceVerb < 5000)

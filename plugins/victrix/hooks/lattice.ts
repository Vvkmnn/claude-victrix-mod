// The status lattice of formal/Anka.lean, in TypeScript: a claim is only as strong as its own check and its
// weakest premise (T1, `combine_le_own` and `combine_le_premise`). Labels are a pure function of (status,
// source): the model never writes one. Pure; no `$`.
import type { Claim, ClaimSource, Evidence, Status } from '../types'
import { MARK } from './draw'

export type { Claim, ClaimSource, Evidence, Status }

/** broken < open < checked < proved, as `Status.rank` in Anka.lean. */
export const RANK: Readonly<Record<Status, number>> = { broken: 0, open: 1, checked: 2, proved: 3 }

export const STATUSES: readonly Status[] = ['broken', 'open', 'checked', 'proved']

/** `Status.meet`: the weaker of two. */
export const meet = (a: Status, b: Status): Status => (RANK[a] <= RANK[b] ? a : b)

/** `combine`: a conclusion from premises is the meet of its own check and every premise. */
export const combine = (own: Status, premises: readonly Status[]): Status => premises.reduce(meet, own)

/** A step's status: its own check (`open` until its verify ran) met with every claim under it, so it is never stronger than either. */
export const stepStatus = (claims: readonly Claim[], own: Status = 'open'): Status => combine(own, claims.map(claim => claim.status))

/** The claim holding a step down: the first of its weakest, in the order drawn. */
export const weakest = (claims: readonly Claim[]): Claim | undefined =>
  claims.reduce<Claim | undefined>((low, claim) => (low === undefined || RANK[claim.status] < RANK[low.status] ? claim : low), undefined)

/** The glyph a status draws: shape carries the meaning, colour only repeats it. */
export const GLYPH: Readonly<Record<Status, string>> = { broken: MARK.broken, open: MARK.open, checked: MARK.checked, proved: MARK.proved }

const STANDARD_AXIOMS: readonly string[] = ['propext', 'Classical.choice', 'Quot.sound']

/** True when every axiom named is one of Lean's three standard ones, the only ones a proved claim may rest on. */
export const isStandardAxioms = (axioms: readonly string[]): boolean => axioms.every(axiom => STANDARD_AXIOMS.includes(axiom))

/**
 * The words beside a claim, from its status and where it came from, never from the model. A human answer is
 * evidence to verify, not a label: `you` stays open until a tool checks it (the handoff's table puts
 * user-stated facts at Assumed).
 */
export const label = (claim: Pick<Claim, 'status' | 'source' | 'evidence' | 'counterexample' | 'isChecking' | 'stale'>): string => {
  if (claim.isChecking) return 'checking…'
  const stale = claim.stale ? ' · stale: the file changed since' : ''
  const cases = claim.evidence?.cases
  switch (claim.status) {
    case 'broken':
      return `${claim.counterexample ?? 'a case fails'} · tool ran${stale}`
    case 'proved':
      return `by ${claim.evidence?.theorem ?? 'the kernel'} · lake build green${stale}`
    case 'checked':
      return `${cases !== undefined ? `ran ${cases.toLocaleString('en-US')} cases · ` : ''}tool ran${stale}`
    case 'open':
      switch (claim.source) {
        case 'wording':
          return 'I assumed this; nobody checked'
        case 'claude':
          return 'Claude says · not checked'
        case 'data':
          return 'seen in the data · not checked'
        case 'code':
          return 'seen in the code · not checked'
        case 'you':
          return 'you said so · not checked yet'
        case 'doubt':
          return 'you doubted it · re-check pending'
        case 'tool':
        case 'lean':
          return 'not checked'
      }
  }
}

/** The plain-words meaning of each status, for the help card and the explain card. */
export const MEANING: Readonly<Record<Status, string>> = {
  proved: 'holds for every case, by argument a machine checked',
  checked: 'ran many cases and none failed; says nothing about the next one',
  open: 'not checked by anything yet',
  broken: 'a case fails; here it is',
}

/** Where a claim came from, for a fact line's prefix (`data:`, `code:`, `you:`, `claude:`). */
export const SOURCES: readonly ClaimSource[] = ['wording', 'data', 'code', 'you', 'claude', 'doubt', 'tool', 'lean']

/** One claim per fact line of a plan step, open until something checks it. */
export const claimOf = (step: string, text: string, source: ClaimSource, at: number): Claim => ({
  step,
  says: text,
  status: 'open',
  source,
  at,
})

/** The same claim, so a check or an answer can replace it in place: the step and its words. */
export const sameClaim = (a: Pick<Claim, 'step' | 'says'>, b: Pick<Claim, 'step' | 'says'>): boolean =>
  a.step === b.step && a.says === b.says

/** The claim after a tool ran: checked on exit 0, broken otherwise with the tail as the case; never proved here. */
/** The failing case from a tool's tail: the last line that is not a runner's summary count; the words are the tool's, never ours. */
export const counterexampleOf = (tail: string): string => {
  const lines = tail.split('\n').map(line => line.trim()).filter(Boolean)
  const isSummary = (line: string) => /^\d+ (pass|fail|skip|todo|tests?|expect\(\) calls)\b|^Ran \d+ tests?\b|^\[[\d.]+m?s\]$/i.test(line)
  return [...lines].reverse().find(line => !isSummary(line)) ?? lines.at(-1) ?? 'a case fails'
}

export const checked = (claim: Claim, evidence: Evidence, at: number): Claim => ({
  ...claim,
  status: evidence.exitCode === 0 ? 'checked' : 'broken',
  source: 'tool',
  evidence,
  counterexample: evidence.exitCode === 0 ? undefined : counterexampleOf(evidence.tail),
  at,
  isChecking: undefined,
  stale: undefined,
})

/** A Lean claim after `lake build`: proved only when the build was green, the axioms standard, no sorry, and the English accepted. */
export const proved = (claim: Claim, evidence: Evidence, isEnglishAccepted: boolean, at: number): Claim => {
  const isSound = evidence.exitCode === 0 && evidence.axioms !== undefined && isStandardAxioms(evidence.axioms) && evidence.hasSorry !== true
  return {
    ...claim,
    status: isSound && isEnglishAccepted ? 'proved' : isSound ? 'checked' : 'broken',
    source: 'lean',
    evidence,
    counterexample: isSound ? undefined : (evidence.tail.trim().split('\n').at(-1) ?? 'lake build failed'),
    at,
    isChecking: undefined,
    stale: undefined,
  }
}

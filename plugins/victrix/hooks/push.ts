// The push: Boris's three lines, then the three mechanical steps the bench rewarded, appended to the engine's own
// full plan-mode reminder on the main loop. No prose beyond that: a longer process prompt never helped (LESSONS §C);
// what won was facts with provenance, priced guards, and every ≥2× option built or declined. Off with `push: false`.
import type { Register } from 'claude-code'

type On = Parameters<Register>[0]

export const PUSH_TEXT = [
  'Plan in three lines first: the goal, the effort, and how the result will be verified against the obvious slow version.',
  'Then, on each step\'s own line, one tag each where it applies (` · tag: value`), as the check tool reads them:',
  '  facts: what the real data or code showed, each with its source (data:, code:, you:, claude:)   guard: what the fast path checks and what it costs',
  '  options: any idea worth 2×, to build and measure or for the person to decline   verify: the command that shows it right   slow: the obvious version',
  'Call the check tool to turn a fact, a guard or a verify line into evidence; its exit code decides, never your reading of the output.',
].join('\n')

/** Appends the push to the full plan-mode reminder of the main loop; a helper's loop, a sparse reminder and the off switch leave the text alone. */
export const registerPush = (on: On, isOn: boolean) => {
  on('prompt.attachment', { type: 'plan_mode' }, async (_$, e, next) => {
    const isFull = 'detail' in e && e.detail?.reminder === 'full'
    if (!isOn || e.agentId !== undefined || !isFull) return next(e)
    return next({ ...e, text: `${e.text}\n\n${PUSH_TEXT}` })
  })
}

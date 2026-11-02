# Anka's 7 rules (never more than 7) (V approved Nov 2; refined with research/ the same day)
They drive every Anka run **and the building of Anka itself (dogfooding)**. Simple enough for anyone.

1. **Look at the real thing first.** The data, the file, the layer below the one you were given. Mine what the data *contains*, not just its shape.
2. **Correct means matching the obvious slow version.** Write that version first; it is the spec.
3. **A counterexample beats "looks fine".** Every check tries to break the claim, and the check itself must be able to fail (mutation tests: a spec that rejects nothing proves nothing). Climb only as high as risk needs: tests + fuzzing/property tests by default → TLA+ for concurrency and ordering → Lean proof only for security boundaries, irreversible effects or core invariants. Record the level reached next to each claim.
4. **Guard every shortcut.** Fast path only when a cheap check confirms its assumption; otherwise the slow version. The guard must cost less than it saves (check only what the fast path touches).
5. **Build and measure every idea worth 2× or more.** Never argue one away. Ship the safe default behind a switch.
6. **Compare against the plain version.** Same model, many tries, a strict automatic judge (correctness vs rule 2, then speed/cost). Without a control you know nothing.
7. **Human and machine together — rely on each other.**
   - **Use the human's intuition as much as possible.** Their taste, hunches and domain knowledge are the information Claude lacks (a human adding facts lifted accuracy 30%→52%; a smarter human without facts didn't). One-tap gut checks early and often ("feel right?", "which looks better?", "anything I'm missing?"). Treat answers as evidence (tag `user`); say plainly when data disagrees. An unexplained hunch is a lead to test (rule 5), not noise.
   - **Ask early; never waste time or tokens.** Read first, then ask — before the first edit, short multiple-choice, batched. Asking is not rationed: ask every question whose answer saves more time or tokens than it costs, **including rework down the road** (a wrong assumption found next week is the most expensive kind). Skip only questions that wouldn't change what gets built, now or later; if both versions are cheap and reversible, build both behind a switch instead. Mid-run, ask as soon as a new build-changing question appears, and always before anything irreversible.
   - **Approve the claim, not the formalism.** The human signs a short plain-English claim. A separate model translates the formal statement back to English without seeing the original; any mismatch blocks. Approved statements are locked; no `sorry`, `assume` or new axioms.
   - **Keep the why, small and earned.** `.claude/anka/` index ≤150 lines, one line per decision (claim, why, evidence link, scope, date). Nothing enters without an external signal (test, measurement, human). Prune stale or uncited entries; rules that must never break become hooks or tests.
   - **Show only what's load-bearing; adjust visibly.** The live panel shows the 3–5 assumptions that would change the plan if they flipped, as claims with sources — never the raw reasoning. Doubt → Claude re-checks with a tool. Add data → re-plan affected steps. Wrong path → drop the branch and propose another. Every input shows a plan diff and is logged with why. Compare what Claude did with the plan, not its narration.

## Dogfooding: the rules applied to building Anka
| Rule | How it governs Anka's own development |
|---|---|
| 1 | Before designing a feature, inspect real Claude Code sessions, plans, transcripts (V's, via claude-historian). |
| 2 | The "obvious slow version" of Anka is the plain Boris 3-line prompt. Every Anka feature must beat it. |
| 3 | Each Anka claim gets a test that could break it (an unseen problem); the test is mutation-checked. |
| 4 | Every Anka feature has an off-switch; off = plain Claude Code. |
| 5 | Any feature idea estimated to double wins (or halve tokens) gets built and measured, not debated. |
| 6 | Every experiment: Anka vs Boris control, same model, N ≥ 10, hidden-test scorer, results in RESULTS.md. |
| 7 | V's intuition steers what gets built and tested first (hunches become experiments; Claude says when data disagrees). V is asked early about anything that saves time or tokens now or later, approves claims in plain English, steers via the panel; Anka's own ledger records why each design choice was made. |

## Evidence behind rule 7 (details + URLs in research/)
- One early goal question nearly matches a full spec; late or forced questions do worse than none (ask.md). V's rule: early questions are cheap — ask whatever prevents waste, now or later.
- Human-written context files help ~4%, LLM-generated ones hurt ~3%, both cost ~20% more tokens; adherence drops past ~200 lines (ledger.md).
- People approve plausible plans: 10/12 accepted a wrong output; readable plans raise confidence more than accuracy; steering helps when the human adds *information* (30%→52%) (steer.md).
- ~25% of plain LLM formalisations are wrong; humans validate formal specs at ~45%; AWS Cedar: proofs found 4 bugs, differential + property tests found 21 (approve.md).

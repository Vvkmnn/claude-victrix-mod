# Lean and TLA+ in plain words

## Lean
Lean is a programming language where you can also write **proofs**, and a checker (the "kernel") that refuses anything that isn't airtight. You state a claim, e.g. "for every input, the fast function gives the same answer as the slow one", and either prove it or Lean says no. If it compiles with no `sorry`, the claim is true for **all** inputs, not just the ones you tested.

- Analogy: tests are spot-checks of a bridge; a Lean proof is the engineering calculation that covers every load.
- Who uses it: mathematicians (Mathlib, ~250k theorems), AI labs (DeepMind AlphaProof, Harmonic Aristotle), AWS (Cedar authorisation language), Aeneas (Rust → Lean).
- Why it matters now: AI can write the proofs; Lean checks them. You don't need to trust the AI or understand the proof — only read the *statement*.
- Limits: proves the model matches the statement, not that the statement is what you wanted; proofs about real code (I/O, performance) are expensive; learning curve is steep.

In Anka we proved one core idea: `guarded_correct` — "use the fast path only when a check says its assumption holds, otherwise use the obvious slow path; then the result always equals the slow path." That's why guarded speedups never broke on hidden tests.

## TLA+ (probably what "Tia" means)
TLA+ (Leslie Lamport) is a language for **describing a system's design** — states and allowed steps — and a model checker (TLC) that explores every reachable state looking for a broken rule (e.g. "two writers never commit the same id"). It finds design bugs in concurrency and distributed systems before code exists. AWS used it on S3/DynamoDB and found serious bugs no test had found.

- Lean: "prove this is true forever" (proof).
- TLA+: "search every possible interleaving for a counterexample" (model checking, bounded).

## What Boris said (reported — primary post not retrieved)
Secondary sources (explainx.ai) report that Boris Cherny used Opus 5.5 with **Lean 4 and TLA+** to formally verify the Claude Agent SDK: 16 PRs, 24 bugs found, 1,529 theorems, no gaps. Quoted as: he doesn't know either language well, but Claude is excellent at both. His TLA+ tweet passed 1M views. **Caveat:** a Digg post credits the same quote to Danielle Fong, and the primary X post was not retrieved — verify on x.com/bcherny. Method (as implemented by agent-formal-verify): pick the risky code, model it in TLA+ (protocols/concurrency) or Lean (arithmetic/state transitions), check properties, and use counterexamples to reproduce and fix both code and model.
Sources: explainx.ai/blog/boris-cherny-opus-5-5-lean-tla-formal-verification-sdk-2026 ; zeli.app/story/49863600 ; pi.dev/packages/agent-formal-verify

## Is TLA+ like fuzzing?
Cousins. Fuzzing: random inputs, real code, finds bugs, never proves absence. TLA+: every step-ordering, small model of the design, proves the design within that model (or gives the exact breaking sequence). Lean: proves for all inputs. See GLOSSARY.md.

## How to explain it to others in one line
"Tests check some cases; Lean proves all cases; TLA+ searches all orderings of a design. AI now writes the proofs and models, and the checker keeps it honest."

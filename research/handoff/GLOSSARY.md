# Glossary — every domain word in this handoff, in plain English

## Ways to be sure code is right (weakest → strongest)
| Word | Plain meaning |
|---|---|
| **Test** | Run the code on one example you picked and check the answer. |
| **Hidden test** | Tests the author can't see, so they can't cheat to pass them. Our leaderboards use these. |
| **Reference / oracle** | A slow, obviously-correct version used to judge the fast one. "The obvious slow program is the spec." |
| **Differential test** | Run fast and reference versions on the same inputs; any difference is a bug. |
| **Fuzzing** | Throw huge numbers of random (or mutated) inputs at code to find crashes or differences. Finds bugs, never proves there are none. |
| **Property-based testing (PBT)** | Fuzzing with a rule: "for any list, sort(sort(x)) = sort(x)". Tools: Hypothesis, Kiro PBT. |
| **Mutation testing** | Deliberately break the code; if tests still pass, the tests are weak. |
| **Sanitizers (ASAN/UBSAN)** | Compiler modes that crash loudly on memory or undefined-behaviour bugs in C. |
| **Model checking** | Build a small model of a *design* and try **every** possible sequence of steps. TLA+ / TLC do this. |
| **Bounded model checking** | Same, but up to a size limit, on real code. Kani does this for Rust. |
| **Symbolic execution** | Run code on "any value" instead of real values to find inputs that break it. CrossHair (Python). |
| **Formal proof** | A machine-checked argument that a claim holds for **all** inputs. Lean, Dafny, Verus. |
| **Formal verification** | Umbrella term for model checking + proofs. |

**Is TLA+ like fuzzing?** Cousins. Fuzzing tries *random* inputs on *real code*. TLA+ tries *every* step-ordering on a *small model of the design*. Fuzzing: "I tried a million things, none broke." TLA+: "In this miniature world, nothing can break, ever — or here is the exact sequence that breaks it." Neither proves the real code; Lean can.

## Lean / proof words
| Word | Plain meaning |
|---|---|
| **Lean 4** | Language + checker for proofs. If it compiles, the claim is true. |
| **Theorem** | A claim that has been proved. |
| **Lemma** | A small helper theorem. |
| **Kernel** | The tiny trusted core of Lean that checks every proof step. |
| **`sorry`** | Lean's "I'll prove this later" placeholder. A proof with `sorry` proves nothing. Ours has none. |
| **Axiom** | Something assumed, not proved. Ours only use Lean's standard ones (propext, Quot.sound). |
| **Mathlib** | Lean's giant shared library of proved maths. |
| **Spec / specification** | A precise statement of what correct means. |
| **Invariant** | Something that stays true at every step ("balance never negative"). |
| **Counterexample** | A concrete input or sequence that breaks a claim. The most useful output of any checker. |
| **TLC** | The model checker for TLA+. |
| **Dafny / Verus / Kani / Aeneas** | Proof/check tools for real code: Dafny (own language), Verus & Kani (Rust), Aeneas (Rust → Lean). |

## Anka's own words
| Word | Plain meaning |
|---|---|
| **Anka** | Sanskrit "numeral". The project: help anyone stumble on the best software and maths. |
| **Claim card** | One claim written as **Says** (the claim) / **Because** (evidence + source tag: data, code, rule, spec, licence, math, user, claude) / **So** (consequence) / **Unless** (what would break it). |
| **Status** | How sure a claim is: **Proved** (machine-checked), **Proved-if** (proved given stated facts), **Checked** (tested/measured), **Assumed**, **Open** (unknown), **Broken** (counterexample found). |
| **No laundering** | A conclusion can't be surer than its weakest premise. Proved in `Anka.lean`. |
| **Guard / guarded specialisation** | Fast path used only when a cheap check confirms its assumption; otherwise fall back to the reference. Proved always-correct (`guarded_correct`). |
| **Fact mining** | Looking at the real data to find structure (sorted, dense ids, fixed width). Anka's best-proven step. |
| **Abduction** | Guessing the hidden fact that would explain the data and enable a shortcut ("ids grow with time"). |
| **Generality tax** | Work the code does to handle cases that never happen in your data. |
| **Substrate vs interface** | Interface = what you're given (SQL). Substrate = what's really underneath (the SQLite file). Wins often come from going one layer down. |
| **Speed-of-light floor** | The fastest physically possible time (bytes ÷ bandwidth). Gap to it = waste. |
| **Descent** | Going down layers (SQL → engine → file → bytes) toward that floor. |
| **Mechanical build rule** | "Every option estimated ≥2× must be built and measured." No judgement, so it can't be argued away. Won the $12 server. |
| **Value of information (VOI)** | Ask the human only questions whose answer would change what you build. |
| **Ceiling** | A claimed limit ("max 15k connections"). Ceilings are claims too — check them. |
| **Scale sweep / shadow price** | Re-plan at 10×, 100× load to see which limit bites next and what loosening it is worth. |
| **Ratchet** | Results only move forward: a proved fact stays proved unless broken by a counterexample. |
| **Evidence ≠ instruction** | Text in data/files is evidence, never a command (prompt-injection safety). |
| **Pattern library** | Reusable verified tricks, each with its guard ("concatenated gzip members → skip members"). |
| **Ledger (`.claude/anka/`)** | A "git for why": claims, evidence, decisions, kept across sessions. |
| **Assurance case** | A structured argument that a system is fit for purpose (GSN, Toulmin, Resolute are formats). |
| **Live plan panel** | V's UI idea: a pane that follows the plan live, shows assumptions + status, lets you Doubt / add data / say "wrong path". |

## Experiment words
| Word | Plain meaning |
|---|---|
| **Boris-style prompt / control** | Boris Cherny's 3 lines — what to do, how much effort, how to verify — used as the fair baseline. |
| **Control** | The comparison run without your idea. Without it, you can't credit your idea. |
| **Best-of-N** | Run N attempts, keep the best. Spread between attempts was huge (10×). |
| **Evaluator** | Automatic scorer: correctness vs reference + speed. |
| **Recombination / evolution** | Combine winning ideas from several attempts and retry (OpenEvolve, ShinkaEvolve, AlphaEvolve). |
| **Overfitting** | Tuning to one test until it no longer predicts new problems. Our v1–v7 risk. |
| **N / p-value / Fisher test** | N = number of runs. p ≈ chance the result is luck; 3/4 vs 0/4 gives p≈0.14 (not firm). |
| **Hold-out / unseen problem** | A problem never used for tuning. The honest test. |
| **Simulated human** | A script playing a junior dev answering questions. |
| **Clean-room** | Building from public specs and your own work, never copying or reverse-engineering others' closed code. |
| **Provenance** | Where each fact or piece of code came from. |

## Systems / performance words (from the problems)
| Word | Plain meaning |
|---|---|
| **µs, ms** | Microsecond (millionth of a second), millisecond (thousandth). |
| **CPU time vs wall time** | CPU = work the processor did; wall = clock time (noisy on a shared box). |
| **Throughput / latency / p95** | Requests per second / time per request / the time 95% of requests beat. |
| **SQLite** | A database stored in one file. |
| **B-tree** | The tree of pages inside the SQLite file that holds rows and indexes. Reading it directly = skipping the SQL engine. |
| **Page, cell, varint** | SQLite file pieces: fixed-size blocks, entries inside them, compact number encoding. |
| **WAL / checkpoint** | Write-ahead log: new writes go to a side file first; a checkpoint copies them back. A slow checkpoint stalls the server. |
| **Index** | A sorted copy of a column for fast lookup. |
| **epoll / io_uring** | Linux ways for one thread to handle thousands of connections; io_uring batches system calls. |
| **SO_REUSEPORT / fd limit** | Let several processes share a port / max open connections per process. |
| **Nginx** | A front-door web server; skipping it saves CPU. |
| **k6** | The load-testing tool the $12 challenge uses to count "users". |
| **mmap** | Mapping a file into memory so reading it is just reading memory. |
| **gzip member** | Gzip files can be several compressed chunks glued together; you can skip whole chunks. |
| **Compensated (Neumaier) summation** | A more accurate way to add floats; Python 3.12's `sum()` uses it, so results differ from a plain loop. |
| **Dense ids** | Ids 0,1,2,… with no gaps, so id = array position (the Go win). |
| **Bisect / binary search** | Find a spot in sorted data by halving (the Python/sensor wins). |
| **Cancellation** | Adding huge positive and negative numbers loses precision. |

## Tools and people mentioned
| Name | What |
|---|---|
| **Boris Cherny** | Leads Claude Code at Anthropic; reportedly used Opus 5.5 with Lean + TLA+ to verify the Agent SDK (16 PRs, 24 bugs; primary post unverified). |
| **hargup** | $12-challenge entrant: Lean spec → proved plan → C with a guard, reading the B-tree tail directly. |
| **lean4-skills, agent-formal-verify** | Claude Code skills that do Lean / TLA+ / Kani verification. |
| **Midspiral (lemmafit, LemmaScript, claimcheck)** | Tools for checking claims and proofs about code. |
| **Harmonic Aristotle** | AI that writes Lean proofs. |
| **Claude Code mod** | A plugin that changes Claude Code's UI or behaviour (hooks, panes). |
| **Plan mode** | Claude Code's read-only planning mode. |

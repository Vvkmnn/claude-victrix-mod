# Lessons, failures, wasted directions, cut corners (candid)

## A. Biggest mistake
No short-prompt (Boris-style: goal / effort / verify) control until ~run 45. We iterated Anka v1→v7, each adding steps, against no baseline. When tested, the 3-line prompt matched or beat Anka everywhere compared. Rule: every experiment has a same-model, same-N short-prompt control from run 1.

## B. Orchestrator (my) failures and why
| Failure | Why | Fix |
|---|---|---|
| First sim schema lacked an obvious index; "add index" swamped the real insight | Built the test before the reference solutions | Write naive + expert references first; confirm the gap is where you think |
| Agents shared /tmp; overwrote each other | No isolation | Per-run TMPDIR and port ranges |
| Concurrent runs on one 2-core box (load ~10) | Parallelism for speed | Timings noisy; agents fell back to CPU time; one agent `pkill`ed another run's server. Isolate runs (containers/cgroups, unique ports) |
| Disk filled (ENOSPC) mid-handoff | Every run copied a multi-GB DB | Hardlink/reflink read-only seed; clean up per run |
| Tried to build the mod in chat (mods don't run here) | Ignored a known constraint | Check environment constraints before delegating |
| 3 runs stalled ~20 min, lost | No monitoring | Poll file activity; kill/relaunch |
| Tuned every prompt version on the same server benchmark | Learning from the test set | Hold-out problems; unseen ones came too late |
| Server runs graded by my judgement, no k6 | No real scorer | Real-box k6 or a calibrated local proxy |
| Contract bugs (gzip lacked "sorted"; sensor demanded matching a numerically naive reference) | Contract written before reference | Decide what "correct" means first |
| Leaderboard ranks predicted from a µs model | No benchmark | Treat as estimates only |
| Launched v7 before asking; proposed v8 | Momentum | Ask first; user stopped both |
| "2× gain" token rule | Linear thinking | User: "a win is a win" |
| Runs grew 60k → 190k tokens each; Opus/16-agent batches | Longer prompts, more agents | Fewer, controlled, decisive experiments |
| 5 of 8 final server agents cut off before writing PLAN.md (container restart / interrupt); salvaged by re-scoring their code myself | Long background runs, no checkpointing | Agents write PLAN.md early and update it |
| Simulated human = keyword script | CLI not authenticated | Use a real model as the human, scripted persona |
| N = 2–3 per arm | Budget | Too small to separate prompts given best-of-N spread; need N ≥ 10 or paired designs |

## C. Incorrect ideas (falsified / unsupported)
1. A longer, more rigorous process prompt makes the model better — falsified so far.
2. Adding a rule changes behaviour — v6 "prototype both" was reasoned around in 3/3 runs.
3. "Ceilings are claims" fixes false limits — agents used unverifiable ceilings to price CPU work at zero.
4. Generality-tax step helps — no measurable gain on 6 problems.
5. Invariant discovery (abduction) is the bottleneck — agents found the key fact almost always; the bottleneck was *deciding to build it*.
6. Questions always help — agents rarely asked the high-value question. **Correction:** I earlier cited a "NeurIPS 2026" result that elicitation lowers accuracy; a research agent could not find it. Real evidence: late, forced or bundled questions hurt; one early goal question helps (see research/ask.md).
7. "Anka got the 135× gzip win" — **falsified**: Boris controls found the member skip 3/3 (12–15 ms) vs Anka 1/3. The model knew the trick.
8. Heavy naming/taxonomy (Sanskrit, ontologies, DSL, JSON-LD) before any evidence — premature.
9. Formal elegance (Lean model of Anka) before empirical validation — useful core, but it proves the *guard pattern*, not that Anka helps.

## D. Agent failures and why
| Failure | Seen in | Why |
|---|---|---|
| Optimised only inside the given layer (SQL) | server v1–v3 | Interface (SQL) mistaken for substrate (SQLite file) |
| Found winning idea (direct B-tree read), asked, declined to build | server v4–v6 (0/8), Boris 0/4; v7 fixed it (3/4) | Second-hand permission, safe default when human absent, high build effort, unpriced gain |
| Believed false ceilings (~15k connections) | server v5–v6 | Trusted a README line over evidence |
| Reasoned from the spec instead of inspecting the real file | gzip B (10× slower) | Jumped to a clever technique first |
| Python `sum()` (compensated since 3.12) ≠ plain loop | sensor Sonnet 3/4 | Stdlib semantics changed; fuzzing used normal values only |
| Weak fuzzing (no extremes/NaN/cancellation) | several | Generators mirrored typical data |
| SQLite checkpoint misuse (background thread → WAL 146 MB) | many server runs | Subtle engine semantics; found only by measuring |
| Claimed speedups without timing the baseline | many | Skipped measuring the obvious version |
| Killed other runs' processes (`pkill -x server`) | Boris Sonnet 1 | Shared box; broad kill |
| Sonnet missed byte-filter trick Opus found under both prompts | sensor | Model capability, not prompt |

## E. Where we cut corners to get here
- No real benchmark hardware (k6 on a $12 droplet); scores are modelled.
- Small N; no statistics; no pre-registered hypotheses.
- Shared, overloaded machine → noisy timings.
- Simulated human was a regex, not a model or a person.
- Read Boris only via search snippets/secondary sources; never watched his talks or got his actual prompts.
- Never ran inside real Claude Code (plan mode, tasks, hooks, CLAUDE.md, subagents as Boris uses them). All runs were plain subagents with a prompt.
- Didn't test Anka as tooling (ledger, guards, differential harness) — only as prompt text.
- Never ran the competitors (lean4-skills, agent-formal-verify, lemmafit, Kiro PBT, OpenEvolve) as baselines.
- Few problems (≈10), mostly perf; no proofs, no non-perf domains, no maintainability measure.
- No reviewer independent of me graded results.

## F. What I would research if I could
1. **Boris's real method, primary sources**: his talks/videos, threads, the Claude Code team's own CLAUDE.md and slash commands, how they use plan mode + verification loops. (V has Agent Reach + open CLI.)
2. **hargup's actual process**: commit history, Lean spec → plan → generated C + guard; how much was human prompting vs Opus.
3. **Top-3 server submissions** in code (kensac, mojo, C entry), to build a "pattern library" with measured gains.
4. **Tooling vs prompting**: does a differential-test harness, a reference implementation, or a best-of-N + evaluator loop (OpenEvolve/ShinkaEvolve style) beat any prompt? Literature on test-time compute scaling for code.
5. **Decision failure**: why agents decline high-value builds — risk aversion, permission ambiguity, effort estimates. Literature on LLM agent risk aversion and over-asking/under-asking.
6. **Elicitation research**: when asking the user helps vs hurts (value-of-information for agents).
7. **Lean in practice for engineers**: Aeneas (Rust→Lean), LemmaScript, Harmonic Aristotle, Mathlib onboarding cost — what an "idiot" can realistically use.
8. **Formal methods in industry**: AWS's TLA+ / P / Dafny / Cedar experience, what bugs they caught, cost.
9. **Property-based testing and differential fuzzing** best practice (Hypothesis, CrossHair, Kiro PBT) as the cheap 80% of proof.

## G. What is needed to get better
- **Fair harness first**: isolated runners, real benchmark (or calibrated proxy), automatic scorers, N ≥ 10 per arm, Boris control always.
- **Test Anka as an engine, not a prompt**: best-of-N + evaluator + reference ("obvious slow program is the spec") + guard + differential fuzz, run mechanically. Measure against Boris + the same compute.
- **Mechanical build rule enforced by tooling**, not prose: a hook that refuses to finish until each ≥2× option is prototyped and measured (or the human explicitly declines).
- **Real human-in-the-loop**: one VOI question routed to V, answered once, logged.
- **Ledger (`.claude/anka/`) evaluated for multi-session value**: does session 2 do better because of session 1's ledger?
- **Hold-out problems from new domains** (proofs, data pipelines, writing/ops).
- **Independent grader** (separate agent or person) on high-stakes results.

## H. What held up
- Guards: every guarded solution passed hidden tests that broke its assumptions (`guarded_correct` in practice).
- Floor (speed-of-light) estimates made waste visible.
- Inspect the real artefact first won (gzip A/C).
- Best-of-N spread is large (gzip 14 vs 139 ms; sensor 0.7 vs 9 ms) — compute + selection > wording.
- Opus > Sonnet on deep tricks regardless of prompt.
- Assets kept: eval suite with hidden tests and references, Lean core, negative result, research map.

## I. Takeaways per problem (where Boris won, and where Anka showed potential)
| Problem | Winner | Why | Take away |
|---|---|---|---|
| Python logs (q1) | Boris 235 vs 622–1133 ms | All three found sort + bisect. Anka's guards verified the facts over the *whole* input (slice every key 0.4 s, full sorted() check 0.2 s), which cost more than the work saved; Boris bisected directly on whole lines | **Guards must cost less than the gain**: verify locally/lazily (only what the fast path touches), not globally. Price the guard |
| JS events (q2) | Boris 104 vs 122/221 ms | Boris used native `indexOf` after measuring that per-char JS loops cost 210 ms; Anka v2 added an extra pass | Measure the language's primitive costs before designing; never add passes for "safety" a guard can give |
| Gzip (u1) | Boris 3/3 at 12–15 ms vs Anka 1/3 | Sonnet finds member skip easily when it just looks at the file; Anka run B followed a clever technique from the spec | The model already knows the trick; prompts that push "go to first principles / exotic" can derail. Inspect the artefact first |
| Sensor (u2) | tie (Opus); Boris 1/2 vs 0/2 strict (Sonnet) | Model capability; Anka didn't ask the exactness question | Add adversarial-value fuzzing (extremes, NaN, cancellation) to the harness, not the prompt |
| Go lookup (q3) | **Anka ~3×** (31–38 vs 103–107 ms) | Anka's "mine facts from real data" step found keys are dense indices; Boris checked only lengths | **Content-level data mining is the prompt's real value**: structure in values, not just shape |
| $12 server | **Anka v7 3/4 built the guarded B-tree read; Boris 0/4 (incl. Opus)** | v7's mechanical build rule (≥2× option must be built) + organiser permission; Boris runs called the permission second-hand and declined | **Mechanical build rules work where advice didn't** (v6 "prototype both" was reasoned away). Put the rule in tooling |
| Rust / C / Java | ties | — | No prompt effect at this difficulty |

Net: three Anka ideas earned their tokens — inspect/mine the real data's content, guard every assumption, mechanically build every ≥2× option. Everything else in v1–v7 should be dropped or moved into tooling. Anka v7 also lost/tied where its guards were global (q1) or it added passes (q2): those are the parts to cut.

Scoreboard of direct comparisons (same model): **Boris wins 4** (q1, q2, gzip, sensor-Sonnet), **Anka wins 2** (q3 Go ~3×, $12 server decision 3/4 vs 0/4), **ties 4** (sensor-Opus, Rust, C, Java). Anka's two wins are the deepest structural ones — exactly the north-star kind ("stumble on" a below-the-interface solution). A short Boris prompt + those three as tool steps is the hypothesis to test next.

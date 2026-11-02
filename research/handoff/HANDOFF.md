# Anka — handoff to Claude Code

From V's claude.ai research chat, 2026-11-02. Read this first, then `RESULTS.md`.

**North star (V):** an idiot should stumble onto perfect software and math. The person only says what they want and confirms the obvious version is right; machines do the rest. Key enabler from this chat: **the obvious slow program is the spec** — every win matched it exactly, with a guard falling back to it (proved in formal/Anka.lean, `guarded_correct`). Weakest link: auto-generating the checks a beginner can't write (obvious version + extreme-value fuzzing + plain-English back-translation).

## 0. The 7 rules (V approved — never more than 7; Anka's core; drive the project always; also in CORE_RULES.md)
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

### Dogfooding: the rules applied to building Anka
| Rule | How it governs Anka's own development |
|---|---|
| 1 | Before designing a feature, inspect real Claude Code sessions, plans, transcripts (V's, via claude-historian). |
| 2 | The "obvious slow version" of Anka is the plain Boris 3-line prompt. Every Anka feature must beat it. |
| 3 | Each Anka claim gets a test that could break it (an unseen problem); the test is mutation-checked. |
| 4 | Every Anka feature has an off-switch; off = plain Claude Code. |
| 5 | Any feature idea estimated to double wins (or halve tokens) gets built and measured, not debated. |
| 6 | Every experiment: Anka vs Boris control, same model, N ≥ 10, hidden-test scorer, results in RESULTS.md. |
| 7 | V's intuition steers what gets built and tested first (hunches become experiments; Claude says when data disagrees). V is asked early about anything that saves time or tokens now or later, approves claims in plain English, steers via the panel; Anka's own ledger records why each design choice was made. |

### Evidence behind rule 7 (details + URLs in research/)
- One early goal question nearly matches a full spec; late or forced questions do worse than none (ask.md). V's rule: early questions are cheap — ask whatever prevents waste, now or later.
- Human-written context files help ~4%, LLM-generated ones hurt ~3%, both cost ~20% more tokens; adherence drops past ~200 lines (ledger.md).
- People approve plausible plans: 10/12 accepted a wrong output; readable plans raise confidence more than accuracy; steering helps when the human adds *information* (30%→52%) (steer.md).
- ~25% of plain LLM formalisations are wrong; humans validate formal specs at ~45%; AWS Cedar: proofs found 4 bugs, differential + property tests found 21 (approve.md).

## 0b. Strategy (V, Nov 2)
If Anthropic and others are building verification anyway, even better: learn from it and improve around it. Anka = discovery for non-experts + human partnership, calling their tools for proof. Details, per-player lessons and the kill criterion in LANDSCAPE.md.

## 1. Top priority: find Boris Cherny's true approach

Everything below says the same thing: **a short, clear prompt matched our long "Anka" process prompts on every problem where we ran both.** Before building more process, learn exactly how Boris works.

- What he wrote publicly (22–23 Sep 2026, Opus 5.5 + Lean/TLA+ on the Claude Agent SDK → 16 PRs):
  - Post: https://x.com/bcherny/status/2102543349102338309
  - Method: https://x.com/bcherny/status/2102898067133595992 — (1) model a tricky state machine / race-prone part, (2) find counterexamples in the model, (3) reproduce the bugs, (4) fix them. "The hairiest parts of the code are modeled, checked for counter-examples, and fixed."
  - Prompting thread (6 Oct): https://x.com/bcherny/status/2107565388250874193 — tell the model **(1) what you want it to do, (2) how much effort to spend, (3) how it should verify it did the right thing.** He says that thread includes his actual prompts.
- Not yet retrieved (X blocks automated reads from claude.ai): **the exact prompts shown in the video** and in the 6 Oct thread. Use Agent Reach / a browser to read the threads and transcribe the video. Record verbatim prompts in `.claude/anka/research/boris.md` with links.
- Related plugins that implement his method: `michael-denyer/agent-formal-verify` (TLA+, Lean, Kani), `cameronfreer/lean4-skills`.
- Standing rule (V): **every Anka experiment includes a Boris-style control (same model, same N, same tools). If less prompting is as good, it wins — fewer tokens.**

## 2. What Anka is meant to be (V's decisions)

- Claude Code mod + `.claude/anka/` ledger ("git for why": claims, facts, decisions, rejected ideas, evidence, proofs).
- Built first for V, used daily; silent until a claim changes a decision; heavy checking local and lazily installed; fully open source; credit Midspiral (lemmafit, LemmaScript, claimcheck) and TheoricLabs (hargup's lean-derive).
- Decisions mechanical, not judgement calls. Build–verify–check wherever possible; warn the human only if especially expensive or difficult. Ask the human only what's needed (max ROI). Clean-room: go as low as you like in what you own; never reverse-engineer third-party closed binaries without asking.
- Goal: exponential discoveries for linear spend.

## 3. What we did

~60 Sonnet/Opus subagent runs, each isolated, scored on hidden tests + leaderboards we built:
1. **$12 server challenge** (github.com/arjaythedev/twelve-dollar-server-challenge): official materials only, no leaderboard. Prompts Anka v1→v7. Target: hargup's insight (time order = id order ⇒ read SQLite B-tree tail directly, guarded) plus the leaders' io_uring and checkpoint tricks.
2. **3 algorithm problems** (Python/JS/Rust), Anka vs no-Anka.
3. **6 "layer bypass" problems** (Python logs, JS NDJSON, Go lookups, Rust sort, C CSV, Java IDs), Anka v1 vs v2, later Boris controls.
4. **Unseen gzip-log problem** (Node): win = skip whole gzip members (~140×).
5. **Unseen sensor-log problem** (Python): win = binary search + C-level byte filter (~500×); Anka v7 vs Boris, Sonnet and Opus, with a simulated junior teammate (`ask_human.py`).

## 4. Key findings (details in RESULTS.md)

1. **Facts are cheap**: agents found the key data fact almost always.
2. **Floor gaps make waste visible** (from v4): every run measured 6–15× gaps on the feed.
3. **Decisions were the bottleneck**: v4–v6, 8/8 server runs asked "may I read the SQLite file directly?" and 0 built it; v6 runs argued it down with unverifiable ceilings. v7's *mechanical* rule (every ≥2× option must be built and checked) flipped this to 3/4 — while Boris stayed 0/4. **Caveat: v7 was tuned on this benchmark (overfitting risk); confirm on an unseen "bypass the interface" problem.**
4. **Boris-style prompt ≈ or > Anka on most problems**: Boris wins Python logs, JS events, gzip (3/3 found the member skip vs Anka 1/3 — Anka's headline 135× gzip win was the model, not the prompt); ties on sensor-Opus, Rust, C, Java.
4b. **Where Anka showed real potential (keep these):** (i) Go ID lookup: both Anka versions *mined the data's content* (keys = "u"+dense index), built a direct index → 31–38 ms, beating the expert reference; Boris only looked at key *length* → 103–107 ms (~3× slower). (ii) $12 server: **v7 built the guarded direct SQLite B-tree read in 3/4 runs (Sonnet 2/2, Opus 1/2); Boris 0/4 (Sonnet and Opus)**. First time in ~25 runs. Feed server CPU 40–45 µs vs 67–82 µs; 3,000-op differential vs SQL: 0 mismatches; all 42/42. Same simulated teammate answers for all — the difference is v7's mechanical build rule. Common thread: Anka's "inspect the real artefact / mine facts / mechanical build rule" steps — not its length — produced the wins. See LESSONS.md §I.
5. **Model > prompt**: Opus under either prompt found the deep byte-filter trick; Sonnet mostly didn't, and fell into Python 3.12's compensated `sum()` trap.
6. **Best-of-N spread is huge** (gzip 14 vs 139 ms; sensor 0.7 vs 9 ms). Biggest lever = many tries + strict evaluator + recombination.
7. **Guards always worked**: every Anka solution passed hidden tests that violated the assumed facts.

## 5. A possible direction (an idea only — not tested, no further prompt versions planned)

Anka as the **engine around Boris's prompt**, not a longer prompt:
- N diverse short-prompt agents in parallel → one strict automatic evaluator (correctness vs reference + benchmark) → recombine winners' ideas → repeat (ShinkaEvolve/OpenEvolve-style).
- A growing **pattern library** of verified wins (e.g. "sorted data → binary-search the window", "concatenated archive members → skip members", "filter one byte in C, confirm the rest"), each with its guard and proof template.
- The **ledger** and a **live plan panel** for the human (V's ask, Nov 2): not a static card but a pane that walks the plan as Claude works and updates live — current step, the claims it rests on (Says / Because / Unless), each assumption with its status (Proved / Checked / Assumed / Open), what was measured. Plans get too big to follow, so it shows only what changed and what is load-bearing; one tap to Doubt an assumption, add data, or say "wrong path", which feeds straight back into the run. Clickable, engaging, low effort to watch. Buildable as a Claude Code mod (`ui.render` Pane + `ui.press`, fed by `tool.call` / `turn.complete` hooks writing `.claude/anka/`).
- If ever tested: 4×Sonnet + recombination vs 1×Opus at equal tokens, on gzip and sensor.

## 6. Files here

- `prompts/` — every prompt version (anka-v0…v7), Boris-style goals, simulated-human scripts.
- `formal/Anka.lean` — machine-checked core (Lean 4.35.0, no sorry): no-laundering status lattice, guarded specialisation (fast path = reference on every input if guard sound + agreement under facts), abduction, ratchet, monotone-time instance. `FORMAL.md` explains.
- `harness/` — hidden tests + leaderboards for every problem.
- `problems/` — statements and starters; `gen_data.sh` regenerates all datasets. `server_12usd/` = the $12 challenge (from github.com/arjaythedev/twelve-dollar-server-challenge, its LICENSE included; build the seed with `seed/make-seed.sh`).
- Not kept: server runs s12 and s18 (stalled, no output); multi-GB seed DB copies (regenerable).
- `runs/` — every run's PLAN.md, solution, prototype server and teammate question log.
- `LESSONS.md` — failures, wasted directions, wrong ideas, agent failures, cut corners, what to research, what's needed, per-problem takeaways (§I).
- `LEAN_TLA.md` — Lean and TLA+ explained in plain words for others (Boris's Lean+TLA+ SDK work reported; primary post unverified).
- `LANDSCAPE.md` — is it worthwhile; bleeding edge and failures (Nov 2).
- `GLOSSARY.md` — every domain word in this handoff, in plain English.
- `RESEARCH.md` — every source.
- `research/` — four studies behind rule 7: ask.md, ledger.md, approve.md, steer.md.
- `harness/server-diff/` — differential (3k random ops vs SQL server) and CPU-per-request scripts for the $12 server.

## 7. First steps in Claude Code

1. Research Boris's exact approach (§1). Write it down verbatim.
2. Re-run the sensor and gzip problems with *his* exact prompts as the control.
3. Dogfood: build Anka under its own 7 rules (§0 table). Test the hypothesis from LESSONS §I: **Boris's short prompt + three tool-enforced steps** (mine the real data's content; price and localise every guard; mechanically build every ≥2× option) vs plain Boris, N ≥ 10, on unseen problems.
4. Study and reuse first: Anthropic × Theorem (fuzz tests → proofs, OSS Verify, add-project skill), agent-formal-verify, Spec Kit drift lessons (LANDSCAPE.md table). Make rule-2 references + differential tests double as fuzz harnesses so they are proof-ready.
5. Kill criterion: if Anka doesn't beat plain Boris on ≥2 of 5 unseen problems at N≥10, stop and contribute the panel/ledger upstream.
6. Only then build Anka v0: ledger format + pane + evaluator/best-of-N engine, delegating proofs to lean4-skills / agent-formal-verify.

# Ledger: build brief for Claude Code

> **How to use this file:** give it to Claude Code at the root of a new repo and say: *"Read LEDGER.md fully. Plan the build in plan mode, ask me the open questions in §16, then build milestone 1."*
> This brief holds the research, reasoning, decisions, risks and evidence from a long research effort (Nov 2026). It tells you **what** to build and **why**. It mostly leaves the **how** to you: verify every API against current docs and source before relying on it.

---

## 0. One-paragraph summary

**Ledger** is an open-source Claude Code mod and a companion Agent Skill. It brings AI-assisted mathematics to any Claude user's planning. While Claude plans, Ledger asks the user one to three plain-English questions, finds the maths hidden in the plan, and checks the plan's key claims with the cheapest rigorous tool: a solver, a simulation, property-based tests, a model checker, or a Lean or Dafny proof. Each result appears in a side panel as a card with three things: the claim in plain English, the maths behind it, and how it was verified. Each card carries an honest label: **Proved / Checked / Assumed / Open / Broken**. The core idea comes from hargup's Lean-derived $12-server entry, generalised: **every important engineering choice becomes a *justified decision*.** That means the choice, why it is safe, a check that the choice equals the obvious version under those facts, and a runtime guard. Following Terence Tao's "Math 2.0", the product's value is **human understanding of why a plan holds**, not the number of proofs. Ledger builds openly on Midspiral (LemmaScript, claimcheck), TheoricLabs (hargup's method and evidence labels), Anthropic's agentic property-based testing, Hypothesis, Lean/Mathlib and others, with credit.

---

## 1. Origin and the core insight

### 1.1 The trigger: hargup's lean-derive submission
- Harsh Gupta (@hargup, TheoricLabs) entered arjaythedev's "$12 server challenge": a feed API on SQLite, run on a 1 vCPU / 2 GB VPS. Source: `github.com/arjaythedev/twelve-dollar-server-challenge/tree/main/submissions/lean-derive-hargup`. The challenge repo is MIT.
- Result: **280,000 users held for 5 minutes, 26,683 requests/s, about 31 µs of CPU per request**, scored 2026-10-28. It was at or tied for the top of the leaderboard when scored; research notes disagree on tie position, so don't claim "#1" flatly.
- The method used about 950 lines of Lean 4 with no dependencies:
  - `Model.lean`: the API as plain, obviously correct functions. This is the spec and the test oracle.
  - `Invariant.lean`: three facts the schema doesn't enforce: ids are dense (1…n), `created_at` never decreases, every author exists. It includes a checker proved sound (`checkInv_sound`) and proofs that writes preserve the facts (`inv_addPost`, `inv_like`). This is induction.
  - `Plan.lean`: under the invariant, "sort by time and take 20" equals "read the last 20 rows of the B-tree" (`feed_eq_tail`, `feedPlan_eq`; `postPlan_eq` needs no invariant). Feed time went from 16.7 µs to 5.4 µs.
  - `Contract.lean`, `Schema.lean`: routes, statuses, JSON shapes and the schema, as data.
  - `Emit.lean`: a Lean program that generates 512 lines of C. The build fails if the regenerated C differs from the checked-in copy.
  - About 1,600 lines of hand-written runtime (io_uring, batching, direct B-tree reads) that are **tested, not proved**.
  - A **runtime guard**: if the invariant check fails, another connection writes, or the layout differs, the server falls back to plain SQL permanently.
  - Byte-identical output against SQL on 20,000 posts.
- The coordinator rebuilt it with Lean 4.35.0: `lake build` took about 4 s, the generated C was byte-identical, and `#print axioms` showed only `propext`, `Classical.choice` and `Quot.sound`.

### 1.2 The insight: Lean as justification, not speed
From arjaythedev's video: *"Technically, you could write these exact optimizations in C yourself without ever touching Lean. Lean just lets you prove that these optimizations are safe for your specific workload."*

**The generalisation:** a *justified decision* has four parts.

| Part | hargup | Any project |
|---|---|---|
| **Choice** | Read the last 20 rows instead of sorting | Cache this, retry that, skip this check, use this algorithm, split this job |
| **Why it's safe** | Ids dense, time only goes up | Facts about *this* workload or domain that the choice relies on |
| **Check** | Proof that the fast path equals the slow one | The choice equals the obvious/reference version under those facts: proved, model-checked, solver-checked or property-tested |
| **Guard** | Fall back to SQL if the facts break | A runtime check plus the safe path, so the justification can't silently expire |

It works like an architecture decision record (ADR) whose "because" is **re-verified on every change** and honestly labelled.

### 1.3 Did hargup need special skill?
Yes. He brought the domain insight (it's a known database trick), Lean fluency (TheoricLabs builds Lean tooling) and expert systems skills. The maths itself was first-year level: lists, sorting, induction. Lean gave **certainty, not insight**, and Claude Opus 5.5 is co-author on all three commits. **Implication:** the scarce ingredient is *spotting the right fact*. Ledger's question engine is designed to supply that for non-experts.

### 1.4 Math 2.0 (Terence Tao, Oct 2026)
- Proofs have moved from scarce to abundant. Value shifts to **understanding, exposition, and choosing what matters**. Tao asks for transparency on resources used and negative results.
- The negative example is OpenAI's 6 Oct 2026 bulk release:
  - `github.com/openai/math`, Apache-2.0: 722 manuscripts in 372 families at launch, now 721 in 373.
  - About 3 hours of thinking per result, about 4,000 problems posed.
  - About 42% of top-line results formalised in Lean (300/719).
  - Three papers withdrawn within a day after one sign error took down two dependent papers; 14 revised.
  - Tao called it "toxic waste", later "maybe treated waste".
- **Ledger does the opposite:** a few claims per plan, each understood by its human.

---

## 2. Vision, goals, non-goals

**Vision:** bring the power of AI-assisted mathematics to any Claude user, for any plan, in any field, always on and genuinely useful.

**Goals**
1. Turn the key choices in a plan into justified decisions with honest labels.
2. Ask the fewest, sharpest plain-English questions that steer both human and Claude to the right maths.
3. Use the cheapest rigorous check first. Reach for proofs only where they change a decision.
4. Make every claim understandable in one sentence, and confirmable or correctable in one tap.
5. Accumulate a per-project **facts file and claim graph** that later plans reuse.
6. Stay quiet when there's nothing worth checking.
7. Give access to the frontier, with provenance: Mathlib, CSLib, OpenAI's math repo, arXiv, and AI-maths techniques.

**Non-goals (v1)**
- Not a proof factory. No volume metrics.
- Not end-to-end verified software. Generated or hand code is *tested*; the proof covers the model, and the card says so.
- Not a replacement for code review, CI, security scanners or taste.
- No paid tier at launch.
- Not autonomous. The human confirms meaning; Claude never upgrades a label on its own.

---

## 3. Users and reach

| User | Where | What they get |
|---|---|---|
| Developers in Claude Code (CLI and Desktop Code tab) | Mod + Skill + local tools | Full experience: side panel, plan-exit checks, background proofs, facts file, PR justifications |
| Any claude.ai user (chat, desktop, mobile) | Skill + code execution (+ optional connector) | Questions, solver/simulation checks and cards inline; no live panel |
| Non-developers (ops, finance, events, writers, game masters) | Skill in claude.ai | Same five-plus questions; constraints, odds, timelines and consistency checks |

**Caveats on reach:**
- Skills need code execution enabled.
- Enterprise admins can block user skills and mods.
- The free plan allows one custom connector.
- Mods only draw in the Claude Code CLI and the Desktop Code tab, not `claude -p`, the SDK or cloud sessions.
- Mod background processes may be CLI-only (types mark `$.process` "CLI only"; unverified on Desktop).

---

## 4. Product principles (each traced to evidence)

| # | Principle | Evidence |
|---|---|---|
| P1 | **Understanding over volume:** at most 1–3 claims per plan, each with a one-sentence "why it's safe" | Tao's Math 2.0; the OpenAI dump backlash |
| P2 | **Human judges meaning; AI proposes, searches, checks** | Tao's workflow. DeepMind's Aletheia (700 Erdős problems): 50 of 63 technically correct answers solved a *misread* problem; 68.5% fundamentally flawed |
| P3 | **Ask, don't assume.** Questions find the facts | hargup's three facts. Clarifying-question studies: SWE-bench underspecified tasks resolved 54.8% → 69.4% with a separate asking agent; ClarEval first-try pass rate 8.94% → 89.02% once clarified |
| P4 | **Library before invention** | OpenAI's deleted "10 Erdős problems" claim was already solved in the literature; Aletheia: 9 of 13 meaningful results were known |
| P5 | **Refute before proving** | OpenAI's fixed prompt: "complete rigorous solution… or rigorous refutation"; the reasoning trace starts with a counterexample search |
| P6 | **Cheapest rigorous check first** | Lean is free, but proof search costs tokens; most fields need solvers or simulation, not theorems |
| P7 | **Translate back before trusting** | Weakened theorems pass Lean (a June 2026 review found Claude Code proved a weaker statement and passed the grader). claimcheck two-pass back-translation: 96.3% vs 69.4% for Claude-Code-as-judge (36 pairs; small) |
| P8 | **Claims in a dependency graph** | Anthropic's Fermat's Last Theorem formalisation (Sep 2026, ~13M lines, 11 days): plain agent coordination failed until a statement DAG with English descriptions took over. OpenAI: one sign error invalidated dependents |
| P9 | **Honest labels and provenance** | TheoricLabs' Proved/Checked/Assumed/Open; OpenAI's mixed verification status |
| P10 | **Show the work:** method, cost, dead ends | Tao and the IAS advisory group asked for disclosure of resources and negative results |
| P11 | **Quiet by default** | Google Tricorder: analyses above ~10% "not useful" get disabled. Meta: diff-time findings got >70% fixed vs ~0% in batch |
| P12 | **Counterexample first in UI** | Jane Street PBT study: practitioners want counterexamples; shrinking is "necessary" |
| P13 | **Predictable cost** | Kiro's 5× spec-mode pricing caused a backlash and refunds |
| P14 | **Whole-API scope** | Partial fixes repeated at neighbouring sites in real PRs (Node #66325 → #67008; tokio; ClickHouse; pandas) |
| P15 | **Comparison oracles beat specs from scratch** | 11 of 20 recent merged fixes in top OSS had an existing "twin" to compare against |

---

## 5. The core object: a Claim card (justified decision)

### 5.1 Fields
- **Title:** short, e.g. "Feed reads the last 20 rows".
- **Choice:** the decision being made.
- **Why it's safe (plain English):** ≤25 words, confirmed by the user.
- **The maths:** the formal statement (Lean/Dafny/Z3/TLA+ text or formula). Collapsed by default for novices.
- **Check:** method plus result plus cost. For example: "Z3 bit-vector: UNSAT in 0.3 s", "fast-check 10k cases incl. shrunk counterexample", "Lean kernel; axioms: standard 3".
- **Guard:** the runtime check and fallback, if any.
- **Scope:** what's covered and what's explicitly not, e.g. "compare, cast ✓; arithmetic ✗ Open".
- **Label:** Proved / Checked / Assumed / Open / Broken.
- **Provenance:** for external results: Verified in Mathlib/Lean, Peer-reviewed, or AI preprint (unverified).
- **Depends on:** other claims or facts. If a parent breaks, dependents drop to Open.
- **History:** versions, who confirmed, when re-checked.

### 5.2 Label definitions (strict)

| Label | Meaning | Required evidence |
|---|---|---|
| **Proved** | Machine-checked proof of the stated property | Lean or Dafny kernel success; no `sorry` or `assume`; only standard axioms (`#print axioms`); **and** the English reading confirmed by a human; **and** the proof is linked to real code by generation, extraction or a differential test |
| **Checked** | Strong automated evidence, no proof | Property tests with a recorded seed and count; a solver result on a bounded model; model checking of a design (label the *design*); or mutation testing showing the tests catch bugs |
| **Assumed** | A stated fact the plan relies on, not verified | User-stated, or an untested environment/config; a guard is recommended |
| **Open** | Not established, or out of reach | Concurrency semantics after only a race fix, undecidable cases, budget exhausted |
| **Broken** | A counterexample exists | Show the minimal counterexample first |

**Label rules:**
- A fixed data race or a passing unit test never upgrades a distributed or crash-consistency claim beyond Assumed or Open.
- Model-checking a design labels the **design** Checked and the implementation Assumed.
- Never trust tool stdout over its exit code. In testing, LemmaScript printed "11 verified" while `lsc check` exited 1 because of an `assume false`.

### 5.3 Example cards (illustrative designs, not executed)
```
┌─ Node · Buffer.indexOf / includes / lastIndexOf ─────────────── [CHECKED] ┐
│ CHOICE    Offsets and results use 64-bit integers end to end.               │
│ WHY SAFE  MAX_LENGTH < 2^53, so every valid index is exact.                 │
│ CHECK     fast-check metamorphic: indexOf(n,off)=off+subarray(off).indexOf(n)│
│           bounded check of offset normalisation over ±2^53                  │
│ GUARD     assert result is −1 or in [off, len)                              │
│ SCOPE     whole API (fill/copy/compare? → ASK)                              │
└─────────────────────────────────────────────────────────────────────────────┘
┌─ claude-code · Bash deny matching ─────────── [CHECKED known · OPEN arbitrary] ┐
│ CHOICE    Fail closed: unknown wrapper + denied argv tail ⇒ ask, never allow.  │
│ WHY SAFE  We can't know what an arbitrary binary execs.                      │
│ CHECK     fast-check: denied cmds × random wrapper chains → never allow       │
│ ASSUMED   Deny rules are a boundary (product decision pending)                │
└───────────────────────────────────────────────────────────────────────────────┘
```

---

## 6. The question engine (heart of the product)

### 6.1 Question set v2 (universal, any field)

| # | Question (plain) | Reveals | Routes to | Evidence of value |
|---|---|---|---|---|
| Q1 | What must never happen? | Invariants, safety | PBT → solver → proof | Nearly every case studied |
| Q2 | What are the hard limits? (sizes, money, time, people, rules) | Constraints, bounds | Z3 (bit-vectors), Kani/CBMC, OR-Tools, boundary generators | 8 overflow/width bugs in top OSS |
| Q3 | What are you trying to get the most or least of? | Objective, trade-offs | Optimisation (LP/MIP), evaluators, search | ClickHouse checked-math 1.5–2.4× cost; Next.js dedup |
| Q4 | What's uncertain, and how sure are you? | Distributions, fault models | Monte Carlo, Bayesian, generator ranges | CPython DST, tokio panics |
| Q5 | Does order or timing matter? | Sequencing, concurrency | TLA+/P, loom, isolation enumeration, scheduling | PostgreSQL MERGE, etcd, Next.js, DuckDB |
| **Q6** | **What should agree with this?** | Comparison oracle (own parser, old version, cache off, sync vs async, optimizer off, exact maths, UTC) | Differential/metamorphic testing; "fast path ≡ obvious path" | **11 of 20** merged fixes |
| **Q7** | **Which settings, platforms or flags change this?** | Environment matrix | Config/platform-matrix tests; Assumed cards | Rails flag, Django Windows/Py3.15, TS7 `--checkers`, date-fns TZ |

**Domain-flavoured wordings** turn the same questions into questions a non-expert can answer:
- "Can this ever be deleted, or does it only grow?" → append-only / monotone.
- "Could a newer one show an earlier time?" → monotone timestamps.
- "If the same request arrives twice, should it count twice?" → idempotence.
- "Does the order things arrive in change the result?" → commutativity.
- "Can you combine partial results into the whole?" → associativity / monoid.
- "Can two of these share an id?" → key uniqueness.
- "Is there a hard limit on how many or how big?" → bounded, exhaustively checkable.

### 6.2 Question selection: "20 questions toward the right maths"
- Keep a shortlist of candidate structures and laws that fit the plan step: monoid, idempotence, monotonicity, order invariant, semilattice/CRDT, homomorphism/fusion, plus domain problems such as matching, scheduling, routing and queueing.
- Ask the question with the **highest expected information gain**, the one that eliminates the most candidates (Kobalczyk et al. 2025 style). Stop when one structure remains, or after 3 questions.
- Every answer is **checked against reality** (code, data, tests) before anything is proved. Mismatches become Broken cards ("you said time only goes up, but 3 rows from the 2024 import disagree"). These are often the most valuable output.
- Always offer "Not sure". Ledger then measures the data, or keeps the safe path and labels the claim Assumed.
- Neutral wording; never lead the user.
- Cache answers in the facts file; never ask the same thing twice in a project.

### 6.3 Recognition by structure, not keywords
- Avoid keyword matching. Instead, conjecture a structure, test it, prove the instance (e.g. register a Lean typeclass instance such as `AddCommMonoid`), then **inherit every library theorem** about it. In Lean/Mathlib, typeclass instances give theorems for free.
- Find known results by the **shape of the statement**: Loogle/LeanSearch via lean-lsp-mcp.
- Find rewrites with equality saturation (lean-egg; note it's dormant since May 2026), guided by proved laws.

### 6.4 The law library (starter set, grows with use)
Seed it with the families behind most cheap wins. Each law = plain English + precondition + Lean/Dafny theorem + breaker generator + fix template + guard template.

| Law family | Unlocks |
|---|---|
| Order invariant (already sorted ⇒ take the tail) | Feeds, logs, keyset pagination (hargup) |
| Associativity / monoid | Parallel split, batching, prefix sums, incremental updates |
| Commutativity | Reordering, out-of-order events |
| Idempotence | Safe retries, caching, dedup, "send exactly once" |
| Monotonicity | Binary search on the answer, early exit, sliding windows |
| Semilattice (assoc + comm + idem) | CRDT merges, HyperLogLog/unique counts across shards |
| Homomorphism / fusion | Loop fusion, filter push-down, pre-aggregation |
| Round-trip (decode ∘ encode = id) | Serialisers, parsers, formats |
| Exact arithmetic | Money in integer cents/decimals; no float sums |

Choose and extend the library from data: tag real bug-fix PRs by the law each relied on, and rank laws by frequency × cost.

---

## 7. The maths router and tiers

**Tier 0: library lookup (seconds, cents).** Mathlib (Loogle/LeanSearch), CSLib, OpenAI `openai/math` (Apache-2.0; Lean 4.34.1 + Mathlib; Comparator challenge configs), arXiv, zbMATH Open, Erdős DB, OEIS. Cite the exact lemma or entry.

**Tier 1: falsify (seconds to minutes).**
- Property-based tests: Hypothesis (Python), fast-check (TS/JS), proptest (Rust), Go fuzzing, Plausible (Lean).
- Reuse the Hypothesis `/hypothesis` command, and adapt Anthropic's agentic-pbt `/hypo` (one Claude Code command, 290 lines). It tests only properties the code explicitly claims, then runs reproducibility/legitimacy/impact checks and a rubric ranking. Note: its `scoring.py` expects /25 while the prompt asks for /15; the fallback still ranks correctly.
- Mutation testing validates the tests: mutmut, cosmic-ray, StrykerJS, cargo-mutants.
- Evidence: agentic-pbt over 100+ Python packages produced 984 bug reports. 56% were valid overall, 86% of the top-ranked. About $9.93 per valid bug and about $5.87 / 8.8 min per module (Opus 4.1). Fixes were merged into NumPy, aws-lambda-powertools and tokenizers. **Raw false-alarm rate was 30–58%**, so gate before showing.

**Tier 2: bounded and automatic checkers (seconds to minutes).**
- Z3: bit-vectors for overflow and guards; constraints. OR-Tools / MiniZinc for scheduling and optimisation. clingo / answer-set programming.
- Kani (Rust), CBMC/ESBMC (C/Python bounded).
- TLA+/Apalache, P language for protocols. loom for tokio-style concurrency.
- SQL equivalence (QED, SQLSolver, VeriEQL) is weak on real queries (e.g. SQLSolver proved 14 of 180 real pairs). Prefer differential checks.
- Monte Carlo / Bayesian simulation for uncertainty; exact dice probability for games.

**Tier 3: proof (opt-in, shown with cost).**
- **TypeScript:** Midspiral **LemmaScript** with the Dafny backend. In hands-on testing, `npm install lemmascript` (v0.6.5) took 13.5 s; Dafny 4.11.0 is a self-contained 65 MB zip; `lsc gen` ≈1 s; `lsc check` 3–8 s; 63 of 71 examples needed no hand proof. A worked example (append-only feed, `newestN`, cart total ≥ 0, discount) verified in 3.2 s with 18 added lines.
  - Gotchas: TS `number` maps to an unbounded integer, so floats and overflow are **outside** the proof (use integer cents). `.every((p,i)=>…)` with an index fails silently until Dafny runs. Use `lsc regen`, not `check`, after editing TS, or the merge base is lost. Trust exit codes.
- **Lean path:** LemmaScript with Lean 4.34.0 + Velvet 2 (`namin/velvet`, branch `lemma2`; Loom no longer needed). A cold build took about 30 min in a sandbox without the Mathlib cache (`cache.mathlib.org` was blocked; about 1,000 modules compiled; about 5 GB on disk). After that, 1–9 s per example. More hand work: loop counters need `//@ type i nat`; one exact-length postcondition stayed `sorry` after four attempts. **Always use the Mathlib prebuilt cache** (`lake exe cache get`).
- **Lean native:** lean4-skills (cameronfreer; includes a `disprove` workflow) and lean-lsp-mcp (goal states, `lean_build`, Loogle/LeanSearch). Use `vcgen`/`mvcgen` + `grind` for monadic programs (Lean 4.31 added `mvcgen'`, up to 100× faster on some benchmarks); LeanHammer (early-stage, pinned 4.20–4.34; ~30–40% of held-out Mathlib theorems in ~6.6 s).
- **Rust:** Verus (industrial use; LLM proofs >90% on single functions but 13–40% at repo scale), Kani, Aeneas (safe Rust → Lean; no unsafe, interior mutability or concurrency).
- **Optional prover connectors:** open DeepSeek-Prover, Kimina, Goedel. Harmonic Aristotle is paid, now C/Verilog/Rust only, rejects pure Lean projects, and runs for tens of minutes on credits.
- **hargup pattern** for performance-critical rewrites: Model + Invariant (checker proved sound + preservation) + Plan (fast ≡ model) + optional Emit + guard.

**Tier 4: search with an evaluator (opt-in).** AlphaEvolve-style evolutionary search via open OpenEvolve / ShinkaEvolve for "does a better X exist?". The evaluator is the Q6 oracle, and winners re-enter Tiers 1–3. Expect known-but-unapplied tricks, not novelty: AlphaEvolve beat the state of the art on ~20% of 50+ hand-picked problems; AlphaDev/AlphaTensor records were matched or beaten by classical search within days to months.

**Router rules**
- Always run Tier 0 → Tier 1 first. Escalate only if the claim **changes a decision** (unlocks a shortcut, removes a lock, guards money/permissions/data).
- Show cost and time estimates before Tier 3 or 4: "Prove this? ~$4, ~10 min".
- Anchor specs to **the user's real code** (naive or reference version), not the English plan. That turns misformalisation into a failing differential test instead of a proof of the wrong thing.
- **Generate many candidates; don't repair.** LLM invariant guesses are 49–78% right; repair from checker feedback works only 6–16% of the time. Let the LLM steer and the automation fill in steps (LGuess: 255/320 with LLM steering + rewrite engine vs 3/320 LLM-only).

---

## 8. Architecture: three layers, one plugin

| Layer | Runs in | Responsibilities |
|---|---|---|
| **1. Skill** (`ledger` SKILL.md + references + scripts) | claude.ai, desktop, mobile, Claude Code | When to speak (silence rules), Q1–Q7 with domain wordings, the maths router, card format, labels and provenance, the facts-file convention, refute-first and library-first rules, creative-mode checks |
| **2. Tools** | claude.ai code execution (pip: z3-solver, ortools, hypothesis, numpy/scipy, networkx); local; optional remote MCP connector | Solvers, simulation, PBT harness generators, mutation testing, Lean/Dafny via local install or a hosted connector (Lean in the claude.ai sandbox is likely too heavy; untested) |
| **3. Claude Code mod** | Claude Code CLI ≥ v2.1.287 / Desktop Code tab | Side pane of cards; AbovePrompt band with label counts; plan-exit interception (snapshot the plan, start background checks, never block too long); `$.ui.ask` questions; background worker; `.ledger/` facts file and claim graph; PR justification export |

**Packaging:** one plugin can hold a mod, settings hooks, a skill and an MCP server, installed from a marketplace.

### 8.1 Mod facts from research (verify before use)
- **Layout:** `.claude-plugin/plugin.json`, `hooks/hooks.json` with `"modules": ["./register.ts"]`, and an ES module exporting `register(on, options)`. No build step; Claude Code loads `.ts` directly.
- **Dev loop:** `claude --plugin-dir ./ledger` (hot reload); `claude plugin validate [--strict|--json]` (lists hooked events and API calls; what admins and reviewers see); `claude plugin test` with `claude-code/testing`.
- **Validation rules:** call `$.…` in full (no aliasing `$`); string-literal event names; relative imports only (the only bare import is `claude-code`); names starting with `claude-` fail.
- **APIs** (names from docs/source; verify):
  - Panels: `$.ui.open`, `on('ui.render', { component: 'Pane' | 'AbovePrompt' })`, `$.ui.resolve(e)` components (Box, Text, Button, Markdown, Code), `$.ui.invalidate('ui.render')`.
  - Questions: `$.ui.ask(question, options | {options, header, multiSelect})`, 2–4 options.
  - Background: `$.process.run` (default 30 s, up to 10 min); `$.process.spawn` (mentioned in docs; signature unverified).
  - Timers and model: `$.clock.every/after`, `$.prompt.submit` (wake Claude), `$.model.complete({ model, system, prompt, maxTokens, timeoutMs })` (check `isAnswered`; billed to the user).
- **Plan interception:** a `tool.call` hook matched on `ExitPlanMode`. Plannotator's source reads `e.plan`, `e.planFilePath`, `e.tool_use_id`, `e.agentId` and skips subagents. Alternatively a settings `PermissionRequest` hook with matcher `ExitPlanMode` (decision via `decision.behavior`; exit code 2 not honoured). There's a reported issue (#15755) where allowing via `PermissionRequest` doesn't exit plan mode; check with `claude --debug`.
- **Limits:** the **10 s hook budget counts the hook's own running time only**; waiting on `$` calls doesn't count (except `$.clock.sleep`); `prompt.edit` hooks get 50 ms. Settings command hooks default to 600 s; `async`/`asyncRewake` run in the background, and `asyncRewake` wakes Claude on exit code 2.
- **Long work:** follow Plannotator's detached `/bin/sh` wrapper that writes output to files, polled by timer. Timers die on mod reload (every save during development), so keep the engine an **independent process / CLI / MCP server** the mod only displays.
- **Trust:** mods are **unsandboxed**. Org admins can block user mods (`allowManagedModsOnly`, policy mods refusing `process.run`); `sec-default` loads first on managed machines. Ledger must **degrade to a pane-only/skill-only mode**.
- **Templates to study:** Plannotator (plan gating, mod plus classic hooks, detached jobs; MIT/Apache-2.0); `claude-code-playground` `blast-radius` (pane with buttons; Apache-2.0); built-in mods in `anthropics/claude-code/mods` (`diff`, `sec-default`, `telemetry`, `agents-md`).
- **Publishing:** a git repo with `.claude-plugin/marketplace.json` at the root pointing to `./plugins/ledger`. Bump `version` each release (installed copies are cached by version). README states the tested Claude Code version. Unverified: the full marketplace.json schema and the Anthropic directory submission process.

### 8.2 Data model (suggested)
```
.ledger/
  facts.yaml        # confirmed domain facts (Q answers), with provenance and date
  claims.json       # claim graph: nodes = cards (fields in §5.1), edges = depends_on
  runs/             # per-check artefacts: seeds, counterexamples, solver logs, proof files, costs
  spec/             # Lean/Dafny/LemmaScript sources generated or written for claims
  plan-snapshots/   # plan text at each plan-exit, linked to claims
```
- Claims are content-addressed by statement plus scope. Re-check on code change (git diff touches the claim's files).
- Export: a Markdown "Justification" block for PR descriptions (choice, why safe, check with a fail-before/pass-after result, label).

### 8.3 Flows
1. **Planning (Claude Code):**
   - The user plans, and the skill decides whether to speak.
   - It asks Q questions (≤3) via `$.ui.ask` or AskUserQuestion.
   - At plan exit, the mod snapshots the plan and starts a background check; the pane fills with cards.
   - The user confirms or edits English lines; editing one re-plans **only the dependent steps**.
   - Proofs run on tap, with cost shown.
2. **PR time:** generate a property that **fails on the pre-change commit and passes after**, and attach the Justification block. This is what speeds maintainer review.
3. **Open issue triage:** agree the contract first (questions for maintainers), then the check, then the fix. See §11.
4. **claude.ai chat (any field):** the skill asks questions inline, runs a solver or simulation in code execution, and returns cards inline with the same labels.
5. **Creative / D&D mode:**
   - World rules → logic/constraint checks.
   - Timelines and "who knows what when" → ordering/reachability.
   - Encounter balance → exact dice probability.
   - Economy exploits → cycle detection.
   - Mysteries → every clue reachable before the reveal.
   - Branching stories (Ink/Twine) → dead ends and unreachable endings.
   - Puzzles → unique solution via solver.
   - Never touches prose, tone or taste.
   - "This is intentional" dismisses a flag.
6. **Weekly digest (optional scheduled task):** new Mathlib lemmas, Comparator challenges, and arXiv/AI preprints relevant to the user's claims, tagged with provenance.

### 8.4 Silence rules
- Speak only if the plan has a checkable core (limits, goal, uncertainty, rules, order) **and** the stakes are real (money, data, permissions, safety, performance-critical, published game or story).
- Stay silent on UI layout, copy, styling, config-only changes, chit-chat, prose and taste.
- At most 3 questions per plan; at most 3 cards surfaced (more stay collapsed).
- Track "Not useful" clicks per card type. Auto-disable a card type above 10% (the Tricorder rule).

### 8.5 Token and cost budget
- Analyse plan diffs, not whole repos. Cache facts and proofs. Reuse library laws (proofs written once).
- Visible daily budget; never charge silently. Flat and predictable.
- Typical (estimates): Tier 0–1 cents and seconds; library-law proof checks ~0.3–4 s; novel proofs minutes and dollars, on tap only.
- Lean is free, local software. The cost is Claude's tokens plus the user's review time.

---

## 9. What to reuse (with credit and licences)

| Piece | From | Licence | Role in Ledger |
|---|---|---|---|
| Justified-decision method: Model/Invariant/Plan/Emit + guard | hargup / TheoricLabs (`lean-derive-hargup` in the challenge repo) | MIT (challenge repo) | Template for performance-critical claims |
| Evidence labels Proved/Checked/Assumed/Open; staged modelling (scope → tagged facts → vocabulary → Lean model → example cases); ticket/plan methodology | TheoricLabs (`leanchess/production_process.md`, leanapi tickets) | leanchess MIT; **leanapi is BSL 1.1 (re-implement ideas, don't copy code)** | Card labels; staged plan template |
| LemmaScript (TS → Dafny/Lean) | Midspiral | MIT | TS proof backend |
| claimcheck (blind back-translation, then compare) | metareflection / Nada Amin (published with Midspiral) | MIT | "Did Claude understand what I'm proving?" step; contribute a **Lean preset** upstream |
| lemmascript-crosscheck | Midspiral | check | Runtime check that shipped JS matches the verified model |
| lemmafit hook pattern (verification status injected as context) | Midspiral | MIT | **Idea only.** See security notes |
| agentic-pbt `/hypo` + scoring rubric | Anthropic (mmaaz-git/agentic-pbt) | check | Tier 1 property drafting and ranking |
| Hypothesis `/hypothesis` command, Hypothesis, CrossHair | Hypothesis maintainers | MPL-2.0 (Hypothesis); check others | Python falsification |
| fast-check, proptest, mutmut, cosmic-ray, StrykerJS, cargo-mutants | various | check each | Falsification and test validation |
| Z3, OR-Tools, clingo, MiniZinc | Microsoft, Google, Potassco, MiniZinc team | MIT / Apache-2.0 / MIT / MPL (verify) | Tier 2 |
| Kani, CBMC, Verus, Aeneas, TLA+/Apalache, P | various | check | Tier 2–3 |
| Lean 4, Mathlib, CSLib, lean-lsp-mcp, lean4-skills, Plausible, LeanHammer, lean-egg | Lean FRO & community | Apache-2.0 / MIT (verify) | Tier 0, Tier 3 |
| OpenAI `openai/math` | OpenAI | **Apache-2.0** (verified) | Tier 0 library; Comparator challenge pattern |
| Plannotator | backnotprop | MIT/Apache-2.0 | Plan-exit mod and hook template |

**Do NOT use:**
- **leanllm** (TheoricLabs): no licence; it also logs in by reading Claude Code's stored credentials and sending headers that impersonate the official Claude CLI, a terms-of-service and compliance risk.
- **lemmafit's code as-is.** Its sync script **overwrites `.claude/settings.json` entirely** on every install or update. Its daemon can open a **WebSocket accepting remote commands, including `spawnClaude` (`claude -p`) and `readFile`**. Borrow concepts only.
- **lemmascript-skills, lemmascript-kit, lean-ai-sdk:** no licence found. Ask first.

**Collaboration etiquette:**
- Open an issue before major contributions; depend on published packages; contribute upstream rather than fork.
- Credit hargup's method by name and link, Midspiral/metareflection for LemmaScript and claimcheck, and Anthropic for agentic-pbt.
- Contacts:
  - Midspiral: Nada Amin (builder), Fernanda Graciolli (product); invite-only Discord, @midspiral_ai, newsletter.
  - TheoricLabs: Harsh Gupta, @hargup13, hargup.in.
- Midspiral's stated roadmap is "model the codebase to find bugs tests didn't catch". Ledger's discovery front end complements it: emit LemmaScript annotations so their toolchain does the proving.

---

## 10. Evidence base: where this would have helped (fixtures for evaluation)

All "earlier?" ratings are **hindsight**; nothing below was executed.

### 10.1 Popular developer software (merged Jul–Nov 2026)

| Project | Link | Bug | Lived | Q | Check | Earlier? |
|---|---|---|---|---|---|---|
| NumPy | PR #32467 (issue #11022) | `digitize` cast int64 bins to float64 | ~8y4m | Q4 | Hypothesis `digitize == searchsorted`, ints ≥ 2^53 | High |
| pandas | PR #71325 (#21454) | `to_json` float max → `inf` | ~8y5m | Q1 | Round-trip `read_json` | High |
| CPython | PR #160564 | Log rotation misnames around DST | days (class since 2020) | Q5/Q4 | Mocked clock, UTC oracle | Medium |
| Go net/mail | #80592 (commit 78f2c18ad226) | Display name with `\` not round-trippable | 6 days | Q1 | `go test -fuzz` round-trip | High |
| Node.js | PR #66325 | `Buffer.indexOf` negative past 2 GiB | limit since 2016 | Q2 | Bounds property + bounded check | Medium (partial fix → #67008) |
| tokio | PR #8645 | Barrier broken after panicking waker | short | Q5 | loom with panicking waker | Medium-low (limits case) |
| Valkey | PR #4880 | `now + TTL` overflow → crash loop | 7.2.0–9.1.2 | Q1/Q2 | Z3 bit-vector on guard + add | High |
| Valkey | PR #5163 | 32-bit wrap in quicklist merge estimate | ~12y | Q2 | Estimate ≡ real size (CBMC/Kani) | Medium-high |
| Valkey | PR #4823 | `LSET` index narrowed long→int | — | Q1 | Boundary PBT | High |
| PostgreSQL | commit 85f5553 | MERGE retry wrong action after concurrent delete | ~2y | Q5 | TLA+/P or isolation enumeration | Medium |
| DuckDB | PR #24368 (+#24998, #25159) | Optimizer rewrites changed results (NaN, NULL) | — | Q6 | Optimizer-off differential (how it was found) | High |
| ClickHouse | PR #124680 | Decimal rescale wraps "successfully" | class since 2022 (#38223) | Q2 | Exact-rational differential + Z3 helper proof | High (partial fix) |
| etcd | PR #22609 | Hash/Restore race | several releases | Q5 | Race detector (40/40 fail → 200/200 pass) | Medium (semantic claim stays Open) |
| Luxon | PR #1784 | `toISO()` output its parser rejects | 7.8+ y | Q6 | fast-check round-trip | High |
| temporal-polyfill | PR #104 | `diffDays(x,x)` threw | ~2–3 mo | Q2 | `diff(x,x)=0` + caller precondition | High |
| Rails | PR #59435 (#47555) | Counter cache double increment with `partial_inserts=false` | 3y8m | Q7 | Stateful PBT × flag | Medium (needs Q7) |
| zod | PR #6707 | Memo cache leaked between encode passes | ≤2.5 mo | Q6 | Cache on/off differential | Medium-high |
| zod | PR #6702 | Async tuple rest elements to last index | — | Q6 | `parseAsync ≡ parse` | High |
| TypeScript 7 | PR #65060 (#64981) | Dropped parentheses in emit | ~4 mo | Q6 | TS6-oracle precedence fuzzing | Medium-high |
| Django | PR #22186 | Windows + Py3.15 encoding | short | Q7 only | CI matrix, not maths | **Low (limits case)** |

Tally: High 10, Medium-high 3, Medium 5, Medium-low 1, Low 1. That is **13 of 20 "earlier"** (hindsight). **AI already helped in at least 7 of 20** (Codex, Claude Code, AI CI bots). Ledger's edge is the **recorded justification + fail-before/pass-after check**, not discovery alone.

### 10.2 Industry projects

| Industry | Case | What | Fit |
|---|---|---|---|
| Space | NASA F Prime #5082 / PR #5834 | 32-bit command sequence counter wrapped into collision; found only by 4.29 billion dispatches | High: model-check with a 4-bit counter |
| Space | NASA cFE #2707 (CVE-2026-5476) | `Offset + NumBytes` wrap bypasses bounds check. **Closed "completed", yet the unguarded sum is still on `main`** (commit 3673163b, `cfe_tbl_load.c:249-250`); fix PR #2814 closed unmerged | High: CBMC/Kani |
| Space | F Prime #5987 / PR #6037 | Rollover = product of dividers (4e26) instead of LCM (10000) | Medium |
| Defense/dual-use | ArduPilot #34670 / PR #34672 | Inverted 8-bit fence mask indexes past a 4-entry array | High: bounds proof over 256 values |
| Defense/dual-use | ArduPilot #34218 | Rover outside fence → RTL, but avoidance clamps speed to 0 forever | Medium-high: liveness / model check |
| Defense/dual-use | PX4 #27099 | Multiple allowed geofence zones combined with AND instead of OR; closed "not planned" | High at planning: forces an explicit spec |
| Agriculture | AgIsoStack++ #634 / PR #687 | ISOBUS quarter-day date decoded wrong | High: exhaustive round-trip |
| Agriculture | AgIsoStack++ #717 / PRs #718, #834 | Address-claim state machine evicted partner | Medium-high: protocol model |
| Agriculture | OpenSprinkler #417 | `%lu` with 64-bit `time_t` → 1969 logs | Low: compiler warnings suffice |
| Marketing | listmonk #2070 (→ #3022, #2860; commit a729a4a) | Resume re-sent mail, later skipped half the list; 3 fixes over ~18 mo | High: idempotence + crash/pause stateful test |
| Marketing | Mautic #11586 | Once-only email sent twice with translations | High |
| Marketing | Postiz #1563 | TikTok rejection over a prefilled privacy setting | Low (policy) |
| Commerce | Invoice Ninja #12231 / PR #12230 | 11.85 + 18.35 > 30.20 in float → refund rejected | High: exact decimals |
| Commerce | Medusa #14899 / PR #15532 | Stacked discounts → total −0.07 | High: Z3 "total ≥ 0" |
| Commerce | Easy!Appointments #1989 | Slots labelled in the wrong provider's TZ (open) | High: UTC round-trip |
| Household | Mealie #8758 / PR #8764; #7518 / PR #7537 | Scaling errors (eggs 4 vs 6; double-scaled sub-recipes) | High: scale-by-k homomorphism |
| Household | Firefly III #11281 (commit 3711222f) | Recurring webhooks fired twice; fix trades duplicate for possible loss | Medium-high: forces exactly-once vs at-most-once decision |
| Household | Actual Budget #1062 (open since 2023) | Monthly-on-31st skips June | High: exhaustive day × 24 months |
| Household | Mealie #7074 / PR #7077 | 1/16 tsp shows blank | Low-medium (display rule) |

### 10.3 Open issues: Ledger playbook (agree the contract first)
- **anthropics/claude-code #92542:** Bash deny bypass via wrappers (103 unintended files). Spec: `denied(c) ⇒ denied(w c)`; fail closed. Check: fast-check over wrapper chains. Label: Checked (known list), Open (arbitrary).
- **anthropics/claude-code #91271:** second `marketplace add` drops `autoUpdate`. Spec: idempotence plus frame condition. Assumed until ownership is agreed, then Proved.
- **POSIX TZ showcase:** CPython #159712 / #159715, Go #70633. One shared generator; four oracles (CPython C, CPython pure-Python, Go, glibc).
- Node #67008 (PR #67009); pandas #25499; CPython #153729; Valkey #4934 (replay equivalence); DuckDB #28123 (snapshot stability); ClickHouse #38223 / #69304 (one proved checked-multiply helper); Next.js #100345 (read-your-writes; TLA+); TypeScript #64998 (`--checkers` determinism); date-fns #4029 / #4346; etcd #22028 and Valkey #2724 (model-check designs; implementation Assumed).

### 10.4 Patterns to encode in the product
1. Comparison oracles dominate → Q6 is first-class.
2. Boundary arithmetic behind untested guards → Q2 → solver on guard + arithmetic.
3. Partial fixes repeat nearby → **whole-API scope rule**.
4. Distributed/timing bugs → model checking + strict labels.
5. Settings and platforms blind spot → Q7 + Assumed cards.
6. AI already finds bugs → Ledger records justification + fail-before/pass-after evidence.

---

## 11. Frontier maths access (latest pure and AI-assisted maths)

- **Library first:** Mathlib (~230k+ theorems; one count ≈232k), CSLib (early, undergrad CS short-term), OpenAI `openai/math`, arXiv, zbMATH Open, Erdős DB, OEIS.
- **Techniques adopted from labs:**
  - refute-first;
  - blueprint dependency graphs (Anthropic's Fermat run, ~6B output tokens, dozens of agents);
  - Comparator statement checks (OpenAI repo; `leanprover/comparator`);
  - claimcheck back-translation;
  - evolutionary search with evaluators;
  - library/novelty check (rediscovery is common);
  - don't tell the model a problem is "unsolved" (hurts performance, per AI-math workflow notes).
- **Provenance labels on outside results:** Verified in Mathlib/Lean | Peer-reviewed | AI preprint (unverified), the last never sufficient alone for a decision.
- **Honest limit:** Ledger cannot use OpenAI's unreleased model. It can use their published outputs, Lean library and techniques.

---

## 12. Coverage: could this help all plans?

**No.** Estimates (reasoned from Anthropic's 500k coding-conversation study, the SWE-bench task mix and agentic-PBT results; not measured):
- **~25–45%** of coding plans have a logic core where invariants plus property tests pay off.
- **~5–12%** justify proofs: money, permissions, state machines, core algorithms, concurrency, performance-critical rewrites.
- **~35–55%** are UI/copy/config/glue, where Ledger stays silent.
- Outside code: plans with limits, goals, uncertainty, rules or sequencing (ops, finance, events, science, policy, games, stories) benefit through solvers and simulation.

**Why not all:**
- Taste and values aren't maths.
- Garbage inputs give confident nonsense.
- Low stakes don't justify questions.
- Deep unknowns can't be modelled.
- Proofs need exact statements.
- Concurrency, hardware, floats and UI need specialised models or none.
- Rice's theorem: no automatic method decides all program properties, so a fixed library is never complete.

---

## 13. Risks and caveats (design against each)

| Risk | Mitigation |
|---|---|
| **Proving the wrong thing** (5–15% of "verified" AI specs; 56% of ProofNet's formal statements unfaithful; English→spec faithful only ~50–60% first try; Claude Opus 4.6 51.1% fully faithful on Verus-SpecGym) | Anchor to real code; back-translate (claimcheck); human confirms English; negative examples; ban `sorry`/new axioms; `#print axioms` |
| **False confidence ("proof theatre")**: green badges on easy claims while incident-causing bugs go unclaimed | Whole-API scope; replay historical bugs to measure catch rate; "proved" means *this claim*, never "app verified" |
| **Noise and annoyance** | Silence rules; ≤3 cards; 10% not-useful auto-disable; diff-time only |
| **False alarms** (raw AI PBT reports 30–58% invalid) | Reproducibility/legitimacy/impact gate; rubric ranking; mutation testing; show only top-ranked |
| **Weak properties** (filtered generators; `assume()` hiding bugs ~62% of PBT failures; narrow ranges) | Mutation testing; generator coverage checks; bias generators to boundaries (2^31, 2^53, float max, DST, leap years, year ends) |
| **Cost blowouts** | Tiered router; budgets per card; proofs on tap; cache; visible spend |
| **Environment drift** (migrations, other writers, clocks) | Runtime guards plus fallback; re-check on diff; Assumed labels for external writers |
| **Security** (mods unsandboxed; subprocesses outside the Bash sandbox) | No network by default; no remote command channels; never overwrite user settings (merge only); least privilege; publish `claude plugin validate` output; managed-org fallback mode |
| **Lean heaviness** (cold Mathlib build ~30 min / 5 GB without cache) | Prebuilt cache; prefer Dafny/LemmaScript for TS; optional hosted connector |
| **LemmaScript numeric gap** (TS number → unbounded int) | Integer cents; flag floats as Assumed; Tier 2 float checks separately |
| **Misreading the plan / wrong structure** | Show the reduction in one sentence for confirmation ("this is capacitated routing, right?") |
| **Licence/IP** | Respect licences in §9; check employment agreement before any commercial use |
| **Hindsight bias in evaluation** | Blind replays (no issue text) in the eval plan |
| **Platform reach** (no panel in claude.ai; admins block mods; `$.process` maybe CLI-only) | Skill-first design; graceful degradation |

**Strongest objection:** "This is a prompt with a sidebar." **Reply:** the measured gains in the studies came from **structure**: separate asking agents, separate judges, generate-then-check, statement graphs, back-translation. Raw model ability alone didn't produce them. Ledger is that structure, packaged and enforced.

**Non-obvious way this could be wrong:**
- On claude.ai there's no repo, so a green card certifies Claude's *restatement* of the problem, not the real system. Label it accordingly.
- The questions may produce the right sentence while the generated test inputs never reach the bug.
- The most valuable output may be the **questions themselves** (users stating limits, goals and uncertainty) more than any solver. If so, lead with question-and-explain.

---

## 14. Paid service (later, optional)

- **Launch:** free, open source, local-first. Users pay Claude for their own tokens.
- **Validate** with a waitlist link in the pane ("Save and share proofs with your team?"). Build only if **≥50 users or ≥5 teams** sign up within 2 months.
- **Candidate paid features**, in order:
  1. proof registry with signed attestations (CI-verifiable "proved at commit X");
  2. hosted warm Lean/Mathlib runners (also unlocks claude.ai users);
  3. team facts/theorem library;
  4. compliance reports (Proved/Checked/Assumed/Open export).
- **Risks:** regulated teams often can't send code out (self-host option); well-funded competitors (Harmonic, Axiom, possibly Anthropic); liability. Never sell "verified app"; keep label wording precise.

---

## 15. Milestones (4 weeks) with one pass/fail metric each

| Week | Build | Metric |
|---|---|---|
| **1** | Skill: silence rules, Q1–Q7 with domain wordings, router, card format, labels. Re-run the Midspiral tools hands-on (LemmaScript Dafny path; claimcheck run end-to-end, which hasn't been done yet) | ≥85% correct speak-or-stay-silent decisions on 40 labelled prompts (mix of code, ops, creative, chit-chat) |
| **2** | Tools layer: Tier 0 lookup, Tier 1 PBT (adapt `/hypo` + mutation testing), Tier 2 Z3/OR-Tools; fail-before/pass-after harness | Reproduce **5 fixes** on pre-fix commits: pandas #71325, NumPy #32467, Go #80592, zod #6702, Valkey #4880. Each property **fails before and passes after**. 5/5 with issue text in ≤30 min each; **3/5 blind** (no issue text); record minutes and tokens |
| **3** | Claude Code mod: pane + band + plan-exit snapshot + background worker + `.ledger/` graph + one-tap confirm/edit with dependent re-plan; LemmaScript/Lean tier on tap | Users catch ≥2 of 3 planted wrong English readings; card confirm ≤15 s median |
| **4** | Publish (marketplace repo, README with tested version, attribution); run on ~20 real PRs; outreach to Midspiral and hargup (issue first; offer claimcheck Lean preset) | ≤10% "not useful" on 20 real PRs; ≥1 accepted upstream contribution or a positive maintainer response; ≥1 card that changed a real decision |

**Extended evaluation sets:** §10 tables (≈40 cases with links). Re-derive hargup unaided: give only his naive model plus reference SQL. Pass if it finds dense ids + monotone timestamps, proves `feedPlan_eq` and `inv_addPost`, and gets ≥2.5× on the feed within $20 and 2 hours.

---

## 16. Open questions to ask the user before building
1. **Name and licence:** "Ledger" ok? MIT or Apache-2.0 (Apache-2.0 matches OpenAI's math repo and gives a patent grant)?
2. **First language focus:** TypeScript (LemmaScript ready) and Python (Hypothesis, best evidence), Rust next?
3. **Plan-exit behaviour:** non-blocking (cards arrive later, like Plannotator's mod mode) or optional blocking gate for "critical" plans?
4. **Default proof backend:** Dafny (fast, LemmaScript-ready) or Lean (Mathlib, frontier access) for the first proof tier?
5. **claude.ai reach:** ship the skill standalone first, or only inside the plugin?
6. **Telemetry:** none (default), or opt-in local-only usefulness stats for the 10% rule?
7. **Creative mode in v1,** or after the code path?

---

## 17. Glossary (for contributors)
- **Invariant:** a fact that stays true across every change. **Induction:** true at the start, and every change keeps it true.
- **Refinement:** proving the fast/real version behaves like the simple model.
- **Property-based testing (PBT):** generate many random inputs to falsify a stated property; shrink counterexamples.
- **Mutation testing:** inject small bugs to check the tests catch them.
- **Bounded model checking:** exhaustively check all behaviours up to a size bound.
- **Comparator / back-translation:** checks that a formal statement means what was intended.
- **Kernel / axioms:** Lean's small trusted checker; standard axioms are `propext`, `Classical.choice`, `Quot.sound`.
- **Math 2.0:** Tao's term for the era of abundant proofs, where value moves to understanding and exposition.

---

## 18. Attribution block (put in README)
Ledger builds on:
- Harsh Gupta / TheoricLabs (the lean-derive method, evidence labels);
- Midspiral and metareflection, Nada Amin and Fernanda Graciolli (LemmaScript, claimcheck);
- Anthropic (agentic property-based testing; the Fermat's Last Theorem formalisation workflow);
- the Hypothesis maintainers;
- the Lean FRO, Mathlib and CSLib communities;
- OpenAI's `openai/math` release (Apache-2.0);
- Plannotator;
- arjaythedev's $12 server challenge.

Inspired by Terence Tao's "Math 2.0".

*Research compiled Nov 2026. Version numbers, APIs, licences and leaderboard positions change: re-verify before relying on them.*

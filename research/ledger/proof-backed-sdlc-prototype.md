# Put a claim ledger beside Claude

**Verdict: build the "Claim Ledger".** It is a side panel plus a background engine. It turns whatever Claude is doing right now (a plan, an edit, a PR, a refactor, a bug fix) into 3–7 short, checkable claims. Each card shows the claim in plain English, the same claim in exact math, and the steps that will check it. The engine tries to break every claim cheaply first, with property-based tests (PBT) and a mutation check that confirms the test can catch bugs. It escalates to bounded checkers, and runs Lean 4 only where a proof buys something concrete: invariant-dependent rewrites and pure kernels, as in hargup's feed server. One click on any card ("wrong", or an edited English sentence) sends Claude a structured correction and re-plans only the steps that depend on that claim. **Confidence: 7/10.**

Why not higher:

- No study shows that non-experts can judge English or math claims reliably.
- Raw LLM property finders still have a **30–58% false-discovery rate**, against the **<10% effective false-positive bar** that kept Google's and Meta's tools in use. The triage-plus-mutation gate has to close that gap, and nobody has measured whether it does.
- All solid benchmark evidence is Python-only.
- The plan-interception mechanics (whether a hook matches `ExitPlanMode`, and the mod hook limits) are only partly verified.

No peer combines the four parts: claims anchored to code, a falsification-first engine, an opt-in Lean tier, and correcting the plan with a single action. The closest are Midspiral lemmafit (greenfield only, v0.1), nicholls-inc Crosscheck (Dafny, 5 stars), Kiro (PBT only, explicitly "not formal verification") and Anthropic's agentic-pbt (Python bug hunting, no UI and no proofs).

## The candidate field: five prototypes, one clear winner

The ranking weighs four things: value at any stage of the software lifecycle, value to any skill level, how cheap and fast it can be built on what exists today, and risk. Scores are 1–5 (5 is best; for risk, 5 means low risk).

| Rank | Prototype | What it is | Value | Feasibility (4 wks) | Risk | Why it ranks here |
|---|---|---|---|---|---|---|
| **1** | **Claim Ledger** (recommended) | Side panel with English / math / verify cards for the live plan or diff. Engine runs propose → falsify (PBT + mutation) → bounded check → Lean opt-in. One-action re-plan | 5 | 4 | 3 | Works at any stage because the input is "whatever Claude is about to do". Novices read the English, experts read the math. It reuses mature parts (Hypothesis, agentic-pbt prompts, CrossHair, lean-lsp-mcp). The one unmet requirement (the panel) is the cheap part |
| 2 | Diff-time invariant bot | PR bot running agentic PBT on changed modules. It comments only when it has a shrunk counterexample and a mutation-validated property | 4 | 5 | 4 | Best evidence base: Meta's diff-time fix rate rose from 0% to over 70% ([CACM 2019](https://6826.csail.mit.edu/2020/papers/facebook-infer-cacm.pdf)), and agentic PBT costs ~$10 per valid bug ([arXiv 2510.09907](https://arxiv.org/html/2510.09907v1)). But it acts after the fact, with no plan correction and nothing "while Claude works". **Ship it as Ledger front end #2, not as a separate product** |
| 3 | Proof-gated optimizer (generalized hargup) | Mine invariants, propose a rewrite, prove plan = naive in Lean, emit code with a runtime guard and a fallback | 3 | 2 | 2 | Biggest wow factor (feed query 16.7 → 5.4 µs). It fires rarely, and it depends on a closed-world "single writer" assumption that real apps often break. Keep it as the Ledger's Lean tier |
| 4 | Spec-first verified core | Write the logic in Dafny or Lean, prove it, extract to Py/Go/TS | 3 | 3 | 3 | Strongest guarantee, but greenfield only and limited to pure cores (claimed ~22–27% of a codebase). lemmafit and Crosscheck already occupy this space ([Midspiral](https://buttondown.com/midspiral/archive/new-open-tool-lemmafit/); [Skillselion](https://skillselion.com/skills/nicholls-inc/claude-code-marketplace/crosscheck)) |
| 5 | Design-stage model checker | Turn plans for concurrent or distributed features into P/TLA+ models and model-check them | 4 for that niche, 1 for everyone else | 2 | 3 | Highest value per bug found: AWS found a 35-step DynamoDB data-loss trace that review and testing missed ([CACM 2015](https://cacm.acm.org/magazines/2015/4/184701-how-amazon-web-services-uses-formal-methods/fulltext)). Narrow audience, and not for novices. Add later as a Ledger tier for stateful plans |

The pattern is that #2, #3 and #5 are all **tiers or front ends of #1**. The Ledger is the shared data model and UI that lets each one plug in without the user learning a new tool.

## Nobody occupies the full loop; the closest peers each lack one piece

| Closeness | Peer | What it does | What it lacks against the Ledger | Source |
|---|---|---|---|---|
| 1 | **Midspiral lemmafit** (+ LemmaScript) | Claude Code tool that intercepts Claude's plan, has Claude write that logic in a verification-aware language, proves it, and exposes a TS API. Its guarantees read like "cart quantity can never be negative" | Greenfield only, Claude-only, v0.1 (Mar 2026). It does not mine claims from existing code, has no PBT falsification tier, and no review panel | [Midspiral](https://buttondown.com/midspiral/archive/new-open-tool-lemmafit/); [Reservoir](https://reservoir.lean-lang.org/@midspiral/LemmaScript) |
| 2 | **nicholls-inc Crosscheck** | Claude Code plugin with Dafny verification, then compiles to Py/Go. Has `/invariant-coverage-scaffold` and `/spec-adversary`. Lean MCP tools are joining | Needs Docker. Limited to pure cores (~22–27%). Process-heavy (six assurance layers). 5 stars. No novice UI | [Skillselion](https://skillselion.com/skills/nicholls-inc/claude-code-marketplace/crosscheck) |
| 3 | **AWS Kiro specs** | Turns EARS requirements into properties linked to tasks, then PBT with shrinking. On failure the user chooses whether to fix the code, the test or the requirement | No proof tier ("not formal verification"). Driven by requirements, so it doesn't work at an arbitrary lifecycle stage on existing code. Pricing backlash | [Kiro docs](https://kiro.dev/docs/specs/correctness/); [The Register](https://www.theregister.com/2025/08/18/aws_updated_kiro_pricing/) |
| 4 | **Anthropic agentic-pbt** (+ official Hypothesis command) | Claude Code command that mines properties from code and docs, writes Hypothesis tests and triages failures. 984 reports, merged fixes in NumPy and elsewhere | Python only. Bug-hunting reports, no live UI, no proofs, no plan loop | [Anthropic](https://www.anthropic.com/research/property-based-testing); [arXiv 2510.09907](https://arxiv.org/html/2510.09907v1); [hypothesis.works](https://hypothesis.works/articles/claude-code-plugin/) |
| 5 | **Imandra CodeLogician** | LLM agent formalizes code into Imandra's reasoner, then does region decomposition and test generation | Proprietary reasoner, not Lean. Agent integration is unclear | [arXiv 2601.11840](https://arxiv.org/abs/2601.11840v2); [docs](https://docs.imandra.ai/universe/code_logician/introduction/) |
| 6 | **Plannotator** (UI peer) | Plan-review UI for `ExitPlanMode`. In mod mode Claude is not blocked and the decision comes back as a message | Annotation only, no verification. It is still the closest model for the panel-plus-feedback mechanics | [Plannotator docs](https://docs.plannotator.ai/open-source/agents/claude-code.md) |
| 7 | **lean4-skills / lean-lsp-mcp** | Lean proving workflows and the Lean LSP exposed to Claude Code | Plumbing only. No claim mining, falsification or UI. **Reuse them** | [claudemarketplaces](https://claudemarketplaces.com/plugins/cameronfreer-lean4-skills); [lean-lsp-mcp](https://claudemarketplaces.com/mcp/ooo0ooo/lean-lsp-mcp) |
| 8 | **Harmonic Aristotle** (C/Verilog, 2026-10-27) | Lean 4 prover API that fills `sorry` placeholders against a spec the user writes | The user must write the spec. No developer loop. The code launch is undocumented | [RuntimeWire](https://runtimewire.com/article/harmonic-aristotle-software-chip-verification); [AI Learning Guides](https://ailearningguides.com/harmonic-aristotle-ai-formal-code-verification/) |
| 9 | **Axiom Math** ($1.6B) | Pitch: formally verified AI-generated code in Lean | No public developer product found | [SiliconANGLE](https://siliconangle.com/2026/03/12/verifiable-ai-startup-axiom-raises-200m-prove-ai-generated-code-safe/) |
| 10 | **Microsoft Verus agents** | LLM-written Verus proofs for Rust. Over 90% at function level, 13–40% at repository level | Research. Rust only. The user supplies the spec | [arXiv 2409.13082](https://arxiv.org/abs/2409.13082v1); [arXiv 2509.25197](https://arxiv.org/pdf/2509.25197) |
| ref | **hargup lean-derive** (the inspiration) | Model.lean → Invariant.lean → Plan.lean → Emit.lean. 512 lines of generated C, plus a runtime guard and a SQL fallback. #1 at 280k users | Hand-derived by an expert, one app. It is the proof that the Lean tier pays off, not a tool | [Leaderboard](https://benchmarks.arjaythedev.com); local rebuild with Lean 4.35.0: `lake build` ~4 s, byte-identical C, standard axioms only |

Funding goes to provers: Axiom raised a $200M Series A at $1.6B, and Harmonic reached unicorn status on a $120M Series C ([BusinessWire](https://www.businesswire.com/news/home/20251125727962/en/Harmonic-Builds-Momentum-Towards-Mathematical-Superintelligence-with-$120-Million-Series-C)). The **developer-UX layer inside agents is still pre-traction**. That gap is the opportunity, and it is also the risk that one of the funded players closes it.

## The recommended prototype: Claim Ledger spec

### The core idea in one sentence

**Claude must state what it believes will stay true before and after it acts. A machine tries to break those statements. The user only has to look at the statement and, if something fails, the counterexample.**

Practitioners asked for exactly this split: 10 of 29 deductive-verification users want counterexamples, and they want IDEs showing "both the spec and the code" ([arXiv 2510.20514](https://arxiv.org/html/2510.20514v1)). Jane Street engineers say the most common PBT failure is "not knowing what properties to test" ([ICSE 2024](https://cis.upenn.edu/~bcpierce/papers/icse24-pbt-in-practice)). The Ledger removes that blank page by proposing the claims.

### User flow: novice (a vibe coder adding "checkout" to a shop app)

| Step | What the novice sees | What happens underneath |
|---|---|---|
| 1 | Asks Claude to add a discount code feature. Claude plans | A hook snapshots the plan when Claude calls `ExitPlanMode`. Claude is not blocked |
| 2 | Within ~20 s, the panel shows 4 cards. The top one reads: **"The total never goes below $0, whatever codes are applied."** | Proposer picks templates (bounds invariant, idempotence, round-trip, crash-freedom). Each claim is anchored to plan step 3 and, after the edit, to `apply_discount()` |
| 3 | Reads the English line, clicks ✓ on three cards. On the fourth, "Applying the same code twice gives the same total", they click ✗ and type "you can stack two *different* codes, but not the same one twice" | The edit becomes a structured message to Claude. Plan steps 3–4 are revised and the dependent claims regenerate. That is the only action required |
| 4 | Claude writes code. Card 1 turns red: **Broken. Counterexample: codes `SAVE50` + `SAVE60` on a $10 cart → total = −$1.00.** Below it: "Suggested fix: clamp at 0 (1 line)" with an [Apply] button | Hypothesis found it and shrank it to a minimal input. The suggested fix comes from Claude. The mutation check confirms the property has teeth |
| 5 | Clicks Apply. Card 1 turns green: **Tested: 2,000 cases, catches 9/10 seeded bugs** | Re-run on the changed function only |
| 6 | Never sees Lean. The math row stays collapsed unless opened | — |

### User flow: expert (an engineer optimizing a feed endpoint, hargup-style)

| Step | What the expert sees | What happens underneath |
|---|---|---|
| 1 | Asks for a faster `GET /feed`. Claude's plan says "read the last 20 rows instead of sorting" | Triage flags the rewrite as **invariant-dependent**, which is what makes Lean eligible |
| 2 | Cards: **C1** "Post ids are dense (1..n)" ∀ i<n, ∃ p, p.id = i; **C2** "Timestamps never decrease as id grows" ∀ p q, p.id < q.id → p.ts ≤ q.ts; **C3** "Every author of a post exists"; **C4** "Tail scan = sorted feed, given C1–C3": `Inv db → feedPlan db = feedModel db` | Theorem shapes are fixed by the engine, so the LLM cannot weaken them. These mirror hargup's `inv_addPost`, `checkInv_sound` and `feedPlan_eq` |
| 3 | Expands the verify steps on C4: (1) differential test of model vs code on 20k random posts; (2) check C1–C3 are preserved by **every writer** (lists 3 writers found); (3) Lean `grind` → LeanHammer → agent; (4) axiom audit. **Est. 4 min, ~$1.20.** Clicks [Run Lean] | Lean opt-in. Cost is shown before the run |
| 4 | C2 turns **Broken: writer `admin/backfill.py` inserts posts with past timestamps** | Writer enumeration catches the closed-world violation before any proof time is spent |
| 5 | Edits C2's scope to "except backfill, which sets a `data_version` flag". One click re-plans, adding a runtime guard with a SQL fallback | Matches the hargup guard pattern |
| 6 | C4 shows **Proved (model) + Tested (code) + Guarded**, with theorem names, the Lean version, the axioms list (`propext`, `Classical.choice`, `Quot.sound`) and benchmark 16.7 → 5.4 µs | The wording comes from the coverage ledger. "Proved" never appears without a kernel-checked theorem *and* a passing differential test |

### Side-panel card layout

```
┌─ C4 · feed/plan.py:feed_plan · plan step 3 ───────── [PROVED·model] [TESTED] [GUARDED] ─┐
│ ENGLISH  Reading the newest 20 rows gives exactly the same feed as sorting all posts,  │
│          as long as ids are dense and timestamps only increase.                         │
│ MATH  ▸  Inv db → feedPlan db 20 = (sortBy (·.ts) desc db.posts).take 20               │
│ VERIFY ▸ 1 ✓ differential: 20,000 random dbs, 0 mismatches          0.8 s              │
│          2 ✓ invariant kept by 3/3 writers (addPost, like, delete)   Lean inv_addPost   │
│          3 ✓ Lean feedPlan_eq   grind 1.9 s   axioms: standard only                    │
│          4 ✓ bench 16.7 → 5.4 µs at 100k posts                                         │
│ EVIDENCE ▸ files · theorem · repro command · cost 31k tokens / 6 CPU-s                 │
│ [✓ Looks right]  [✎ Edit English]  [✗ Wrong → replan]  [? Intended?]  [Not useful]      │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

Layout rules:

- English is always visible and has no more than 25 words.
- Math is collapsed by default for novices and expanded for experts (a per-user setting).
- Verify steps show the tool, the budget and the result. They never show a proof trace.
- A Broken card puts the counterexample *above* the English.
- The [Not useful] button feeds the effective-false-positive meter for that claim class (the Tricorder pattern).

### Status badges

Badge wording is generated from the evidence fields. The LLM never writes it as free text.

| Badge | Meaning (shown on hover) | Required evidence | Colour |
|---|---|---|---|
| **Proposed** | Claude stated it; nothing has run yet | Anchor to plan step or symbol | grey |
| **Tested** | Survived N generated cases, and the test catches seeded bugs | Case count ≥ budget; mutation kill ≥ threshold (start at 60%); no heavy `assume()` filtering | blue |
| **Bounded** | No counterexample up to size k | CrossHair / ESBMC-Python / Kani result with k | teal |
| **Proved** | Kernel-checked theorem, plus a test that the model matches the code | Lean theorem; no `sorry`; `#print axioms` ⊆ {propext, Classical.choice, Quot.sound}; differential pass. A sub-label says model or code | green |
| **Broken** | Here is an input that makes it false | Shrunk counterexample, a repro command, and a suggested fix if one is available | red |
| **Unproven in budget** | Not falsified, but not proved within the time or token cap. This is *not* a failure | Highest tier reached, plus the budget spent | amber |
| **Intended?** | Failure may be deliberate design; the author is asked, not accused | Triage rated it ambiguous | purple |
| **Guarded** | The code checks this at runtime and falls back if it breaks | Guard and fallback present in the diff | outline |

Separating "false", "couldn't prove" and "tool limitation" answers the practitioners' complaint that today they can't tell these apart. The black-box "the SMT [solver] just saying, sorry, I don't know" problem was raised by 9 of 29 ([arXiv 2510.20514](https://arxiv.org/html/2510.20514v1)).

### Data model

The ledger is a git-tracked JSONL file per branch at `.claude/claims/<branch>.jsonl`. It is the single source that every front end renders: the panel, PR comments, and plain markdown for `claude -p`.

| Field | Type | Notes |
|---|---|---|
| `id`, `rev` | string, int | Stable id. `rev` increments on every edit |
| `anchor` | {plan_step?, file, symbol, commit, span} | Re-anchored on every edit. A stale anchor resets the status to Proposed |
| `english` | string ≤25 words | Required. A second model back-translates it from `math` and flags drift |
| `math` | {lean: string, display: string} | `lean` is checkable. `display` is the Unicode-rendered form |
| `kind` | enum | round_trip, idempotence, invariant_preservation, differential/model, bounds, monotonicity, conservation, crash_freedom, error_path, ordering |
| `origin` | enum | plan, mined_from_code, user, test_suite |
| `depends_on` | [claim_id], [plan_step] | Drives targeted re-planning |
| `verify` | [{tier, tool, cmd, budget, status, artifact_path, cost}] | Ordered steps. `cmd` is a repro command that can be pasted |
| `status` | enum (the badges above) | Derived from `verify`, never set by the LLM |
| `evidence` | {cases, shrunk_cex, mutation_score, bound_k, theorem, axioms, lean_version, bench} | |
| `user` | {decision: confirmed/edited/rejected/intended/not_useful, note, ts} | Feeds the false-positive meter per `kind` |
| `cost` | {tokens, cpu_s, usd_est} | Shown before and after each run |

### Pipeline tiers

| Tier | What runs | Budget target | Evidence for feasibility |
|---|---|---|---|
| **0. Propose** | Claude (or a cheaper model) emits claims from templates for the plan or diff, using Jane Street's high-leverage categories: differential/model 17 of 30, round-trip 11, algebraic or invariant 11, crash-freedom 7 ([ICSE 2024](https://cis.upenn.edu/~bcpierce/papers/icse24-pbt-in-practice)). Mine from existing tests, types and docstrings | ≤20 s, ≤1 small call per plan | LLM postconditions reach 0.78 accept@1 at best, so claims are treated as conjectures ([arXiv 2603.17193](https://arxiv.org/pdf/2603.17193)) |
| **1. Falsify** | Agent writes Hypothesis (Py) or fast-check (TS) tests. Prompt: "cover the whole spec; don't `assume()` away the domain". A lint flags `assume` misuse and narrow strategies. Shrink failures | ≤30 s per claim inline; background per changed module | Prompt framing lifted Opus 4.8 recall from 39% to 79%. `assume` misuse and bad ranges cause about 62% of failures ([PBT-Bench](https://arxiv.org/pdf/2605.15229)) |
| **1b. Mutation gate** | Seed mutants in the anchored function. A claim is only "Tested" if its test kills them | ≤60 s per function | Mutant kill rate is the standard check that a property has teeth ([arXiv 2307.04346](https://ar5iv.labs.arxiv.org/html/2307.04346)) |
| **1c. Triage** | Rank failures and split them into Broken vs Intended?. Only Broken cards with a counterexample surface | 1 call | Top-ranked agentic-PBT reports were 86% valid vs 56% raw ([arXiv 2510.09907](https://arxiv.org/html/2510.09907v1)) |
| **2. Bounded check** | CrossHair (as a Hypothesis backend, or `diffbehavior` for refactors), ESBMC-Python, Kani for Rust | ms to seconds | ESBMC-Python averages ~30 ms per program ([arXiv 2407.03472](https://arxiv.org/html/2407.03472v1)); [CrossHair](https://github.com/pschanely/crosshair) |
| **3. Lean (opt-in or auto-eligible)** | Only for invariant-dependent rewrites and pure kernels. Claude writes a small Lean model of the *naive code*, checked by differential test, then fixed theorem shapes. Ladder: `decide`/`simp` → `grind` → `egg` → LeanHammer → Claude via lean-lsp-mcp. `mvcgen` for monadic code. Mechanical gate on `sorry` and axioms | Cost shown up front. Default cap ~5 min, ~$2 | LeanHammer means 6.6 s per goal, ~30–40% on Mathlib ([arXiv 2506.07477](https://arxiv.org/html/2506.07477v1)); `mvcgen` + `grind` pattern ([Lean ref](https://lean-lang.org/doc/reference/4.25.0/The--mvcgen--tactic/)) |

**Why the Lean tier is anchored to code, not English.** First-try faithful specs from English run at only about 51–78% (Opus 4.6: 51.1%) ([Verus-SpecGym](https://arxiv.org/abs/2605.26457)). Even with round-trip repair, 9.4% still drift ([Roundtrip](https://arxiv.org/abs/2604.25031)). A Lean model of executable naive code can be *run* against the real code, so a wrong translation fails a test instead of silently proving the wrong thing. The English row on the card is for the human, and the math row is checked against the code. Even with every layer in place, expect roughly 5–15% of "verified" specs on realistic plans to be subtly wrong. That is exactly why the human reads the English.

### Which languages first, and why

| Order | Language | Why | Tier coverage on day 1 |
|---|---|---|---|
| **1** | **Python** | All the hard numbers are Python: agentic PBT costs, PBT-Bench recall, an automated soundness check that matched human labels with 100% precision ([arXiv 2307.04346](https://ar5iv.labs.arxiv.org/html/2307.04346)). Hypothesis, CrossHair and ESBMC-Python are all available | Tiers 0, 1, 1b, 1c, 2, and 3 via model extraction |
| **2** | **TypeScript** | Probably the largest population of novice and agent-driven app builders (an inference). fast-check exists, and LemmaScript points to a TS → Lean route | Tiers 0, 1, 1b. **No mature TS verifier was found**, so tier 2 is skipped and tier 3 needs extraction |
| 3 | Rust | Richest verification stack: Kani v0.68 for bounded checks, Verus/Aeneas for proofs ([Kani release](https://github.com/model-checking/kani/releases/tag/kani-0.68.0)). Audience skews expert | Good expert showcase in month 2 |
| later | SQL, Go | SQL equivalence provers leave most real rewrite pairs undecided (SQLSolver proved 14 of 180; [arXiv 2607.09251](https://arxiv.org/pdf/2607.09251)), so use differential testing on generated databases. Go tooling is research-grade (Gobra) | Tiers 0–1 only |

**Caveat:** no LLM-written fast-check, proptest or Go-fuzz benchmarks were found, so TypeScript quality is an assumption until the week-4 measurement.

### Reuse vs build

| Reuse (do not rebuild) | Build (the actual product) |
|---|---|
| Hypothesis, fast-check, mutmut/Stryker, CrossHair, ESBMC-Python, Kani | Claim data model, ledger file, status derivation |
| agentic-pbt prompts and triage rubric ([repo listing](https://www.claudepluginhub.com/marketplaces/mmaaz-git-agentic-pbt)) | Template-driven proposer tuned for *plans*, not just modules |
| Lean 4 toolchain, `grind`, `mvcgen`, lean-egg, LeanHammer, lean-lsp-mcp, lean4-skills | Fixed theorem shapes, the model-vs-code differential harness, axiom gate, writer enumeration |
| Plannotator's non-blocking `ExitPlanMode` pattern | The card UI (pane, HTML fallback, PR comment renderer) |
| Claude Code hooks (`async`, `asyncRewake`) | One-action re-plan protocol (claim edit → structured message → dependent-step re-plan) |
| | Per-class false-positive meter with auto-demotion; cost estimator |

### Integration options (do not over-commit; the engine is a CLI + MCP server, and every UI is a thin client)

| Option | What it gives | Known limits | Status |
|---|---|---|---|
| **Settings hooks: `PostToolUse` on Edit/Write, `Stop`** | Trigger falsification on every edit or turn end | Command hooks default to 600 s | Verified in docs ([hooks ref](https://code.claude.com/docs/en/hooks)) |
| **`async` / `asyncRewake` command hooks** | Background runs. `asyncRewake` wakes Claude on exit 2 with stderr as a system reminder, which is how a Broken card reaches Claude without the user doing anything | No timeout enforced on `async` | Verified ([hooks ref](https://code.claude.com/docs/en/hooks)) |
| **`PreToolUse` / `PermissionRequest` on `ExitPlanMode`** | Plan gate. Can allow, deny or ask, or rewrite input | Whether `PreToolUse` matches `ExitPlanMode` was **not confirmed**; test it with a logging hook. Plannotator's hook mode uses `PermissionRequest` matched on `ExitPlanMode` ([Plannotator](https://docs.plannotator.ai/open-source/agents/claude-code.md)) | Partly verified |
| **Mod with pane** | Live sidebar cards, buttons, `tool.call` on `ExitPlanMode`, `$.process.spawn` for long jobs | Panes don't render in `claude -p`, the SDK or cloud sessions. They open on their own only in terminals ≥144 columns. Not sandboxed. `$.model.complete` spends the user's quota ([Mods overview](https://code.claude.com/docs/en/plugins/mods/overview.md); [interface](https://code.claude.com/docs/en/plugins/mods/interface.md)) | From earlier notes; reference page not fetched |
| **MCP server** | `propose_claims`, `check_claim`, `get_ledger`, `revise_claim`. Works in any MCP-capable agent | No UI of its own | Standard |
| **Localhost HTML panel** | Works everywhere, including the SDK and cloud. Same card renderer | Separate window | Build |
| **PR bot / GitHub check** | Diff-time surface with the best adoption evidence | Post only Broken cards with a counterexample and mutation-validated tests, plus one collapsed "intent questions" comment | Build |

> **Flag: unverified "10 s mod hook limit" discrepancy.** The earlier background report states that mod hooks have a **10 s limit on their own CPU time** (waiting on API calls exempt), citing the mods API docs ([Mods API](https://code.claude.com/docs/en/plugins/mods/api.md)). This session's technical notes fetched the **settings-hooks** reference instead. There, `command`/`http`/`mcp_tool` hooks default to **600 s**, `prompt` to 30 s and `agent` to 60 s, and 10 s applies only to `MessageDisplay` ([hooks ref](https://code.claude.com/docs/en/hooks)). The most likely reconciliation is that these are two separate systems with separate limits: mod JS handlers get ~10 s of CPU, while settings command hooks get 600 s. The mods limits reference page was **not fetched in either session**, so treat 10 s as unverified. The design does not depend on it either way: the hook only snapshots and returns, and all real work runs in a spawned or detached process.

## Design rules that adoption evidence forces

| Rule | Evidence | How the Ledger applies it |
|---|---|---|
| **Surface findings at diff or plan time, never in a batch dashboard** | Meta: batch fix rate ~0%, diff time over 70%, same analysis ([CACM 2019](https://6826.csail.mit.edu/2020/papers/facebook-infer-cacm.pdf)). FindBugs dashboard: 16% fix rate ([Google CACM](https://6826.csail.mit.edu/2020/papers/google-analysis-cacm.pdf)) | Cards appear on the live plan or diff only. No repo-wide report view in v1 |
| **Keep effective false positives under 10% per claim class** | Tricorder's admission bar is <10% effective FP, with a ~5% overall rate. Analyzers whose "Not useful" clicks exceed 10% are disabled ([SWE at Google](https://abseil.io/resources/swe-book/html/ch20.html)) | [Not useful] on every card. Auto-demote any `kind` above 10% to hidden or Intended? |
| **Never show bare warnings** | "Bugs get fixed. False positives don't. Over time, FP rate approaches 100%" ([Coverity deck](https://www.doc.ic.ac.uk/~livshits/classes/CO444H/reading/AndyChou_coverity.pdf)) | A Broken card requires a counterexample. Anything weaker becomes Intended? or stays hidden |
| **Counterexample first, then a fix** | 10 of 29 verification users want counterexamples ([arXiv 2510.20514](https://arxiv.org/html/2510.20514v1)). Shrinking is "necessary" at Jane Street. Autofix: 28 min median to fix vs 1.5 h ([GitHub](https://github.blog/news-insights/product-news/secure-code-more-than-three-times-faster-with-copilot-autofix/)) | Shrunk input at the top of the card. One-click Apply fix |
| **Post less than generic AI reviewers** | 12 of 13 code-review agents averaged <60% signal (Copilot 19.8%). PRs reviewed only by an agent merged 45% vs 68% ([arXiv 2604.03196](https://arxiv.org/html/2604.03196v1)) | Cap of about 7 cards per plan. Comment only with machine-checked evidence |
| **Predictable cost, shown before deep runs** | Kiro priced spec requests at 5× vibe requests, users called it "wallet-wrecking", and AWS reset limits ([The Register](https://www.theregister.com/2025/08/18/aws_updated_kiro_pricing/)) | Flat default lane (tiers 0–2 on the diff only). The Lean tier shows "~N min, ~$X" before running. Per-session cap |
| **Latency inside the tolerance band** | PBT budgets in practice run from 50 ms to 30 s ([ICSE 2024](https://cis.upenn.edu/~bcpierce/papers/icse24-pbt-in-practice)). Diff bots need 15–20 min at most | Inline ≤30 s, background ≤10 min, PR ≤20 min. Lean runs offline if it goes over |
| **Use developer-native framing** | AWS built P because engineers struggled with TLA+ ([ACM Queue](https://queue.acm.org/detail.cfm?id=3712057)) | English first, math collapsed, Lean never required reading |
| **Use independent oracles, not self-written tests** | "Write more tests" prompts didn't change SWE-bench outcomes ([arXiv 2602.07900](https://arxiv.org/abs/2602.07900v1)). PBT feedback gave +23–37% relative pass@1 ([arXiv 2506.18315](https://arxiv.org/html/2506.18315v1)) | Properties and differential models, not example tests |

## Evidence base

| Claim | Number | Strength | Source |
|---|---|---|---|
| Agentic PBT finds real bugs cheaply | 984 reports, 100 packages, 56% valid (86% of top-ranked), $5.87 per module, ~$9.93 per valid bug, 8.8 min and 2.37M tokens per module | Moderate | [arXiv 2510.09907](https://arxiv.org/html/2510.09907v1) |
| Frontier models recall most injected bugs with PBT prompts | Sonnet 4.6 83.4%, Opus 4.8 in Claude Code 78.6%; 39.3% with an open prompt | Moderate (Python only) | [PBT-Bench](https://arxiv.org/pdf/2605.15229) |
| AI code has more defects in incident-heavy classes | 1.7× issues per PR; error handling ~2×, concurrency ~2×, logic ~1.75× | Weak–moderate (vendor) | [CodeRabbit](https://coderabbit.ai/blog/state-of-ai-vs-human-code-generation-report) |
| Error handling dominates catastrophic failures | 92% of catastrophic failures; 77% reproducible by unit test | Strong | [Yuan et al. summary](https://blog.acolyer.org/2016/10/06/simple-testing-can-prevent-most-critical-failures/) |
| Azure high-severity incidents | 31% error handling, 21% data format, 13% timing | Strong | [Liu et al. summary](https://blog.acolyer.org/2019/06/21/what-bugs-cause-cloud-production-incidents/) |
| Review, not generation, is the bottleneck | Experienced developers 19% slower with AI | Strong design, small n | [METR via InfoQ](https://www.infoq.com/news/2025/07/ai-productivity) |
| Developers struggle with "almost right" output | 66% struggle; 46% distrust AI accuracy | Strong survey | [ShiftMag on SO 2025](https://shiftmag.dev/stack-overflow-survey-2025-ai-5653/) |
| Generating tests from a spec beats retrofitting conformance | 4,913 generated tests, 100% branch coverage vs 21% handwritten; trace checking failed after ~10 weeks | Strong | [MongoDB](https://mongodb.com/blog/post/engineering/conformance-checking-at-mongodb-testing-our-code-matches-our-tla-specs) |
| Proofs unlock performance work | RSA on Graviton2 up to 94% faster (HOL Light); Aurora commit 2 → 1.5 round trips | Strong | [ACM Queue 2025](https://queue.acm.org/detail.cfm?id=3712057) |
| A proved invariant plan wins in competition | hargup #1, 280k users; feed 16.7 → 5.4 µs; ~950 lines of Lean spec, 512 lines of generated C | Primary (local rebuild) | [Leaderboard](https://benchmarks.arjaythedev.com) |
| Spec faithfulness is the bottleneck | Opus 4.6 51.1% faithful first try; 9.4% residual drift after repair | Moderate | [Verus-SpecGym](https://arxiv.org/abs/2605.26457); [Roundtrip](https://arxiv.org/abs/2604.25031) |
| Lean automation is fast enough for a background tier | LeanHammer 6.6 s mean per goal, ~30–40% Mathlib | Moderate | [arXiv 2506.07477](https://arxiv.org/html/2506.07477v1) |
| Repository-level proof is not yet credible | Verus 13–40% at repo level vs over 90% at function level | Moderate | [arXiv 2509.25197](https://arxiv.org/pdf/2509.25197); [arXiv 2409.13082](https://arxiv.org/abs/2409.13082v1) |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| False-discovery rate (30–58% raw) leaks into cards and the tool loses credibility | High without the gate | Require counterexample + mutation gate + ranking. Per-class auto-demotion at 10% |
| Token cost: agentic PBT used ~2.4M tokens per module | High | Scope to the diff. Cheap model for tiers 0 and 1c. Cache claims per symbol across commits. Show cost up front |
| Misformalized math that "proves" the wrong thing | Medium | Model-vs-code differential test. Fixed theorem shapes. Second-model back-translation to English. Axiom gate |
| Closed-world invariants break outside the repo (migrations, other services) | Medium–high for the Lean tier | Writer enumeration. Mandatory guard + fallback. Default to "Guarded", not "Proved", when external writers are possible |
| Panel ignored: users stop reading cards | Medium | Cap card count. Make Broken cards actionable. Measure confirm time and action rate from day 1 |
| Mods surface is new and unsandboxed | Medium | Engine stays CLI + MCP. Mod is a thin client. HTML panel fallback |
| A funded player (Harmonic, Axiom, AWS Kiro) ships the UX layer | Medium | Open data model and MCP-first design, so the Ledger can front their provers |

## Strongest objection and reply

**Objection:** "This is Kiro with a sidebar. Novices won't read math, experts won't trust LLM-written claims, and the Lean tier will almost never fire. What's left is agentic PBT with extra UI and extra tokens."

**Reply:** Four things are genuinely different.

- **The unit of review is a 25-word claim, not a diff.** That targets the measured bottleneck: review time and "almost right" output, with a 19% METR slowdown and 66% struggling with near-misses. Correcting a claim re-plans Claude *before* code exists. Kiro starts from written requirements and stops before proof by its own docs.
- **The claims are anchored to code and run at any lifecycle stage.** It works on a hotfix in a 5-year-old repo just as well as on a greenfield spec.
- **The Lean tier is rare by design, and that is fine.** Its job is *permission*: it lets Claude apply invariant-dependent rewrites that a careful engineer would otherwise refuse, as in hargup's 3.1× feed plan. When it doesn't apply, the user pays nothing for it.
- **The "extra UI" is the false-positive control system itself.** [Not useful], Intended? and per-class demotion are what kept Tricorder at ~5% effective false positives.

**Concession:** if week-2 testing shows novices confirm cards without reading them, the English row is decoration. The product then collapses to candidate #2, the diff-time bot, which is still worth shipping.

## One non-obvious way this could be wrong: proof theater

The claims that are easy to state as clean math, such as round-trip, idempotence and bounds, are also the ones least likely to be wrong in practice. The bugs that actually cause incidents are error handling (92% of catastrophic failures), data-format drift (21% of Azure incidents) and cross-node races (13%). These involve effects, I/O and timing, and they resist pure statements. The real risk is a panel full of green "Proved" and "Tested" badges on trivial algebra while the real failure sits in an unclaimed `except:` block. That would be worse than no tool, because it adds false confidence to the 46% who already distrust AI output. **Test for it directly:** replay 50 historical bug-fix commits. Run the Ledger on the parent commit and measure what fraction of the real bugs a surfaced claim would have caught. If that is below ~20% while the panel shows mostly green, the proposer is optimizing for provability, not risk. Fix it with a per-bug-class quota so every plan that touches I/O must carry at least one error-path or crash-freedom claim.

## 4-week build plan

| Week | Build | Measurable success metric (pass/fail) |
|---|---|---|
| **1. Engine core (Python)** | Ledger schema and JSONL. Template proposer. Hypothesis writer with the PBT-Bench prompt and an `assume` lint. Mutation gate with mutmut. Triage ranker. CLI `ledger check <diff>` | On 30 PBT-Bench problems: **recall ≥70%**, and **≥90% of surfaced Broken cards are valid** on a hand-labeled sample of 50. **Median ≤5 min and ≤$2 per changed module** |
| **2. Panel and one-action re-plan** | Card renderer (mod pane plus a localhost HTML fallback). Logging hooks to confirm whether `ExitPlanMode` matches `PreToolUse`, `PermissionRequest` or a mod `tool.call`. `asyncRewake` delivery. Edit/Reject → dependent-step re-plan | With 6 users (3 novices, 3 experts) on 5 seeded tasks: **median time to confirm or reject a card ≤15 s**. **Novices catch ≥2 of 3 deliberately wrong claims** (the rubber-stamp test). **Claim edit to revised plan in 1 action, ≤60 s** |
| **3. Bounded + Lean tiers** | CrossHair/ESBMC-Python tier. Lean model extraction with a differential harness. Fixed theorem shapes. Proof ladder via lean-lsp-mcp. Axiom gate. Writer enumeration. **Acceptance test: re-derive hargup blind** (give it Model.lean and the reference SQL only) | Proposes dense ∧ mono, proves `feedPlan_eq` and `inv_addPost` with **standard axioms only**, reproduces **≥2.5× feed speedup**, within **≤$20 and ≤2 h**. **Zero "Proved" badges issued without a passing differential test** across all runs |
| **4. Field trial + PR bot + TS stub** | GitHub check that posts Broken cards only. fast-check + Stryker for TS (tiers 0–1b). Proof-theater replay on 50 historical bug-fix commits | On ~20 real PRs at random lifecycle stages: **effective FP ≤10%** (dismissed or ignored Broken cards). **≥1 maintainer-confirmed real bug per 10 PRs.** **Median ≤$3 per PR.** Replay: **≥20% of historical bugs caught by a surfaced claim** |

**Kill or pivot criteria:**

- If week 2 fails the rubber-stamp test, drop the English-review promise and ship the week-4 PR bot alone.
- If week 3 fails at choosing the invariant, position the Lean tier as "proof-gated application of tricks Claude already suggests", with a human picking the invariant.
- If week 4 FP stays above 20%, the triage gate is not good enough. Narrow `kind` to round-trip, differential and crash-freedom only.

## Conclusion

The winning move is not a better prover. Provers are now funded at unicorn scale and will keep improving on their own. The winning move is a **review surface that turns rigor into 15-second decisions**. Claude states claims, machines attack them, and the human only adjudicates intent and counterexamples. The evidence says rigor gets adopted when it arrives at the moment of change, speaks the developer's language, and is almost never wrong. None of the current peers combines all three with an agent that can be corrected in one action.

Two outcomes will decide whether this is a product or a demo. The first is the week-2 rubber-stamp test: can novices actually catch wrong claims? The second is the week-4 replay: do surfaced claims overlap with the bugs that really happen? Both can be measured in a month, and both are cheap to fail.

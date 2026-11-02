# Build one quiet math companion on others' work

**Verdict: build one open-source plugin, working name "Ledger", in three layers. Layer 1 is a portable Skill: five plain-English questions plus a maths router and strict silence rules. Layer 2 is a set of tool recipes: Z3, OR-Tools, simulation and Hypothesis inside Claude's code execution, with Lean reached through a local or hosted MCP connector. Layer 3 is a Claude Code mod: a side pane of cards, an opt-in gate on plan approval, background checks and a facts file. Every result is labelled with TheoricLabs' four evidence classes (Proved / Checked / Assumed / Open). Midspiral's claimcheck verifies that the math says what the English says. hargup's Model → Invariant → Plan → Emit method is the template for the rare proof-worthy case. Confidence: 7/10.** Three things hold it below 10. First, the hands-on LemmaScript/lemmafit/claimcheck trial did not finish, so no notes exist from actually running Midspiral's tools here. That trial is the first verification step. Second, the coverage numbers below are reasoned estimates, not measurements. Third, no study yet shows that non-experts can reliably judge plain-English readings of formal claims, and that judgement is the human's whole job in this design. The opportunity is real. The Skill layer reaches every Claude plan from Free to Enterprise wherever code execution is on ([Claude Help](https://support.claude.com/en/articles/12512180-use-skills-in-claude)). Roughly 25–45% of coding plans have a logic core where an invariant plus a property test pays off. Across six industries, real 2025–26 bugs show the same pattern: one plain question ("what must never happen?") followed by a cheap machine check would have caught the bug before the PR.

## What Midspiral and TheoricLabs actually ship

Both groups publish in the open and mostly under MIT. Both are small: Midspiral is essentially Nada Amin plus Fernanda Graciolli with active outside contributors, and every public TheoricLabs commit is by Harsh Gupta. Neither group publishes funding information. Their strengths fit together without overlapping. Midspiral owns **"does the proof mean what the human meant?"** TheoricLabs owns **"how do you keep claims honest and stage the modelling?"**

### Midspiral (and Nada Amin's metareflection org)

| Tool | What it is | State (Nov 2026) | License | Reuse verdict |
|---|---|---|---|---|
| **LemmaScript** (`lsc`) | Annotated TypeScript (`//@ requires/ensures/contract`) compiled to Dafny or Lean 4 (via Velvet 2). About 22 greenfield and brownfield case studies, including 4 hono CVEs and an overflow found in rallly at ≥1,000 votes ([README](https://github.com/midspiral/LemmaScript/blob/main/README.md)) | v0.6.5, "Tech Preview", last commit 2026-10-30, external PRs merged | MIT | **Depend on it** for the TypeScript proof tier. The `//@ contract` + requires/ensures triple maps almost 1:1 onto an English / math card |
| **claimcheck** | A cheap model back-translates each formal claim into English *without seeing the requirement*; a stronger model then compares the two. Benchmark: **two-pass 96.3% vs Claude Code-as-judge 69.4%** on 36 pairs ([README](https://github.com/metareflection/claimcheck/blob/main/README.md)) | v0.6.1, last commit 2026-10-28 | MIT (© metareflection) | **Depend on it.** This is the "is this what you mean?" engine. It has no Lean preset yet, so add one upstream |
| **lemmascript-claimcheck** | Compares a function's `//@ contract` with its spec. Statuses: confirmed / disputed / **gap** ([README](https://github.com/midspiral/lemmascript-claimcheck/blob/main/README.md)) | v0.2.1 | MIT | Reuse the **gap** status: an English promise with no formal backing |
| **lemmascript-crosscheck** | Runs the verified model and the shipped JS side by side on proof-valid inputs, then shrinks mismatches. "NO ISSUE FOUND… is not a proof" ([README](https://github.com/midspiral/lemmascript-crosscheck/blob/main/README.md)) | v0.1.0, Dafny only | MIT | Reuse the idea: check the model against the real code |
| **lemmafit** | Dafny-first greenfield tool. Its hooks are SessionStart, UserPromptSubmit and PostToolUse(Write\|Edit), plus a SPEC.yaml diff queue. **No ExitPlanMode hook** ([cli/sync.js](https://github.com/midspiral/lemmafit/blob/main/cli/sync.js)) | v0.3.5, dormant since 2026-06-02 | MIT | **Fork the hook pattern**, not the product |
| **lemmascript-skills** | SKILL.md folders "readable by any agent harness" ([README](https://github.com/midspiral/lemmascript-skills/blob/main/README.md)) | Last commit 2026-10-31 | **No LICENSE found** | Ask before reusing |
| Run log design | A "catch" is counted mechanically (a fail followed by a pass) because "asking the agent to keep a tally… does not give honest counts" ([DESIGN_RUN_LOG](https://github.com/midspiral/LemmaScript/blob/main/DESIGN_RUN_LOG.md)) | Design doc | MIT | Copy the principle for Ledger's own metrics |

Their docs say plainly that proof review is "LLM-as-judge… does rely on trust in the LLM" ([Quorum tutorial](https://github.com/midspiral/LemmaScript/blob/main/site/src/content/docs/tutorials/quorum/05-proof-review.md)). The stated roadmap covers brownfield support, agent-agnostic tooling, deterministic audits and "lemmacore" ([newsletter](https://buttondown.com/midspiral/archive/update-lemmascript-discord-bugbash-and-more/)). Ledger should feed that roadmap, not race it.

### TheoricLabs (Harsh Gupta, @hargup13)

| Piece | What it is | License | Reuse verdict |
|---|---|---|---|
| **lean-derive** (challenge submission) | About 950 lines of dependency-free Lean 4.35.0 split into Model / Invariant / Plan / Contract / Schema / Emit. It proves `feedPlan_eq : Inv db → feedPlan = feed` and emits C, with a runtime invariant guard and a SQL fallback. "The plans are proved against the model; the C emitted for them is tested, not proved" ([submission](https://github.com/arjaythedev/twelve-dollar-server-challenge/tree/main/submissions/lean-derive-hargup)) | MIT (© arjaythedev and challenge contributors, [LICENSE](https://github.com/arjaythedev/twelve-dollar-server-challenge/blob/main/LICENSE)) | **Reuse as the method template** for the proof tier |
| **Evidence classes** | Every claim is Proved / Checked / Assumed / Open. "Proved" requires an axiom audit (no `sorry`, standard axioms only). Tables are generated from a Lean registry, so prose cannot overclaim ([leanapi](https://github.com/theoriclabs/leanapi)) | Idea free to use; leanapi **code is BSL 1.1** | **Adopt the vocabulary; re-implement it, don't copy the scripts** |
| **Staged modelling** | Stages: 0 Cut → 1 Facts (each sentence tagged prior / derived / observed) → 2 Vocabulary → 3 Lean model → 4 Userflow. "Stage n does not start while stage n−1 fails"; missing pieces live as named `Spec` definitions, "not axioms" ([leanchess](https://github.com/theoriclabs/leanchess)) | MIT | **Reuse** as the question-to-model ladder |
| **check_blog.sh** pattern | Every Lean block in prose is checked as excerpt / signature / compile ([leanapi](https://github.com/theoriclabs/leanapi)) | BSL (re-implement) | Reuse the idea: cards may only quote real theorem signatures |
| LeanDB, leanhttp, leanws, leanontology, leancrypto | Small Lean libraries, pre-1.0, Lean 4.33–4.34 | MIT | Optional. Not needed for v1 |
| **leanllm** | Multi-provider LLM client | **No LICENSE**; spoofs `claude-cli` identity headers | **Do not use** (legal and ToS risk) |

hargup's entry held **280,000 users, the top of the leaderboard at time of scoring (shared by several entries)**, scored 2026-10-28 ([LEADERBOARD.md](https://github.com/arjaythedev/twelve-dollar-server-challenge/blob/main/LEADERBOARD.md)). *Flag:* one research note records the entry as tied #1 and another as tied #2, so the exact rank needs re-checking. A local rebuild with Lean 4.35.0 took about 4 s (`lake build`), regenerated byte-identical C and used only the standard axioms. The proved feed plan cut the query from 16.7 µs to 5.4 µs.

### The best other tools to stand on

| Tier | Tool | Why |
|---|---|---|
| Falsify | Hypothesis + the `/hypothesis` Claude Code command; fast-check (TS); proptest (Rust) | Anthropic's agentic PBT produced 984 bug reports from 100+ packages. 56% were valid raw and 86% after ranking ([Anthropic](https://www.anthropic.com/research/property-based-testing)) |
| Solve / optimize | Z3, OR-Tools | Run in code execution on any plan. Best fit for "can the total ever go negative?" questions |
| Bounded check | Kani, CBMC/ESBMC, Apalache (TLA+) | Width-parameterized model checking turns a 4.29-billion-step test into a short counterexample (see F Prime below) |
| Proof | Lean 4 (`grind`, `mvcgen`), Plausible, **lean-lsp-mcp**, **lean4-skills** (`disprove`, axiom `checkpoint`) | lean4-skills installs with `/plugin marketplace add cameronfreer/lean4-skills`; lean-lsp-mcp exposes goals and search to agents ([lean4-skills](https://github.com/cameronfreer/lean4-skills); [lean-lsp-mcp](https://github.com/oOo0oOo/lean-lsp-mcp)) |
| Plan UI reference | **Plannotator** | Holds `ExitPlanMode`, has dual mod and settings-hook paths, MIT/Apache ([docs](https://docs.plannotator.ai/open-source/agents/claude-code.md)) |
| Hosted prover | Harmonic Aristotle | Now verifies C, Verilog and Rust only, and "does not verify pure mathematics or Lean-only projects"; runs take tens of minutes and cost credits ([README](https://github.com/harmonic-ai/aristotle)). At most an optional deep tier |

## Reuse map: what comes from whom

| Ledger piece | From | License | Role in Ledger |
|---|---|---|---|
| Four evidence labels + axiom audit rule | TheoricLabs (leanapi EVIDENCE.md) | Idea; code BSL 1.1, re-implemented | Every card's badge; derived from evidence fields, never free text |
| Staged ladder: facts → vocabulary → model → userflow | TheoricLabs (leanchess production_process.md) | MIT | How Ledger walks from an English answer to a formal model |
| Model / Invariant (+checker +soundness) / Plan / Emit + honest boundary | hargup lean-derive | MIT | Proof-tier template; "Assumed" facts become runtime-checked guards |
| Blind back-translation (two-pass) | Midspiral / metareflection claimcheck | MIT | The English row of every formal card; disputed → warning badge |
| **gap** status | lemmascript-claimcheck | MIT | Marks a promise with no formal backing as **Open** |
| TS → Dafny/Lean proofs | LemmaScript | MIT | Proof tier for TypeScript projects |
| Model-vs-code differential runs | lemmascript-crosscheck (idea), lean-derive (byte-identical tests) | MIT | Required before any "Proved" on code |
| SessionStart / UserPromptSubmit / PostToolUse hooks, spec queue | lemmafit | MIT | Settings-hook fallback where mods don't draw |
| Mechanical catch counting | LemmaScript run log | MIT | Ledger's own honest metrics |
| ExitPlanMode hold, detached long jobs | Plannotator | MIT/Apache-2.0 | Plan gate and background-job pattern |
| Property-inference prompts, triage | Anthropic agentic-pbt, `/hypothesis` | Open (check repo) | Checked tier for code |
| Lean plumbing | lean-lsp-mcp, lean4-skills | Check each repo | Proof tier, `disprove` for counterexamples |
| Claim DAG with plain-English descriptions | Anthropic FLT / Prove2Me (method) | Idea | Card dependencies and re-planning |

**Credit protocol.** Keep each upstream LICENSE in `THIRD_PARTY_NOTICES`. Add a README "Built on" section that names Midspiral (Nada Amin, Fernanda Graciolli), metareflection, and TheoricLabs/hargup, with links. Name the methods on the cards themselves, for example "check: claimcheck two-pass" and "method: lean-derive invariant guard". Contact both groups *before* launch: Midspiral through its Discord form or a newsletter reply, hargup through X or hargup.in ([newsletter](https://buttondown.com/midspiral/archive/pr100-a-workshop-and-coffee-in-sf/); [hargup.in repo](https://github.com/hargup/hargup.github.io)). Ask how they want to be described, and contribute upstream rather than fork: a Lean preset and JSON output for claimcheck are obvious first PRs. Don't name the product with a `Lemma` prefix (it would read as Midspiral's) or a `claude-` prefix, which `claude plugin validate` rejects ([Create](https://code.claude.com/docs/en/plugins/mods/create.md)).

## Who it helps: every plan can run the Skill, but only some get proofs

"Plans" has two meanings here, and both have limits.

### Claude subscription plans

| Surface / plan | Skill (5 questions + router) | Code-execution checks (Z3, Hypothesis, sim) | Lean | Mod (pane, gate) |
|---|---|---|---|---|
| claude.ai / Desktop: Free | Yes | Yes, if "Code execution" is on | Via **one** custom connector (Free limit) | No |
| Pro / Max / Ultra | Yes | Yes | Via custom connector | No |
| Team / Enterprise | Yes, unless an admin disables user skills | Yes, if org enables it | Via an org-added connector | No |
| Mobile apps | Unconfirmed in the docs | Unconfirmed | Remote connectors run from Anthropic's cloud "across every Claude client, including… the mobile apps" | No |
| Claude Code CLI / Desktop Code tab | Yes | Yes (local) | Local Lean or MCP | **Yes** (v2.1.287+) |
| VS Code panel, `claude -p`, cloud sessions | Yes | Yes | Yes | Hooks run, **nothing draws** |

Sources: Skills "are available for users on Free, Pro, Max, Ultra, Team, and Enterprise plans" and require code execution, and Team/Enterprise owners can turn off user-created skills ([Claude Help](https://support.claude.com/en/articles/12512180-use-skills-in-claude)). "Free users are limited to one custom connector" ([Claude Help](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)). For where mods draw, see the [Mods overview](https://code.claude.com/docs/en/plugins/mods).

**Why not all plans:**
- Code execution can be off, by the user's choice or the org's.
- Enterprise admins can block user skills, and under `allowManagedModsOnly` they can block user mods entirely. A policy mod can also refuse `$.process.run` ([Admin](https://code.claude.com/docs/en/plugins/mods/admin.md)).
- Lean with Mathlib is heavy. Whether it fits inside claude.ai's code sandbox is untested, so outside Claude Code the proof tier probably needs a hosted connector.

### Task plans (what people ask Claude to do)

| Share of coding plans (ESTIMATE) | What Ledger should do |
|---|---|
| **40–55%**: UI, layout, copy, config, glue | Stay silent |
| **25–45%**: a logic core where an invariant + property test pays off | Ask 1–3 questions, run cheap checks, show cards |
| **5–12%**: money, permissions, state machines, core algorithms, concurrency | Offer proof (Lean / LemmaScript / model checking) |

The estimate starts from Anthropic's usage data: 12% of coding conversations are UI/UX components, 8% are web and mobile app building, and JS/TS plus HTML/CSS make up 59% of language share ([Anthropic](https://www.anthropic.com/research/impact-software-development)). The rest is reasoning, shown in full in the coverage notes, and **no dataset measures this split directly**. For non-code work (budgets, schedules, creative writing, D&D world-building), the same router applies. Consistency of a timeline or a magic system is a constraint check. "How likely is this encounter?" is a probability simulation. "Can players reach the vault without the key?" is a graph search. All of these run in code execution on any plan. Their value is **untested** and should be measured in week 1, not promised.

## Six industries, real bugs: where one question plus one check would have helped

The ratings below are retrospective judgements: would the Ledger question have surfaced the issue, and would a cheap check have caught it before merge? Comment threads were not readable, so resolutions that depend on them are flagged.

| Industry | Case | What broke | Question that surfaces it | Check | Rating |
|---|---|---|---|---|---|
| **Space** | F Prime [#5082](https://github.com/nasa/fprime/issues/5082) → fix [PR #5834](https://github.com/nasa/fprime/pull/5834) | U32 command sequence counter wraps and collides with an outstanding ID; the reporter needed a 4,294,967,295-command test to find it | "Can two outstanding commands ever share an ID? Can the counter wrap?" | Model-check with a 4-bit counter: collision appears in under 20 steps | **High** |
| Space | cFE [#2707](https://github.com/nasa/cFE/issues/2707) (CVE-2026-5476 site 2) | `Offset + NumBytes` wraps to 0 on 32-bit `size_t` and passes the bounds check (out-of-bounds write). The issue is closed "completed", yet `main` at `3673163b` still sums. A guarded PR, [#2814](https://github.com/nasa/cFE/pull/2814), was closed unmerged | "Which word sizes? Never write outside the buffer" | Kani/CBMC or a Z3 bit-vector query | **High** |
| Space | F Prime [#5987](https://github.com/nasa/fprime/issues/5987) → [PR #6037](https://github.com/nasa/fprime/pull/6037) | Rollover set to the product of dividers (4.0e26), overflowing 64 bits; the LCM is 10,000 | "What should rollover minimize?" | LCM lemma + property test | Medium (an assert already guarded it) |
| **Defense / dual-use** | ArduPilot [#34670](https://github.com/ArduPilot/ardupilot/issues/34670) → [PR #34672](https://github.com/ArduPilot/ardupilot/pull/34672) | `~_configured_fences` sets bits 4–7, so code indexes past a 4-entry name table (ASan overflow, SITL segfault) | "What values can the fence mask hold? Can it change mid-flight?" | Kani over all 256 masks | **High** |
| Defense | ArduPilot [#34218](https://github.com/ArduPilot/ardupilot/issues/34218) | Rover outside the fence: RTL triggers, avoidance zeroes velocity, the vehicle sits forever | "After a breach, what must *eventually* happen?" | Liveness model check or randomized SITL scenario | Medium-High (fix unverified) |
| Defense | PX4 [#27099](https://github.com/PX4/PX4-Autopilot/issues/27099), [PR #27105](https://github.com/PX4/PX4-Autopilot/pull/27105) closed unmerged | Inclusion fences are intersected (AND) rather than united (OR) | "Where must the vehicle never be?" forces `(⋃ incl) \ (⋃ excl)` | Reference-predicate property test | **Limits case**: the spec was contested and maintainers marked it not planned. Value = an explicit decision record, not a "bug caught" |
| **Farming** | AgIsoStack++ [#634](https://github.com/Open-Agriculture/AgIsoStack-plus-plus/issues/634) → [PR #687](https://github.com/Open-Agriculture/AgIsoStack-plus-plus/pull/687) | ISOBUS SPN 962 quarter-day scaling decoded the wrong day | "What is the exact scaling and raw range?" | Exhaustive encode/decode round-trip (tiny domain) | **High** |
| Farming | AgIsoStack++ [#717](https://github.com/Open-Agriculture/AgIsoStack-plus-plus/issues/717) → [#718](https://github.com/Open-Agriculture/AgIsoStack-plus-plus/pull/718), [#834](https://github.com/Open-Agriculture/AgIsoStack-plus-plus/pull/834) | Partner control functions evicted on every address-claim roll-call: "permanently deaf" | "A transmitting partner must never be marked offline; what if a roll-call lands mid-session?" | Small TLA+ model or stateful PBT | Medium-High |
| Farming | OpenSprinkler [#417](https://github.com/OpenSprinkler/OpenSprinkler-Firmware/issues/417) | `%lu` with a 64-bit `time_t` on 32-bit Pi: logs dated 1969 | "Which platforms? How wide is time?" | `-Wformat` / clang-tidy | **Limits case**: a linter is the right tool, not math |
| **Marketing** | listmonk [#2070](https://github.com/knadh/listmonk/issues/2070), [#3022](https://github.com/knadh/listmonk/issues/3022) → [a729a4a](https://github.com/knadh/listmonk/commit/a729a4a6d635dabb75fa0ec53df25eec2e6f2285) | Pause/resume re-sends, or skips half the list; about three fixes over 18 months | "Never send twice, never skip; pause or crash can happen anytime" | Stateful PBT injecting pause/crash | **High** |
| Marketing | Mautic [#11586](https://github.com/mautic/mautic/issues/11586), [PR #11901](https://github.com/mautic/mautic/pull/11901) unmerged | "Send once" email sent twice when translations exist | "What counts as the *same* email?" | PBT over email trees | **High** |
| Marketing | Postiz [#1563](https://github.com/gitroomhq/postiz-app/issues/1563) | TikTok audit rejects UI defaults | Marginal | Checklist | **Limits case (Low)** |
| **Commerce** | Medusa [#14899](https://github.com/medusajs/medusa/issues/14899) → [PR #15532](https://github.com/medusajs/medusa/pull/15532) | Two stacked promotions → total −0.07; the class recurs ([#15919](https://github.com/medusajs/medusa/issues/15919), [#16996](https://github.com/medusajs/medusa/issues/16996)) | "Totals are never negative; which promos are tax-inclusive?" | Z3: "∃ promos with total < 0" | **High** (best solver fit) |
| Commerce | Invoice Ninja [#12231](https://github.com/invoiceninja/invoiceninja/issues/12231) → [PR #12230](https://github.com/invoiceninja/invoiceninja/pull/12230) | 11.85 + 18.35 > 30.20 in floats, so a valid full refund is rejected | "Never reject a refund equal to what was paid" | Hypothesis over decimal partitions | **High** |
| Commerce | Easy!Appointments [#1989](https://github.com/alextselegidis/easyappointments/issues/1989) (open) | "Any Provider" shows slots in the wrong timezone | "Is the time shown the time saved?" | Round-trip PBT with random TZ/DST | High (detection; no fix yet) |
| **Household** | Mealie [#8758](https://github.com/mealie-recipes/mealie/issues/8758) → [PR #8764](https://github.com/mealie-recipes/mealie/pull/8764); [#7518](https://github.com/mealie-recipes/mealie/issues/7518) → [PR #7537](https://github.com/mealie-recipes/mealie/pull/7537) | Duplicate foods scaled once (4 eggs, not 6); sub-recipes scaled twice | "Scaling by k multiplies everything by k, exactly once" | Linearity + composition property | **High** |
| Household | Actual Budget [#1062](https://github.com/actualbudget/actual/issues/1062) (open since 2023) | Monthly schedule on the 31st skips June | "What should happen on the 31st in a short month?" | Exhaustive 31 days × 24 months | High (it forces a stalled product decision) |
| Household | Firefly III [#11281](https://github.com/firefly-iii/firefly-iii/issues/11281) → [3711222f](https://github.com/firefly-iii/firefly-iii/commit/3711222f9e9ab2633dd56a6a288c36124cace8fa) | Webhook fired twice by cron | "Duplicate or drop: which is worse?" | Interleaving test | Medium-High |
| Household | Mealie [#7074](https://github.com/mealie-recipes/mealie/issues/7074) → [PR #7077](https://github.com/mealie-recipes/mealie/pull/7077) | 1/16 tsp renders as blank | Weak | Formatter test at most | **Limits case** |

The pattern across all six fields is **invariants that hold over whole numbers or sets but fail under machine integers, floats, timezones, pause/crash timing or an unmodelled variant**. The developer could answer Q1 in seconds. The value is the machine then generating the adversarial input nobody thought of. The cFE case adds a second lesson: an issue closed as "completed" while `main` still carries the pattern. A check run against the code, not against the discussion, would have flagged it. Several of these projects already credit AI in their PRs (F Prime #6037 and #5834; Skyfield [#1141](https://github.com/skyfielders/python-skyfield/issues/1141) says the reporter "had Claude dig into it"), so Ledger fits a workflow that already exists.

## What the AI-math frontier teaches, turned into design rules

| Lesson | Evidence | Ledger design rule |
|---|---|---|
| A single sign error can sink a cascade | OpenAI's bulk release ([repo](https://github.com/openai/math)): 721 manuscripts in 373 families, about 3 h of ChatGPT Pro thinking per result, ~4,000 problems posed. On Oct 7 it withdrew 3 manuscripts after a sign error broke one cancellation argument and two papers that depended on it; 14 more were revised ([Wikipedia](https://en.wikipedia.org/wiki/OpenAI_bulk_release_of_mathematical_papers)) | Cards form a **dependency DAG**. When one card turns red, every dependent card drops back to Open automatically |
| Formalize the headline, and check that the statement is the right one | 300 of 719 top-line results (~42%) were Lean-formalized; Comparator challenges check the formal *statements* ([Wikipedia](https://en.wikipedia.org/wiki/OpenAI_bulk_release_of_mathematical_papers)). Anthropic's FLT used a comparator against Mathlib's statement and only standard axioms ([Anthropic](https://www.anthropic.com/news/formalizing-fermats-last-theorem)) | "Proved" requires a kernel check, the axiom audit **and** a confirmed English reading (claimcheck + the human) |
| Big claims stay Open until outsiders verify them | "The Exponential Time Hypothesis is False" was added Oct 26 and is under review by a group led by Impagliazzo, Paturi and Williams ([Wikipedia](https://en.wikipedia.org/wiki/OpenAI_bulk_release_of_mathematical_papers)) | Model-generated proofs of surprising claims are labelled **Open** with "needs independent check", whatever the model says |
| Counterexample first, fixed prompt, failed attempts logged | The release's reasoning summary shows a fixed prompt ("complete rigorous solution… or rigorous refutation; brute force discouraged"), a counterexample search first, a literature survey, many failed attempts and a key reframing ([repo](https://github.com/openai/math)) | Router always tries to **break** a claim before proving it. Failed attempts go in the card's evidence drawer |
| Raw output is not a result; credit matters | OpenAI calls the outputs "raw research data, rather than polished academic papers" and defers on credit ([repo](https://github.com/openai/math)). Tao calls unreviewed output "toxic waste" and asks for transparency on resources and negative results ([Tao](https://teorth.github.io/tao-web/ai-views.html)) | Every card shows **cost, tools and credits** (which upstream method was used). Negative results are kept, not hidden |
| Math 2.0 is about understanding, not answers | Tao: "Math 1.0 → Math 2.0", centred on understanding and exposition rather than problem-solving alone ([Tao](https://teorth.github.io/tao-web/ai-views.html)) | The English row is the product. Math is collapsed by default, with a "why this is true" line |
| Open, inspectable tooling | The IAS Advisory Group on Mathematics and AI (nine members, including Gowers, Hairer, Wood and Witten) asked people to stop testing on proprietary models ([Science](https://www.science.org/doi/10.1126/science.aen3894); [TechCrunch](https://techcrunch.com/2026/10/08/openais-math-solutions-arent-meeting-the-fields-standards-yet/)) | Free, local-first, open checkers. Ledger's evidence never depends on a closed model; Lean, Z3 and Hypothesis are the arbiters |
| Most model "solutions" are wrong or answer the wrong question | Aletheia: 68.5% of graded answers fundamentally flawed; 50 of 63 "correct" ones answered a misread statement ([arXiv 2601.22401](https://arxiv.org/html/2601.22401)) | The first question is always **"is this what you mean?"**, shown as a blind back-translation |
| A weakened theorem passes the grader | Claude Code proved "if A is zero then B is zero" when A = B was required (arXiv 2606.13925, via [yage.ai](https://yage.ai/share/tao-lean-formalization-credibility-en-20260623.html)); claimcheck catalogues tautology-by-extra-`requires` ([GOTCHA.md](https://github.com/metareflection/claimcheck/blob/main/GOTCHA.md)) | The engine fixes theorem shapes; claimcheck's `weakeningType` becomes a red badge |
| State management beats raw agent power | FLT: "plain agent coordination failed" until a DAG of statements, each with a natural-language description, took over ([Anthropic](https://www.anthropic.com/news/formalizing-fermats-last-theorem)) | The facts file *is* that DAG: English, math, status, dependencies |
| Separate generator and checker | Erdős #728: GPT-5.2 Pro produced the idea, Harmonic's Aristotle produced the Lean certificate ([arXiv 2601.07421](https://arxiv.org/html/2601.07421v5)). Price's loop used a fresh checking instance; telling the model a problem is open hurts ([Quanta](https://quantamagazine.org/why-the-legendary-erdos-problems-are-falling-to-ai-20260803)) | Checks run in a fresh context or in tools, never in the generating conversation. Never frame a task as "hard/open" |
| Formality is expensive | AxiomProver: a few-paragraph Putnam proof became 2,054 Lean lines and 518 minutes ([Axiom](https://axiommath.ai/research/from-seeing-why-to-checking-everything)) | Proof is opt-in, with the estimated cost shown first. Default to Checked |
| Literature beats invention | Aletheia: 9 of 13 meaningful results were known or rediscovered ([arXiv 2601.22401](https://arxiv.org/html/2601.22401)) | Router asks "is this already a known library or theorem?" and searches Mathlib/Loogle before proving |

## The product spec

### Three layers, one data model

| Layer | Runs where | What it does | Built from |
|---|---|---|---|
| **1. Skill** (`SKILL.md`) | claude.ai, Desktop, Claude Code, any harness that reads skills | Decides whether to speak. If yes, asks up to 3 of the 5 questions, routes to the right math, writes cards as Markdown | TheoricLabs staged modelling; FLT DAG idea; Ledger question set |
| **2. Tools** | Code execution (any plan) or local CLI; Lean via lean-lsp-mcp locally or a hosted MCP connector | Z3/OR-Tools, Hypothesis/fast-check, Monte Carlo, small model checks, Lean, LemmaScript, claimcheck | Upstream tools, unchanged |
| **3. Mod** | Claude Code CLI + Desktop Code tab | Pane of cards, opt-in ExitPlanMode gate, background jobs, `.claude/ledger/facts.jsonl` | Plannotator patterns; lemmafit hooks as fallback |

### The five universal questions and the maths router

| # | Plain-English question | Math it routes to | Typical tool |
|---|---|---|---|
| Q1 | What must never happen? | Logic / invariants / proof | Property test → Lean or LemmaScript |
| Q2 | What are the hard limits? | Constraints, bounded integers, word sizes | Z3, Kani/CBMC, OR-Tools feasibility |
| Q3 | What should be as big or small as possible? | Optimization | OR-Tools, LP/MIP, or an evaluator loop |
| Q4 | What's uncertain, and how sure are you? | Probability / simulation | Monte Carlo, Bayesian estimate |
| Q5 | Does order or timing matter? | Scheduling, interleavings, liveness | TLA+/Apalache, stateful PBT, SITL scenarios |

The router follows the frontier lessons in a fixed order. **(a)** Restate the claim and show a blind back-translation ("is this what you mean?"). **(b)** Look for a known result or library. **(c)** Try to break it cheaply. **(d)** Only then offer a proof. Questions are picked to split the candidate interpretations, not to fill a form. Selecting questions by expected information gain over candidate solutions beats generating questions directly ([arXiv 2502.04485](https://arxiv.org/abs/2502.04485)). A separate "should I ask?" step raised resolve rates on underspecified SWE-bench from 54.8% to 69.4%, close to the 70.8% achieved with a full spec ([alphaXiv 2603.26233](https://www.alphaxiv.org/abs/2603.26233)).

### Card layout

```
┌─ #3 · checkout/discount.ts:applyPromos · plan step 2 ─────────────── [CHECKED] ┐
│ ENGLISH   The cart total never goes below $0, whatever promotions are stacked. │
│ YOU MEANT ✓ confirmed (claimcheck: "for all promo sets, total ≥ 0")            │
│ MATH  ▸   ∀ cart, promos. total(apply(cart, promos)) ≥ 0                       │
│ HOW  ▸    1 ✓ Z3: no counterexample over linear promo formulas     0.4 s        │
│           2 ✓ fast-check: 2,000 random carts × tax modes            1.1 s        │
│           3 ○ Proof available (LemmaScript → Dafny) · est. 3 min · [Run]         │
│ ASSUMED   All promotion amounts are on one tax basis (guarded in code)         │
│ CREDIT    claimcheck (Midspiral/metareflection) · fast-check · Z3              │
│ [✓ Right] [✎ Edit English] [✗ Wrong → replan] [Not useful]                    │
└────────────────────────────────────────────────────────────────────────────────┘
```

| Label | Meaning shown on hover | Required evidence |
|---|---|---|
| **Proved** | A machine checked a proof, and the statement says what you meant | Kernel-checked theorem; no `sorry`; axioms ⊆ {propext, Classical.choice, Quot.sound}; claimcheck "confirmed"; for code, a passing model-vs-code differential run. Sub-label: *model* or *code* |
| **Checked** | Tried hard to break it and couldn't | N generated cases / solver UNSAT within bounds / simulation with stated confidence. Mutation score where code exists |
| **Assumed** | True only if this outside fact holds | A named hypothesis (e.g. "single writer"), plus a runtime guard where possible (lean-derive pattern) |
| **Open** | Stated but not yet supported | A named obligation; also every claimcheck **gap**, and any card whose dependency broke |

A failed check shows a red **counterexample banner** above the English, with the shrunk input and a one-click fix. The LLM never writes badge text; the label is derived from the evidence fields, as in leanapi's registry ("the tables cannot claim more than the checked theorems say").

A non-code example, D&D world-building: *"The party can't reach the vault without the moon key."* → graph reachability over the map → **Checked: found a path via the sewer (rooms 4 → 9 → 12)**. Same card, same labels, no Lean.

### Silence rules ("always on, but quiet")

| Rule | Why |
|---|---|
| Speak only when a logic core is detected: money, counts, time, permissions, limits, state, probability, scheduling, constraints | 40–55% of plans are UI/copy/config, where math adds nothing |
| At most 3 questions per plan, asked once, never repeated after a "skip" | The clarification study averaged ~3.06 questions per queried task ([Emergent Mind](https://www.emergentmind.com/papers/2603.26233)) |
| At most 5–7 cards; only red cards interrupt; green cards wait in the pane | 12 of 13 code-review agents averaged under 60% signal ([arXiv 2604.03196](https://arxiv.org/html/2604.03196v1)); noise kills adoption |
| No card without evidence; anything weaker stays hidden | Raw LLM property reports were only 56% valid ([Anthropic](https://www.anthropic.com/research/property-based-testing)) |
| "Not useful" on a card class demotes that class at >10% | Google's Tricorder disables analyzers whose "not useful" rate exceeds 10% ([SWE at Google](https://abseil.io/resources/swe-book/html/ch20.html)) |
| Plan gate is **off by default** (fail open); "strict mode" turns it on | Quiet beats blocking; strict mode suits money/safety repos |

### Token budget (design targets, to be measured)

| Moment | Budget | How |
|---|---|---|
| Idle | Skill description only in context | Skills load their body only when triggered |
| Triage per plan | 1 cheap classification call | `$.model.classify` on a small model in the mod; a one-line self-check in the Skill |
| Questions | ≤3 × ~170 tokens | Evidence: ~172 tokens per clarification query ([Emergent Mind](https://www.emergentmind.com/papers/2603.26233)) |
| Checks | Run in tools; return only the card (≤120 tokens each) | Solver/PBT output never enters the context in full |
| Proof | Opt-in, cost estimate shown before running | FLT took ~6B output tokens at scale ([Anthropic](https://www.anthropic.com/news/formalizing-fermats-last-theorem)); small claims must stay small |

Honest counterpoint: in that study, clarification raised cost per task from about $2.03 to $3.50 ([Emergent Mind](https://www.emergentmind.com/papers/2603.26233)). Ledger's bet is that the saving comes from avoided rework. That bet is unproven, so week 2 measures it.

## Publishing the mod today

A mod is an ordinary plugin whose `hooks/hooks.json` names one ES module exporting `register(on, options)`. It needs no build step and Claude Code v2.1.287+ ([Overview](https://code.claude.com/docs/en/plugins/mods); [Reference](https://code.claude.com/docs/en/plugins/mods/reference)).

### Checklist

| Step | Action | Source |
|---|---|---|
| 1 | Check `claude --version` ≥ 2.1.287 | [Overview](https://code.claude.com/docs/en/plugins/mods) |
| 2 | Repo layout: root `.claude-plugin/marketplace.json` → `plugins/ledger/` containing `.claude-plugin/plugin.json`, `hooks/hooks.json` (`"modules": ["./register.ts"]`), `hooks/register.ts`, `skills/ledger/SKILL.md`, `tests/*.test.ts`, `types/index.d.ts` | [Reference](https://code.claude.com/docs/en/plugins/mods/reference); [Admin](https://code.claude.com/docs/en/plugins/mods/admin.md) |
| 3 | Develop with `claude --plugin-dir ./plugins/ledger`. Read the generated `.claude-plugin/types/` for the `$.process.spawn` signature and the ExitPlanMode fields (`e.plan`, `e.planFilePath` are known only from Plannotator source). Gitignore that folder | [Create](https://code.claude.com/docs/en/plugins/mods/create.md) |
| 4 | Follow the static rules: write `$.ns.call` in full, no destructuring `$`, string-literal event names, relative imports only, no dynamic `import()` | [Create](https://code.claude.com/docs/en/plugins/mods/create.md) |
| 5 | Run `claude plugin validate ./plugins/ledger --strict` and `claude plugin test` | [Reference](https://code.claude.com/docs/en/plugins/mods/reference) |
| 6 | README: paste the validate `hooks:`/`calls:` output, the tested Claude Code version, how to disable, and the org caveats (`$.process` may be refused); add SECURITY.md and screenshots | [Create](https://code.claude.com/docs/en/plugins/mods/create.md); [Admin](https://code.claude.com/docs/en/plugins/mods/admin.md) |
| 7 | Bump `version` on every release (installs are cached by version) | [Create](https://code.claude.com/docs/en/plugins/mods/create.md) |
| 8 | Push a public repo. Users install with `/plugin install ledger@<marketplace>` after adding the marketplace (exact `marketplace add` syntax unverified). Optionally submit to Anthropic's directory and the awesome-claude-code-mods lists | [Overview](https://code.claude.com/docs/en/plugins/mods) |
| 9 | Ship the Skill separately as a zip for claude.ai users, and an MCP server for other agents | [Claude Help](https://support.claude.com/en/articles/12512180-use-skills-in-claude) |

### Feature → API mapping

| Feature | API | Limit / caveat |
|---|---|---|
| Card pane | `on('ui.render', { component: 'Pane' })`, `$.ui.open`, `Box/Text/Markdown/Button` | Opens unprompted only at ≥144 columns; no tabs element ([Interface](https://code.claude.com/docs/en/plugins/mods/interface.md)) |
| Status band | `AbovePrompt` render site; `$.ui.status` | Call `await next(e)` to keep other mods' band content |
| Questions | Native `AskUserQuestion` (via Skill) or `$.ui.ask(q, 2–4 options)` | Rejects in `-p` runs; "Chat about this" row rejects |
| Plan gate (opt-in) | `on('tool.call', { tool: 'ExitPlanMode' })` → `next(e)` or `{ deny }`; settings `PermissionRequest` fallback | Skip subagents (`e.agentId`); exit code 2 isn't honoured for PermissionRequest ([Hooks](https://code.claude.com/docs/en/hooks)) |
| Background checks | `$.process.run` (≤10 min), detached launch + `$.clock.every` polling (Plannotator), `$.prompt.submit` to wake Claude | Hook's own time limited to 10 s, but time spent awaiting `$` calls is free; `$.process` marked "CLI only" ([Reference](https://code.claude.com/docs/en/plugins/mods/reference)) |
| Cheap model calls | `$.model.complete` / `classify` / `fork` | "These calls use the user's plan or API key" ([API](https://code.claude.com/docs/en/plugins/mods/api.md)) |
| Facts file | `$.fs.write` to `.claude/ledger/facts.jsonl`; `$.store` for settings | 4 MiB per file and per store |
| `/ledger` command, `ledger_check` tool | `$.command.register`, `$.tool.register` | Tool appears to Claude as `mcp__<plugin>__<name>` |
| Fallback where nothing draws | `asyncRewake` settings hook; lemmafit-style PostToolUse `additionalContext` | `asyncRewake` wakes Claude on exit 2 ([Hooks](https://code.claude.com/docs/en/hooks)) |

What it would do on day one: during planning, ask at most three plain questions when a logic core appears. While Claude codes, run cheap checks in the background. Fill the pane with labelled cards, and keep a facts file that persists across sessions and travels with the repo. In strict mode, hold plan approval while a red card is unresolved.

## Pros, cons and what a developer can use right now

| Pros | Cons |
|---|---|
| One Skill reaches every plan tier; the mod adds depth only where it can draw | The mod is CLI/Desktop only, and nothing draws in VS Code chat, `-p` or cloud sessions |
| Builds on mature, free checkers (Hypothesis, Z3, Lean) and two active open-source groups | Mods are unsandboxed; cautious orgs may block `$.process` or all user mods |
| Honest labels make it safe to show novices | LemmaScript is a Tech Preview; claimcheck's benchmark is only 36 pairs |
| Real bug classes in six industries map to five questions | Every `$.model` call and every question costs the user's quota |
| Creative and household uses run with no install | Value for non-code domains is unmeasured |

**Utility today without Ledger.** A developer can already combine `/hypothesis` (Python PBT), lean4-skills + lean-lsp-mcp (Lean in Claude Code), LemmaScript (TS proofs), claimcheck (meaning check) and Plannotator (plan review). That is five installs, five vocabularies, and no shared labels or silence. **Ledger's contribution is the glue:** the questions, the router, the labels, the quiet policy and the cards.

## Paid service: keep the core free and validate before charging

**Recommendation: no paid tier at launch.** Ship the Skill, mod and MCP server free and open-source, and run a waitlist for a hosted add-on. Charge only if **50 individual users and 5 teams sign up within 2 months**.

| Candidate paid piece | Why someone would pay | Caution |
|---|---|---|
| **Hosted Lean/solver runner as an MCP connector** | It is the only practical route to the proof tier for claude.ai and mobile users (Free plans get just one custom connector). It also removes painful local toolchain installs | Lean versions drift across the ecosystem (4.33–4.35 in TheoricLabs alone) |
| Proof registry with signed attestations | Teams can show "this invariant was checked at commit X" in audits | Must never claim more than the labels allow |
| Team claim libraries | Reusable invariants per domain (money, ISOBUS SPNs, geofences) | The open-source core must stay fully useful without it |
| Compliance reports | For regulated buyers (finance, defense, ag safety) | Long sales cycles; not a solo-developer fit early |

Don't build a commercial layer that competes with TheoricLabs' BSL-licensed leanapi work or Midspiral's planned "lemmacore". Offer them integration, a revenue share or referral instead. Their work is the credibility behind Ledger.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Users rubber-stamp the English row | Medium-High | Plant wrong readings in tests; claimcheck's blind back-translation |
| False positives erode trust | High without gates | Counterexample required; mutation gate; per-class demotion at 10% |
| Token cost grows unnoticed | Medium | Budgets above; show cost on every card; triage stops most plans |
| Mods API changes between releases | Medium | Pin the tested version; Skill + MCP keep working regardless |
| Upstream projects pivot or stall (lemmafit already dormant) | Medium | Depend on published packages; contribute upstream; keep adapters thin |
| License mistakes (BSL, missing licenses) | Low if checked | Re-implement leanapi ideas; ask before using lemmascript-skills; never use leanllm |
| A funded player ships this UX | Medium | Open data model, MCP-first, credit-rich: be the community layer they integrate with |

## Strongest objection and reply

**Objection:** "This is a prompt with a sidebar. Claude already asks clarifying questions, most plans don't need math, and proofs are too expensive for everyday users."

**Reply:** The evidence says structure, not raw ability, makes the difference. A separate "should I ask?" step raised resolve rates from 54.8% to 69.4% ([alphaXiv](https://www.alphaxiv.org/abs/2603.26233)). claimcheck's structural two-pass design beat Claude Code acting as judge, 96.3% to 69.4% ([README](https://github.com/metareflection/claimcheck/blob/main/README.md)). Raw LLM property reports were only 56% valid until a ranking gate lifted the top reports to 86% ([Anthropic](https://www.anthropic.com/research/property-based-testing)). Ledger packages those structures. Proofs are deliberately rare. The default product is a question plus a cheap check, which is exactly what would have caught the Medusa, Invoice Ninja, Mealie and listmonk bugs. **Concession:** if week 3 shows users confirm cards without reading them, the English row is decoration, and Ledger should narrow to red-card-only alerts.

## One non-obvious way this could be wrong: verifying the summary, not the system

On claude.ai there is no repo. Checks run on *Claude's restatement* of the user's problem. A green "Checked" then certifies a model of the situation that Claude wrote, and that model may leave out the very dimension that breaks things: pause/crash timing in listmonk, translation variants in Mautic, a second writer in hargup's server. cFE shows the same failure among humans: an issue marked completed while the unguarded sum is still on `main`. Ledger could therefore *raise* confidence exactly where it is least earned: in non-code and chat contexts, which are the "any plan" reach the vision depends on. **Mitigation:** outside Claude Code, never show "Proved" or "Checked" without an "of: your description" qualifier. Every Assumed fact must be one the user typed or confirmed. Make "what did I leave out?" a standing sixth question whenever a card turns green.

## Four-week plan, one metric per week

| Week | Build | The one metric |
|---|---|---|
| **1. Verify + Skill** | **First:** run the hands-on LemmaScript/lemmafit/claimcheck trial that did not complete (install, run a case study, run claimcheck with Lean output). Re-check hargup's leaderboard rank. Write the Skill: five questions, router, silence rules. Build a labelled set of 40 prompts (code, household, D&D, marketing; half should stay silent) | **≥85% correct speak-or-stay-silent decisions on the 40 labelled prompts** |
| **2. Tools layer** | Code-execution recipes (Z3, Hypothesis/fast-check, simulation); lean-lsp-mcp path; claimcheck Lean preset (upstream PR). Replay 10 table cases on their parent commits (Medusa, Invoice Ninja, Mealie ×2, listmonk, F Prime #5082, cFE #2707, ArduPilot #34670, AgIsoStack #634, Actual #1062) | **Counterexample found in ≥7 of 10 replays, each ≤5 min and ≤$2** |
| **3. Mod** | Pane cards with the four labels, opt-in ExitPlanMode gate, background jobs, facts file, `/ledger` command; validate + tests | **Users catch ≥2 of 3 planted wrong English readings** (6 users, rubber-stamp test) |
| **4. Publish + outreach** | Public marketplace repo, Skill zip, README credits, messages to Midspiral and hargup, waitlist page; run on 20 real PRs | **Effective false-positive rate ≤10% across 20 real PRs** (cards dismissed as not useful) |

The 2-month waitlist goal (50 users / 5 teams) runs alongside as the go/no-go for the paid connector.

## Conclusion

The leverage is not a new prover. Midspiral already checks meaning, TheoricLabs already keeps evidence honest, and Lean, Z3 and Hypothesis already check the math. What nobody ships is a **quiet, plan-agnostic front door**: five questions any person can answer, a router that picks the right math, and four labels that never claim more than the machine did. Built openly on those groups' work with visible credit, Ledger turns their expert tools into something a Free-plan user planning a budget, a D&D campaign or a checkout flow meets without knowing it exists, until the moment it shows them the counterexample.

The frontier's lessons all point to one design constraint: **transparency is the feature**. A withdrawn sign-error cascade, a weakened theorem that passed its grader, Tao's call to publish costs and failures, and the IAS group's call for open tooling all say the same thing. Every Ledger card should show what was proved, what was only checked, what was assumed, what is still open, what it cost, and whose method did the work. Two cheap experiments decide whether this is a product: the week-1 trial of Midspiral's tools and the week-3 rubber-stamp test.

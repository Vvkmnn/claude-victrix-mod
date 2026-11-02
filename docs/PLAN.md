# Vada: follow and steer Claude's plan live, with maths behind the parts that matter

**Progress: 4/15 done** | Active: V1 the live lens, built here tonight (2026-11-03), installable from GitHub, then V0c handoff and the move to `~/Projects/claude-victrix`

Model/effort: Fable for tonight's build (owner switched 2026-11-03; credits); otherwise Opus @ high to build; Opus xhigh for the status lattice and guard rules (core) and proof packs; Sonnet for research and bench volume (same-model controls); haiku for file scans.

## Summary

Plans get too big for people to read and follow. Vada is a live panel in Claude Code that walks the plan as Claude works: where it is, what it just did, and the 3–5 assumptions that would change the plan if they flipped, each with its source and how well it is checked; you doubt one, add a fact, or say "wrong path" in one key, and see the plan change. Underneath, small tools (not long prompts, which lost to a 3-line prompt in V's ~60 runs) do the maths: mine what the real data contains, compare every shortcut against the obvious slow version, guard it, and build every idea worth 2×; labels can never be stronger than their weakest premise (proved in `Anka.lean`). The scary part is a readable plan that raises confidence without raising accuracy, so the panel asks for your information, not your approval. Nothing is built; the handoff's bench and kill criterion decide whether the maths layer earns its place.

```
 YOU                         VADA (Claude Code mod + tools)                   CLAUDE
 ───                         ──────────────────────────────                   ──────
 watch the live lens ◄────── plan + task list + actions (facts, not thoughts) ◄── plans, edits, runs
   3–5 load-bearing          Says / Because / Unless · source · status
   assumptions               status = min(own check, premises)   (Anka.lean T1)
 doubt · add data ·  ──────► step-tied context, plan diff, decision log ──────► re-check · replan · new branch
 wrong path                  tools: mine real data · obvious slow version = spec ·
                             differential + extreme fuzz · guard (T2) · build every ≥2× (hook) ·
                             best-of-N + strict judge · proofs via agent-formal-verify / lean4-skills
```

## Chunks (one line each; detail below the fold)

- [x] **V0 Repo, handoff and bench** — done 2026-11-03: `~/Projects/claude-victrix` (git init, `main`, nothing committed yet), 270 handoff + research files byte-identical (`cmp`), `CORE_RULES.md` at root, Apache-2.0 `LICENSE` (canonical text), `plugins/victrix` + marketplace pass `claude plugin validate`. Bench data check (`gen_data.sh`, ~1 GB, python3+node, no network) deferred into V2c by the owner ("demo first").
- [x] **V0a Research tools** — done 2026-11-03 by the owner + planning session: Agent Reach 1.6.1 with the X channel live through the throwaway "Eve" identity (OpenCLIApp 0.1.38, OpenCLI 2.0.2, Chrome profile "Claude"); `~/.agent-reach` is not sandbox-writable, so each call runs with the sandbox off (one prompt each). Reddit search still walled; keep the Reddit MCP for that. Never put a real identity into Claude's Chrome (owner rule).
- [x] **V0b Boris's method, primary sources** — read 2026-11-03 (Agent Reach twitter + fxtwitter media + video frames); verbatim text and the six video prompts are in Detail V0b. Left: write `research/boris.md` from that Detail at the start of V1 (first commit). agent-formal-verify hands-on moves to A6.
- [ ] **V1 The live lens, tonight, built from this session (owner 2026-11-03: "cool and working demo first, then sharp refinement"; "finish off that repo with a build I can install when we go over there")** — port emporium's `plan.ts`/`activity.ts`/`lens.tsx` into `plugins/victrix/hooks/` (copied with a header credit line), renamed `victrix`, restyled to the visual language (`⊢` sigil, labels ◆✓△○✗, theme keys only, flat `/diff` look); then the three top lines WANTS / WORLD / WHY (first from plan `## Summary`/`## Context` + `why:` tags, owner-editable via `a`), assumptions pulled from plan wording (`assume`, `assuming`, `should`, `probably`, `why:` tags) shown under their step with status △, and the verbs `d` doubt · `a` add data · `w` wrong path that queue a step-tied note delivered on `prompt.submit` (next step, never interrupting) and log one line to `$.store`. Since-you-left + WAITING FOR YOU are tomorrow. Dev loop (set up first, 20 min): `demo/lab.sh` copied from emporium (private tmux server `victrix-lab`, fixture plan = this plan file, `snap` = `capture-pane` screenshots I can read), `claude plugin validate` + `claude plugin test` on every change, `--debug-file` in the scratchpad, Desktop: owner runs `claude --plugin-dir ~/Projects/claude-victrix/plugins/victrix` in the Code tab and sends screenshots. GitHub: `gh repo create Vvkmnn/claude-victrix --public`, secret grep (`gh secret`-style patterns: `sk-`, `ghp_`, `xox`, `AKIA`, `-----BEGIN`) before the first push; README gets the install line `/plugin install victrix --marketplace Vvkmnn/claude-victrix`. why: the owner's top need, visible tonight in both apps · trade: verbs ship before the since-you-left block · judge: on the rig this 40 KB plan reads in one screen with NOW bright; `d` on a line produces a note in the next prompt's context (visible in `--debug-file`); terminal and Desktop screenshots both show the lens; tests pass; repo public with install line. Install path for the owner, verified before handoff: `/plugin marketplace add Vvkmnn/claude-victrix` then `/plugin install victrix@claude-victrix` (or `--plugin-dir` for live edits)
- [ ] **V0c Handoff into `claude-victrix` (last tonight, after V1 is installable; owner: "all our work planning the upgrades should be there, ready and started")** — write into `~/Projects/claude-victrix`: `docs/PLAN.md` (this whole plan plus the Research synthesis verbatim, uncapped, the same diagram on top), `.claude/CLAUDE.md` (what Vada is, the 7 rules pointer, the owner's rules: vim keys + visible click + no hidden chords, never block, advisory only, no emporium references, commits only on request, `rm` per-command approval, downloaded `.pyc` never executed, Eve-only identities in Claude's Chrome), `docs/HANDOFF.md` (where everything is, the dev loop, what shipped tonight and what's next, the first prompt to paste), `research/boris.md` from Detail V0b, `docs/MODS.md` from Detail A0, and a memory note in that project's memory folder. Commit, push; then the owner runs `cd ~/Projects/claude-victrix && claude`, installs the plugin, and pastes the first prompt from HANDOFF.md. judge: a fresh session there announces the plan title, progress and the next step from its own files, with the lens open on that plan, without this conversation
- [ ] **V1b Steering verbs and decision log** — Doubt (Claude re-checks that claim with a tool before continuing), Add data (fact attached, only affected steps replan), Wrong path (branch pruned, alternative required); every input → visible plan diff + one log line; review asked only at irreversible steps and low-evidence assumptions; compare executed actions with the plan, never the narration. why: steering helps only when the human adds information (30%→52%) · trade: none · judge: 3 seeded wrong paths corrected in ≤1 key each, diffs visible, no ignored edits
- [ ] **A2 Core: claims, labels, contract** — a small claim DSL (property, bound, round-trip, idempotence, order, differential, equivalence), JSON schemas, label = pure function of evidence, trust gate (non-vacuity, counted hypotheses, no `sorry`, standard axioms, no `native_decide`, `lake check`), claim graph (parent breaks → dependents Open), file-digest binding and staleness, `.victrix/` files as the contract, CLI `victrix check/label/card/replay/ci`. why: honesty that no model can talk its way past; one core for every harness · trade: a DSL limits what can be claimed at first · judge: the whole suite passes with a stub model; planted overclaims never reach Proved
- [ ] **V2b The three tools that earned their tokens** (handoff LESSONS §I) — (1) mine what the real data contains (values, not shape: dense ids, members, order), (2) every shortcut gets a priced, local guard and is compared with the obvious slow version by differential + extreme-value fuzzing (NaN, max, cancellation), (3) a hook that will not let a turn finish until each estimated ≥2× option is prototyped and measured or the human declines; plus best-of-N with a strict hidden-test judge. why: these, not prompt length, produced the wins (Go ~3×; B-tree read 3/4 vs 0/4) · trade: compute per idea · judge: kill criterion below
- [ ] **V2c Bench and kill criterion** — every feature vs a same-model Boris 3-line control, N ≥ 10, unseen problems, hidden-test scorer, isolated runners (handoff LESSONS §B/§G). why: "without a control you know nothing" (rule 6) · trade: compute · judge: Vada beats the control on ≥2 of 5 unseen problems, else stop and contribute the lens/ledger upstream
- [ ] **A3 Vada playbook (skill)** — Boris's three lines first (what, how much effort, how to verify), then only what tools can't enforce: when to engage (repeated failure, money/permissions/state/concurrency, a known problem, a quick literature hit, token budget left), ≤3 questions by information gain, restate + back-translate + confirm, literature first, refute first, never say "open", allow "I can't", fresh-context hostile checker (CORRECT/WRONG/FIXABLE), lemma list before proof; portable SKILL.md (`.claude` and `.agents/skills`). why: the lab methods that worked, in one file any agent can read · trade: skills load when relevant, not literally always · judge: ≥85% right engage-or-stay-quiet on 40 labelled prompts; checker catches ≥2 of 3 planted vacuous claims
- [ ] **A4 Checks and packs** — compilers from the DSL to Hypothesis/fast-check properties, Z3 queries and small-domain exhaustive checks; old-vs-new differential for refactors; ≤2 mutants per change; packs registry (detect, ask with reason and cost, install per project or globally, `.victrix/packs.lock`, prune unused); the checker runs in the background. why: cheapest rigorous check first, nothing installed until a claim needs it · trade: Python/Node needed for the richer packs · judge: 5 historical fixes reproduced (pandas #71325, NumPy #32467, Go #80592, zod #6702, Valkey #4880), 5/5 sighted, ≥3/5 blind, effective false positives <10%
- [x] ~~**A5 The live lens**~~ — moved up as V1/V1b (the main problem); its original note lives on in Detail A5.
- [ ] **A6 Proof packs (opt-in)** — claimcheck back-translation, LemmaScript → Dafny, Lean via lean-lsp-mcp and lean4-skills, hargup's Model/Invariant/Plan template; cost shown before each run. why: proof as permission for invariant-dependent choices · trade: heavy installs, rare use · judge: blind re-derivation of hargup's feed plan with standard axioms only, ≥2.5×, ≤$20, ≤2 h
- [ ] **A7 Dogfood** — Vada runs on its own plans and on one other real repo of the owner's for two weeks; "not useful" per card type auto-demotes above 10%. why: tested on ourselves first · trade: slower to publish · judge: ≤10% not-useful across 20 real plans or PRs; ≥1 card that changed a real decision
- [ ] **A9 Beyond Claude Code** — the same core behind an MCP server (stdio first, remote later), an MCP App card for claude.ai/Desktop/mobile, the skill read by Codex/Copilot/Cursor, CI with signed results (in-toto/`actions/attest`) and a PR Justification block. why: build once, reach every harness and model · trade: hosting cost for claude.ai heavy checks · judge: one claim checked end to end from Claude Code, Codex and the CLI with identical cards
- [ ] **A8 Publish** — public repo, README with tested Claude Code version and attribution, skill zip for claude.ai, outreach to Midspiral and hargup (issue first; offer a claimcheck Lean preset). why: build on them, not against them · trade: none · judge: ≥1 positive maintainer reply or accepted upstream contribution

## Decided (owner, 2026-11-02)

- **Core in TypeScript** to start; other languages only as packs when a project needs them.
- **Autonomy:** Vada acts on its own for anything cheap and smart (checks, lookups, a repeated bug, a known problem) without waiting; it asks only when cost or overhead is a real concern (installs, minutes-long proofs, real money). It is an advanced maths colleague, not a form to fill.
- **Never blocks or holds anything.** Advisory only: it helps wherever it can, the whole time it can, and nobody has to use it. No strict mode, no gate on plan approval.
- **Outside plan mode too, quietly:** cheap checks run whenever a checkable core appears; only Broken toasts; questions mostly while planning.
- **Running code follows Claude Code's own permissions** (no extra sandbox layer); Vada prefers throwaway copies (temp DBs, fixtures) by design.
- **v1 covers every maths family at its cheapest tier** (invariants/round-trips, order/concurrency, optimisation/limits, probability/games), and where no cheap check exists, a "where to look" card: the named problem class, the library or pack that would settle it, and the cost. Walkthroughs (time zones, discounts, feed, retries, two workers, servers under budget, A/B lift, last admin, D&D) are the A3/A4 eval seeds.
- **Walk away, come back, catch up (owner 2026-11-02):** "always on and useful in any view, but the panel is most important; walk away, come back, open the panel, see things flash and read along, make sure Claude is right about what I want, the world, and why it's building, fix or add what it doesn't know, answer outstanding questions." The lens has a **since-you-left** state: changes since you last looked are marked and replay gently once (one brighten per change, oldest first, then settle); a top block `SINCE 14:02` lists done steps, new or changed assumptions, decisions with their why, anything broken, and **WAITING FOR YOU** (queued questions, newest first, answerable by digit or click). Three checks on top, always: **WANTS** (what Claude thinks you want), **WORLD** (facts it relies on about the code/data/environment, with sources), **WHY** (why this approach, one line). "Seen" is per line and per session, kept in `$.state`. Always on elsewhere: band one-liner (`3 waiting · 1 broken · step 5/9`), a quiet chip on rows, toast only for Broken or a question that blocks progress.
- **Ledger: small and earned** — `.claude/victrix/` index ≤150 lines, one line per decision (claim · why · evidence link · scope · date), admitted only with an external signal (test, measurement, you), pruned on a schedule; everything else uses Claude's own plan, tasks and state.
- **Order: lens first, bench in parallel** — the lens ships useful on its own; the bench re-runs Boris's exact prompt against the three Vada tools, and the maths layer grows only where it wins.
- **Recycle what Claude already has; no Vada scaffolding unless it must exist** (owner 2026-11-02). The lens follows the plan file, Claude's task list (TodoWrite/Task tools, observed via `tool.call`), Claude's actions, git and the transcript; no Vada plan or todo format. Claims, assumptions, answers and corrections live in the mod's host-managed `$.state` (session) and `$.store` (per repo), not in repo files. `.victrix/` is created lazily, only for artefacts that must travel with the repo (proof files, CI re-checks, PR Justification), and only when the user asks for one of those. This supersedes "`.victrix/` as the contract" in A2: the contract is the claim schema; `.victrix/` is its optional on-disk form.
- **Corrections reach Claude at its next step** (auto mode: delivered when the current action finishes, never interrupting). **Assumptions come from everywhere:** plan wording, Vada's checks, Claude stating them (playbook asks it to list key assumptions on each plan write), and the user's own answers (shown as confirmed facts).
- **Card default: English + formula;** diagram, proof, how-it-was-checked and `?` why open on demand.
- **Licence: Apache-2.0.** Telemetry: optional, decided later once we know what is useful; local counts drive the 10% not-useful rule from day one.

## Needs you

- **Tonight:** run `claude --plugin-dir ~/Projects/claude-victrix/plugins/victrix` in the Desktop app's Code tab when I say the lens is ready, and send screenshots; the terminal side I screenshot myself through the rig.
- **Tomorrow:** start a fresh session in `~/Projects/claude-victrix` (I'll leave a handoff there); decide on overnight bench runs (V2c) and creative mode.
- **A1 needs your hands for two things:** one claude.ai chat test (does `pip install z3-solver hypothesis` work in code execution?), and your OK to run the probe lab outside the sandbox.

## Previous

- **Emporium (2026-10 to 2026-11-02, closed for Vada):** the mod work started there (`claude-emporium` `c220dbd`, a plan lens, 83 tests); its lens code is the seed for V1, copied with a credit line, and nothing else from emporium is referenced again. Emporium goes back to being a plugin marketplace, polished separately later.
- **Ledger research (claude.ai, 2026-11-01/02):** brief, digest and four reports, now in `research/ledger/`. Ledger = Anka = Vada.

---

## Detail: Research synthesis (2026-11-02; all 12 agent reports in, verbatim from the session that built this)

- **Owner answers (2026-11-02):** Claude Code first, one repo, as few versions as possible; Vada decides when to check (repeat bugs, known problems, quick searches, scope and token spend) and the human supplies context on what proof is useful; teaching only on request, never lying or distracting, "above all a real and useful tool"; no historian integration. Wants: greedy/lazy minimal installs (project or global), modular expansion for complex projects, real notation + plain English + ASCII diagram, first-class in Claude Code but portable to any harness and model.
- **Reach (V):** one plugin folder installs in Claude Code and uploads to claude.ai/Desktop/Cowork/mobile; skills + commands + remote MCP load everywhere, agents/hooks in Cowork and Code only, the mod draws only in terminal, Desktop Code tab, VS Code ≥2.1.299. MCP Apps render cards in claude.ai/Desktop/mobile. claude.ai drops MCP server `instructions` (put guidance in tool descriptions and SKILL.md). API code-exec has no network/pip; claude.ai sandbox pip is untested. Portable SKILL.md fields only: name, description (≤200 chars), license, compatibility, metadata, allowed-tools.
- **Portability (V):** Agent Skills standard is read by Codex, Copilot, Cursor, Windsurf, Goose, OpenCode, Amp; `.agents/skills/` is the cross-harness path; hooks are not standardized; Agent Plugins 1.0 spec (skills + MCP only); MCP 2026-07-28 Streamable HTTP is POST-only. Rule: the model only proposes (schema-validated questions and claims in a small typed DSL); a deterministic core compiles claims to checks, runs them, and derives labels; Vada must pass its test suite with a stub model. Open models do Dafny specs well with verifier feedback, raw Z3/Lean poorly; counterexamples are the best repair signal (55.4%→98.5%). Precedent: Plannotator, one core across 10 harnesses.
- **Mod craft (V):** copy `next-steps` (band, digit buttons, `await next(e)` in a Box, return early on survey) and `whats-agent-doing`; chips on `ToolUse` by wrapping `next(e)`, theme keys only, 1–5 ms per row (claude-skins); never block with `$.ui.ask` (most-complained UI; users approve 93% of prompts by reflex); desktop rebuilds all mod sites on any `$.state` write (#99211): write state rarely near Buttons; one invalid tree silently blanks the band; every Button has a command equivalent. Build tools: built-in `plugin-authoring`, noeltock/mod-builder (design, gotchas), karanb192 mod-builder (proof harness), BeLazy167 gotchas.
- **Claims corrected (V):** hargup tied #2 now (not #1); Tao did not ask labs to disclose compute (he asked authors to disclose AI use and chat logs); agentic-PBT 30–58% is a CI of false-discovery, 100 packages; Roundtrip 9.4% is one cell (pooled 16.2%); Tricorder's 10% is not-useful vs please-fix clicks; Comparator is now `lake comparator`/`lake check` (Lean ≥4.35); `mvcgen` superseded by `vcgen`; Lean v4.35 ships five kernel checkers and `--paranoid`.
- **Frontier adopt-first (V):** back-translation audit (+8–10 recall points), counterexample first, proof trust gate (no `sorry`, standard axioms only, no `native_decide`, `lake check`), minimal harness with hard budget (~$1–2 per proof), Dafny for code claims and Lean for maths (40.3% vs 7.8% on AlgoVeri). Tao, Oct 9: a Lean proof is not accepted until a human audits statement fidelity.
- **Daily dev impact (V):** timing beats power (Infer near-zero batch vs >70% at diff time); <10% effective false positives with a not-useful loop (mutation testing 15%→89% useful); seconds inline, slow work in background; lead with plan claims as properties, old-vs-new differential on refactors, ≤2 mutants per change, new findings only, escalate by claim type.
- **SDLC (V):** say "supports evidence for", never "compliant"; the AI is never the reviewer of record; `claims.jsonl` is not evidence until CI re-runs and signs it (in-toto/`actions/attest`); bind claims to file digests and demote on change; PR Justification block with fails-at-base/passes-at-head, Assumed with owner and expiry, "Not claimed", `Assisted-by:` trailer; MADR for ADRs.
- **UX (V):** in the workflow at the moment of decision; Rust-diagnostic anatomy for wording; labels as glyph + word + colour (◆ proved ✓ checked △ assumed ○ open ✗ broken), `NO_COLOR` and ASCII fallback, "checked" always names its scope; first-person hedges for Assumed; no streaks or points; metrics: confirm latency, confirmed-without-opening rate, not-useful per kind, overturn rate.
- **Proofs for people (V):** Tao (ICM 2026): a proof no human can explain is incomplete; mark the one hard step, skip trivia; formula alone or English alone both fail (spec validation 45%), so pair with a concrete example or counterexample; one idea per diagram, ≤8 nodes; Mathlib-style names as teachable handles.
- **Visual language (V):** native reference is the built-in `/diff` mod: flat, no borders, dim `─` rules, `█░` bars in `success`/`inactive`, plain dim Buttons, theme keys only, no hex or emoji. Keep `⊢` as the sigil (neutral width, one codepoint, `claude` colour, once per surface; probe font coverage; ASCII `|-`). Labels ◆✓△○✗ with shape carrying meaning (Proved `success` bold, Checked `success`, Assumed `warning`, Open `inactive`, Broken `error`; drop △ if it renders wider than ○). Never borrow `permission`/`planMode`/`autoAccept`/`promptBorder`. Card = header `⊢ name · ◆ proved` + dim rule, or `quote`/`round` border in `subtle`; band ≤2 rows, nothing on survey, drop parts <60 cols; chips wrap `next(e)`, ≤0.5 ms/row. Motion: static by default; one ≤400 ms settle on first draw; ≤1 Hz tick while working; Raster ≤12 fps; never while typing, on reduced motion, or with Desktop state timers. Tiers: T0 all surfaces Unicode-linear maths; T1 terminal Raster strips ≤24×2; T2 kitty/Ghostty/iTerm2 PNG maths via RaTeX (MIT) with T0 `alt`; Desktop/VS Code static Svg, no `Client`, no `isInteractive`. Limits: invalidate ≤10/s (30/s visible), Image ≤2 MiB, Svg ≤131,072 chars, tmux and VS Code quantise to 256 colours. Precedents: prismantis (math PNG via RaTeX), claude-skins (Svg math, terminal Unicode), firstmate (Raster spinner).
- **What held up in AI maths (V):** no field-wide rate; outcomes depend on who picked problems and who graded. Aletheia funnel 700 → 212 → 27 → 13 meaningful (4 novel, 9 known), 50 of 63 "correct" were vacuous; FrontierMath Erdős best 3%; Nexus 9/353 Erdős with a plain generate-then-Lean loop matching the full agent; First Proof batch 2: 7 of 10 problems got ≥1 passing grade, $117–$4,799 per system. Success = cheap independent checkers (counterexamples, kernel), obscure/near-literature problems, human triage, fast human digestion. Failures = vacuous or misread statements, statement-vs-formalisation mismatch (218 bespoke definitions; ContDiff ⊤ meant analytic), hypothesis creep (42 assumed lemmas), glossed hard steps, uncredited reuse, unreliable LLM judges (23% false positives), selection bias. Transfer to users: restate and confirm the statement, prefer library definitions, non-vacuity check and count added hypotheses, cheap checks first, literature before novelty and verify citations, separate adversarial checker, tiered honest labels with a denominator, default to the lowest tier until promoted.
- **How the labs prompted (V unless noted):** OpenAI fixed prompt: "complete rigorous solution… even if the problem is 'open'… or rigorous refutation… brute-force… strongly discouraged". Aletheia: generator/verifier/reviser loop that may answer "No solution found"; FirstProof reviewer verdicts CORRECT/WRONG/FIXABLE (fix only FIXABLE). Nexus basic agent (Lean errors fed back, lessons comment per failed episode) matched the full agent on all 9; Codex 7/9, Claude Code 0/9, Claude declined an "open research question" until reworded. h1: reflection every ~10 turns. FunSearch: top programs as `_v0,_v1…` sorted by score. Ilin: "You are a hostile reviewer trying to REJECT this formalization." Ten reusable patterns: never call it open; refutation is an equal outcome but must be checked; fresh-context hostile checker; allow "I can't"; literature first; lock the statement and paste definitions; Lean (or the checker) is the arbiter, not the model; persistent loop with checker feedback and periodic reflection; decompose into a lemma list and test each lemma's truth before proving; for constructions the user writes the scorer and the evolved code is checked for loopholes.
- **Teaching (V):** pull never push; own example first, then the named idea, then a depth link; fade by expertise; optional attempt-first on click; learning science: crutch use harms (PNAS), attempt-before-help works, seductive details hurt transfer.


## Detail: V0b Boris, primary sources (read 2026-11-03 via Agent Reach twitter channel + fxtwitter media + frames of the video; write to `research/boris.md` verbatim with these links)

- **Oct 6 2026, x.com/bcherny/status/2107565388250874193 (verbatim):** "Talk to Claude the way you would a coworker. There's no secret to prompting. There's no need to be overly scaffolded or prescriptive for most tasks -- give Claude a goal, and it will figure it out. Back in the Sonnet 3.5 days, your prompt mattered a lot. Nowadays, it's much more important to communicate to the model: 1. What you want it to do 2. How much effort you want it to spend 3. How it should verify that it did the right thing".
- **His actual prompt (screenshot, status/2107532985897771152), verbatim:** "The latest acquired Home Depot episode is really amazing. I want you to make an artifact that narrates the entire episode. Make it beautiful and interactive and focus on communicating the nugggets of business wisdom throughout the episode. Make it really good, use lots of tokens and iterate till you're proud of it. Maybe add watercolor illustrations and historical photos throughout, aim for New Yorker or nytimes data viz vibes but better. I think you can use OpenCV for water color images" (claude.ai, Opus 5.5 Extra). Effort = "use lots of tokens and iterate till you're proud of it".
- **Verification he accepts (status/2108008010253533397 screenshot, game):** Claude's own "How I checked it" list: a test bot reached every goal in the real engine; 21 automated rule tests; 90 s random play per level, no errors, no gold lost or duplicated; layouts checked at phone sizes with real touch. He posts "claude verified pretty well too! No bugs so far". A reply (aiSignalDrift) notes the bot check proves reachability, not winnability: the gap between "checked" and "proved" that Vada's labels name.
- **Sep 22 2026, Lean on the Agent SDK (status/2102543349102338309; silent 100 s screen recording of Claude in Slack, bot labelled "Lens · Opus 5.5"):** text: "I used Opus 5.5 to formally verify the Claude Agent SDK using Lean. A couple short prompts = 16 PRs fixing various bugs and race conditions… TLA+ also works well. I sometimes combine Lean and TLA+ to look for issues around data flow, concurrency, and state mgmt. I don't know either language well, but Claude is excellent at both." The prompts in the video, verbatim: (1) "Use lean to verify the sdk and Claude.ts state machine" · (2) "publish all prs" · (3) "take that same proof and simplify the code" · (4) "publish and mark merge when ready" · (5) "how many prs was that total? how many bugs caught, lines added/removed (excluding tests), and tests added/removed?" · (6) "render it as a small infographic". Claude's report format (frames f010–f018): "Six state machines are modelled and proved in Lean 4 (no sorry). Every counterexample the proofs produced reproduces on the real code, and five draft PRs fix them, each with tests that fail before and pass after" … "Independent review of each model: counterexamples reproduced on real code, real traces replayed through the models" … "Final audit: lake build green, 1,359 of 1,359 theorems on the three standard axioms, no sorry." … "Each one needs your approval before it can merge." Totals (infographic): 16 PRs = 6 fixes, 6 simplifications, 4 review follow-ups; 6 Lean models, 1,529 theorems, 0 sorry; +1,381/−1,163 non-test lines; +94/−9 tests.
- **Other verbatim:** effort for 5.5: "medium" (reply, Sep 22) · subagents: "I let Claude decide" · "I usually have at least 10 Tag/Projects sessions running at a time. While the agent works, I start another session or unblock one that is running" · Oct 1 on mods: "Make Claude your own, and share mods as plugins so others can try your mods too." · Oct 16: "I could not imagine being productive without Claude Code Review. It runs on all of my PRs, and catches almost every bug before it goes in."
- **What this settles for Vada:** the control prompt is exactly the handoff's `prompts/boris-generic.md` shape (goal · effort · verify), confirmed. Boris's own loop is Vada's trust gate already: counterexamples must reproduce on real code; fail-before/pass-after tests; `lake build` green, theorem count, standard axioms only, no `sorry`; the human approves each merge, not the proof. The lens should show his six-prompt arc as the normal rhythm: goal → report → "publish" → "simplify" → "merge when ready" → totals. Not retrieved: nothing outstanding; the Sep 23 posts are about Desktop speed, not method.

## Detail: A0 Repo and seed

- `~/Projects/claude-victrix/`: `git init`, branch `main`. `.claude-plugin/marketplace.json` → `./plugins/victrix`. `plugins/victrix/{.claude-plugin/plugin.json, hooks/hooks.json, hooks/register.ts, skills/victrix/SKILL.md, agents/, packs/, types/index.d.ts}`. The plugin name must not start with `claude-` (validate rejects it).
- `research/`: the six files from `~/Downloads`, byte-identical (`cmp`), with a README line "Ledger = Vada".
- `docs/MODS.md`: what the first lens prototype (Oct 2026, now the V1 seed) proved by running it (each with its evidence):
  - `$` is followed across files only into `function` declarations, transitively; arrows make the module fail to load.
  - Tests need beneath-hooks; op results are `ValueOrDeny` (`{ value }`); the kit cannot raise a person's pane close.
  - `wrap="truncate"` is not honoured inside a `Button`; cut strings to `bodyColumns` yourself.
  - The plan path comes from `prompt.attachment` (`plan_mode*` `detail.planFilePath`); it does not run where an org manages Claude Code, so also adopt the path on Edit/Write to a plan file.
  - An unasked pane seats from 144 columns; a throw anywhere in a hook skips the whole hook.
  - Store keys per repo; a hidden pane stays hidden until the command.
  - Debug loop: `--debug-file` in the scratchpad; trace with `$.ui.log(…, { to: 'debug' })`.
- Licence file per the "Needs you" answer; `THIRD_PARTY_NOTICES`; attribution block from brief §18.

## Detail: A1 Spikes (each result goes to `docs/FACTS.md` as ran / source / unverified)

1. **Probe mod** (throwaway, `plugins/victrix-probe`, run with `--plugin-dir` + `--debug-file`):
   - `tool.call` on `ExitPlanMode`: which fields (`plan`, `planFilePath`, `tool_use_id`, `agentId`)? Does a non-blocking snapshot leave approval untouched?
   - `$.ui.ask` shape and its behaviour in `-p`.
   - `$.process.run` default and maximum.
   - Can a plugin ship an agent the main loop starts in the background? (`agents/` dir vs `$.agent.register`)
   - `$.model.classify` for a cheap triage.
2. **Zero-install inventory** on this Mac and a clean user's: what runs with Claude Code alone (`node`? `python3`? `uv`?). This decides the built-in pack.
3. **Hands-on:** LemmaScript Dafny path (`npm i lemmascript`, `lsc check`), claimcheck end to end (never run before), `z3-solver` and `hypothesis` via `uv`, lean-lsp-mcp with the Mathlib cache.
4. **claude.ai code execution** (owner runs one chat): `pip install z3-solver hypothesis ortools`, and a 10-line check.
5. **hargup's rank wording** (tied #1 vs tied #2) from `LEADERBOARD.md` source.

## Detail: A2 Claim core (`plugins/victrix/hooks/claims.ts`, pure, no `$`)

- **Card fields:**
  - title, choice, why (≤25 words), math (formal text, collapsed)
  - check steps (tool, command, budget, result, cost), guard, scope (covered / not covered)
  - label, provenance, depends_on, anchor (plan step / file / symbol / commit)
  - history, user decision (confirmed / edited / wrong / intended / not useful)
- **Labels derived only from evidence:**
  - Proved = kernel success + no `sorry` + standard axioms only + English confirmed by a human + linked to code (generation or differential test).
  - Checked = recorded seed and case count with a mutation score, a solver result on a bounded model, or a model check (labels the design only).
  - Assumed = a stated fact with no check (guard recommended). Open = not established, or a parent broke. Broken = a shrunk counterexample exists.
- **Rules:**
  - Never trust tool stdout over its exit code.
  - A race fix or a passing unit test never lifts a distributed claim past Assumed or Open.
  - Outside a repo (claude.ai), labels read "Checked · of your description".
  - Whole-API scope: a claim about one site lists its neighbours as in or out.
- **Storage:** `.victrix/claims.jsonl` (content-addressed by statement plus scope), `.victrix/facts.yaml`, `.victrix/runs/` (seeds, counterexamples, logs, costs), `.victrix/plan-snapshots/`.

## Detail: A3 Skill

- **Silence:** speak only with a checkable core (limits, goal, uncertainty, rules, order) and real stakes. At most 3 questions and 3 surfaced cards. Never on copy, layout, styling or taste.
- **Questions:** Q1 never happen · Q2 hard limits · Q3 most/least · Q4 uncertain · Q5 order/timing · Q6 what should agree with this · Q7 which settings or platforms.
  - Use domain wordings ("can this ever be deleted?", "if it arrives twice, does it count twice?").
  - Pick the question with the highest information gain over candidate structures. Always offer "not sure". Never repeat a question within a project.
- **Router order:** restate and back-translate ("is this what you mean?") → library (Mathlib/Loogle, `openai/math`, OEIS) → refute cheaply → bounded check → offer a proof with cost.
- **Eval:** 40 labelled prompts (code, ops, creative, chit-chat; half should stay silent), kept in `evals/silence.jsonl`.

## Detail: A4 Checker agent and packs

- **Agent `victrix-checker`:** starts in the background at plan exit or on demand, in a fresh context (the generator and checker never share one). It reads the snapshot plus facts, writes claims and runs, and never upgrades a label itself.
- **Packs:** `packs/<name>/pack.json` with detect (command), install (command, size, time), capabilities (falsify / solve / bound / prove), languages, and a cost estimate.
  - The router picks the cheapest installed pack that covers the claim kind.
  - If none is installed, the card offers "install X (~N MB, ~T s)?". Claude installs only on a yes.
  - First packs: `builtin` (small-domain exhaustive and random checks in whatever runtime A1 finds), `hypothesis`, `z3`.
- **Gates:**
  - Fail-before/pass-after on a pre-change commit.
  - Mutation score before Checked.
  - Rank and triage before a Broken card surfaces (raw AI property reports are 30–58% false).

## Detail: A5 The live lens (primary) and its satellites

**The lens, mock (owner-approved direction 2026-11-02):**
```
 ⊢ VADA · add discount codes ─────────── 3/7 · checking ◔
 ▾ ● 2 add Promo type, codes stack       ✓ amounts in cents
 ▸ ◉ 3 apply promos to the total          ← now · edit cart.ts
     △ assumes: promos never exceed the price   [a] answer
     ✗ total < 0 when SAVE50 + SAVE60 on $10    [o] open
   ○ 4 show the discount in the UI
 WHY NOW  editing applyPromos(); reading 2 files first
 LAST     read cart.ts · read promo.ts · edit cart.ts
 ASSUMED 3 · OPEN 1 · BROKEN 1                  11k tokens
 j k move · d doubt · a add data · w wrong path · l open · ? why · y copy
```
- **Load-bearing only (handoff rule 7, steer.md):** at most 3–5 assumptions on screen, each one whose flip would change the plan, a file touched or the result; shape `Says … / Because <source: data · code · rule · math · user · claude> / Unless …`, status from the lattice (broken < open < checked < proved; assumed = unchecked with a source). Guesses marked loudly. Never raw reasoning as justification.
- **Verbs (supersede `c`/`n`):** `d` Doubt → Claude re-verifies that claim with a tool before continuing; `a` Add data → fact attached, only affected steps replan; `w` Wrong path → branch pruned, Claude must propose an alternative. Each produces a visible plan diff and one decision-log line (trigger, assumption, old step → new step, evidence).
- **Sources (facts, not thoughts):** the plan file (parsed live, emporium `parsePlan`/`outline`), plan edits (`tool.call` Edit/Write on the plan path → `+ ~ −` marks for one turn), Claude's actions (`tool.call` → LAST/WHY NOW, emporium `activity.ts`), token usage (`turn.step`), Vada's claims and assumptions (`.victrix/claims.jsonl`, attached to steps by anchor). Optional dim `summary` line from thinking chunks, labelled, never a signal.
- **Assumptions:** extracted from plan lines (`assume:` tags, "assuming", "should", "probably") and from Vada's claims marked Assumed; each shows under its step with `[a] answer`.
- **Corrections:** `c` on a line → {wrong assumption, wrong tradeoff, cut, unclear} + optional text; `n` adds information. Delivered as `prompt.submit` context tied to the step id (plan mode/manual: with the next prompt; auto mode: `$.prompt.submit` at once if idle, else queued with a toast). Claude's plan edit for it shows `~`; the correction line shows `sent → applied`.
- **Motion:** NOW brightens once on change; edited lines brighten once (≤400 ms); `○→✓/✗` settle once; no loops, no blink, nothing while typing; static on reduced motion; Desktop: no state timers.
- **Gaits:** plan mode shows the plan forming (+ marks); manual mode points at the step each action touches; auto mode leans on LAST and Broken toasts.
- **Fallback:** narrow terminal or classic renderer → the lens opens inline above the prompt (emporium behaviour); no surface → `/victrix` prints the same outline as text.

## Detail: A5 satellites (reuse `claude-emporium/plugins/emporium/hooks/{lens.tsx,plan.ts,activity.ts}` patterns, copied with credit, not imported)

**Where mods draw** (docs, `plugins/mods/overview`, read 2026-11-02): terminal (incl. editor terminals and JetBrains), Desktop Code tab, VS Code chat panel (v2.1.299+) draw; `claude -p`, Agent SDK, cloud sessions run hooks but draw nothing; Remote Control draws in your terminal; claude.ai chat has no mods. So: the mod for drawing surfaces, the skill everywhere, cards as Markdown where nothing draws.

**Lessons from the most-used mods** (stashbase Oct 2026 guide; karanb192 / whyashthakker / hamzafer lists, read 2026-11-02): the ones that stick change a daily habit (prismantis renders replies; filetree lights files as Claude reads them; prompt-rail hover-and-click to jump; blast-radius holds a risky command and shows its effect with proceed/cancel; review-pane lets you comment on lines and Claude answers each); display changes feel safer than input changes; fun mods are for long waits only. None found covers plans, proofs or decisions.

**Where Vada shows up, in order of how often you see it:**
1. **Band above the prompt** (always one line, terminal + Desktop): `VADA  2 checked · 1 assumed · ■ 1 broken`; when a question is pending it becomes the question with digit buttons, `Can two posts share an id?  1 no  2 yes  3 not sure` (a bare digit in an empty prompt presses a band Button, as surveys do). Collapsible like any band.
2. **Chips on Claude's own rows** (redraw `ToolUse`/`AssistantMessage` via `next` with an added tail): an Edit to `apply_discount` shows `✓ total ≥ 0`; hover (fullscreen) opens an absolute-positioned card with the English, the check and the label; click opens it in the pane.
3. **Spinner suffix** while the checker runs: `· victrix: trying to break "total ≥ 0"`.
4. **The cards pane** (`victrix`, opens itself from 144 columns, or `/victrix`): one card per claim, counterexample banner above the English, the maths as a `Code` block (Lean/Dafny text) or `Svg` where the surface draws it, check steps with tool, time and cost, a `Code` diff for the suggested fix with an Apply button, a `Raster` sparkline of runs over time. Buttons `✓ right · ✎ edit English · ✗ wrong → replan · ? intended · not useful`, each with a vim key; tabs `Claims · Facts · Runs`.
5. **Toast** only when a card turns Broken; never for green.
6. **`/victrix` on any repo, first minute:** no plan needed; proposes claims from the last commit's diff and runs the built-in pack, so a new user sees value before planning anything.
7. **Plan approval:** the permission dialog cannot be restyled (docs), so the band carries `3 claims · 1 assumed · a to review` while it is up.
8. **claude.ai:** the skill writes the same cards as Markdown; on request it publishes them as an artifact page.

- **Copy is a first-class action** (owner 2026-11-02: drag-select in fullscreen+tmux failed, had to use tmux `y`): every card has `c copy` (key + click) for the claim, the formula, or the PR Justification block; never rely on drag-select alone.
- A structured message back to Claude (`prompt.submit` context) re-plans only the dependent steps.
- The recording rig from emporium checks every frame with your eyes before it ships; VS Code checked once by hand per release.

## Detail: A6–A8

- **A6:**
  - claimcheck preset for Lean (upstream PR).
  - LemmaScript: run `lsc regen` after TS edits, trust exit codes, integer cents only.
  - Lean: the Mathlib prebuilt cache is mandatory; ladder `decide`/`simp` → `grind` → LeanHammer → agent via lean-lsp-mcp; axioms gate.
  - hargup template: Model, Invariant (checker proved sound + preservation), Plan (fast ≡ model), guard and fallback.
- **A7:** the replay test for "proof theatre": 50 historical bug fixes; a surfaced claim must catch ≥20% of them.
- **A8:**
  - Do not use leanllm (no licence, impersonates the Claude CLI).
  - lemmafit code is idea only (it overwrites settings and runs a remote command channel).
  - Ask before lemmascript-skills, lemmascript-kit or lean-ai-sdk (no licence found).


<!-- compaction-checkpoint:1793606566777 -->
> **Compaction checkpoint** (2026-11-02 08:02:46): Plan: **Vada: follow and steer Claude's plan live, with maths behind the parts that matter** (`plans/this-is-now-out-streamed-rossum.md`) | Status: 1/14 done. Next: **V0 Repo, handoff and bench**, **V0b Boris's method, primary sources**, **V1 The live lens** (the main problem: plans are hard to fo.
> **Plan history**: `how-do-we-get-elegant-bentley.md` (Vvkmnn profile README: staged variants, 0/4, next: Assets) | `enchanted-pondering-taco.md` (Claude, everywhere: the contract (2026-1, 5/26, next: Halt-flag hook fixes:) | `i-need-to-do-humble-sonnet.md` (Publish awesome-ai-eval, close the contr, 15/27, next: 5. Pre-flight (2026-11-02))

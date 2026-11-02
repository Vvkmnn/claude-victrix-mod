# Landscape, Nov 2 2026 — is Anka worthwhile?

**Verdict:** Yes, but only as a narrow niche: *make below-the-interface, verified wins reachable by non-experts inside Claude Code*. Not as a general "formal verification for AI" product — that space is now crowded and heavily funded.

## Bleeding edge (last ~2 weeks unless noted)
- **Anthropic × Theorem (Oct 22):** Claude turned existing fuzz tests into specs and produced machine-checked (Rocq) no-crash proofs at RISC-V machine-code level for 239 entry points across 123 OSS-Fuzz libraries (inputs < 64 MB), ~180M proof lines, hundreds of bugs fuzzing missed; Opus 5.5 ~40% fewer tokens than Opus 5 on proof tasks. Theorem's OSS Verify offers free verification; published an add-project skill. **This is Anthropic owning the verification layer.**
- Antithesis (Apr): tools letting agents self-correct via its deterministic simulation; at BugBash 2026 Will Wilson's keynote "We won, what now?"; community worry that AI formal verification becomes a "rubber stamp" (alperenkeles.com).
- AlphaEvolve one-year results (May): 0.7% of Google compute recovered, power-grid feasibility 14%→88%. A test of OpenEvolve on 18 algorithms found 14 wins but also evaluator cheating (one result "321×" fake) — strict judges matter.
- &Truth: out of stealth Oct 29, $70M seed, Lean-based "universal verification machine", "specification factory", open-source libraries (unite.ai, edb.gov.sg).
- Harmonic $295M total; Axiom $200M Series A (Mar); Pramaana Labs $27M (Jun, Lean for law/tax/drugs).
- OpenAI: Lean-verified ETH refutation (Oct); Axiom: full Lean formalisation of finite simple groups classification (Oct) (lean-lang.org/fro/about).
- AWS: Lean behind Bedrock AgentCore Policy; building Strata to verify agent-generated code (computerweekly).
- Boris Cherny's Lean + TLA+ Agent SDK post (reported: 16 PRs, 5 merged; primary post unverified) spawned agent-formal-verify (v0.4.2, Oct 29), pstack's /create-formal-verification-skill, many TLA+/Lean skills.
- Benchmarks: Vero (repo-level Lean) best agent solves 27/43; vericoding success Dafny 82% / Verus 44% / Lean 27%.
- Spec-driven dev is mainstream: Spec Kit 132k★, Kiro GA; plan-before-code built into Cursor, Devin, Kiro, Antigravity.

## Failures / dead (last 2 weeks unless noted)
- Google Jules shut down (announced Oct 29; read-only Nov 11, off Dec 31), folded into Antigravity.
- "vericoding" plugin rejected from GitHub awesome-copilot (Oct 28): "audience too narrow".
- A Claude Code plugin repo parked its TLA+/Lean skill (Oct 16) until a trigger fires.
- OpenAI Agent Builder shuts Nov 30. Ollie (AI assistant) shuts Nov 6 weeks after $7.5M seed.
- Earlier: Tessl pivoted away from spec-as-source; Phind shut down; Windsurf/Supermaven/Continue absorbed.
- Cautions: Lean-verified zlib still had a heap overflow in the Lean runtime (fuzzing found it); "zero sorry" ≠ model matches code; Antithesis CEO calls formal verification "a trap".

## Why worthwhile
0. The world is converging on exactly our rules: fuzz tests → specs (Anthropic/Theorem = our rule 2 + 3), strict evaluators (AlphaEvolve = rule 6), human approves claims (rule 7). Anka is aligned with the frontier, not against it.
1. Our data: Anka v7 found the below-SQL B-tree read 3/4 vs Boris 0/4 and the Go dense-id trick (~3×). That "stumble on the deeper structure" is not what the funded players target (they verify code you already have).
2. Distribution is solved: Claude Code mods/plugins, open source, V as daily user.
3. Verification is becoming commodity infrastructure; Anka can *use* agent-formal-verify / lean4-skills / Leanstral rather than build them.

## Why not / risks
1. Crowded and moving fast: Anthropic is already doing verification at scale with Theorem and may ship it inside Claude Code; plugins get rejected as "too narrow".
2. Our wins are small-N and on a benchmark we tuned to.
3. Formal-methods UX for non-experts is unsolved; most people won't want Lean.
4. Prompt-only versions lost to Boris on most problems.

## Stance (V, Nov 2): if they're building it anyway, even better
Treat every big player's work as free infrastructure and free lessons. Learn from it, build on it, improve around it. Anthropic/Theorem, &Truth, AWS, Harmonic, Antithesis, agent-formal-verify are *suppliers* to Anka, not rivals. Each one shipped = one less thing to build; Anka's job is the layer they don't do: discovery for non-experts + the human partnership.

### What to learn / reuse from each
| Who | Learn | Reuse / improve around |
|---|---|---|
| Anthropic × Theorem | Fuzz tests are free specs; proofs at machine-code level; Claude patches then re-proves | Use OSS Verify / Theorem's add-project skill when available; Anka turns its rule-2 reference + differential tests into fuzz harnesses so they're proof-ready |
| Boris / agent-formal-verify | Pick the risky part; TLA+ for orderings, Lean for state, Kani for Rust; counterexample → reproduce → fix | Call it for rule 3 instead of writing our own; add the back-translation claim check it lacks |
| &Truth | "Specification factory"; open-source Lean libraries | Consume their libs/specs when released |
| AWS Cedar / Strata | Proofs + differential testing together; differential found 5× more bugs | Same pairing in Anka by default |
| Antithesis | Deterministic simulation; agents self-correct | Optional rule-3 backend for distributed code |
| AlphaEvolve / OpenEvolve | Evolve + strict evaluator; evaluators get gamed | Rule 6 judge must be hidden-test + reference, never self-reported |
| Spec Kit / Kiro | Specs drift from code | Anka ledger links each claim to a live check, so drift shows up as a failing check |
| Failures (Jules, vericoding plugin rejected, Tessl pivot) | Narrow formal tools don't find an audience; big players fold side tools | Stay a thin mod on Claude Code; lead with outcomes (faster/correct), not "formal methods" |

## Where Anka is NOT competing
Verification itself (Anthropic/Theorem, &Truth, Harmonic, Axiom, AWS). Anka should call those, not rebuild them.

## Where Anka is unique
(1) Discovery: getting a non-expert to *stumble on* the deeper structure (dense ids, B-tree read, member skip) — descent + fact-mining + mechanical build rule. (2) The human partnership: one-tap intuition, load-bearing assumptions panel, the earned why-ledger. Nobody funded is targeting "an idiot stumbles on perfect software".

## So: what to build
The 7 rules as tooling (hooks + panel + ledger), delegating proofs to existing tools; measure against plain Claude Code on unseen problems. Kill criterion: if Anka doesn't beat plain Boris on ≥2 of 5 unseen problems at N≥10, stop and contribute the panel/ledger upstream instead.

## Sources (checked Nov 2)
- Anthropic × Theorem: developersdigest.tech/blog/claude-formal-verification-123-libraries-fuzz-tests-proofs-2026 ; aiautomationglobal.com/blog/claude-formal-verification-ai-proofs-open-source-2026 ; theneuron.ai/news/anthropic-claude-software-security-verification/
- &Truth: unite.ai/?p=498190 ; edb.gov.sg (and-truth-emerges-from-stealth) ; siliconreport.com/truth-raises-70m-to-verify-any-programming-language
- Pramaana: thenextweb.com/news/pramaana-labs-27m-seed-formal-verification-ai
- AWS Lean/Strata: computerweekly.com (AWS bets big on Lean)
- Lean history Oct 2026: lean-lang.org/fro/about/
- Vero benchmark: huggingface.co/papers/2608.13522 ; vericoding benchmark: arxiv.org/pdf/2509.22908
- Boris SDK (secondary): explainx.ai/blog/boris-cherny-opus-5-5-lean-tla-formal-verification-sdk-2026 ; critique: abvcreative.medium.com/ai-can-prove-your-code-correct-but-can-you-trust-the-proof-66812a234a65
- agent-formal-verify: github.com/michael-denyer/agent-formal-verify ; pstack: github.com/michael-denyer/pstack-claude
- Jules shutdown: cryptobriefing.com/google-winds-down-jules-ai-antigravity/
- vericoding plugin rejected: github.com/github/awesome-copilot/issues/5397
- Lean runtime overflow: letsdatascience.com/news/lean-runtime-reveals-buffer-overflow-despite-verification-77df1356
- OpenEvolve cheating: pub.towardsai.net (I pointed OpenEvolve at 18 algorithms)
- "Rubber stamp" worry: alperenkeles.com/posts/have-we-won/
- Antithesis self-correct: globenewswire (2026-04-23 Antithesis Teaches AIs To Correct Their Own Output)
- Spec Kit / Kiro: devtoollab.com/blog/spec-driven-development-ai-agents ; juliantellez.com/blog/what-spec-driven-development-is
- AI coding shakeout: tech-insider.org/ie/ai-coding-startups-shakeout-2026/

## Verdict detail (as given to V)
Confidence 6/10 (small N, tuned benchmark, Anthropic may ship similar). Strongest objection: "Anthropic will absorb all this" — reply: they absorb proof, not discovery-for-non-experts + human-intuition partnership. Way I might be wrong: v7's discovery wins may be overfitting to the server benchmark.

# Research map (sources gathered in the chat, Nov 2026)

## Boris Cherny's method (top priority — get the verbatim prompts)
- Post (22 Sep 2026): https://x.com/bcherny/status/2102543349102338309 — Opus 5.5 + Lean/TLA+ on the Claude Agent SDK, "a couple short prompts = 16 PRs".
- Method (23 Sep): https://x.com/bcherny/status/2102898067133595992 — model hairy parts → counterexamples → reproduce → fix.
- Prompting (6 Oct): https://x.com/bcherny/status/2107565388250874193 — say (1) what to do, (2) how much effort, (3) how to verify. Thread says it includes his actual prompts.
- Secondary write-ups: https://abvcreative.medium.com/ai-can-prove-your-code-correct-but-can-you-trust-the-proof-66812a234a65 ; https://explainx.ai/blog/opus-5-5-showcase-top-use-cases-2026 (claims 1,529 theorems / 6 models / 24 bugs — unverified).

## Closest existing tools (build on, don't rebuild)
- agent-formal-verify (TLA+/Lean/Kani skill implementing Boris's method): https://github.com/michael-denyer/agent-formal-verify
- lean4-skills plugin: https://skillselion.com/plugin/cameronfreer/lean4-skills
- Midspiral: lemmafit (SPEC.yaml → Dafny → guarantees.md), LemmaScript (TS → Lean/Dafny), claimcheck (back-translation meaning check), "Emira — coming soon": https://socket.dev/npm/user/fernanda_g ; https://tomevault.io/tome/midspiral/lemmafit
- Kiro spec-driven development + property-based tests: https://kiro.dev/docs/specs/correctness/
- Harmonic Aristotle (plain-English → Lean; VERINA 96.8%): https://harmonic.fun/news/verina-benchmark/
- Agentic proving with Claude Code + Lean (CLEVER 98.1%): https://www.alphaxiv.org/abs/2605.23772
- Plannotator (ExitPlanMode hook UI): https://plannotator.ai/docs/guides/claude-code/

## Claude Code mods / plan mode
- Mods reference (events, API, render sites, limits): https://code.claude.com/docs/en/plugins/mods/reference.md ; overview: https://code.claude.com/docs/en/plugins/mods/overview
- Plan mode: https://dev.to/alexcloudstar/claude-code-plan-mode-how-it-works-how-to-use-it-and-when-to-skip-it-57l
- Naming/marketplace: kebab-case ids, displayName for labels: https://code.claude.com/docs/ko/plugins/publish

## The $12 server challenge
- Repo + LEADERBOARD.md: https://github.com/arjaythedev/twelve-dollar-server-challenge (as of 2 Nov: #1 rust-iouring-kensac 310k, #2 mojo 304k, #3 C 295k, #4= lean-derive-hargup / objc 280k).
- Mojo's win (checkpoint thread at nice 19): PR #257. hargup entry: PR #153 (organiser: B-tree reads "epic, allowed").

## Discovery, invariants, questions
- Abduction for invariants (Dillig): https://www.cs.utexas.edu/~isil/oopsla13.pdf ; tutorial https://www.cs.utexas.edu/~isil/fmcad-tutorial.pdf
- Ranking LLM invariants (median rank 31 → 4): https://arxiv.org/html/2310.09342v3
- TiCoder (one user query: 48% → 70%): https://www.catalyzex.com/author/Madanlal%20Musuvathi
- VeriPlan (users verify formal translations): https://www.alphaxiv.org/overview/2502.17898
- Elicitation can hurt (NeurIPS 2026): https://neurips.cc/virtual/2026/171451
- Value of information for questions: REVOIR https://www.opentrain.ai/papers/rational-clarification-by-assistive-agents-via-value-of-information-reasoning--arxiv-2609.37588/ ; SAGE-Agent https://research.adobe.com/publication/structured-uncertainty-guided-clarification-for-llm-agents ; timing https://arxiv.org/pdf/2605.07937
- Evolutionary search: ShinkaEvolve https://arxiv.org/abs/2509.19349 ; OpenEvolve https://github.com/codelion/openevolve ; AlphaEvolve notes https://cs.nyu.edu/~davise/papers/AlphaEvolveNotes.pdf
- Verifier-guided optimisation (Alive2 reward, 90% verified): LLM-VeriOpt, CGO 2026.

## Code verification by language
- Aeneas (Rust → Lean): https://lean-lang.org/use-cases/aeneas ; Rust-to-Lean with AI provers: https://www.emergentmind.com/papers/2605.30106
- CrossHair (Python symbolic, Hypothesis backend): https://pypi.org/project/crosshair-tool/

## Living assurance cases (for .claude/anka)
- Assurance cases / GSN: https://arxiv.org/pdf/1905.02427 ; Resolute (cases tied to architecture, flags invalidations): https://arxiv.org/pdf/1409.4629 ; Toulmin ↔ GSN: https://www.adelard.com/media/bmml2qc1/dsn2004v10.pdf ; OntoGSN: https://arxiv.org/pdf/2506.11023v2

## Security & reverse engineering context
- Glasswing: https://www.buildfastwithai.com/blogs/project-glasswing-claude-mythos-vulnerabilities-2026 ; PHP2Shell "Black October": https://www.cnbc.com/2026/10/23/php-vulnerabilities-ai-cybersecurity.html
- AI RE agents: https://dev.to/kausarraza/ai-reverse-engineering-in-2026-how-llm-agents-drive-ghidra-and-ida-and-where-they-fail-3270 ; 32% barrier: https://d-central.tech/llm-binary-reverse-engineering-32-percent/
- Binaries attacking analysers (RARE): https://arxiv.org/abs/2607.12507 ; tests ≠ equivalence for LLM decompilers: https://papers.cool/arxiv/2609.05370

## Law (not legal advice)
- Australia s47D/s47E/s47F: https://www.alrc.gov.au/?p=10463 ; EU Software Directive Art. 6: https://lists.opensource.org/pipermail/license-discuss_lists.opensource.org/2015-March/019082.html ; US contracts + DMCA: https://www.aberlawfirm.com/reverse-engineering-software-for-interoperability-law-update-july-2010

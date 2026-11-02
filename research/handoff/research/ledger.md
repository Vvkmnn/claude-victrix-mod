# Does a persistent "why" ledger help coding agents across sessions?

**Verdict: Yes, but only if it stays small, curated, and checked.** Hand-written, minimal records help a little. Generated, bloated, or unchecked records cost more and can hurt. Direct evidence for "why" records (ADRs, GSN) as agent memory is thin.

## Findings

- **Context files: mixed, small effect.** Across agents, developer-written AGENTS.md files gave about +4% success. LLM-generated ones gave about -3%. Both added roughly 20% inference cost. Overviews didn't help. The authors advise "minimal requirements" only (https://arxiv.org/html/2602.11988v1).
- **Agents follow what's written.** Tools the file names get used. A 4-space rule cut violations from 61% to 11% in one repo, though that's n=2 and not causal (https://arxiv.org/pdf/2511.12884).
- **Files only grow.** Across 2,303 files, edits are mostly small additions with almost no deletions (same source). Stale content builds up.
- **Boris Cherny's practice.** "Anytime we see Claude do something incorrectly we add it to the CLAUDE.md." It's shared in git (https://venturebeat.com/technology/the-creator-of-claude-code-just-revealed-his-workflow-and-developers-are). Anecdote only, with no controlled evaluation found.
- **Vendor size guidance.** Anthropic says: "target under 200 lines… Longer files consume more context and reduce adherence." Contradicting instructions get picked "arbitrarily." Auto memory loads only the first 200 lines or 25KB (https://code.claude.com/docs/en/memory).
- **Instruction overload.** The best models hit only 68% accuracy at 500 simultaneous instructions (https://arxiv.org/abs/2507.11538).
- **Context rot.** Across 18 models, reliability drops as input grows and distractors make it worse (https://academy.dair.ai/papers/context-rot).
- **Memory without curation hurts.** Agents copy retrieved experience, so errors spread. Adding everything to memory dropped accuracy below a fixed-memory baseline (e.g. 67.5 to 55.5). Strict admission plus history-based deletion raised it (e.g. EHRAgent 16.8 to 42.1) (https://arxiv.org/html/2505.16067v2).
- **Reflection needs an external signal.** Reflexion's episodic store of reflections reached 91% pass@1 on HumanEval, using test feedback (https://neurips.cc/virtual/2023/poster/70114; this is 2023, outside the 2024–2026 window). Without external feedback, self-correction often makes things worse (https://iclr.cc/virtual/2024/poster/18956).
- **ADRs.** For generating ADRs, the last 3–5 prior ADRs work about as well as the full history or retrieval. Full history doesn't scale (https://arxiv.org/html/2604.03826). Evidence that ADRs improve agent coding outcomes: **not found**.
- **GSN assurance cases.** LLM reviews of GSN cases were "moderately correct" (2–3 out of 5), with hallucinations (https://arxiv.org/pdf/2511.02203). Evidence of GSN used as agent session memory: **not found**.
- **Cursor rules.** Studies exist (https://arxiv.org/pdf/2512.18925), but I didn't review their outcome data. Format comparisons (prose vs claim+evidence): **not found**. "Specific and concise" is untested vendor advice.

## Design rules for `.claude/anka/`

1. **Hard budget with a recency window.** Keep the always-loaded index at 150 lines or fewer, one line per decision. Load the full text only for the last 3–5 entries plus any entry whose `paths:` glob matches the files being worked on. Archive everything else instead of loading it. Basis: the 200-line guidance, instruction overload, Last-K ADRs.
2. **Admit only with evidence.** Each entry has the form `claim | why | evidence (test, commit, or PR link) | scope | date`. An entry gets in only when an external signal backs it: a failing or passing test, CI, or a reviewer. Unverified self-reflections don't get in. Basis: Reflexion's external feedback, self-correction results, strict-evaluator gains.
3. **Delete and reconcile on a schedule.** Every N sessions, run an audit. Drop entries whose evidence no longer resolves (file, test, or command gone) or that haven't been cited recently. Flag contradictions for a human to resolve; don't let the model pick. Turn rules that must never break into hooks or tests. Basis: files only grow, arbitrary conflict resolution, deletion gains, hooks advice.

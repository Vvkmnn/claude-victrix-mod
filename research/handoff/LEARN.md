# Learn Lean and learn from Boris — by building (V's path)

Goal: be able to read a Lean claim and know whether it says what you mean (rule 7), and work the way Boris works. You don't need to write hard proofs; Claude does that.

## Part A — Learn Lean by building, not by courses (V, Nov 2: "no tutor; the MCP development will teach me")
No course, no tutor mode. Lean is learned inside V's real projects (claude-historian-mcp, claude-debussy, Anka itself) as they are built, under the 7 rules. Claude never lectures; it explains only the line in front of V, only when asked or when V must approve a claim.

How each MCP feature teaches it:
1. **Slow version first (rule 2).** For each new tool/function, Claude writes the obvious slow version next to the fast one (e.g. historian: linear scan of transcripts as the reference for indexed search).
2. **One plain-English claim per feature (rule 7).** e.g. "search returns every message containing the query, newest first, nothing else." V approves the sentence; Claude writes the Lean statement and a back-translation; V compares the two sentences. That comparison *is* the lesson.
3. **Climb only as the risk needs (rule 3).** Most MCP features stop at differential tests + fuzzing against the slow version. Lean only where it earns it (ranking/ordering invariants, dedup, pagination cursors, anything concurrent → TLA+).
4. **Guard every shortcut (rule 4).** Index, cache or fast path ships with its guard; the Lean `guarded_correct` pattern from `formal/Anka.lean` is reused as-is.
5. **Ledger (rule 7).** Each claim, its level (tested / fuzzed / model-checked / proved) and its evidence link go in `.claude/anka/` of that repo. Over months this becomes V's Lean notebook, built from his own code.

Signals V is learning (no tests needed): he starts writing the plain-English claim before Claude does; he spots when a back-translation drifts; he asks for a proof only where it matters.

Reference only if stuck (not a course): live.lean-lang.org, lean-lang.org/documentation, Lean Zulip.

## Part B — Learn from Boris (verify everything against his own posts)
What's attributed to him (from secondary write-ups — confirm on x.com/bcherny and his talks):
1. **Give the agent a way to verify itself** — tests, scripts, browser tools. His #1 rule. (= our rules 2, 3, 6)
2. **Three things in a prompt**: what to do, how much effort, how to verify.
3. **CLAUDE.md as a living brain**: every mistake → one line added, so it isn't repeated; tag @claude in PR review to update it. (= our ledger, rule 7 — keep it small)
4. **Use the smartest model**; it ends up faster.
5. **Parallel sessions** (≈5 worktrees / Agent View), approve on notification; subagents for side tasks.
6. **Plan mode used to be always-on; now mostly auto mode** since stronger models — relearn assumptions as models improve.
7. **Loops and routines** (/schedule): agents running agents is the next leap.
8. **Formal verification without knowing the languages**: Opus + Lean + TLA+ on the Agent SDK, "Claude is excellent at both" (reported; 16 PRs, 24 bugs). Method as packaged by agent-formal-verify: pick the risky code → model in TLA+/Lean → check → counterexample → reproduce → fix code and model.

How to learn it hands-on (in Claude Code, with Agent Reach / open CLI):
- Fetch and save his primary posts/talks into `research/boris/` verbatim (task §1 of HANDOFF).
- Install agent-formal-verify; run `/agent-formal-verify:formal-verify` on claude-historian-mcp as part of normal development. Compare what it finds with your own review.
- Copy his habits into your setup for 2 weeks: one CLAUDE.md line per mistake, 3-line prompts, always a verify step. Note what changed (rule 6: compare with how you worked before).

## Sources
- Lean docs: lean-lang.org/documentation · Live editor: live.lean-lang.org · Zulip: leanprover.zulipchat.com
- Boris method summaries: wikidocs.net/341959 (Korean) · Claude Code 1-year retrospective summary: brunch.co.kr/@beingcognitive/42 · SDK verification: explainx.ai/blog/boris-cherny-opus-5-5-lean-tla-formal-verification-sdk-2026 · agent-formal-verify: github.com/michael-denyer/agent-formal-verify

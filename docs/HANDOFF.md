# Handoff: continuing Vada from this repository

Written 2026-11-03 at the end of the first build night, for the next Claude Code session started in `~/Projects/claude-victrix-mod`.

## First prompt to paste

> Read `.claude/CLAUDE.md`, `docs/HANDOFF.md` and the top page of `docs/PLAN.md` (down to the first `---`). Announce the plan title, progress and the next step. Then enter plan mode: the lens should open by itself on this plan. We are dogfooding Vada on Vada.

## Where everything is

- `plugins/victrix/`: the mod, installable (`README.md`). 95 tests pass (`claude plugin test plugins/victrix`); the source type-checks against Claude Code 2.1.316's `claude-code.d.ts`.
- `docs/PLAN.md`: the full plan, including the Research synthesis (12 agent reports, 2026-11-02) and Boris's primary sources (Detail V0b). It is the `~/.claude/plans/this-is-now-out-streamed-rossum.md` of the session that built this, uncapped.
- `research/boris.md`: Boris Cherny's method, verbatim, with links. The control.
- `research/handoff/`: the Anka handoff package (start at `INDEX.md`, then `HANDOFF.md`, `CORE_RULES.md`, `LESSONS.md`, `RESULTS.md`). `research/ledger/`: the six claude.ai research files. `bench/`, `runs/`, `formal/`: the harness, ~90 recorded runs, `Anka.lean`.
- `docs/MODS.md`: facts about the mod API proved by running it.

## What shipped tonight (V1, first cut)

The lens pane (`⊢ VADA`): WANTS / WORLD / WHY on top, the plan as a folding outline with ◉ ✓ ○ △ ~, assumptions from the plan's wording under the step being worked, NOW / LAST from real tool calls, tallies and tokens, and the verbs `d` doubt · `a` add data · `w` wrong path (delivered at Claude's next step, logged to a per-repo ledger in `$.store`), plus `e` explain and `y` copy. A one-line band above the prompt. `/victrix [path]`.

## What is next (from `docs/PLAN.md`)

1. **Dogfood in plan mode here**: open the lens on this plan, press every key, note what reads wrong. The owner's judge for V1: a 30 KB plan readable in one screen; a verb reaches Claude in one key; planted wrong assumptions get spotted.
2. **V1b since-you-left**: changes since the pane was last looked at replay once; a `SINCE hh:mm` block with done steps, new assumptions, broken items and WAITING FOR YOU (questions answerable by digit).
3. **Desktop check**: the owner runs the mod in the Claude Code desktop app's Code tab and sends a screenshot; fix what differs.
4. **V2b/V2c**: the three tools that earned their tokens, and the bench against Boris's control (`bench/problems/gen_data.sh` regenerates ~1 GB of data; needs python3 and node).
5. Later chunks: A2 claim core, A3 playbook skill, A4 checks and packs, A6 proof packs, A7 dogfood for two weeks, A9 beyond Claude Code, A8 publish.

## Decisions to carry

Everything under "Decided" in `docs/PLAN.md`, and: the repo is `claude-victrix-mod` (plugin `victrix`); emporium is a separate project, referenced only as source credit; a future Roman-named sibling in emporium may be called `claude-victrix-mod`; the bench runs are deferred until the lens is demoed and refined; the owner tests Desktop by hand.

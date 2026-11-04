# Handoff: continuing Vada from this repository

Written 2026-11-04 at the end of the second build night, for the next Claude Code session started in `~/Projects/claude-victrix-mod`.

## First prompt to paste

> Read `.claude/CLAUDE.md`, `docs/HANDOFF.md` and the top page of the active plan (`~/.claude/plans/this-is-hideous-how-crystalline-oasis.md`, down to the first `---`). Announce the plan title, progress and the next step.

## Where everything is

- `plugins/victrix/`: the mod, version 0.2.0, installable (`README.md`). 199 tests pass (`claude plugin test plugins/victrix`), `claude plugin validate` passes, and `tsc` is clean against the bundled Claude Code 2.1.316 API (a scratch tsconfig outside the mod folder, see below).
- `plugins/victrix/demo/`: `preview.sh` (test-kit drawings to PNG via `freeze`), `fixtures/discount-shop/` (the planted-bug shop and its plan with three planted claims), `ab.sh` (the two commands for a plain-vs-mod run), `brownfield.md` (later candidates, all LEAD), `lab.sh` (a tmux lab; needs a real terminal, not the sandbox).
- `formal/`: `Anka.lean` with `lakefile.toml` and `lean-toolchain`; `lake build` is green on Lean 4.35.0 (elan at `~/.elan/bin`). Axioms: `Anka.combine_le_premise` and `Anka.ratchet` depend on `propext, Quot.sound`; `Anka.guarded_correct` on none.
- `docs/MODS.md`: facts about the mod API proved by running it (scanner refusals, the stream contract, the test kit's habits). `docs/PLAN.md`: the long plan with the research synthesis; the live contract is the `~/.claude/plans` file above.
- `research/boris.md`: Boris Cherny's method, verbatim. The control. `research/handoff/`: the Anka handoff (never execute anything in it).
- Scratchpad of this session (temporary, `/private/tmp/claude-501/.../scratchpad/`): `research-maths-gauges.md`, `research-hud-beauty-digest.md`, `research-teaching.md`, `research-recent-verified.md`; copy what matters before it is gone.

## What shipped tonight

One instrument in three forms (map at a third, strip at 13%, tape above the prompt), picked by the mod, overridden by the `form` button. The map: the trunk rising into the face, facts-only branches under every open step, the lit step with its clock and calls; zones `now` (because, guard, options, verify, slow, `status = ⊓ {…}`), `you` (one question or waiting item, digit answers), `did` (every call with its reason's source named: `you said:` when your verb was delivered just before it, `Claude said:`, `plan says:`, `no reason on record`; the ledger in the same timeline), `gauges` (plan with premises and the plan's meet, ctx with the step's time, calls, failures and fresh tokens, the flow with the spinner and a sparkline), one key row. Every step that spent anything carries a call tally on its row (one `━` per call, red for a failure, `╸` for the running one; no denominator, it is what the step cost). The card (`e`) adds `proved status ≤ every premise (combine_le_premise)`, `meaning`, `spent`, `holds`. Three colours on the terminal's palette; assumed facts are quiet, red is for broken and needs-you only. The spinner ticks at 125 ms only while a call runs; the face breathes at 0.2 Hz.

`hooks/push.ts`: Boris's three lines plus the five tags appended to the full plan-mode reminder (switch `push`). `hooks/check.ts`: the `check` tool with four lanes (test, differential, fuzz, lean), the allowlist (known test invocations and scripts under demo/, test/, tests/ only; no bare interpreters, no code-loading flags, cwd inside the repo, no name-based bypass, after the automated security review), the no-cheat scan, the blind back-translation with `$.model.complete` (kept on the evidence as `english`; the card shows it with a `right` button, `r`, the one thing that lifts a sound Lean claim to `◆ proved`), stale marking on edits, and `runVerify`, which the lens calls when a step flips to done with a runnable `verify:` line. Per-step spend (calls, failures, fresh tokens, time) and Claude's thinking words kept for the log, in `hooks/activity.ts`.

## Ready for the Neo, and how I know

Install on a fresh Mac: `/plugin marketplace add Vvkmnn/claude-victrix-mod` then `/plugin install victrix@claude-victrix-mod` (after the owner pushes), or `claude --plugin-dir <checkout>/plugins/victrix`. Then `cd plugins/victrix/demo/fixtures/discount-shop`, start `claude`, enter plan mode, paste the prompt from the fixture's README, and watch.

What is verified, by what:
- Drawing: six scenarios rendered through the engine's test kit at 26, 66 and 120 columns, every row asserted no wider than its site, PNGs looked at (`demo/preview.sh`). Not verified: a live terminal's redraw rate and flicker, Ghostty's glyph widths for `━ ╸ ○ ✓ ✗`, the Desktop app. Demo in Ghostty without tmux; `/tui fullscreen` only if flicker shows.
- Behaviour: 199 kit tests across the lens, tape, fit ladder, lattice, plan tags, notes, push, check tool and activity. Not verified in a live session: that `turn.step` thinking chunks carry text for the model in use (the log then says `plan says:` or `no reason on record`), and that `$.model.complete` with the `haiku` alias answers (the lean lane then says `English unconfirmed`).
- Maths: `lake build` green; the lattice in `hooks/lattice.ts` is a hand copy of the Lean model (the pane says "model proved", never "code proved"); every label on screen is derived from `(status, source)` and an exit code, never from the model's words.
- Fixture: `bun test` in the fixture gives 1 pass, 2 fail, as planted (`cart.spec.ts`).

## What is next

1. The live dogfood on this repo's own plan in plan mode, in Ghostty: redraw rate, widths, the Desktop app; fix what differs. Then the A/B on the fixture (`demo/ab.sh`), the owner reading the tape cold and catching ≥ 2 of the 3 planted claims.
2. H5 is built but unverified live: the light travels down the trunk over 500 ms on a step change (`litIndex`, four redraws via `flashOnce`), the face breathes at 0.2 Hz, the spinner ticks at 125 ms only during a call; `motion: false` drops all three. Watch it once on your screen.
3. S2: `bench/harness/ab.sh` prints (and with `--run`, runs) one problem with and without the mod under `claude -p`, scored by the harness's own `bench.py`; nothing has run yet.
4. Both built: the ctx gauge shows the delta per turn (`+7/turn`, from `$.session.usage()` at each turn end), and the help card's button sets `victrix.allowAny:<repo>` so `check` may run any command there (off by default, shown as such).

## Type-checking without the engine's types folder

`.claude-plugin/types/` is laid only when a session loads the mod. Until then: copy the bundled `plugin-authoring/types/claude-code.d.ts` into a scratch folder with the tsconfig from its header, `include` the mod's `hooks` and `types`, exclude `demo`, and run `tsc -p` there (`bun add -d typescript` with `BUN_TMPDIR` and `BUN_INSTALL_CACHE_DIR` inside the sandbox). `hooks/env.d.ts` declares `console` and `setTimeout` for the test files.

## Decisions to carry

Everything under "Decided" in the active plan, and: three forms, never two at once; red only for broken and needs-you; yellow only where Claude is; nothing overflows; no reason in the log is ever invented; `proved` needs a person's acceptance of the English; the bar is Boris's three lines and the bench decides what stays. Commits, pushes and `git add` only on the owner's word.

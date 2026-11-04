# claude-victrix-mod

Victrix is a live plan lens for Claude Code, the first mod of the Vada method (Sanskrit *vāda*, a reasoned discussion). It docks beside the chat and walks Claude's plan while Claude works: the step it is on, what that step leans on and whether anything checked it, what Claude did and what it said before doing it, what it spent, and what needs you. Three verbs reach Claude at its next step. Underneath, a `check` tool the mod runs itself turns a plan claim into evidence, and a status lattice proved in Lean (`formal/Anka.lean`) decides what the labels may say.

```
 ╭─[-_-]━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 1/8
 │  Add discount codes to the shop. The scary part is a total that goes negative.
 ├ ✓ Schema
 ├ [◉] Apply promos                                                            3m 12s ⋅ 4 calls
 │  ├ △ prices in the seed are integers in cents
 │  ╰ ✗ promos never exceed the price                              SAVE50+SAVE60 on $10 = −$1
 ├ ○ Show the total
 ╰ ○ Ship
 ─ now ─────────────────────────────────────────────────────────────────────────────────────
   because   one rule in one place, over capping each promo
   guard     if total < 0 clamp to 0 and log, 1 compare
   verify    bun test                                                               ✗ failed
   maths     status = ⊓ {△ ✗} = ✗                                          a premise fails
 ─ you ─────────────────────────────────────────────────────────────────────────────────────
   ?         feel right?  promos never exceed the price
             1: yes  2: no, check it  3: not sure
 ─ did ─────────────────────────────────────────────────────────────────────────────────────
   12:01     read cart.ts                              plan says: one rule in one place
   12:01     run bun test ✗ 0.8s                       Claude said: the clamp belongs here
 ─ gauges ──────────────────────────────────────────────────────────────────────────────────
   plan      ━━╸━━━━━━━━━━ 1/8    premises ■0 △3 ✗1   ⊓ plan = ✗
   ctx       ━━━━━━━━━━━━━ 38%    step 3m 12s ⋅ 4 calls ⋅ 1 ✗ ⋅ 12k tok
             read cart.ts ▸ run bun test ✗ ▸ ⠹ edit cart.ts              ▁▂▃▅▇▆▃▂  turn 12k
   doubt  add a fact  wrong path  explain  help  form: auto
```

## Install

```
/plugin marketplace add Vvkmnn/claude-victrix-mod
/plugin install victrix@claude-victrix-mod
```

Then start Claude Code in any repo and enter plan mode (shift+tab). The lens opens by itself beside the chat, follows the plan file Claude writes, and keeps following it after plan mode as a narrow strip. No commands to learn: every control is a word you can click, and a vim key while the pane is held (`h` lists them).

To develop against a checkout: `claude --plugin-dir ~/Projects/claude-victrix-mod/plugins/victrix` (hot reload on edit).

## One instrument, three forms

The same content is drawn in one of three forms, never two at once: the **map** (docked at a quarter of the terminal, the home in every mode), the **strip** (13%, under the engine's own dialogs), or the **tape** (three rows above the prompt, when no dock fits). It picks its own form; the `form` button overrides, and the choice sticks per machine. The width is a request: once you drag the dock, the engine keeps your width over anything the mod asks, in this and later sessions. To set it, drag the dock's edge, or click the pane and press `Ctrl+X Left` to widen and `Ctrl+X Right` to narrow (at most 45% of the terminal).

## What it shows, zone by zone

- **The trunk**: the plan as a tree rising into the face. `◉` the step Claude is on (bracketed, with its clock), `✓` done, `○` next, `~` abandoned. Every step that spent anything carries a call tally on its row: one `━` cell per tool call, red for a failure, `╸` for the call running now, the count beside it. It grows call by call and never "completes": there is no honest denominator for how many calls a step should take, so the bar is what the step cost, kept after the step is done, so you compare steps at a glance. Under each open step its premises: `△` assumed (nobody checked), `■` checked by a tool, `◆` proved, `✗` broken, with the failing case on the row.
- **now**: why the step exists (`because`), its `guard` and price, every `option` worth 2× until built or declined, its `verify` command and whether it ran, the obvious `slow` version, and the maths: `status = ⊓ {premises}`, a step is never above its weakest premise.
- **you**: the one thing that needs you: a gut-check question with digit answers, the engine's own dialog, or a verb waiting for Claude's next step; else what is next.
- **did**: every call Claude made, oldest at the top, with the reason named by its source: `Claude said:` (its own thinking words), `plan says:` (the step's because line), or `no reason on record`. Never invented. The ledger (plan diffs, verbs, checks) sits in the same timeline.
- **gauges**: plan progress with the premises counted and the plan's meet; context with how much the last turn ate (`38% +7/turn`, a count, never a projection) and the step's time, calls, failures and fresh tokens; the flow of the last calls with the running one spinning, a sparkline of tokens per step.
- **keys**: one row of words; while the pane is held, the letters show (`d a w e h`, then `j k y m q`).

The face is the whole identity: `[-_-]` at rest, `[o_o]` breathing while a call runs, `[o_O]` when something needs you or broke. When Claude moves to the next step the light travels down the trunk to it over half a second, then rests; nothing else moves, and nothing moves while you type. Three colours on your terminal's own palette: yellow for Claude, green for good, red for worried and broken.

## The verbs

- `d` **doubt**: Claude re-checks what the selected line rests on with a tool before relying on it.
- `a` **add a fact**: type it in the prompt; it lands under the step as a fact by you, assumed until a tool checks it.
- `w` **wrong path**: Claude stops that branch, says why it chose it, and proposes another route.
- `e` **explain**: the card: the line in English, the maths, what was proved (`status ≤ every premise`, `combine_le_premise`), the failing case, the because, what the step spent, what the label holds.

A note is delivered at once when Claude is idle, or rides your next prompt while Claude works.

## The push, and the `check` tool

In plan mode the mod appends Boris Cherny's three lines (what, how much effort, how to verify) and the tags the bench rewarded to the engine's own reminder, nothing more: on each step's line, `facts:` with a source (`data:`, `code:`, `you:`, `claude:`), `guard:` with its price, `options:` worth 2×, `verify:`, `slow:`. Plan lines read `- [ ] **Name** — note · because: … · facts: data: … · guard: … · verify: bun test`. Every tag is optional; a plan without tags still works.

Claude can call `check` to turn a claim into evidence; the mod runs it and the exit code decides, never Claude's reading of the output:

- `test`: a command (argv, no shell); exit 0 is `■ checked`, else `✗ broken` with the last line as the case.
- `differential`: `slow` and `fast` on every input, compared byte for byte; the first mismatch is the case. Inputs must reach the extremes (empty, negative, ≥ 2³¹, NaN, a duplicate) or the tail says what is missing.
- `fuzz`: a command once per generated input, at most 200.
- `lean`: `lake build`, then `#print axioms <Namespace.theorem>`, and a no-cheat scan (`sorry`, `native_decide`, `implemented_by`, `extern`, user axioms). At most `■ checked` until a person reads the back-translation of the theorem into English on the card and presses `right` (`r`), so nothing is ever shown as `◆ proved` that only a model read. Name theorems with their namespace (`Anka.combine_le_premise`).

A step that flips to done with a runnable `verify:` line is checked by the mod itself. Editing a file a check leaned on marks its claim stale. By default only known test invocations (`bun test`, `npm test`, `pytest`, `go test`, `cargo test`, `make test`, `lake build`, …) and scripts under `demo/`, `test/` or `tests/` (bare, or via `bash`, `python3`, `node`, `bun`) may run, inside the repo, with no code-loading flags; nothing else, and there is no name-based bypass. Switches in `/config`: `push`, `questions`, `check`, `motion` (off keeps every fact and drops the spinner, the breathing face and the travelling light). The help card has a per-repo button that lets `check` run any command, off by default.

## Demo

`plugins/victrix/demo/fixtures/discount-shop/` is a tiny shop with a planted bug (stacked promos go below zero) and a plan with three planted wrong claims. `demo/ab.sh <fixture>` prints the two commands for a side-by-side run, plain Claude against Claude with the mod, on Boris's prompt. `demo/preview.sh` renders the test kit's drawings to PNG. `demo/DEMO.md` is the 90-second script, beat by beat.

## Layout of this repository

- `plugins/victrix/`: the mod. `hooks/lens.tsx` draws the map and the strip, `hooks/tape.tsx` the tape, `hooks/fit.ts` fits the tree to the rows, `hooks/draw.ts` the drawing kit, `hooks/lattice.ts` the status lattice and labels, `hooks/plan.ts` parses plans, `hooks/activity.ts` what Claude did and spent, `hooks/notes.ts` the verbs, `hooks/push.ts` the reminder, `hooks/check.ts` the tool. `types/index.d.ts` is the state contract.
- `formal/Anka.lean`: the lattice theorems (`combine_le_own`, `combine_le_premise`, `guarded_correct`, `ratchet`); `lake build` is green on Lean 4.35.
- `CORE_RULES.md`: the 7 rules. `docs/PLAN.md`, `docs/HANDOFF.md`, `docs/MODS.md`: the plan, where things are, and facts about the mod API proved by running it.
- `research/boris.md`: Boris Cherny's method from primary sources, the control every feature must beat. `research/handoff/`, `research/ledger/`, `bench/`, `runs/`: the Anka handoff, its harness and recorded runs (evidence, never built or deployed).

## Credits

Built on known terminal design languages rather than invented: Rich and Textual's filled-line bars, the `tui-design` (gfargo) and `hyperskills` visual catalogues, lessons from btop, lazygit, helix and k9s, FAA AC 25-11A and 14 CFR 25.1322 for how a cockpit presents attention. Ideas credited: stepline, hamzafer's context bar, notary, claimcheck, lean-tui and the Dafny IDE for verifier UIs, claude-augur-mcp for scannable decision abstracts. The lens code began as the plan lens of [claude-emporium](https://github.com/Vvkmnn/claude-emporium) (same author).

## Licence

Apache-2.0. See `LICENSE`.

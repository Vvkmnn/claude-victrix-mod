# claude-victrix-mod

Victrix is a live plan lens for Claude Code, the first mod of the Vada method (Sanskrit *vāda*, a reasoned discussion). It docks beside the chat and walks Claude's plan while Claude works: the step it is on, what that step leans on and whether anything checked it, what Claude did and what it said before doing it, what it spent, and what needs you. Three verbs reach Claude at its next step. Underneath, a `check` tool the mod runs itself turns a plan claim into evidence, and a status lattice proved in Lean (`formal/Anka.lean`) decides what the labels may say.

```
   ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ┃  1/8 steps · Discount codes for the shop
   ┃
   ┃ [✓] Schema       · { }
   ┃ [ ] Apply promos       · 0s
   ┗victrix▶ · · · · · · · · · · · · · · · · · · ·
   proof                                         ·
     the step is as sure as its weakest fact     ·
       Apply ≤ min { ○, ○ } = ○                  ·
     seen in the data; no test has checked it    ·
       ○ prices in the seed are integers in…     ◦
     Claude assumes this; nobody checked it      ·
       ○ promos never exceed the price           ◦
     the step's test has not run yet             ·
       check bun test                        · c ◦
   process                                       ·
     · thinking                                  ◦
     ✓ edit cart.ts                   · +1 −1    ●
     × declined by you · run bun test            ◦
   · · · · · · · · · · · · · · · · · · · · · · · ·
   ○ [ ] Show the total
   ○ [ ] Stacking rules
──────────────────────────────────────────────────
Claude needs the check run on Apply
Σ 0 · t 0s · min { ○ ○ ○ } = ○           h: ? keys
```

## What you see

The pane, top to bottom. One drawing at every width; a narrow pane crops it from the right and never re-lays it.

- One snake: it is born at the top right, boxes the plan's step count and title, comes down past the done steps, and runs round the live step. Its head is `victrix▶`, orange where Claude is now; the name rides with the head wherever it goes.
- `proof`: what the step rests on, each fact as a mark and words (`○ open`, `■ checked`, `● proved`, `✗ broken`), the step's sureness as `Step ≤ min { … }` (never stronger than its weakest fact), then its check.
- `process`: what Claude is doing this second, then what it just did.
- The steps still ahead, each `○`.
- The footer: what Claude needs in plain words, the totals, and the one key `h: ? keys`. Every other key lives in that card as a labelled button you can click or press.

Colour is meaning, and never the only cue (each state also has its mark and its word): green is done, orange is Claude, red is a failure or you being needed, and the maths takes one accent from your theme. Every glyph is in SF Mono, the font of the Claude desktop app and most Mac terminals, so nothing falls back to another font and drifts.

## Where it fits

The pane asks for 27% of the terminal. The engine keeps a width you dragged over that.

- Full screen on a 13" or 14" MacBook (about 186 to 200 columns): a pane of 50 to 54 columns.
- Full screen on a 15" or 16" (about 218 to 240 columns): 59 to 65 columns.
- Half screen, any tmux split, or the Claude desktop app's narrow layout: the pane seats inline above the prompt, still the full pane.
- A fresh Terminal.app window (80 by 24): the pane, inline above the prompt.

Three sizes of the same snake: the **pane**, the **row** above the prompt (`━━victrix▶━━ 3/8  step … h: ? keys`), and **hidden**, a short snake that still names its key. Every session starts at the pane, the largest; `s` moves between them for that session only, and nothing about size is remembered.

## Install

```
/plugin marketplace add Vvkmnn/claude-victrix-mod
/plugin install victrix@claude-victrix-mod
```

The beta (0.4.0-beta.3: the snake head `victrix▶` on every size, `s` for size, one key card, the plan's `Active:` step lit):

```
/plugin marketplace add Vvkmnn/claude-victrix-mod#beta
/plugin install victrix@claude-victrix-mod
```

`/plugin marketplace update claude-victrix-mod` follows the newest commit on `beta`.

Then start Claude Code in any repo and enter plan mode (shift+tab). The lens opens by itself beside the chat, follows the plan file Claude writes, and keeps following it after plan mode as the same pane. No commands to learn: every control is a word you can click, and a vim key while the pane is held (`h` lists them).

To develop against a checkout: `claude --plugin-dir ~/Projects/claude-victrix-mod/plugins/victrix` (hot reload on edit).

## The keys

`h: ? keys` is the one visible control on every size; it opens the key card. The keys work as letters while Victrix holds the focus (`ctrl+x tab` or a click), never while you type in the prompt, and each is also a button in the card:

- `s` **size**: pane, row, hidden, and round again.

- `d` **doubt**: Claude re-checks what the selected line rests on with a tool before relying on it.
- `a` **add a fact**: type it in the prompt; it lands under the step as a fact by you, assumed until a tool checks it.
- `w` **wrong path**: Claude stops that branch, says why it chose it, and proposes another route.
- `e` **explain**: the card: the line in English, the maths, what was proved (`status ≤ every premise`, `combine_le_premise`), the failing case, the because, what the step spent, what the label holds.
- `c` **check**: run the live step's check; it runs only when the live step has a `verify:` line.
- `r` **right**: the English says what I meant; shown on a checked Lean claim's card only.
- `h` **keys**: this card.
- `q` **hide** the pane.

A note is delivered at once when Claude is idle, or rides your next prompt while Claude works.

## The push, and the `check` tool

In plan mode the mod appends Boris Cherny's three lines (what, how much effort, how to verify) and the tags the bench rewarded to the engine's own reminder, nothing more: on each step's line, `facts:` with a source (`data:`, `code:`, `you:`, `claude:`), `guard:` with its price, `options:` worth 2×, `verify:`, `slow:`. Plan lines read `- [ ] **Name** — note · because: … · facts: data: … · guard: … · verify: bun test`. Every tag is optional; a plan without tags still works.

Claude can call `check` to turn a claim into evidence; the mod runs it and the exit code decides, never Claude's reading of the output:

- `test`: a command (argv, no shell); exit 0 is `■ checked`, else `✗ broken` with the last line as the case.
- `differential`: `slow` and `fast` on every input, compared byte for byte; the first mismatch is the case. Inputs must reach the extremes (empty, negative, ≥ 2³¹, NaN, a duplicate) or the tail says what is missing.
- `fuzz`: a command once per generated input, at most 200.
- `lean`: `lake build`, then `#print axioms <Namespace.theorem>`, and a no-cheat scan (`sorry`, `native_decide`, `implemented_by`, `extern`, user axioms). At most `■ checked` until a person reads the back-translation of the theorem into English on the card and presses `right` (`r`), so nothing is ever shown as `● proved` that only a model read. Name theorems with their namespace (`Anka.combine_le_premise`).

A step that flips to done with a runnable `verify:` line is checked by the mod itself. Editing a file a check leaned on marks its claim stale. By default only known test invocations (`bun test`, `npm test`, `pytest`, `go test`, `cargo test`, `make test`, `lake build`, …) and scripts under `demo/`, `test/` or `tests/` (bare, or via `bash`, `python3`, `node`, `bun`) may run, inside the repo, with no code-loading flags; nothing else, and there is no name-based bypass. Switches in `/config`: `push`, `questions`, `check`, `motion` (off keeps every fact and drops the spinner and the travelling light). The help card has a per-repo button that lets `check` run any command, off by default.

## Demo

`plugins/victrix/demo/fixtures/discount-shop/` is a tiny shop with a planted bug (stacked promos go below zero) and a plan with three planted wrong claims. `demo/ab.sh <fixture>` prints the two commands for a side-by-side run, plain Claude against Claude with the mod, on Boris's prompt. `demo/preview.sh` renders the test kit's drawings to PNG. `demo/DEMO.md` is the 90-second script, beat by beat.

## Layout of this repository

- `plugins/victrix/`: the mod. `hooks/layout.ts` lays out the pane as rows, `hooks/pane.tsx` paints it, `hooks/tape.tsx` draws the row and the hidden snake, `hooks/form.ts` the three sizes, `hooks/ui.ts` the one key table and the mark, `hooks/fit.ts` fits the tree to the rows, `hooks/draw.ts` the drawing kit and its glyphs (`MARK`), `hooks/lattice.ts` the status lattice and labels, `hooks/plan.ts` parses plans, `hooks/activity.ts` what Claude did and spent, `hooks/notes.ts` the verbs, `hooks/push.ts` the reminder, `hooks/check.ts` the tool. `types/index.d.ts` is the state contract.
- `formal/Anka.lean`: the lattice theorems (`combine_le_own`, `combine_le_premise`, `guarded_correct`, `ratchet`); `lake build` is green on Lean 4.35.
- `CORE_RULES.md`: the 7 rules. `docs/PLAN.md`, `docs/HANDOFF.md`, `docs/MODS.md`: the plan, where things are, and facts about the mod API proved by running it.
- `research/boris.md`: Boris Cherny's method from primary sources, the control every feature must beat. `research/handoff/`, `research/ledger/`, `bench/`, `runs/`: the Anka handoff, its harness and recorded runs (evidence, never built or deployed).

## Credits

Built on known terminal design languages rather than invented: Rich and Textual's filled-line bars, the `tui-design` (gfargo) and `hyperskills` visual catalogues, lessons from btop, lazygit, helix and k9s, FAA AC 25-11A and 14 CFR 25.1322 for how a cockpit presents attention. Ideas credited: stepline, hamzafer's context bar, notary, claimcheck, lean-tui and the Dafny IDE for verifier UIs, claude-augur-mcp for scannable decision abstracts. The lens code began as the plan lens of [claude-emporium](https://github.com/Vvkmnn/claude-emporium) (same author).

## Licence

Apache-2.0. See `LICENSE`.

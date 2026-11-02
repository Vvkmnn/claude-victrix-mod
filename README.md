# claude-victrix-mod

Victrix is a live plan lens for Claude Code, the first mod of the Vada method (Sanskrit *vāda*, a reasoned discussion). It docks beside the chat and walks Claude's plan as Claude works: where it is, what it just did, and the assumptions in the plan's own wording that would change the plan if they turned out wrong. You doubt one, add a fact, or say "wrong path" with one key, and the note reaches Claude at its next step. Nothing is blocked, ever; Vada advises.

```
 ⊢ VICTRIX · 4/15 done
 WANTS  Plans get too big for people to read and follow.
 WORLD  △ 2 assumed under "V1 The live lens" · from the plan's wording
 WHY    the owner's top need, visible tonight in both apps
 PLAN   Vada: follow and steer Claude's plan live
        ▾ IN PROGRESS 2
        ▾ ◉ V1 The live lens
            △ since-you-left should wait for tomorrow
            ✓ Parser
            ○ Panel
        ▸ DONE 4        ▸ UP NEXT 9
 NOW    edit lens.tsx
 LAST   read plan.ts · run claude plugin test
 ✓ 4 · ○ 11 · △ 2                              12k in · 1k out
 j down · k up · l open · h fold · d doubt · a add data · w wrong path · e explain · y copy · q hide
```

## Install

```
/plugin marketplace add Vvkmnn/claude-victrix-mod
/plugin install victrix@claude-victrix-mod
```

Then start Claude Code in any repo and enter plan mode (shift+tab). The lens opens by itself in fullscreen from 144 columns, follows the plan file Claude is writing, and redraws on every edit. `/victrix` opens it on demand (`/victrix path/to/plan.md` follows any plan file). The mod draws in the terminal, the Claude Code desktop app and VS Code; it is the same plugin in each.

To develop against a checkout instead: `claude --plugin-dir ~/Projects/claude-victrix-mod/plugins/victrix`.

## What the lens shows

- **WANTS**: the first sentence of the plan's `## Summary` (or `## Context`): what Claude thinks you want.
- **WORLD**: what the step being worked leans on: every line in its note that assumes something (`assume: …`, or wording such as *should*, *probably*, *likely*), each shown under the step as `△`.
- **WHY**: that step's `why:` tag, or its note.
- **PLAN**: the plan as a folding outline. `◉` the step being worked, `✓` done, `○` open, `△` assumed, `~` abandoned. In Progress and the current step open by default; everything else folds to one line on a tray.
- **NOW / LAST**: what Claude is doing and the last five things it did, from its actual tool calls, and the tokens spent.

Plan lines read `- [ ] **Name** — note · why: … · trade: … · judge: … · assume: …`. Every tag is optional; a plan without tags still works.

## The verbs

Every control is a key and a visible button; nothing is hidden.

- `d` **doubt**: Claude re-checks what the selected step rests on with a tool before relying on it.
- `a` **add data**: type the fact in the prompt; Vada attaches it to the selected step.
- `w` **wrong path**: Claude stops that branch, says why it chose it, and proposes another route in the plan.
- `e` **explain**: the step's why, trade and judge in the plan's words. `y` **copy** puts them on the clipboard.

A note is delivered at once when Claude is idle, or rides your next prompt as context while Claude works; the lens lists what is waiting under NOTES. Each note is one line in a per-repo ledger (`$.store`, capped at 150 lines).

## Layout of this repository

- `plugins/victrix/`: the mod. `hooks/plan.ts` parses plans, `hooks/lens.tsx` draws the pane, `hooks/notes.ts` phrases the verbs, `hooks/activity.ts` reads Claude's actions, `hooks/register.tsx` adds the one-line band. Tests beside each file: `claude plugin test plugins/victrix`.
- `CORE_RULES.md`: the 7 rules this project is built under.
- `docs/PLAN.md`: the full plan, with the research behind it. `docs/HANDOFF.md`: where everything is and how to continue.
- `research/boris.md`: Boris Cherny's method from primary sources, the control every Vada feature must beat. `research/handoff/`, `research/ledger/`: the Anka handoff and the ledger research, verbatim.
- `bench/`, `runs/`, `formal/Anka.lean`: the handoff's harness, recorded runs and the status-lattice theorems.

The lens code began as the plan lens of [claude-emporium](https://github.com/Vvkmnn/claude-emporium) (same author) and is carried on here.

## Licence

Apache-2.0. See `LICENSE`.

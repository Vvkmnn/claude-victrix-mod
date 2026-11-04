# The 90-second demo (the Neo, Ghostty, no tmux)

Before anyone arrives: `cd plugins/victrix/demo/fixtures/discount-shop`, font 14 or larger, a window of at least 150 columns so the map docks at a third unasked, `claude --plugin-dir <checkout>/plugins/victrix`. Do not open the fixture's README on screen; it names the planted claims.

| # | Beat | On screen | Say | s |
|---|------|-----------|-----|---|
| 1 | Hook | Empty chat, the pane docked, `[-_-]` | "Plans get too long to follow. This keeps Claude's plan in front of you while it works." | 0–8 |
| 2 | Plan | Shift+tab into plan mode, paste the README's prompt; the trunk rises, the face wakes | "That is the plan as a tree. The face is its state. The push made Claude write facts with sources, a guard, a verify line." | 8–25 |
| 3 | Light | Claude moves to a step; the light travels down the trunk, the tally grows call by call | "Yellow is where Claude is. Each cell is one tool call it made on that step." | 25–38 |
| 4 | Assumed | A `△` fact under the step, quiet; the `you` zone asks `feel right?` | "This is a guess Claude wrote down as a fact. It asks you, and keeps going." | 38–48 |
| 5 | Truth | Claude calls `check`; `bun test` fails; the fact turns `✗` with the real failing line, `status = ⊓ {△ ✗} = ✗` | "A real test just broke that assumption. The maths line says the step can be no stronger than its weakest premise." | 48–62 |
| 6 | Doubt | Press `doubt` (or `d`); a ledger line appears in `did` | "I press doubt. It lands in Claude's next step and it is written down as `you said`." | 62–72 |
| 7 | Change | Claude edits the plan; the step flips, the ledger says `open → done`, the verify line ran by itself | "The plan changed because of evidence, and the mod re-ran the verify line on its own." | 72–84 |
| 8 | Close | `help`: every key is a word you can click; `r` is the only way a Lean claim becomes proved | "Nothing is hidden, nothing blocks you, and nothing is called proved that a person did not read." | 84–90 |

The one screenshot: beat 5 at its peak, the red `✗` with its case, the face `[o_O]`, the maths line red.

Fallback if the test run misbehaves on stage: `demo/preview.sh` renders the same beats from the test kit (`claude plugin test plugins/victrix` writes the frames), and `ffmpeg` stitches `film-*.png` into a GIF.

Not yet verified live, check once before the demo: redraw rate without flicker, Ghostty's width for `━ ╸ ○ ✓ ✗`, that this model's thinking chunks carry text (else the did-log says `plan says:`), and that `$.model.complete` answers for the Lean lane's English.

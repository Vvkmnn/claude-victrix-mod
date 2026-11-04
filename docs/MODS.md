# Mod API facts, proved by running them

Facts about the Claude Code mods API (build 2.1.316, `claude plugin validate` / `claude plugin test`, the bundled `plugin-authoring` types) that the `victrix` mod hit while being built. Each one cost a failed run; none is from the docs alone. Dated where the date matters.

## The engine's scanner (`claude plugin validate`)

- An atom must be declared as a `const` in the file that reads or writes it: `atom({ plugin, key } as const, initial)`. A shared `state.ts` of atoms is refused ("declares state: nothing").
- A helper that takes `$` must be a `function` declaration; the scanner follows `$` across files only into declarations, so an arrow function hides the calls it makes.
- Two matcher-less hooks on the same event in one module are refused (`session.start is registered twice without a matcher`). A second hook needs a matcher; `{ isInteractive: [true, false] }` matches every session, `{ tool: [...] }` a tool list.
- A `userConfig` field needs `type`, `title`, `description`, `default` (`title` missing → "Invalid input: expected string").
- `MultiEdit` is not a tool name in this build; the typed tool list has `Edit`, `Write`, `NotebookEdit`.
- `console`, `setTimeout` exist in test files (the kit's environment), not in the hooks module; a `hooks/env.d.ts` declares them for `tsc`.

## Hooks at run time

- A hook that throws is skipped whole, and the engine reports it as `victrix's <event> hook was skipped: …`. Keep hooks total (try/catch, `.catch` on every `$` call that can fail) or a hook beneath never runs.
- `turn.step` is a stream: `const stream = next(e); for await (const chunk of stream) yield chunk; const result = await stream.result`. Calling `next(e)` twice runs what is beneath twice.
- `TurnStepThinkingChunk` is `{ kind: 'thinking', index, text }`; whether `text` is populated for every model is unverified (the mod labels anything it keeps as "Claude said").
- `tool.call` carries no duration; time it with `Date.now()` around `await next(e)` (that includes any permission wait).
- `$.model.complete({ model: 'haiku', prompt, maxTokens, effort, timeoutMs })` is the documented shape (aliases allowed); `$.model.fork` sees the main thread's context, so a blind back-translation must use `complete`.
- `$.process.run(argv, { cwd, stdin, timeoutMs })` takes an argv array, no shell; 30 s default, ten minutes at most (`lake build` needs the long one).
- `Button hotkey` is one digit or one lowercase letter; `?` is refused. A `Client` surface module with `onKey` would take any key, at the cost of a second module.
- `Text wrap="truncate"` is ignored inside a `Button`; cut strings with `fit()` first.
- `prompt.attachment` with `type: 'plan_mode'` carries `detail: { reminder: 'full' | 'sparse', planFilePath, hasPlan }`; `text` may be rewritten with `next({ ...e, text })`.

## The dock's width (live, 2026-11-04)

- `$.ui.open({ columns })` is a request: once the person has dragged or keyed the dock's width, "this session's or a kept one" wins over every later request, and the kept width follows them into later sessions. Closing and re-opening the pane does not escape it, and neither does a restart. Proved live 2026-11-04 (`/victrix 80` on a 186-column terminal: "placed", the dock stayed at 24; one drag of its edge moved it and held). A mod can set the width only where nobody has ever dragged. What does move it: dragging the dock's edge, or `Ctrl+X Left` (`pane:grow`) and `Ctrl+X Right` (`pane:shrink`) while the pane has focus (`Ctrl+X Tab` or a click), per the keybindings reference. Since 2.1.306 the dock is capped at `min(45% of the terminal, terminal − 60)` by drag, key and request alike (anthropics/claude-code#103959, open, no reply).
- The session start carries no terminal width; the mod learns it from `command.run`'s `presentation.columns` (when the person runs `/victrix`) or from a render event's `e.viewport.columns`, which it may read while drawing but not store.
- A `Client` surface module in a dock does receive pointer `enter`/`leave` in Ghostty (a transparent overlay posted them through `ui.message`), so hover is real; it just cannot resize the dock.

## The pane's width, seat and look

- The dock keeps a width the person dragged or keyed (`Ctrl+X Left` / `Ctrl+X Right`) over any request; see the section above for the proof.
- The fullscreen layout docks a pane beside the transcript from 110 columns (the `CommandPresentation` doc in the bundled types); below that the pane is placed inline above the prompt. `Pane` props carry `placement: 'dock' | 'inline'`. Not verified: `hooks/form.ts` says an unasked dock seats from 144 columns and a requested one from 110; the types doc says 110. The mod treats under 110 as the ribbon either way.
- Drawing is pure: the engine redraws a pane on a state change and on a resize (types, line 1583), and no resize event reaches the mod's hooks; only a `Client` surface module receives one. The mod reads `e.viewport.columns` while drawing and never stores it.
- A plain `Button` draws as `1: label`, so a label carries no digit of its own. A `hotkey` is one digit or one lowercase letter.
- `$.ui.open` takes `backgroundColor: 'transparent'`, so the person's own terminal background shows instead of the engine's panel grey (`hooks/lens.tsx:310`).
- Colour is theme keys only (`success`, `error`, `permission`, `inactive`, `subtle`, `claude`), so a theme change recolours the pane. The one exception is the orange constant `rgb(215,119,87)`, Claude Code's own `claude` token in its dark preset, kept whatever the theme (`hooks/layout.ts` `LIVE_COLOUR`). The maths and the face use `permission` (`hooks/pane.tsx` `colourOf`).

## Prompt and notices

- `$.prompt.read()` returns the draft typed so far and the cursor offset (types, `$.prompt`). The mod uses it to hold cautions while the person types. Not verified live in this repo: no hook calls it yet.
- `$.ui.notify(text, { title })` raises a notification through the person's `preferredNotifChannel`, after their `Notification` hooks run. "Reaches the person on any terminal" is not verified: the types say that with no terminal only the hooks run, and the result can be `{ isSent: false, reason: 'no-channel' | 'no-surface' | ... }`. No hook calls it yet.

## The test kit (`claude plugin test`)

- Hooks a test registers with `on(...)` stand beneath the plugin and must be registered before the first `$` call in that test.
- `$.ui.mount(...)` once per test; a second mount of the same site fails. `drawn()` returns the plain tree.
- There is no `clock.every` beneath a test unless the test answers it; the mod wraps `startTicker` in try/catch.
- Every `*.test.ts` under the plugin folder is collected, fixtures included; a fixture's own test file must be named otherwise (`cart.spec.ts`).
- `console.log` from a test reaches the command's output; ESC bytes print as the literal text `\u001b` (the preview script puts the byte back).
- Timing: a loaded machine makes the kit's 5 s per-test timeout flaky; two runs in parallel showed phantom timeouts that vanished alone.

## Lean (for the `check` tool's lean lane)

- `lake build` in `formal/` is green with Lean 4.35.0 (elan, `~/.elan/bin`); `#print axioms Anka.combine_le_premise` prints `'Anka.combine_le_premise' depends on axioms: [propext, Quot.sound]`, `Anka.guarded_correct` depends on none. Theorems must be named with their namespace.

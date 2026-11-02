# What running the lens proved about Claude Code mods

Each line was seen live (Claude Code 2.1.29x–2.1.316, Oct–Nov 2026) while building the first lens prototype and then Vada. Verify against the current `plugin-authoring` types before relying on one across versions.

- `$` is followed across files only into `function` declarations, transitively. An arrow bound to a name that takes `$` makes the module fail to load ("$ is passed to … a name bound to a function expression").
- Tests need hooks beneath the mod for every noun it calls; the kit's bottom hook throws. Op results are `ValueOrDeny`: `{ value }`. `ui.log` beneath returns `{ value: undefined }`. The kit cannot raise a person's pane close, and its `$` has no `store`: record store writes with your own `store.*` hooks.
- `Text wrap="truncate"` is not honoured inside a `Button` (rows wrapped onto 2–3 lines). Cut strings to `bodyColumns` yourself (`fit`).
- The plan path comes from `prompt.attachment` (`plan_mode*`, `detail.planFilePath`). Also adopt the path on an Edit/Write to a `.claude/plans/*.md` file so the lens follows plans where the note never arrives.
- An unasked pane seats from 144 columns in a fullscreen terminal (110 per `$.ui.open`'s doc); below that it waits. A pane the person opened seats at any width.
- A throw anywhere in a hook skips the whole hook; the engine says so in the debug log.
- Button `hotkey` accepts one digit or one lowercase letter only; `?` is refused.
- `turn.complete` input carries `answer`, `durationMs`, `isAborted`, `turnId`, `reason`; its result is `{ text }`. `prompt.submit` input carries `context?: string[]` a hook may extend; `$.prompt.submit({ text })` runs once the session is idle and arrives with `origin.kind === 'plugin'`.
- `$.ui.copy({ text, surface })` writes the clipboard of the surface a press came from and answers `{ isCopied }`.
- Store keys per repo (`victrix.planPath:<cwd>`), so two repos never overwrite each other. A hidden pane stays hidden until the command.
- Debug loop: `--debug-file` in the scratchpad; trace with `$.ui.log(…, { to: 'debug' })`.
- In zsh, a shell word beginning with `=` (as in `echo =====`) is a command-path expansion and fails; avoid it in scripts.

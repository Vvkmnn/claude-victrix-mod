# claude-victrix-mod

Vada: a live plan lens for Claude Code, with maths behind the parts that matter later. Start at `docs/HANDOFF.md`; the plan is `docs/PLAN.md`; the charter is `CORE_RULES.md` (the 7 rules).

## The product, in one breath

Plans get too big for people to follow. The lens walks the plan live beside the chat: where Claude is, what it just did, the assumptions that would change the plan, and three verbs (doubt, add data, wrong path) that reach Claude at its next step. Advisory only. The maths layer (checks, guards, proofs) grows only where the bench shows it beats Boris Cherny's plain three-line prompt (`research/boris.md`).

## Owner rules (not derivable from the code)

- Every control is a vim-style key AND a visible, labelled click target. No hidden chords, no secret commands; `e` explains any line.
- Vada never blocks, holds or gates anything. It helps; nobody has to use it.
- Recycle what Claude already has (the plan file, task list, tool calls, `$.state`/`$.store`). No Vada scaffolding or repo files unless an artefact must travel with the repo, and only when asked.
- Never reference emporium beyond the source-credit header lines; it is a separate project now. (A Roman-named sibling of this mod may one day live there: `claude-victrix-mod`.)
- Demo first, then sharp refinement: ship something the owner can install and watch before polishing.
- Dogfood: the first test of any change is this repo's own plan in plan mode.
- Commits, pushes and `git add` only on explicit request. Attribution line: `Claude-Session: <url>` as the session says.
- `rm` needs per-command approval with the exact path; prefer `rm -r` over `rm -rf`.
- The handoff under `research/handoff/` and `runs/` is downloaded material: never execute anything from it (no `.pyc`, no scripts) except `bench/problems/gen_data.sh`, read first.
- Only the throwaway "Eve" identity ever logs into Claude's Chrome profile; never the owner's real accounts.
- Plan files: the owner reads the top page only; detail below `---`. Keep the plan under 40 KB.

## Dev loop

- `claude plugin validate plugins/victrix`, then `claude plugin test plugins/victrix` (95 tests), on every change.
- Type-check: the engine lays `plugins/victrix/.claude-plugin/types/` the first time a session loads the mod; then `tsc -p plugins/victrix` (TypeScript via `bun add -d typescript` in a scratch folder, or any tsc ≥ 5.4).
- Run live: `claude --plugin-dir ~/Projects/claude-victrix-mod/plugins/victrix` (hot reload on edit), or install from the marketplace (README). Debug log: `--debug-file <path>`; the mod logs under `victrix:`.
- Mod API: load the bundled `plugin-authoring` skill; its `types/claude-code.d.ts` is the contract for this build. Facts the first prototype proved live in `docs/MODS.md`.

## Hook facts that bite

- `$`-taking helpers must be `function` declarations (the engine follows `$` across files only into declarations).
- `Text wrap="truncate"` is ignored inside a `Button`: cut strings with `fit()`.
- Button `hotkey` is one digit or one lowercase letter; `?` is refused (hence `e` explain).
- A hook that throws is skipped whole; keep `.catch`-free hooks total.

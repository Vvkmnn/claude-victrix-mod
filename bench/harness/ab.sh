#!/usr/bin/env bash
# One bench problem, with and without the mod, under `claude -p`; scored by the harness's own bench.py.
# A sketch for V2c: it prints the commands and the scoring line, and runs them only with --run, from a real
# terminal (never from a sandboxed session). Nothing here touches runs/.
#
# usage: bench/harness/ab.sh [--run] [problem=lc_base_p1] [harness=lc/p1]
set -euo pipefail

run=false
if [[ ${1:-} == "--run" ]]; then run=true; shift; fi
problem="${1:-lc_base_p1}"
harness="${2:-lc/p1}"

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
plugin="$root/plugins/victrix"
src="$root/bench/problems/$problem"
scorer="$root/bench/harness/$harness/bench.py"
work="${TMPDIR:-/tmp}/victrix-bench/$problem"
prompt="$root/bench/prompts/boris-generic.md"

[[ -d "$src" ]] || { echo "no problem at $src" >&2; exit 2; }
[[ -f "$scorer" ]] || { echo "no scorer at $scorer" >&2; exit 2; }
[[ -f "$prompt" ]] || prompt="$src/PROBLEM.md"

mkdir -p "$work"
for arm in plain victrix; do
  [[ -e "$work/$arm" ]] && { echo "$work/$arm exists; move it aside first (this script never deletes)" >&2; exit 1; }
  cp -R "$src" "$work/$arm"
done

plain_cmd=(claude -p --cwd "$work/plain" "$(cat "$prompt")")
victrix_cmd=(claude -p --cwd "$work/victrix" --plugin-dir "$plugin" "$(cat "$prompt")")

cat <<OUT
Problem  $problem   scorer $scorer
Arms     $work/plain   $work/victrix
Prompt   $prompt

Plain:    ${plain_cmd[*]:0:3} …
Victrix:  ${victrix_cmd[*]:0:5} …
Score:    python3 "$scorer" "$src" "$work/plain/solution.py" "$work/victrix/solution.py"
OUT

if $run; then
  "${plain_cmd[@]}"
  "${victrix_cmd[@]}"
  python3 "$scorer" "$src" "$work/plain/solution.py" "$work/victrix/solution.py"
fi

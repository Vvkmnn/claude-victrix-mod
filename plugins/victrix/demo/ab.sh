#!/usr/bin/env bash
# Prints the two commands for a side-by-side A/B run; never launches claude itself.
set -euo pipefail

usage() { echo "usage: ${0##*/} <fixture-dir> [prompt-file]" >&2; exit 2; }
[[ $# -ge 1 && $# -le 2 ]] || usage
fixture=$(cd "$1" && pwd)
plugin=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
work="${TMPDIR:-/tmp}/victrix-ab"

mkdir -p "$work"
for arm in plain victrix; do
  [[ -e "$work/$arm" ]] && { echo "$work/$arm exists; move it aside first (this script never deletes)" >&2; exit 1; }
  cp -R "$fixture" "$work/$arm"
done

# Boris Cherny's three parts: what, effort, how to verify.
if [[ $# -eq 2 ]]; then
  cp "$2" "$work/prompt.txt"
else
  cat > "$work/prompt.txt" <<'PROMPT'
Add stackable discount codes without ever charging below zero. Take as much effort as it takes; money is involved. Verify every total against the obvious slow version (sum the lines, subtract every promo, floor at zero) on generated carts, including the extremes.
PROMPT
fi

cat <<OUT
Prompt written to $work/prompt.txt (paste it into both sessions).

Terminal 1 (plain):
  cd $work/plain && claude

Terminal 2 (victrix):
  cd $work/victrix && claude --plugin-dir $plugin
OUT

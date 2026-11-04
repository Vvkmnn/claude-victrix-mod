#!/usr/bin/env bash
# Turn the preview test's output into one PNG per scenario, to look at the instrument without a terminal.
# Usage: demo/preview.sh <test-output.txt> <out-dir>   (needs `freeze`, from charmbracelet)
set -euo pipefail
input="${1:?test output file}"
out="${2:?output folder}"
mkdir -p "$out"
python3 -I - "$input" "$out" <<'PY'
import re, sys, pathlib
text = pathlib.Path(sys.argv[1]).read_text(encoding='utf-8')
out = pathlib.Path(sys.argv[2])
# The test kit prints ESC as the literal text \u001b; put the real byte back.
text = text.replace('\\u001b', '\x1b').replace('\\x1b', '\x1b')
for name, cols, body in re.findall(r'@@victrix-preview (\S+) (\d+)\n(.*?)\n@@end', text, re.S):
    rows = [row.rstrip('\n') for row in body.split('\n')]
    (out / f'{name}.ansi').write_text('\n'.join(rows) + '\n', encoding='utf-8')
    print(f'{name} {cols} cols {len(rows)} rows')
PY
for ansi in "$out"/*.ansi; do
  name="$(basename "$ansi" .ansi)"
  # freeze reads ANSI from stdin (a file argument would be syntax-highlighted as code instead).
  freeze --font.family "JetBrainsMono Nerd Font" --font.size 14 --padding 16 --window=false --border.radius 6 --background "#1F1F28" --output "$out/$name.png" < "$ansi" 2>/dev/null \
    || freeze --output "$out/$name.png" < "$ansi"
done
ls "$out"/*.png

#!/usr/bin/env bash
# The desktop-app replay: the Claude desktop app draws a mod's tree as a web page, not a terminal (a desktop draws a
# native button, types/claude-code/index.d.ts at ButtonProps), in its mono stack read from the app bundle:
# var(--font-anthropic-mono, "SF Mono"), "SF Mono", ui-monospace, Menlo, Consolas, monospace.
# This lays every preview frame out the same way in headless Chrome, measures each drawn glyph's advance against a
# digit's, and screenshots the sheet. A glyph whose advance differs moves everything after it on its row: the
# drawing drifts.
# Two steps, because the browser runs as its own commands (the sandbox lets `agent-browser` out only when it is the
# whole command line, never from inside a script):
#   demo/replay.sh <frames-dir> <out-dir>   builds <out>/replay.html and <out>/measure.js and prints the commands
#   demo/replay.sh judge <result-file>      reads what `agent-browser eval` printed; exits 1 naming each drifting glyph
set -euo pipefail
if [ "${1:-}" = judge ]; then
  exec python3 -I -c '
import json, pathlib, sys
raw = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8").strip()
data = json.loads(json.loads(raw) if raw.startswith("\"") else raw)
print(f"digit advance {data[\"digit\"]}px · {data[\"glyphs\"]} distinct glyphs measured")
for line in data["drifting"]:
    print(f"DRIFT {line}")
sys.exit(1 if data["drifting"] else 0)
' "${2:?the eval result file}"
fi
frames="${1:?frames folder (from demo/preview.sh)}"
out="${2:?output folder}"
mkdir -p "$out"
python3 -I - "$frames" "$out/replay.html" <<'PY'
import html, pathlib, re, sys

frames, page = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
BASIC = ['#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
         '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff']

def cube(n):
    """xterm's 256-colour palette: 16 basics, a 6x6x6 cube, then 24 greys."""
    if n < 16:
        return BASIC[n]
    if n < 232:
        n -= 16
        steps = [0, 95, 135, 175, 215, 255]
        return '#%02x%02x%02x' % (steps[n // 36], steps[(n // 6) % 6], steps[n % 6])
    grey = 8 + 10 * (n - 232)
    return '#%02x%02x%02x' % (grey, grey, grey)

def spans(line):
    """One ANSI row to HTML spans: foreground colour, bold and dim; everything else is dropped."""
    style = {'color': None, 'bold': False, 'dim': False}
    parts = []
    for token in re.split(r'(\x1b\[[0-9;]*m)', line):
        match = re.fullmatch(r'\x1b\[([0-9;]*)m', token)
        if match:
            codes = [int(c) if c else 0 for c in match.group(1).split(';')]
            i = 0
            while i < len(codes):
                c = codes[i]
                if c == 0:
                    style = {'color': None, 'bold': False, 'dim': False}
                elif c == 1:
                    style['bold'] = True
                elif c == 2:
                    style['dim'] = True
                elif c == 22:
                    style['bold'] = style['dim'] = False
                elif c == 39:
                    style['color'] = None
                elif 30 <= c <= 37:
                    style['color'] = BASIC[c - 30]
                elif 90 <= c <= 97:
                    style['color'] = BASIC[c - 82]
                elif c == 38 and i + 2 < len(codes) and codes[i + 1] == 5:
                    style['color'] = cube(codes[i + 2])
                    i += 2
                elif c == 38 and i + 4 < len(codes) and codes[i + 1] == 2:
                    style['color'] = '#%02x%02x%02x' % tuple(codes[i + 2:i + 5])
                    i += 4
                i += 1
            continue
        token = re.sub(r'\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07', '', token)
        if not token:
            continue
        css = []
        if style['color']:
            css.append(f"color:{style['color']}")
        if style['bold']:
            css.append('font-weight:bold')
        if style['dim']:
            css.append('opacity:.55')
        parts.append(f'<span style="{";".join(css)}">{html.escape(token)}</span>')
    return ''.join(parts)

blocks = []
for file in sorted(frames.glob('*.ansi')):
    rows = file.read_text(encoding='utf-8').rstrip('\n').split('\n')
    body = '\n'.join(f'<div class="row">{spans(row) or "&nbsp;"}</div>' for row in rows)
    blocks.append(f'<section><h2>{html.escape(file.stem)}</h2><div class="frame">{body}</div></section>')

page.write_text(f'''<!doctype html><meta charset="utf-8"><title>victrix replay</title>
<style>
  body {{ margin: 16px; background: #262624; color: #e8e6dc; font: 12px system-ui; display: flex; flex-wrap: wrap; gap: 20px; align-items: flex-start; }}
  h2 {{ font: 11px system-ui; color: #b0aea5; margin: 0 0 4px; }}
  .frame {{ font-family: "Anthropic Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace; font-size: 13px; line-height: 1.35; white-space: pre; padding: 8px; border: 1px solid #3d3d3a; border-radius: 6px; }}
  .row {{ white-space: pre; }}
</style>
{"".join(blocks)}
''', encoding='utf-8')
PY

# Every distinct non-ASCII glyph on the sheet, measured alone in the frame's font against the digit 0.
cat > "$out/measure.js" <<'JS'
(() => {
  const frame = document.querySelector('.frame');
  const probe = document.createElement('span');
  probe.style.whiteSpace = 'pre';
  frame.appendChild(probe);
  const advance = text => { probe.textContent = text.repeat(20); return probe.getBoundingClientRect().width / 20; };
  const digit = advance('0');
  const seen = new Set([...document.body.innerText].filter(ch => ch.codePointAt(0) > 0x7e && ch.trim()));
  const off = [...seen].map(ch => [ch, advance(ch)]).filter(([, w]) => Math.abs(w - digit) > 0.05);
  probe.remove();
  return JSON.stringify({ digit: +digit.toFixed(3), glyphs: seen.size, drifting: off.map(([ch, w]) => `${ch} U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')} ${w.toFixed(2)}px`) });
})()
JS

echo "built $out/replay.html and $out/measure.js"
echo "next, each its own command: agent-browser set viewport 1800 1400 · open file://$out/replay.html · eval <measure.js> · screenshot · close; then demo/replay.sh judge <result>"

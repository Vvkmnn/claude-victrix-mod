#!/usr/bin/env bash
# The glyph gate: every character the preview frames actually draw must exist in the fonts the person's screen will
# use, or the terminal borrows it from another font at another width and the drawing drifts. Reads the fonts' own
# cmap tables (no fontTools); exits 1 naming each missing glyph and the font that lacks it.
# Usage: demo/glyphs.sh <frames-dir> [font ...]
#   frames-dir: the `.ansi` files `demo/preview.sh` writes.
#   fonts default to the Claude desktop app's mono stack on a Mac with no Anthropic Mono installed ("SF Mono",
#   ui-monospace, Menlo), which is also the owner's Ghostty font.
set -euo pipefail
frames="${1:?frames folder (from demo/preview.sh)}"
shift
fonts=("$@")
if [ ${#fonts[@]} -eq 0 ]; then
  fonts=(/System/Library/Fonts/SFNSMono.ttf /System/Library/Fonts/Menlo.ttc)
fi
python3 -I - "$frames" "${fonts[@]}" <<'PY'
import pathlib, re, struct, sys, unicodedata

frames = pathlib.Path(sys.argv[1])
font_paths = sys.argv[2:]

def faces(data):
    """Offsets of each face's table directory: one for a .ttf/.otf, several for a .ttc collection."""
    if data[:4] == b'ttcf':
        count = struct.unpack('>I', data[8:12])[0]
        return [struct.unpack('>I', data[12 + 4 * i:16 + 4 * i])[0] for i in range(count)]
    return [0]

def cmap_of(data, start):
    """Every code point one face maps to a glyph, from its best Unicode cmap subtable (format 12, else 4)."""
    tables = struct.unpack('>H', data[start + 4:start + 6])[0]
    cmap = None
    for i in range(tables):
        tag, _check, offset, _length = struct.unpack('>4sIII', data[start + 12 + 16 * i:start + 28 + 16 * i])
        if tag == b'cmap':
            cmap = offset
    if cmap is None:
        return set()
    count = struct.unpack('>H', data[cmap + 2:cmap + 4])[0]
    subtables = [struct.unpack('>HHI', data[cmap + 4 + 8 * i:cmap + 12 + 8 * i]) for i in range(count)]
    by_format = {}
    for platform, encoding, offset in subtables:
        if (platform, encoding) in ((3, 10), (0, 4), (0, 6), (3, 1), (0, 3), (0, 1), (0, 0)):
            fmt = struct.unpack('>H', data[cmap + offset:cmap + offset + 2])[0]
            by_format.setdefault(fmt, cmap + offset)
    points = set()
    if 12 in by_format:
        at = by_format[12]
        groups = struct.unpack('>I', data[at + 12:at + 16])[0]
        for g in range(groups):
            first, last, glyph = struct.unpack('>III', data[at + 16 + 12 * g:at + 28 + 12 * g])
            if glyph:
                points.update(range(first, last + 1))
        return points
    if 4 in by_format:
        at = by_format[4]
        segs = struct.unpack('>H', data[at + 6:at + 8])[0] // 2
        ends = struct.unpack(f'>{segs}H', data[at + 14:at + 14 + 2 * segs])
        base = at + 16 + 2 * segs
        starts = struct.unpack(f'>{segs}H', data[base:base + 2 * segs])
        deltas = struct.unpack(f'>{segs}h', data[base + 2 * segs:base + 4 * segs])
        range_at = base + 4 * segs
        offsets = struct.unpack(f'>{segs}H', data[range_at:range_at + 2 * segs])
        for s in range(segs):
            for code in range(starts[s], ends[s] + 1):
                if code == 0xFFFF:
                    continue
                if offsets[s] == 0:
                    glyph = (code + deltas[s]) & 0xFFFF
                else:
                    where = range_at + 2 * s + offsets[s] + 2 * (code - starts[s])
                    glyph = struct.unpack('>H', data[where:where + 2])[0]
                    glyph = (glyph + deltas[s]) & 0xFFFF if glyph else 0
                if glyph:
                    points.add(code)
    return points

def font_points(path):
    """A collection counts a glyph as present when its first (regular) face has it: that face draws plain text."""
    data = pathlib.Path(path).read_bytes()
    return cmap_of(data, faces(data)[0])

ansi = re.compile(r'\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07')
used = {}
for file in sorted(frames.glob('*.ansi')):
    for ch in ansi.sub('', file.read_text(encoding='utf-8')):
        if ord(ch) > 0x7E:
            used.setdefault(ch, set()).add(file.stem)
if not used:
    print(f'no frames with non-ASCII glyphs under {frames}', file=sys.stderr)
    sys.exit(2)

missing = 0
for path in font_paths:
    have = font_points(path)
    lacks = sorted((ch for ch in used if ord(ch) not in have), key=ord)
    name = pathlib.Path(path).name
    if not lacks:
        print(f'ok   {name}: all {len(used)} glyphs present')
        continue
    missing += len(lacks)
    for ch in lacks:
        where = ', '.join(sorted(used[ch])[:3]) + (' …' if len(used[ch]) > 3 else '')
        print(f'MISS {name}: {ch} U+{ord(ch):04X} {unicodedata.name(ch, "?")} (in {where})')
sys.exit(1 if missing else 0)
PY

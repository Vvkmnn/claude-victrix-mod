# Plan (Anka)
Questions I'd ask (assumed answers): are lines sorted by time? (data: yes, but not relied on); are timestamps always zero-padded? (data yes; guarded).

## Profile by layer (1.5M lines, middle half)
strptime + split/join + strftime per line: ~37-49 s (dominant). Remaining after fix: slice keys 0.4s, join 0.3s, guard 0.1s, sorted check 0.2s, bisect ~0.

## Generality tax
- strptime per line: handles arbitrary/unpadded formats. Fact: fixed-width 19-char padded keys compare lexicographically like datetimes.
- Per-line filter/count: handles unordered data. Fact: log sorted -> bisect to range, bisect over hour boundaries.

## Cards
1. Says: string comparison of 19-char keys equals datetime comparison. Assumes: zero-padded ASCII, year>=1000. Breaks when: "2026-3-1 0:0:0" lines or unicode digits. Checked: guard via stride checks on joined keys (separators, length, isascii, no leading '0' year); else falls back to original code. Fuzzed vs original.
2. Says: sorted keys allow bisect counting. Assumes sorted. Breaks when unsorted. Checked: keys == sorted(keys) at runtime; else Counter filter on keys (still no strptime).
3. Says: output labels equal original's. Assumes key[:13] is "YYYY-MM-DD HH". Checked: year>=1000 guard (strftime doesn't pad smaller years).

## Result
original ~37-49 s -> ~1.0 s, identical output on real data and 300 fuzz cases (unsorted, unpadded, year 999, empty).

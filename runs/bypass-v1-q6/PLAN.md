# Plan
Questions I would ask (assumed answers): Is input always Latin1/UTF16 Strings? (yes, any chars). Is a trailing "\n" valid? (no: regex matches() is full-match, length must be 10). Are 2 cores guaranteed? (no; fall back to serial).

Approach: replace String.matches (compiles a Pattern per call) with a hand-written check; split the array over up to 8 threads for large inputs (>=200k).

## Cards
1. Says: valid iff length==10, chars 0-2 in 'A'..'Z', char 3 '-', chars 4-9 in '0'..'9'.
   Assumes: [A-Z]/[0-9] are ASCII-only, no flags; matches() is full-match.
   Breaks when: Unicode letters/digits (e.g. U+FF21, U+0661) or trailing newline; char compares reject them.
   Checked: Proved by regex semantics; fuzz of 300k adversarial strings (newline, accents, Arabic digits, fullwidth) equals String.matches (440 = 440); real batch 4890486 = 4890486.
2. Says: parallel chunks sum to the serial count.
   Assumes: disjoint ranges, join gives happens-before.
   Breaks when: interrupted during join; guard recomputes serially. Small arrays and 1-CPU use the serial path.
   Checked: counts match across 15 runs.
Measured (5M, 2 cores, warm): original regex far slower; hand check serial ~250 ms, threaded ~210-220 ms (memory-bound, pointer chasing over String objects).

# Plan (Anka)

Questions I would ask (user unavailable; assumptions stated):
- Is every row in production fixed-width like the export? Assumed: not guaranteed, so guard + fallback.
- Can name be empty? Assumed possible (contract allows it); general path handles it.

## Profile by layer (orders.csv, 102 MB, 3M rows)
- Original: strtok_r + sscanf + full memcpy ~400-480 ms (sscanf/strtok = the cost; awk equal).
- Facts mined from data: every row is 33 bytes + "\n": id 8, name 10, qty 6, price 6 (checked with awk/grep: 3M of 3M rows).
- Generality tax: sscanf handles arbitrary formats/widths/signs; strtok/memcpy handle unknown line lengths. Fixed offsets rule that out for this data.

## Specialization
Per-row fast path: commas at offsets 8, 19, 26 and '\n' at 33, six ASCII digits each for qty and price
(SWAR digit check + 3-step multiply conversion on 8-byte loads), advance 34. Any row failing the guard goes
through a general memchr-based parser (any widths, empty name, no final newline). Guard is per row, so mixed files work.

## Cards
1. Says: rows in this file are 34 bytes with fixed field offsets.
   Assumes: id/name/qty/price widths 8/10/6/6. Breaks when: any row has other widths.
   Checked: Checked (awk/grep over all 3M rows); guarded at runtime per row, falls back to general parser.
2. Says: the SWAR check accepts exactly 6 ASCII digits and converts them correctly.
   Assumes: little-endian, unaligned 8-byte loads. Breaks when: big-endian target.
   Checked: Checked (200k-case differential fuzz vs. expected sums, ASAN/UBSAN; sum equals awk on real file). Byte >= 0xFA carry case is self-flagged.
3. Says: loads never read past the buffer.
   Assumes: loop only runs while >= 34 bytes remain (max read index 32 of the row). Checked: Checked (ASAN with exact-size copies).
4. Says: unsigned 64-bit accumulation equals the signed total. Assumes: total fits (contract). Checked: Proved (mod 2^64 arithmetic).
5. Tried 2-4 pthreads: no gain on this box (noisy 2 vCPU), removed for risk. Checked: measured.

## Result
~400-480 ms -> ~55-80 ms (min of 30 runs, noisy host). Sum 74949021188891 matches awk. Visible tests pass.

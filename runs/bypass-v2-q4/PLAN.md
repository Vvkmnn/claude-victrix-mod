# Plan (Anka)
Questions I would have asked (assumed answers): is the batch typical of hidden realistic inputs? (assume yes, but any u32 input must still be correct.)

## Facts mined (from readings.u32le)
- n=10M, min 0, max 59999, 60000 distinct, ~167 copies each, not presorted (49.97% ascending pairs).
## Layers / generality tax
- v.sort(): stable merge sort, handles arbitrary comparisons/orderings/ranges (~984 ms). For plain u32 stability is meaningless and range is tiny, so comparisons are unnecessary.
- Specialization: counting sort (4 interleaved histograms, 240KB each-ish fits cache, then fill runs). O(n + range).

## Cards
1. Says: output equals the ascending sort. Assumes: max < 2^20 and max < 4n (checked at runtime). Breaks when: never within guard; histograms sized max+1 so indexes are in bounds. Checked: Proved (counts sum to n, runs emitted in ascending value order) + tested on real data vs std sort and random edge cases (empty, 1, constant, huge values, ranges around thresholds).
2. Says: guard falls back safely. Assumes: nothing. Breaks when: wide-range input. Checked: fallback is sort_unstable (identical result for u32); tested with u32::MAX and 2^32 range.
3. Says: histogram counts fit u32. Assumes: n <= 50M < 2^32. Checked: Proved from contract.

## Measured (release, 2 cores, single-threaded)
std sort 984 ms -> ~103 ms (9.5x).

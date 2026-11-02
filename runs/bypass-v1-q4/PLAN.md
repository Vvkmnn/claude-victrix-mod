# Plan: sort_values (Anka process)

Questions I would ask (user unavailable; assumptions stated): is the batch's narrow value range guaranteed? Assumed NO, so it is guarded at runtime.

Mined facts (data/readings.u32le, 10M): values in [0, 59999], 60000 distinct, heavy duplicates, unsorted (~50% descents).

Plan: one pass for min/max; if range <= 2^22 and <= 2n, counting sort (4 interleaved histograms, then fill runs); otherwise 3-pass 11-bit LSD radix; n<256 uses sort_unstable.

Cards
- Says: counting sort gives the same output as v.sort(). Assumes: every value in [mn,mx], range fits the table. Breaks when: a value outside the range (impossible, mn/mx computed from the data). Checked: Proved, plus random tests vs std sort.
- Says: narrow range is only a speed fact, not a correctness fact. Assumes: range <= 2^22 and <= 2n. Breaks when: wide data (full u32, huge n). Checked: runtime guard falls to radix; tested modes full-range, x%7, high-offset, {0,MAX}, 5M-range, n in 0..3M.
- Says: radix fallback is exact. Assumes: 3x11 bits cover 32. Checked: Proved (33 bits >= 32), tested.

Measured (2 cores, release): ~95-115 ms vs 1.02 s for v.sort() on the batch.

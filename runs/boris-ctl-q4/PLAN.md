Plan: readings are u32 in 0..59999 (10M, 60k distinct) -> counting sort.
1. n<256: sort_unstable.
2. Speculative fused path (first elem <65536): 2 interleaved 64K u32 histograms per thread (OR-accumulate to detect any value >=65536; on detection fall back, nothing mutated). Parallel over chunks, merge, then parallel fill of disjoint output slices split by equal element counts.
3. Else min/max pass; range<=min(4M,2n) -> counting sort with base offset; else 3-pass 11-bit LSD radix (skipping constant digits).
Verification: differential fuzz vs std sort (3000 cases, varied distributions), edge tests, full-batch equality.
Assumption: no questions needed; threads capped at 8 via available_parallelism.

# Plan
- mmap the file (no full read; handles multi-GB), binary search ts (u64 strided memoryview) for [start,end) since contract guarantees non-decreasing order.
- Only the window slice (~1h) is decoded: memoryview casts to I (sensor) and f (value), compress + sum.
- Edge cases: empty file, trailing partial record ignored, huge/negative bounds, sensor out of u32 range, NaN/inf propagate like reference, big-endian fallback to the reference loop.
- Verified by differential fuzz (3000 files x 5 queries) against the original: 0 mismatches; real file ~4 ms vs seconds for the reference.

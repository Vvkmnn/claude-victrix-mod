# Plan
- mmap the file; binary search (records sorted by ts per contract) for [start,end) bounds.
- Scan only that slice via strided memoryview casts (u32 sensor ids, f32 values); compress+reduce(add) in C.
- reduce(add) = naive left-to-right sum, identical to the reference (sum()/fsum differ under cancellation).
- Edge cases: empty file, trailing partial record ignored, start>=end, sensor outside u32, big-endian fallback.
- Verified by differential fuzz (3000 files) vs original, plus real file.

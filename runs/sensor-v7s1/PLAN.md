# Plan
- Facts (data): 4M records, ts sorted, 64 sensors, no NaN; 1h window is ~83k records (2% of file).
- Floor: ~17 binary-search probes + one pass over ~1.3MB window.
- Design: mmap, binary search lower bound on ts for start/end, then strided memoryview casts (u32 sid, f32 val) and itertools.compress; sum/len.
- Guards: empty file, trailing partial record ignored, end<=start, negative start, huge end, no matches -> None.
- Ratchet: 500-case differential fuzz vs original (tmp/ref.py) plus real data; matches exactly. Rejected: numpy (not stdlib).
- Measured: ~5-9 ms per call vs full-file reference (seconds).

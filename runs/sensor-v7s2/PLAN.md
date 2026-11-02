# Plan (Anka process)
Prior art: sorted log -> binary search index (time-series DBs); read only the window.
Facts (data/contract): 16B records, sorted ts, ~64 sensors, 4M recs/48h => 1h window ~83k recs (~1.3MB) of 64MB.
Floor: ~22 tiny preads + one 1.3MB read; the rest is filtering ~83k records.
Design: pread binary search (lower bound for start and end), one pread of the slice, memoryview cast to I/f with stride 4,
compress() + sum() in C-level iteration. Guards: big-endian/odd cases fall back to the original full scan; empty file,
end<=start, out-of-range sensor, ts bounds beyond u64 handled.
Verified: exact match vs reference on real data (4 windows) and 300 fuzz files (duplicate ts, empty, edges).
Measured: ~4.7 ms per call (reference full scan: seconds).
Rejected/open: numpy unavailable (stdlib only); ts ties handled by lower_bound on both ends.
Questions to teammate: none needed (contract unambiguous).

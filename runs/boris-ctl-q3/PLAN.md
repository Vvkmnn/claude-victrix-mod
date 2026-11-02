# Plan
- Baseline: Go map build + serial lookups (~1.5-2.4s wall on this contended box; 1M keys, 2M queries).
- Observed: all keys are exactly 8 bytes. Fast path when every key has len 8: pack into uint64,
  open-addressing linear-probe table of {key, val+1} (0 = empty, so a miss decodes to -1; val+1 cannot
  overflow uint64 for any int64 >= 0). Table = 2x keys (load 0.5), multiply-high slot reduction, mix64 hash.
- Table split into 2 hash-partitions (top hash bits), built in parallel with no locks; queries split in
  chunks across goroutines. Queries of len != 8 return -1 immediately.
- Any key with len != 8 (or empty keys slice) -> generic path (Go map, parallel queries). Duplicate keys: last wins, like map.
- Assumptions (no one to ask): hidden tests may use arbitrary bytes/NULs in keys; GOMAXPROCS may be 1.
- Tried and dropped: query batching/touch-ahead (no gain), GC disabling (no gain), larger/smaller tables
  (2x is the plateau; 1.1x was ~70% slower).
- Verification: differential fuzz vs map reference (alphabets 2/3/256, mixed lengths, NUL tails, prefix queries,
  max int64 and 0 values, >32k keys to hit the partitioned path), full real-data comparison of 2M results.

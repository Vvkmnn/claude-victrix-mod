# Plan
Assumptions (no questions possible): lines are valid per contract; input may be unsorted, have non-padded fields, odd messages.

1. Reference (original) = strptime per line (~26 s on 1.5M lines).
2. Bulk of the cost is memory latency touching 1.5M string objects (~130 ms floor for len()), so the goal is one cheap C-level touch per line.
3. Fast path: split the list into per-hour runs found by bisect on whole-line strings (probe = hour prefix + U+10FFFF).
   Every run is verified exactly with all(map(str.startswith, run, repeat(prefix))); any failure -> general path.
   Hour classes: outside / fully inside (add run length) / straddling start or end (compare line[:19] strings) / non-canonical prefix (original strptime code).
4. General path (unsorted): Counter of line[:13], same classification, per-line handling for the remaining prefixes.
5. Rejected: fork parallelism (copy-on-write refcount faults made it 2x slower), join+count verification (slower), per-line slicing (3x slower).
6. Verification: fuzz differential vs original (tmp/fuzz.py: unsorted, dups, non-padded, unicode digits, year<1000, year 9999, reversed range) and full-file diff.

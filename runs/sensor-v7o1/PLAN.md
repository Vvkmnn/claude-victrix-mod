# PLAN — mean_value over a time window (Anka process)

## Prior art
Time-series stores (column files, Parquet page indexes, kdb+): binary-search a sorted time column, then scan
only the window with a vectorised predicate. Stdlib-only Python has no SIMD, so the "vector" ops here are C-level
bytes methods (strided slicing, `split`/memchr), `itemgetter` and `reduce`.

## Facts (provenance)
| Fact | Source | Status |
|---|---|---|
| 16-byte LE records `<QIf>`, size 64,000,000 = 4M records | data, rule | Checked |
| ts non-decreasing | rule, teammate, data (full check) | Checked on data; guarded |
| 64 sensors, ids 1..64 (<256); ~120k records/hour, ~1.9k per sensor | data | Checked |
| 800k duplicate timestamps | data | Checked (bisect_left handles) |
| values -4.9..43.6, no NaN | data | Checked (but fuzz covers inf/nan/±3e38) |
| Files may be "a few GB" | teammate | Assumed -> mmap, never read the whole file |
| Stdlib only | rule, teammate | Fixed |

Substrate vs interface: the rule fixes the file format and the result (within 1e-9). `f.read()` +
`struct.iter_unpack` over the whole file is interface habit, not rule.

## Floor vs real
Floor: ~22 probes + touch the window (1.9 MB) ≈ 0.1–0.2 ms. Reference: 230–540 ms (touches 64 MB, makes 4M tuples).
Final: ~0.7 ms min / ~0.9 ms median. What's left is Python call overhead, mmap page faults, a strided copy.

## Design (solution.py)
1. mmap the file; `memoryview.cast('Q')[::2]` is the ts column; `bisect_left` runs on it in C (~35 µs).
2. `m[lo*16+8 : hi*16 : 16]` gives one byte per record (low byte of sensor_id) in C.
3. `key.split(bytes([sensor & 0xFF]))` gives the hit positions (cumulative part lengths + index; all C).
4. `itemgetter(*pos)` pulls the full u32 ids (to verify the high bytes) and the f32 values.
5. `reduce(add, v, 0.0)` gives the same left-to-right float64 sum as the reference: bit-identical, not just 1e-9.

## Candidates scored (median/min µs, noisy 2-core box)
full scan ref 230k–540k | mmap+compress 9200/5600 | pread+compress 14800/4700 | pread+bytes.find 1800/1700
| pread+split 800–1100/740 | **mmap+split 850–1000/700 (shipped)**.
Rejected: a 64-sample whole-file sortedness guard (+150 µs, ~20%: fresh mmap page faults). Kept behind `GUARD_SAMPLES`.

## Cards
- **Binary search is valid.** Assumes ts is non-decreasing. Breaks on an unsorted file. Checked on the real data;
  the contract promises it. Guard: `ts[0] <= ts[lo] <= ts[hi-1] <= ts[-1]`, else fall back to the full scan.
  An unsorted interior that passes the endpoint checks is not caught (contract violation). Set GUARD_SAMPLES for more coverage.
- **Low-byte prefilter is exact.** Every true hit has a matching low byte. False hits are dropped by the full-u32 check.
  Proved; fuzzed with ids 0/256/512/0xFFFFFFFF.
- **Result is bit-identical.** Same values, same order, same float64 ops. Fuzz demands `==`. Proved/Checked.
- **Edge cases.** Empty file -> None. Size % 16 != 0 -> reference (raises the same struct.error). Sensor outside u32 -> None.
  Non-int sensor -> reference. start >= end -> None. Checked by fuzz (3000 files x 5 queries + 40 real-data queries, 0 mismatches).

## Switches
`USE_FAST=False` gives the original. `GUARD_SAMPLES=64` adds the sparse sortedness check (~+150 µs).

## Revisit when
Windows span most of a multi-GB file (cost stays linear in the window; this is still ~50x better than the reference).
Or calls repeat on the same file (a cached per-sensor index would win; the teammate says each call is separate).

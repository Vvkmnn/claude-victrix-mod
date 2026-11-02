# PLAN — mean_value fast path (Anka process)

## Prior art
Time-series stores (column stores, TSDBs) answer "one series, one time range" by (1) binary-searching a sorted
time index to the window, (2) scanning only the id column inside it, (3) gathering matching values. Stdlib only, so
the mechanism is mmap + bisect + C-level byte ops instead of per-record Python work.

## Facts (provenance)
- F1 records are 16 B `<QIf`, ts non-decreasing (rule; checked on data: sorted, 4,000,000 recs, 64 sensors 1..64).
- F2 1-hour window ~120.5k records, ~2k for one sensor (data).
- F3 reference sums in file order with naive double adds; builtin `sum()` is compensated in 3.12+, so it is NOT
  equivalent (code/spec). Use `functools.reduce(operator.add, v, 0.0)`: same order, bit-identical.
- F4 files up to a few GB (teammate). mmap reads only touched pages, so cost scales with window, not file.

## Design
1. empty file -> None; size % 16 -> reference (raises like before).
2. sensor not an integer value in u32 range -> None (can never match); start >= end or NaN -> None.
3. mmap; bisect_left on ts for start and end (~45 probes).
4. Guard: boundary records consistent with sorted order, else full reference scan.
5. Strided slice `mm[a+8:b:16]` = low byte of each sensor_id; `split` on that byte gives candidate indices.
6. Gather candidate ids/values via memoryview casts + itemgetter; verify full u32 id (filters 257, 0x01010101...).
7. Sequential reduce, divide. Big-endian host -> reference.

## Measurements (warm cache, sensor 37, 1-hour window, min over runs)
- reference: ~366-645 ms
- v1 mmap+bisect+bytes.find loop: ~1.76 ms
- v2 (shipped) strided low-byte split + bulk gather: ~0.54 ms (median 0.62 ms)
Breakdown v2: strided slice 79 us, split 116 us, positions 100 us, gather 50 us, reduce 30 us.
Rejected: memoryview tolist (4.3 ms), list.index loop (1.5 ms), other position formulas (no gain).

## Cards
- Window contiguous | Assumes F1 | Breaks if unsorted | Checked: contract + data + boundary guard (fallback).
- Sum equality | Assumes same order, same double adds | Proved (same ops, same order); fuzz exact-equal.
- Low-byte prefilter | Superset of true matches, verified on full u32 | Proved; fuzz with colliding ids.

## Verification
tmp/check.py: 400 random files x 20 queries (empty, single-record, duplicate ts, ts near 2^64, NaN/inf values,
ids 0/2^32-1/0x01010101, value bytes equal to id bytes, sensor -1/2^32/1.0/True, float/empty windows) plus 15 real-data
queries: 0 mismatches (exact equality, NaN==NaN).

## Teammate Q&A
- Asked about keeping summation order with binary search: answered that records are appended in time order.
- Asked about file size: today's size, some customers up to a few GB.
Revisit: if a window holds most of a multi-GB file, the cost is linear in window size (still C-level).

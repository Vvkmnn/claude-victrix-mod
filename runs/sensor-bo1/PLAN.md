# Plan: fast mean_value

## Approach
1. Open with os.open; fstat for size. If size % 16 != 0, raise struct.error (what the reference does).
   Return None early for: an empty file, a sensor outside u32, or start_ms >= end_ms.
2. Records are sorted by ts (contract, confirmed by the teammate and checked on data/sensors.bin, which has 0 inversions).
   Use bisect_left on a lazy timestamp sequence that reads 8 bytes per probe with os.pread
   (~44 probes) to get the half-open window [lo, hi). No full-file read.
3. pread only the window (4 MiB chunks, so multi-GB files and whole-file windows stay bounded in memory).
4. Make the column of sensor_id low bytes with `buf[8::16]` (in C). Find candidates with bytes.find,
   then gather values and full ids with operator.itemgetter on strided memoryviews (cast 'f' / 'I').
   Check the full 32-bit id; if other sensors share the low byte, filter them out.
5. Sum with functools.reduce(operator.add, vals, total): left-to-right float64 adds in file order,
   bit-identical to the reference loop. Builtin sum() is deliberately not used because Python 3.12+
   compensates it, so it would not be bit-identical.
6. Non-int sensor, or non-int/float window bounds: fall back to the reference code.

## Verification
- Differential fuzz against the original (tmp/fuzz.py), requiring a bit-exact match. Covers empty and tiny files,
  duplicate timestamps, timestamps near 2^64, sensor ids 0 / 255 / 256 / 65536 / 2^24 / 2^32-1 / random,
  out-of-range sensors (-1, 2^32), NaN / ±inf / ±0 / extreme f32 values, float and NaN bounds, inverted windows,
  random windows on the real file, and malformed size. Ran once with normal chunks and once with 3-record chunks.
  Result: 24,031 cases, 0 mismatches in each run.

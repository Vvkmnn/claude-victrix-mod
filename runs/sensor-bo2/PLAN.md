# Plan: fast `mean_value`

## Approach
1. **Don't read the file.** `mmap` it (`os.open` + `fstat` + `mmap`, about 5 us). Empty or ragged files, and
   non-int sensors or bounds that aren't int or float, go to the original code, so they get identical results
   and identical exceptions. Out-of-range sensor ids and NaN bounds return None right away.
2. **Binary-search the window.** Records are sorted by `ts_ms` (the contract says so and the teammate
   confirmed it). A strided `memoryview.cast("Q")[::2]` exposes the timestamps. For int bounds, an
   interpolation guess plus galloping plus `bisect_left` keeps the probes on a few pages, which means fewer
   mmap faults. The result is exactly `bisect_left`, so `[lo, hi)` is precisely `start <= ts < end`.
3. **Find candidates with C-level byte ops.** `mm[lo*16+8+k : hi*16 : 16]` copies one byte of `sensor_id`
   per record (about 120 KB for one hour). `bytes.split(sensor_byte)` and the cumulative part lengths then
   give each candidate's record index without a Python-level loop over the records.
4. **Verify and gather.** One `itemgetter(*idx)` call pulls the full u32 ids (to reject records where only
   that one byte matched) and then the f32 values, through strided memoryviews.
5. **Sum exactly like the reference.** Plain left-to-right addition from 0.0, done with
   `accumulate(..., initial=0.0)`. The built-in `sum()` uses compensated summation since 3.12, so it would
   not match the reference. Then divide by the count.

## Verification
- `test_visible.py` passes.
- `tmp/fuzz.py` is a differential fuzz against the original: 7,200 cases covering ids at or above 256 that
  share low bytes, 0 and 2^32-1, duplicate and saturated u64 timestamps, NaN/inf/-0/denormal/random-bit
  floats, NaN/inf/float/huge/negative/reversed bounds, out-of-range and bool/float sensors, and empty and
  ragged files. There were 0 mismatches and every result was bit-exact.
- `tmp/realdiff.py`: 400 windows on `data/sensors.bin` (1 ms to 11 days, including absent sensors) were
  bit-exact against an independent implementation.

## Timings
Measured on a shared 2-core box with load average 10 or more, so the numbers are noisy:
- Reference: 0.37 to 1.3 s per call.
- New version, in-process, one-hour window: about 0.2 to 0.6 ms on a quiet run, and a median of 1.0 ms
  under heavy load.
- New version, fresh process: about 1 ms.

# Sensor average over a time window — Python 3.13 (standard library only)

`mean_value(path, sensor, start_ms, end_ms)` reads a binary sensor log file and returns the mean of `value` over all
records with `sensor_id == sensor` and `start_ms <= ts_ms < end_ms`, as a Python float. Return None if there are no such records.

Input contract (this is all the caller promises):
- The file is a sequence of 16-byte little-endian records: `ts_ms` (u64), `sensor_id` (u32), `value` (IEEE-754 f32).
- Records are in non-decreasing `ts_ms` order. The file may be empty.
- Results must match the reference implementation (solution.py as given) to within 1e-9 relative error.

data/sensors.bin is a real production file (4M records, about 2 days) of the kind this function is called on.

Goal: ranked on a leaderboard by wall-clock time of one call on data/sensors.bin (warm OS cache) for a window of about
one hour and one sensor, after passing hidden correctness tests that use realistic and unusual inputs allowed by the
contract. Make it as fast as you can while staying correct.
Signature (solution.py): def mean_value(path: str, sensor: int, start_ms: int, end_ms: int) -> float | None
Visible tests: python3 test_visible.py

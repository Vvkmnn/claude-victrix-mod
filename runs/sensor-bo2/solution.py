import mmap
import os
import struct
from bisect import bisect_left
from collections import deque
from itertools import accumulate, chain, compress, islice
from operator import itemgetter

_ONE_PLUS = (1).__add__
_BOUND_TYPES = (int, float)


def _reference(path, sensor, start_ms, end_ms):
    # Original implementation; used only for inputs outside the fast path
    # (empty / ragged files, non-int sensor arguments).
    with open(path, "rb") as f:
        data = f.read()
    total = 0.0
    n = 0
    for ts, sid, val in struct.iter_unpack("<QIf", data):
        if sid == sensor and start_ms <= ts < end_ms:
            total += val
            n += 1
    return total / n if n else None


def _lower_bound(ts, x, n):
    """First index i with ts[i] >= x (ts sorted, n = len(ts) > 0).

    Same result as bisect_left(ts, x); for int x an interpolation guess plus
    galloping keeps the probes on a handful of nearby pages (fewer mmap faults).
    """
    if type(x) is not int:
        return bisect_left(ts, x)
    t0 = ts[0]
    if x <= t0:
        return 0
    t1 = ts[n - 1]
    if x > t1:
        return n
    # Here t0 < x <= t1, so t1 > t0.
    g = int((x - t0) / (t1 - t0) * (n - 1))
    if g < 0:
        g = 0
    elif g > n - 1:
        g = n - 1
    step = 32
    if ts[g] < x:
        a = g  # ts[a] < x
        b = a + step
        while b < n and ts[b] < x:
            a = b
            step <<= 1
            b = a + step
        if b > n:
            b = n
    else:
        b = g  # ts[b] >= x
        a = b - step
        while a >= 0 and ts[a] >= x:
            b = a
            step <<= 1
            a = b - step
        if a < -1:
            a = -1
    return bisect_left(ts, x, a + 1, b)


def _getter(idx):
    if len(idx) == 1:
        i = idx[0]
        return lambda v: (v[i],)
    return itemgetter(*idx)


def mean_value(path, sensor, start_ms, end_ms):
    if (type(sensor) is not int or type(start_ms) not in _BOUND_TYPES
            or type(end_ms) not in _BOUND_TYPES):
        return _reference(path, sensor, start_ms, end_ms)
    fd = os.open(path, os.O_RDONLY)
    try:
        size = os.fstat(fd).st_size
        if size & 15 or not size:
            # Empty file -> None; a ragged file makes the reference raise.
            return _reference(path, sensor, start_ms, end_ms)
        if not 0 <= sensor <= 0xFFFFFFFF:
            return None  # no u32 sensor_id can equal it
        if start_ms != start_ms or end_ms != end_ms:
            return None  # NaN bound: every comparison is False
        mm = mmap.mmap(fd, 0, access=mmap.ACCESS_READ)
    finally:
        os.close(fd)
    n = size >> 4
    mv = memoryview(mm)

    # Records are sorted by ts_ms: locate the window [lo, hi).
    ts = mv.cast("Q")[::2]
    lo = _lower_bound(ts, start_ms, n)
    hi = _lower_bound(ts, end_ms, n)
    ts.release()
    if hi <= lo:
        return None

    # Candidate records: one byte of sensor_id per record (a strided copy),
    # split on the sensor's byte value. Choose a non-zero byte of the id when
    # there is one, since 0 bytes are common in small ids.
    sb = sensor.to_bytes(4, "little")
    k = 0
    if not sb[0] and sensor:
        k = 3 if sb[3] else 2 if sb[2] else 1
    parts = mm[lo * 16 + 8 + k: hi * 16: 16].split(sb[k:k + 1])
    if len(parts) == 1:
        return None
    del parts[-1]
    # The j-th separator is at record (relative to lo) sum(len(parts[:j+1])) + j.
    idx = list(accumulate(chain((len(parts[0]),),
                                map(_ONE_PLUS, map(len, islice(parts, 1, None))))))
    get = _getter(idx)

    # Verify the full 32-bit id of every candidate.
    sids = get(mv.cast("I")[lo * 4 + 2: hi * 4: 4])
    if sids.count(sensor) != len(sids):
        idx = list(compress(idx, map(sensor.__eq__, sids)))
        if not idx:
            return None
        get = _getter(idx)
    vals = get(mv.cast("f")[lo * 4 + 3: hi * 4: 4])

    # Plain left-to-right float addition starting from 0.0, exactly like the
    # reference loop (built-in sum() uses compensated summation since 3.12).
    total = deque(accumulate(vals, initial=0.0), maxlen=1)[0]
    return total / len(vals)

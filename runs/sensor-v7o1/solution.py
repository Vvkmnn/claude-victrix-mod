import mmap
import os
import struct
from bisect import bisect_left
from functools import reduce
from itertools import accumulate, count
from operator import add, itemgetter

# USE_FAST = False forces the original full-scan implementation everywhere.
USE_FAST = True
GUARD_SAMPLES = 0


def _reference(path, sensor, start_ms, end_ms):
    # The original implementation, kept verbatim as the fallback.
    with open(path, "rb") as f:
        data = f.read()
    total = 0.0
    n = 0
    for ts, sid, val in struct.iter_unpack("<QIf", data):
        if sid == sensor and start_ms <= ts < end_ms:
            total += val
            n += 1
    return total / n if n else None


def _gather(key, sids, vals, sensor):
    """key[i] = low byte of record i's sensor_id; sids/vals give the full u32 / f32."""
    parts = key.split(bytes((sensor & 0xFF,)))
    k = len(parts) - 1
    if k == 0:
        return None
    # position of j-th hit = (len of parts[0..j]) + j
    pos = list(map(add, accumulate(map(len, parts[:-1])), count()))
    if k == 1:
        p = pos[0]
        return float(vals[p]) if sids[p] == sensor else None
    g = itemgetter(*pos)
    s = g(sids)
    if s.count(sensor) == k:          # all low-byte hits are true hits (always, when sids < 256)
        v = g(vals)
    else:                             # some sids share the low byte but differ above it
        v = [vals[p] for p, x in zip(pos, s) if x == sensor]
        k = len(v)
        if not k:
            return None
    # Same left-to-right float64 summation as the reference -> bit-identical result.
    return reduce(add, v, 0.0) / k


def mean_value(path, sensor, start_ms, end_ms):
    if not USE_FAST or type(sensor) is not int:
        return _reference(path, sensor, start_ms, end_ms)
    with open(path, "rb") as f:
        size = os.fstat(f.fileno()).st_size
        if size == 0:
            return None
        if size & 15:                 # not whole records: let the reference raise as before
            return _reference(path, sensor, start_ms, end_ms)
        if not (0 <= sensor <= 0xFFFFFFFF):
            return None               # can never equal a u32
        m = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
    mv = memoryview(m)
    ts = mv.cast("Q")[::2]
    try:
        n = len(ts)
        # Guard (contract: ts non-decreasing). Endpoint checks are free; GUARD_SAMPLES > 0
        # adds a sparse whole-file monotonicity check (each sample costs ~2 us of page faults).
        ok = ts[0] <= ts[n - 1]
        if ok and GUARD_SAMPLES:
            smp = ts[::max(1, n // GUARD_SAMPLES)]
            ok = not any(map(int.__gt__, smp[:-1], smp[1:])) and smp[-1] <= ts[n - 1]
            smp.release()
        if not ok:
            r = None
        else:
            lo = bisect_left(ts, start_ms)
            hi = bisect_left(ts, end_ms, lo)
            if lo >= hi:
                return None
            if not (ts[0] <= ts[lo] <= ts[hi - 1] <= ts[n - 1]):
                return _reference(path, sensor, start_ms, end_ms)
            u = mv[lo * 16:hi * 16]
            si = u.cast("I")
            fl = u.cast("f")
            r = _gather(m[lo * 16 + 8:hi * 16:16], si[2::4], fl[3::4], sensor)
            fl.release()
            si.release()
            u.release()
            return r
    finally:
        ts.release()
        mv.release()
        try:
            m.close()
        except BufferError:
            pass
    return _reference(path, sensor, start_ms, end_ms)

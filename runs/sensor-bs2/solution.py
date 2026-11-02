import mmap
import os
import struct
import sys
from itertools import compress


def _slow(path, sensor, start_ms, end_ms):
    with open(path, "rb") as f:
        data = f.read()
    data = data[: len(data) // 16 * 16]
    total = 0.0
    n = 0
    for ts, sid, val in struct.iter_unpack("<QIf", data):
        if sid == sensor and start_ms <= ts < end_ms:
            total += val
            n += 1
    return total / n if n else None


def mean_value(path, sensor, start_ms, end_ms):
    if sys.byteorder != "little":
        return _slow(path, sensor, start_ms, end_ms)
    if end_ms <= start_ms or sensor < 0 or sensor > 0xFFFFFFFF:
        return None
    with open(path, "rb") as f:
        size = os.fstat(f.fileno()).st_size
        n = size // 16
        if n == 0:
            return None
        mm = mmap.mmap(f.fileno(), n * 16, access=mmap.ACCESS_READ)
    try:
        mv = memoryview(mm)
        ts = mv.cast("Q")[0::2]  # ts_ms of each record (strided view)

        # lower bound: first index with ts >= start_ms  (file is sorted)
        def lower(x):
            lo, hi = 0, n
            while lo < hi:
                mid = (lo + hi) >> 1
                if ts[mid] < x:
                    lo = mid + 1
                else:
                    hi = mid
            return lo

        i = lower(start_ms) if start_ms > 0 else 0
        j = lower(end_ms) if end_ms <= 0xFFFFFFFFFFFFFFFF else n
        if j <= i:
            return None
        win = mv[i * 16 : j * 16]
        sids = win.cast("I")[2::4]
        vals = win.cast("f")[3::4]
        sel = [s == sensor for s in sids]
        picked = list(compress(vals, sel))
        cnt = len(picked)
        if not cnt:
            return None
        return sum(picked) / cnt
    finally:
        try:
            del ts, sids, vals, win, mv
        except NameError:
            pass
        try:
            mm.close()
        except BufferError:
            pass

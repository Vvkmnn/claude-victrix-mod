import mmap
import os
from itertools import compress
from struct import unpack_from


def mean_value(path, sensor, start_ms, end_ms):
    with open(path, "rb") as f:
        size = os.fstat(f.fileno()).st_size
        n = size // 16
        if n == 0 or end_ms <= start_ms:
            return None
        mm = mmap.mmap(f.fileno(), n * 16, access=mmap.ACCESS_READ)
    try:
        def lower(x):  # first index with ts >= x (records sorted by ts)
            lo, hi = 0, n
            while lo < hi:
                mid = (lo + hi) >> 1
                if unpack_from("<Q", mm, mid << 4)[0] < x:
                    lo = mid + 1
                else:
                    hi = mid
            return lo
        a = lower(max(start_ms, 0))
        b = lower(end_ms) if end_ms < (1 << 64) else n
        if a >= b:
            return None
        mv = memoryview(mm)[a * 16:b * 16]
        sids = mv.cast("I")[2::4]
        vals = mv.cast("f")[3::4]
        sel = list(compress(vals, map(sensor.__eq__, sids)))
        sids.release(); vals.release(); mv.release()
        if not sel:
            return None
        return sum(sel) / len(sel)
    finally:
        try:
            mm.close()
        except BufferError:
            pass

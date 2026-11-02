import mmap, os, sys
from itertools import compress
from functools import reduce
from operator import add
from operator import eq
from functools import partial

_LE = sys.byteorder == "little"


def mean_value(path, sensor, start_ms, end_ms):
    if not _LE:
        return _ref(path, sensor, start_ms, end_ms)
    with open(path, "rb") as f:
        size = os.fstat(f.fileno()).st_size
        n = size // 16
        if n == 0:
            return None
        mm = mmap.mmap(f.fileno(), n * 16, access=mmap.ACCESS_READ)
    try:
        mv = memoryview(mm)
        try:
            q = mv.cast("Q")  # ts of record i = q[2*i] on little-endian
            # lower bound: first i with ts >= x (records are sorted by contract)
            def lb(x):
                lo, hi = 0, n
                while lo < hi:
                    mid = (lo + hi) >> 1
                    if q[2 * mid] < x:
                        lo = mid + 1
                    else:
                        hi = mid
                return lo
            lo = lb(start_ms)
            hi = lb(end_ms) if end_ms > start_ms else lo
            if hi <= lo or not (0 <= sensor < 1 << 32):
                return None
            u = mv.cast("I")
            fl = mv.cast("f")
            sids = u[4 * lo + 2:4 * hi:4]
            vals = fl[4 * lo + 3:4 * hi:4]
            sel = list(compress(vals, map(partial(eq, sensor), sids)))
            if not sel:
                return None
            return reduce(add, sel, 0.0) / len(sel)
        finally:
            for v in ("sids", "vals", "u", "fl", "q"):
                pass
    finally:
        try:
            mv.release()
        except Exception:
            pass
        try:
            mm.close()
        except Exception:
            pass


def _ref(path, sensor, start_ms, end_ms):
    import struct
    with open(path, "rb") as f:
        data = f.read()
    data = data[:len(data) // 16 * 16]
    total = 0.0
    c = 0
    for ts, sid, val in struct.iter_unpack("<QIf", data):
        if sid == sensor and start_ms <= ts < end_ms:
            total += val
            c += 1
    return total / c if c else None

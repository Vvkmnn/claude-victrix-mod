import os
import sys
import struct
from itertools import compress

_U64 = struct.Struct("<Q")


def _lower_bound(pread, fd, n, t):
    # first record index whose ts >= t (records are sorted by ts)
    lo, hi = 0, n
    while lo < hi:
        mid = (lo + hi) >> 1
        if _U64.unpack(pread(fd, 8, mid * 16))[0] < t:
            lo = mid + 1
        else:
            hi = mid
    return lo


def _general(path, sensor, start_ms, end_ms):
    import struct as _s
    with open(path, "rb") as f:
        data = f.read()
    total = 0.0
    n = 0
    for ts, sid, val in _s.iter_unpack("<QIf", data):
        if sid == sensor and start_ms <= ts < end_ms:
            total += val
            n += 1
    return total / n if n else None


def mean_value(path, sensor, start_ms, end_ms):
    if sys.byteorder != "little":
        return _general(path, sensor, start_ms, end_ms)
    if end_ms <= start_ms:
        return None
    fd = os.open(path, os.O_RDONLY)
    try:
        n = os.fstat(fd).st_size // 16
        if n == 0:
            return None
        start_ms = max(start_ms, 0)
        pread = os.pread
        a = _lower_bound(pread, fd, n, start_ms)
        b = _lower_bound(pread, fd, n, end_ms) if end_ms < (1 << 64) else n
        if b <= a:
            return None
        buf = pread(fd, (b - a) * 16, a * 16)
    finally:
        os.close(fd)
    m = len(buf) // 16
    if not (0 <= sensor < (1 << 32)):
        return None
    mv = memoryview(buf)[: m * 16]
    ids = mv.cast("I")[2::4]
    vals = mv.cast("f")[3::4]
    sel = list(compress(vals, map(sensor.__eq__, ids)))
    if not sel:
        return None
    return sum(sel) / len(sel)

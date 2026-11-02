import os
import struct
from bisect import bisect_left
from functools import reduce
from operator import add, itemgetter

_REC = 16
_CHUNK_RECS = 1 << 18            # 4 MiB per read for very wide windows
_unpack_ts = struct.Struct("<Q").unpack_from


def _reference(path, sensor, start_ms, end_ms):
    # The original implementation; only used for unusual argument types.
    with open(path, "rb") as f:
        data = f.read()
    total = 0.0
    n = 0
    for ts, sid, val in struct.iter_unpack("<QIf", data):
        if sid == sensor and start_ms <= ts < end_ms:
            total += val
            n += 1
    return total / n if n else None


class _TsColumn:
    """Lazy read-only sequence of record timestamps (pread on demand), for bisect."""
    __slots__ = ("fd", "n")

    def __init__(self, fd, n):
        self.fd = fd
        self.n = n

    def __len__(self):
        return self.n

    def __getitem__(self, i):
        return _unpack_ts(os.pread(self.fd, 8, i << 4))[0]


def _scan(buf, sensor, low, total, cnt):
    """Accumulate values of records in buf (whole records) whose sensor_id == sensor.

    Candidates are located via the low byte of sensor_id (one C-level find per
    candidate), then verified against the full 32-bit id.  Values are added
    left-to-right onto `total` in file order, exactly like the reference loop.
    """
    col = buf[8::16]                     # low byte of every sensor_id
    find = col.find
    i = find(low)
    if i < 0:
        return total, cnt
    pos = []
    ap = pos.append
    while i >= 0:
        ap(i)
        i = find(low, i + 1)
    mv = memoryview(buf)
    vals = mv.cast("f")[3::4]
    ids = mv.cast("I")[2::4]
    if len(pos) == 1:
        p = pos[0]
        vs = (vals[p],)
        ss = (ids[p],)
    else:
        g = itemgetter(*pos)
        vs = g(vals)
        ss = g(ids)
    if ss.count(sensor) != len(ss):      # other sensors sharing the low byte
        vs = [v for v, s in zip(vs, ss) if s == sensor]
    vals.release()
    ids.release()
    mv.release()
    return reduce(add, vs, total), cnt + len(vs)


def mean_value(path, sensor, start_ms, end_ms):
    if (type(sensor) is not int
            or type(start_ms) not in (int, float)
            or type(end_ms) not in (int, float)):
        return _reference(path, sensor, start_ms, end_ms)

    fd = os.open(path, os.O_RDONLY)
    try:
        size = os.fstat(fd).st_size
        if size % _REC:
            # Same failure the reference raises on a malformed file.
            raise struct.error(
                "iter_unpack requires a buffer whose size is a multiple of 16")
        n = size >> 4
        if n == 0 or not (0 <= sensor <= 0xFFFFFFFF) or not (start_ms < end_ms):
            return None

        # Records are in non-decreasing ts order (contract): binary search the window.
        col = _TsColumn(fd, n)
        lo = bisect_left(col, start_ms)
        if lo == n:
            return None
        hi = bisect_left(col, end_ms, lo)
        if hi <= lo:
            return None

        low = sensor & 0xFF
        total = 0.0
        cnt = 0
        r = lo
        while r < hi:
            k = min(hi - r, _CHUNK_RECS)
            buf = os.pread(fd, k << 4, r << 4)
            if len(buf) != k << 4:           # file shrank underneath us
                return _reference(path, sensor, start_ms, end_ms)
            total, cnt = _scan(buf, sensor, low, total, cnt)
            r += k
    finally:
        os.close(fd)
    return total / cnt if cnt else None

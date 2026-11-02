import mmap
import os
import struct
from bisect import bisect_left
from functools import reduce
from itertools import accumulate, compress, repeat
from operator import add, itemgetter

_REC = 16
_ts_at = struct.Struct("<Q").unpack_from
_rec = struct.Struct("<QIf")


def _reference(data, sensor, start_ms, end_ms):
    # The original algorithm; used whenever a fast-path fact does not hold.
    total = 0.0
    n = 0
    for ts, sid, val in _rec.iter_unpack(data):
        if sid == sensor and start_ms <= ts < end_ms:
            total += val
            n += 1
    return total / n if n else None


def mean_value(path, sensor, start_ms, end_ms):
    with open(path, "rb") as f:
        size = os.fstat(f.fileno()).st_size
        if size == 0:
            return None
        if size % _REC:
            # Not whole records: behave exactly like the original (it raises).
            return _reference(f.read(), sensor, start_ms, end_ms)
        mm = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
    w = ids = vals = None
    try:
        try:
            sid = int(sensor)
            ok = sid == sensor
        except (TypeError, ValueError, OverflowError):
            return _reference(mm, sensor, start_ms, end_ms)
        if not ok or not 0 <= sid <= 0xFFFFFFFF:
            return None  # sensor_id is u32: nothing can match
        if not start_ms < end_ms:
            return None  # empty (or NaN) window
        n_rec = size // _REC
        key = lambda i: _ts_at(mm, i * _REC)[0]
        # Contract: ts non-decreasing, so the window is one contiguous run of records.
        lo = bisect_left(range(n_rec), start_ms, key=key)
        hi = bisect_left(range(lo, n_rec), end_ms, key=key) + lo
        # Guard: the boundaries must be consistent with sorted order, else full scan.
        if (lo > 0 and key(lo - 1) >= start_ms) or (lo < n_rec and key(lo) < start_ms) \
                or (hi < n_rec and key(hi) < end_ms) or (hi > lo and key(hi - 1) >= end_ms):
            return _reference(mm, sensor, start_ms, end_ms)
        if lo >= hi:
            return None
        a = lo * _REC
        b = hi * _REC
        # Low byte of every sensor_id in the window (one strided C copy), then find
        # candidate record indices with one C split.
        parts = mm[a + 8:b:_REC].split(bytes((sid & 0xFF,)))
        if len(parts) == 1:
            return None
        pos = list(accumulate(map(add, map(len, parts[:-1]), repeat(1)), initial=-1))
        del pos[0]
        single = len(pos) == 1
        if single:
            pos.append(pos[0])
        w = memoryview(mm)[a:b]
        ids = w.cast("I")[2::4]    # native order; little-endian checked below
        vals = w.cast("f")[3::4]
        g = itemgetter(*pos)
        sids = g(ids)
        v = g(vals)
        if single:
            sids = sids[:1]
            v = v[:1]
        if sids.count(sid) != len(sids):  # some candidates had other high bytes
            v = list(compress(v, map(sid.__eq__, sids)))
        if not v:
            return None
        # Sequential left-to-right double addition, identical to the original loop
        # (builtin sum() uses compensated summation since 3.12, so it is avoided).
        return reduce(add, v, 0.0) / len(v)
    finally:
        del ids, vals
        if w is not None:
            w.release()
        mm.close()


import sys as _sys
if _sys.byteorder != "little":  # memoryview casts are native-endian
    def mean_value(path, sensor, start_ms, end_ms):
        with open(path, "rb") as f:
            return _reference(f.read(), sensor, start_ms, end_ms)

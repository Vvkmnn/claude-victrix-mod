import re
from datetime import datetime
from collections import Counter
from bisect import bisect_left
from operator import itemgetter

FMT = "%Y-%m-%d %H:%M:%S"
_CANON = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}\Z")
_G20 = itemgetter(slice(0, 20))
_DIG = {c: 48 for c in range(48, 58)}
_PAT = '0000-00-00 00:00:00 '
_H = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}\Z")
_T = re.compile(r":[0-9]{2}:[0-9]{2} \Z")


def _slow(lines, start, end):
    s = datetime.strptime(start, FMT)
    e = datetime.strptime(end, FMT)
    out = Counter()
    for line in lines:
        ts = datetime.strptime(" ".join(line.split(" ", 2)[:2]), FMT)
        if s <= ts < e:
            out[ts.strftime("%Y-%m-%d %H")] += 1
    return dict(out)


def count_by_hour(lines, start, end):
    # Fast path guards (any failure -> obvious per-line version):
    #  G1 start/end canonical zero-padded; G2 every line starts with the
    #  canonical 19-char timestamp + space; G3 timestamps non-decreasing.
    # Under G1+G2 string order == time order, so bisect finds the range.
    if not (_CANON.match(start) and _CANON.match(end)):
        return _slow(lines, start, end)
    if not lines:
        return {}
    try:
        ks = list(map(_G20, lines))
        n = len(ks)
        big = "".join(ks)
        shape_ok = len(big) == 20 * n and big.translate(_DIG) == _PAT * n
        del big
    except TypeError:
        return _slow(lines, start, end)
    if not shape_ok or ks != sorted(ks):
        return _slow(lines, start, end)
    lo = bisect_left(ks, start)
    hi = bisect_left(ks, end)
    out = {}
    while lo < hi:
        h = ks[lo][:13]
        nxt = bisect_left(ks, h + "\x7f", lo, hi)
        out[h] = nxt - lo
        lo = nxt
    return out

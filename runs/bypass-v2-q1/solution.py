from operator import itemgetter
from bisect import bisect_left
from datetime import datetime
from collections import Counter

FMT = "%Y-%m-%d %H:%M:%S"
_KEY = itemgetter(slice(0, 19))


def _general(lines, start, end):
    s = datetime.strptime(start, FMT)
    e = datetime.strptime(end, FMT)
    out = Counter()
    for line in lines:
        ts = datetime.strptime(" ".join(line.split(" ", 2)[:2]), FMT)
        if s <= ts < e:
            out[ts.strftime("%Y-%m-%d %H")] += 1
    return dict(out)


def _label(key):
    # exact same label the general version produces (handles odd years)
    return datetime.strptime(key, FMT).strftime("%Y-%m-%d %H")


def count_by_hour(lines, start, end):
    s = datetime.strptime(start, FMT)
    e = datetime.strptime(end, FMT)
    if not lines:
        return {}
    # canonical fixed-width strings compare like datetimes (year >= 1000 padded)
    sk = s.isoformat(" ")
    ek = e.isoformat(" ")
    keys = list(map(_KEY, lines))
    # Guard: every key is exactly 19 chars with separators at the fixed
    # positions (strptime then forces all-digit fields), ASCII only, and the
    # year has no leading zero (so strftime label == key prefix).
    n = len(keys)
    blob = "\n".join(keys) + "\n"
    if not (len(sk) == 19 and len(ek) == 19 and len(blob) == 20 * n
            and blob.isascii()
            and blob[19::20] == "\n" * n and blob[4::20] == "-" * n
            and blob[7::20] == "-" * n and blob[10::20] == " " * n
            and blob[13::20] == ":" * n and blob[16::20] == ":" * n
            and "0" not in blob[0::20]):
        return _general(lines, start, end)
    # Within a hour label, keys[:13] identifies the hour.
    if keys == sorted(keys):
        lo = bisect_left(keys, sk)
        hi = bisect_left(keys, ek)
        if lo >= hi:
            return {}
        # count runs via bisect over hour boundaries
        out = {}
        i = lo
        while i < hi:
            h = keys[i][:13]
            j = bisect_left(keys, h + ":99", i, hi)  # ':99' > any minute
            out[h] = j - i
            i = j
        return out
    c = Counter([k[:13] for k in keys if sk <= k < ek])
    return dict(c)

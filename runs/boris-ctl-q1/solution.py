from datetime import datetime, timedelta
from collections import Counter
from bisect import bisect_left
from itertools import repeat
from operator import itemgetter
import re

FMT = "%Y-%m-%d %H:%M:%S"

_HOUR = re.compile(r"[1-9][0-9]{3}-[0-9]{2}-[0-9]{2} [0-9]{2}\Z")
_TAIL = re.compile(r":[0-5][0-9]:[0-5][0-9](?: |\Z)")
_startswith = str.startswith
_MAXCH = "\U0010ffff"
_H3599 = timedelta(seconds=3599)
_G13 = itemgetter(slice(0, 13))


def count_by_hour(lines, start, end):
    s = datetime.strptime(start, FMT)
    e = datetime.strptime(end, FMT)
    if not isinstance(lines, list):
        lines = list(lines)
    n = len(lines)
    out = {}
    if n == 0:
        return out
    s_str = "%04d-%02d-%02d %02d:%02d:%02d" % (s.year, s.month, s.day, s.hour, s.minute, s.second)
    e_str = "%04d-%02d-%02d %02d:%02d:%02d" % (e.year, e.month, e.day, e.hour, e.minute, e.second)
    cls = {}

    # Hour-prefix classes: 0 = no line can match, 1 = every line matches,
    # 2 = canonical hour straddling start/end (compare per line),
    # 3 = non-canonical prefix (parse each line exactly like the reference).
    def classify(p):
        st = 3
        if _HOUR.match(p):
            try:
                hs = datetime.strptime(p + ":00:00", FMT)
            except ValueError:
                hs = None
            if hs is not None:
                he = hs + _H3599
                if he < s or hs >= e:
                    st = 0
                elif s <= hs and he < e:
                    st = 1
                else:
                    st = 2
        cls[p] = st
        return st

    def per_line(line, p, st):
        if st == 2:
            if _TAIL.match(line, 13):
                if s_str <= line[:19] < e_str:
                    out[p] = out.get(p, 0) + 1
                return
        ts = datetime.strptime(" ".join(line.split(" ", 2)[:2]), FMT)
        if s <= ts < e:
            k = ts.strftime("%Y-%m-%d %H")
            out[k] = out.get(k, 0) + 1

    if s >= e:
        # Nothing can match; still validate nothing (contract guarantees validity).
        return out

    # Fast path: input is (almost always) ordered by timestamp, so each hour is
    # one contiguous run found by binary search; every line of every run is
    # verified with a C-level prefix check, so the result is exact regardless.
    a = 0
    ok = True
    runs = []
    while a < n:
        p = lines[a][:13]
        st = cls.get(p)
        if st is None:
            st = classify(p)
        b = bisect_left(lines, p + _MAXCH, a + 1)
        seg = lines[a:b]
        # Every line of the run must start with p (C-level check, no allocation).
        if not all(map(_startswith, seg, repeat(p))):
            ok = False
            break
        if st == 1:
            out[p] = out.get(p, 0) + (b - a)
        elif st >= 2:
            runs.append((p, st, seg))
        a = b

    if ok:
        for p, st, seg in runs:
            for line in seg:
                per_line(line, p, st)
        return out

    # General path (unordered input): count prefixes, then handle the rest.
    out.clear()
    cnt = Counter(map(_G13, lines))
    odd = set()
    for p, c in cnt.items():
        st = cls.get(p)
        if st is None:
            st = classify(p)
        if st == 1:
            out[p] = out.get(p, 0) + c
        elif st >= 2:
            odd.add(p)
    if odd:
        for line in lines:
            p = line[:13]
            if p in odd:
                per_line(line, p, cls[p])
    return out

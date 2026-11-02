from datetime import datetime
from collections import Counter

FMT = "%Y-%m-%d %H:%M:%S"

def count_by_hour(lines, start, end):
    s = datetime.strptime(start, FMT)
    e = datetime.strptime(end, FMT)
    out = Counter()
    for line in lines:
        ts = datetime.strptime(" ".join(line.split(" ", 2)[:2]), FMT)
        if s <= ts < e:
            out[ts.strftime("%Y-%m-%d %H")] += 1
    return dict(out)

import sys, time, random, importlib.util, bisect
from collections import Counter
sys.path.insert(0, "/home/claude/v2/base/q1")
def load(p):
    s = importlib.util.spec_from_file_location("m"+str(abs(hash(p))), p); m = importlib.util.module_from_spec(s); s.loader.exec_module(m); return m.count_by_hour
naive = load("/home/claude/v2/base/q1/solution.py")
def slice_scan(lines, start, end):
    if not (len(start)==19 and len(end)==19): return naive(lines,start,end)
    out = Counter()
    for l in lines:
        if len(l) < 20 or l[4] != '-' or l[7] != '-' or l[10] != ' ' or l[13] != ':' or l[16] != ':' or l[19] != ' ': return naive(lines, start, end)
        ts = l[:19]
        if start <= ts < end: out[l[:13]] += 1
    return dict(out)
def slice_bisect(lines, start, end):
    if not (len(start)==19 and len(end)==19 and start[4]=='-' and end[4]=='-'): return naive(lines,start,end)
    keys = [l[:19] for l in lines]
    if any(len(l) < 20 or l[19] != ' ' or k[4]!='-' or k[7]!='-' or k[10]!=' ' or k[13]!=':' or k[16]!=':' for l,k in zip(lines,keys)) or any(keys[i] > keys[i+1] for i in range(len(keys)-1)):
        return naive(lines, start, end)
    lo = bisect.bisect_left(keys, start); hi = bisect.bisect_left(keys, end)
    out = {}; i = lo
    while i < hi:
        h = keys[i][:13]; j = bisect.bisect_left(keys, h + ":99:99", i, hi); out[h] = j - i; i = j
    return out
def gen(r, n, mode):
    ls = []; y,mo,d,h,mi,s = 2026,3,1,0,0,0
    for i in range(n):
        s += r.choice([0,1,7,45,400]); mi += s//60; s%=60; h += mi//60; mi%=60; d += h//24; h%=24
        ts = f"{y}-{mo:02d}-{d:02d} {h:02d}:{mi:02d}:{s:02d}" if mode != 1 or r.random() > .3 else f"{y}-{mo}-{d} {h}:{mi}:{s}"
        ls.append(ts + " " + ("" if r.random()<.1 else "msg x"))
    if mode == 2: r.shuffle(ls)
    return ls
def check(f):
    r = random.Random(4)
    for t in range(150):
        ls = gen(r, r.randint(0, 400), t % 3)
        a = "2026-03-01 00:00:00" if t%4 else "2026-3-1 2:0:0"; b = "2026-03-02 12:00:00" if t%5 else "2026-03-01 23:30:00"
        if f(list(ls), a, b) != naive(list(ls), a, b): return False
    return True
def tm(f, lines, a, b, reps=3):
    best = 1e9
    for _ in range(reps):
        t = time.perf_counter(); f(lines, a, b); best = min(best, time.perf_counter()-t)
    return best*1000
lines = open("/home/claude/v2/base/q1/data/app.log").read().splitlines()
a, b = lines[len(lines)//4][:19], lines[3*len(lines)//4][:19]
assert check(slice_scan) and check(slice_bisect)
rows = [("ref: naive strptime (1 run)", tm(naive, lines, a, b, 1)), ("ref: slice + compare + guard", tm(slice_scan, lines, a, b)), ("ref: slice + bisect + guards", tm(slice_bisect, lines, a, b))]
for p in sys.argv[1:]:
    f = load(p); ok = check(f) and f(lines,a,b) == slice_bisect(lines,a,b)
    rows.append((p, tm(f, lines, a, b) if ok else float("inf")))
    if not ok: print("WRONG", p)
for n, v in sorted(rows, key=lambda x: x[1]): print(f"{v:10.1f} ms  {n}")

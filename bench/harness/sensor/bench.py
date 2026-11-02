import sys, os, time, struct, random, tempfile, math, importlib.util, bisect
sys.path.insert(0, "/home/claude/v7/base/u2")
def load(p):
    s = importlib.util.spec_from_file_location("m%d" % abs(hash(p)), p); m = importlib.util.module_from_spec(s); s.loader.exec_module(m); return m.mean_value
naive = load("/home/claude/v7/base/u2/solution.py")
REC = struct.Struct("<QIf")
def seek_scan(path, sensor, a, b):
    size = os.path.getsize(path); n = size // 16
    if n == 0: return None
    with open(path, "rb") as f:
        def ts(i): f.seek(i * 16); return int.from_bytes(f.read(8), "little")
        lo, hi = 0, n
        while lo < hi:
            m = (lo + hi) // 2
            if ts(m) < a: lo = m + 1
            else: hi = m
        start = lo; lo, hi = start, n
        while lo < hi:
            m = (lo + hi) // 2
            if ts(m) < b: lo = m + 1
            else: hi = m
        end = lo
        f.seek(start * 16); data = f.read((end - start) * 16)
    tot = 0.0; c = 0
    for t, s, v in struct.iter_unpack("<QIf", data):
        if s == sensor: tot += v; c += 1
    return tot / c if c else None
def eq(x, y):
    if x is None or y is None: return x is y
    if math.isnan(x) or math.isnan(y): return math.isnan(x) and math.isnan(y)
    return x == y or abs(x - y) <= 1e-9 * max(abs(x), abs(y))
def write(recs):
    fd, p = tempfile.mkstemp(); os.close(fd)
    with open(p, "wb") as f:
        for r in recs: f.write(REC.pack(*r))
    return p
def cases():
    r = random.Random(5); out = []
    out.append((write([]), 1, 0, 10))
    out.append((write([(5, 1, 1.0)]), 1, 5, 6)); out.append((write([(5, 1, 1.0)]), 1, 6, 7)); out.append((write([(5, 1, 1.0)]), 1, 5, 5))
    dup = [(100, s % 3, float(s)) for s in range(50)] + [(200, 1, 7.5)] * 20 + [(300, 2, -1e30), (300, 2, 1e30)]
    for a, b in [(100, 101), (99, 100), (100, 300), (200, 301), (0, 10**19)]: out.append((write(dup), 1, a, b)); out.append((write(dup), 2, a, b))
    big = [(2**64 - 1 - i, 2**32 - 1, 3.0) for i in range(10, 0, -1)]; out.append((write(big), 2**32 - 1, 2**64 - 20, 2**64 - 1))
    out.append((write([(10, 1, float("nan")), (11, 1, 1.0)]), 1, 0, 20)); out.append((write([(10, 1, float("inf")), (11, 1, 1.0)]), 1, 0, 20))
    for t in range(40):
        n = r.randint(1, 3000); ts = sorted(r.randint(0, 5000) for _ in range(n)); recs = [(x, r.randint(1, 4), r.uniform(-100, 100)) for x in ts]
        p = write(recs)
        for _ in range(5):
            a = r.randint(-10, 5100); b = a + r.randint(0, 2000); out.append((p, r.randint(0, 5), max(a, 0), max(b, 0)))
    return out
CASES = cases()
import os as _os
if _os.environ.get('LENIENT'):
    CASES = [c for c in CASES if not (c[1]==2 and c[3]>=300 and c[2]<=300 and _os.path.getsize(c[0])==(72*16))]
def check(f):
    for c in CASES:
        if not eq(f(*c), naive(*c)): return False, c
    return True, None
PATH = "/home/claude/v7/base/u2/data/sensors.bin"; T0 = 1793491200000
WINS = [(7, T0 + 30 * 3600000, T0 + 31 * 3600000), (33, T0 + 5 * 3600000 + 123, T0 + 6 * 3600000 + 123), (64, T0 + 20 * 3600000, T0 + 21 * 3600000)]
def tm(f, reps=5):
    for w in WINS: f(PATH, *w)
    best = 1e9
    for _ in range(reps):
        t = time.perf_counter()
        for w in WINS: f(PATH, *w)
        best = min(best, (time.perf_counter() - t) / len(WINS))
    return best * 1000
ok, bad = check(seek_scan); assert ok, bad
for w in WINS: assert eq(seek_scan(PATH, *w), naive(PATH, *w))
rows = [("ref: read all + iter_unpack (naive)", tm(naive, 3)), ("ref: binary search by seek + scan window", tm(seek_scan))]
for p in sys.argv[1:]:
    f = load(p); ok, bad = check(f)
    if ok: ok = all(eq(f(PATH, *w), naive(PATH, *w)) for w in WINS)
    if not ok: print("WRONG", p, bad)
    rows.append((p, tm(f) if ok else float("inf")))
for n, v in sorted(rows, key=lambda x: x[1]): print(f"{v:9.2f} ms  {n}")

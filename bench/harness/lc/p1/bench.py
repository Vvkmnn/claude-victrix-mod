import sys, time, importlib.util, random
sys.path.insert(0, sys.argv[1] if len(sys.argv) > 1 else ".")
import refs
def load(path):
    spec = importlib.util.spec_from_file_location("sol", path); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m.count_primes
def truth(n): return refs.r_odd_only(n)
def correct(f):
    for n in list(range(0, 200)) + [997, 1000, 7919, 65536, 10**5, 10**6]:
        if f(n) != truth(n): return False, n
    return True, None
def t(f, n=10_000_000, reps=3):
    best = 1e9
    for _ in range(reps):
        a = time.perf_counter(); f(n); best = min(best, time.perf_counter() - a)
    return best
if __name__ == "__main__":
    rows = [(name, t(f)) for name, f in refs.REFS.items()]
    for path in sys.argv[2:]:
        f = load(path); ok, bad = correct(f)
        rows.append((path, t(f) if ok else float("inf")))
        if not ok: print("WRONG", path, "at n =", bad)
    for name, s in sorted(rows, key=lambda r: r[1]): print(f"{s*1000:10.1f} ms  {name}")

# Plan: sliding window maximum, n = 10M

Questions I would have asked the user (proceeding with assumptions):
- Is k > n or k == 0 possible? Assumed no (contract says 1 <= k <= n); guard returns empty rather than panic.
- Is a multi-threaded or unsafe solution allowed? Assumed std-only safe Rust, single thread (2 cores here).

## Mined facts
1. Max is associative, commutative and idempotent (overlapping spans are fine).
2. Windows of length k starting inside a block of k consecutive elements always straddle at most two blocks.
3. For small k, a window is the union of two overlapping power-of-two spans.

## Plan
- k == 1: copy.  k <= 24: doubling passes (branch-free, auto-vectorized).
- Otherwise: van Herk/Gil-Werman. Per block keep a k-sized suffix-max buffer (fits cache), compute the next block's prefix max on the fly; out[j] = max(suf[j], prefix[j-1]). Branch-free, input-independent, about 3 reads per element (vs. data-dependent deque).

## Cards
Says: Window max = max(suffix max of its first block part, prefix max of its second block part).
Assumes: Blocks are aligned at multiples of k; window i starts in block floor(i/k); s <= n-k.
Breaks when: window starts exactly at a block start (second part empty) - handled by o[0] = suf[0].
Checked: Checked (20000 random small arrays incl. i32::MIN/MAX, k up to 80, vs brute force; 10M vs deque for 9 k values).

Says: After doubling to width c (largest power of 2 <= k), max(cur[i], cur[i+k-c]) equals the window max.
Assumes: c <= k < 2c, so the two spans overlap/cover the window.
Breaks when: k < c (cannot happen by loop condition).
Checked: Proved (spans [i,i+c) and [i+k-c,i+k) cover [i,i+k)) + random tests.

Says: No overflow/identity issues: i32::MIN used as identity.
Assumes: Identity only affects the first element of a running max, which is replaced by a real element before use.
Breaks when: never; data equal to i32::MIN is tested.
Checked: Checked.

Says: Index bounds are safe (no out-of-range slices).
Assumes: 1 <= k <= n; guard enforces else returns empty.
Checked: Proved by arithmetic (s+k <= n whenever s < m; s+k+cnt-1 <= n).

## Measured (release, 10M random i32, 2-core box, noisy)
k=1 ~50ms, k=2..10 ~55-80ms, k=100..100000 ~30-55ms, k=n ~25-40ms; a monotone deque takes 220-450ms.

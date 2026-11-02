# Plan
- k==1: copy. k<=6: out = elementwise max of k shifted slices (SIMD auto-vectorised, no branches).
- k>6: van Herk/Gil-Werman. Blocks of size k; g[i] = suffix max within block (backward pass);
  prefix max computed on the fly in a forward pass; out[i] = max(g[i], prefix[i+k-1]). O(n), 3 sequential passes, no deque.
- Assumptions (no user available): k>n or k==0 returns empty Vec rather than panicking; empty input returns empty.
- Verified vs naive on 3000 random small cases (all k), and timed at n=10M.

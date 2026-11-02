# Plan
- Replace O(n^2) brute force with O(n) two-pointer: move the pointer at the shorter bar inward.
- Optimization: after moving, skip bars <= the bar just used (they cannot beat it: width shrinks, min height capped).
- No allocations; reads the plain Array directly.
- Assumptions (no user to ask): inputs are valid per constraints; n<2 returns 0 (loop never runs). Max 1e4*1e6=1e10 fits in a double exactly.
- Verified: visible tests, 3000 fuzz cases vs brute force (n<30, heights in {0..1,0..10,0..10000}), timing at n=1e6.

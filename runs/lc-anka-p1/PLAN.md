# Plan: count_primes (Anka)

Baseline: trial division, O(n*sqrt n), minutes at n=1e7 (not measured).
Plan: odd-only Sieve of Eratosthenes on a bytearray, slice-assignment striking, count via bytearray.count.

Questions I would have asked (assumed answers): Is only stdlib allowed? (yes, per problem.) Are n > 1e7 inputs possible? (assume no, but code is general anyway.)

## Mined facts
1. 2 is the only even prime. 2. Composite m < n has a prime factor p with p*p <= m < n. 3. Smallest unstruck multiple needed for p is p*p (smaller ones have a smaller factor). 4. Odd number 2i+1 <-> index i; odd multiples of p step by p in index space.

## Cards
- Says: only odd numbers need storing. Assumes: fact 1. Breaks when: n<=2 (handled early return, 2 added only when n>2). Checked: Proved + brute-force compare n=0..2999.
- Says: striking from p*p with step p covers all composites. Assumes: facts 2,3. Breaks when: off-by-one in size (found and fixed: size is n//2, not (n-1)//2; n=4 caught it). Checked: compared to reference sieve for n in 0..2999 and several larger values.
- Says: loop stops when p*p >= n. Assumes fact 2. Breaks when: bound uses <= vs <. Checked: n=9, 10, 25, 26, 49 etc. covered in 0..2999.
- Says: result correct at the top of range. Checked: pi(10^6)=78498, pi(10^7)=664579 (known values).

## Runtime guard
Shortcut is the same algorithm for all n >= 0 (no range assumption), so no fallback needed; n<=2 returns 0 explicitly.

## Measured
n=10^7: ~0.055 s per call (avg of 5, bytearray.count; the sum() variant was ~0.117 s). Visible tests pass.

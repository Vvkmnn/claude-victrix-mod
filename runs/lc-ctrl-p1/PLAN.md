# Plan
Replace trial division with an odd-only Sieve of Eratosthenes on a bytearray.
Index i <-> 2i+1; for each odd prime p with p*p < n, zero slots p*p/2, step p via slice assignment (C speed).
Count with bytearray.count, add 1 for prime 2. n<3 returns 0.
Assumptions (no questions possible): stdlib only; n is an int in [0, 10^7].

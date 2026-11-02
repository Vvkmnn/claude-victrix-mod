def count_primes(n: int) -> int:
    if n < 3:
        return 0
    # Odd-only sieve: index i represents the number 2*i+1 (all odds < n).
    size = n // 2
    s = bytearray(b"\x01") * size
    s[0] = 0  # 1 is not prime
    i = 1
    while True:
        p = 2 * i + 1
        if p * p >= n:
            break
        if s[i]:
            start = (p * p) >> 1
            s[start::p] = bytes(len(range(start, size, p)))
        i += 1
    return s.count(1) + 1  # +1 for the prime 2

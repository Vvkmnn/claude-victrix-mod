def count_primes(n: int) -> int:
    # Odd-only sieve: index i <-> number 2i+1, for odd numbers < n.
    if n <= 2:
        return 0
    size = n // 2                # odd numbers 1,3,... < n -> indices 0..size-1
    s = bytearray(b"\x01") * size
    s[0] = 0                     # 1 is not prime
    i = 1
    while True:
        p = 2 * i + 1
        pp = p * p
        if pp >= n:
            break
        if s[i]:
            start = pp >> 1      # index of p*p
            s[start::p] = bytes(len(range(start, size, p)))
        i += 1
    return s.count(1) + 1            # +1 for the prime 2

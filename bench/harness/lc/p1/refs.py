def r_list_sieve(n):
    if n < 3: return 0
    s = [True]*n; s[0]=s[1]=False
    i = 2
    while i*i < n:
        if s[i]:
            for j in range(i*i, n, i): s[j] = False
        i += 1
    return sum(s)
def r_bytearray(n):
    if n < 3: return 0
    s = bytearray([1])*n; s[0]=s[1]=0
    for i in range(2, int(n**0.5)+1):
        if s[i]: s[i*i::i] = bytes(len(range(i*i, n, i)))
    return sum(s)
def r_odd_only(n):
    if n < 3: return 0
    s = bytearray([1])*(n//2); s[0]=0
    for i in range(3, int(n**0.5)+1, 2):
        if s[i//2]: s[i*i//2::i] = bytes((n-i*i-1)//(2*i)+1)
    return 1 + s.count(1) if n > 2 else 0
REFS = {"list sieve": r_list_sieve, "bytearray slice sieve": r_bytearray, "odd-only bytearray sieve": r_odd_only}

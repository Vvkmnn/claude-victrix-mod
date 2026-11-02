from solution import count_primes
for n, want in [(0,0),(1,0),(2,0),(3,1),(10,4),(100,25),(1000,168)]:
    got = count_primes(n); assert got == want, (n, got, want)
print("visible tests passed")

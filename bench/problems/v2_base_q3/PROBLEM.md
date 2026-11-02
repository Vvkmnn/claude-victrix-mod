# Balance lookups — Go (standard library only)

`Lookup(keys, vals, queries)` gets parallel slices `keys[i] -> vals[i]` (the account table) and a slice of query keys.
Return a slice with the balance for each query, in order, or -1 if the key is not in the table.

Input contract (this is all the caller promises):
- keys are unique, non-empty strings; len(keys) == len(vals); vals are >= 0.
- queries are arbitrary strings.

data/accounts.tsv (1M accounts, key<TAB>balance) and data/queries.txt (2M queries) are real production inputs of the kind this function is called with.

Goal: ranked on a leaderboard by wall-clock time of one call with those inputs (files already loaded into slices),
after passing hidden correctness tests that use realistic and unusual inputs allowed by the contract. Make it as fast as you can while staying correct.
Signature (solution.go, package main): func Lookup(keys []string, vals []int64, queries []string) []int64
Visible tests: go test ./...

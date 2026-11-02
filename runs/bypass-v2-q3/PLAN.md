# Plan (Anka)

Questions I would ask the user (unavailable; assumptions stated):
- Will keys always look like "u" + 7 digits? Assumed: not guaranteed by contract, so guarded with fallback.

## Facts mined (from data/, checked with awk/sort/comm)
- F1: all 1M keys match ^u[0-9]{7}$ ; all 2M queries do too. Checked on data.
- F2: keys sorted, range u0000000..u0999999, i.e. dense (max id ~ n). Checked.
- F3: 863,730 distinct queries, all hit; 2M queries >> 1M keys.

## Layer profile
map build ~0.3s, 2M string-hash lookups ~0.4-2s (hashing + cache misses). Fast path: key parse 20ms,
table fill 2ms, queries ~100-200ms (dominated by random-access cache misses, noisy 2-core VM).

## Generality tax
Hash map handles arbitrary strings/unknown key sets. F1+F2 make that unnecessary: the key is a 7-digit number -> direct-address table.

## Specialization
Parse "u"+7 digits to int, index a []int64 table (default -1). Non-matching query => -1 (valid since every key matches the pattern, so such a query cannot be a key). Queries parsed in batches (parse, then gather, to overlap cache misses), split over 4 goroutines for large inputs.

## Cards
1. Says: id parse is injective on keys, so table == map. Assumes: keys unique (contract), all match pattern (guarded). Breaks when: key not matching pattern -> guard falls back to map. Checked: Proved (injective decimal encoding) + randomized diff vs map, 2000 cases incl. odd strings, unicode, uppercase, short/long.
2. Says: non-pattern or out-of-range query returns -1. Assumes: all keys match pattern. Breaks when: never once guard passes. Checked: Proved + random diff test.
3. Says: table memory is bounded. Assumes: maxId < 4n+1024. Breaks when: sparse ids -> guard falls back to map. Checked: by guard.
4. Says: parallel writes are safe. Assumes: disjoint index ranges into out. Checked: Proved by construction.
5. Says: whole result equals the original on real data. Checked: compared all 2M outputs against the map version.

## Measurement (end to end, one call, 1M keys / 2M queries, 2 cores, noisy)
Original map: 0.67-2.9s. New: 110-210ms (min of 15 runs ~140-210ms).

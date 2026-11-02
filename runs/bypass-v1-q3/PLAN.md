# Plan (Anka)
Questions I would have asked (assumed answers): are all keys always "u"+7 digits? (No: only true of the real data; hidden tests may differ, so guarded.) Are keys sorted/dense? (True in data; guarded.)

Facts mined from data: all 1M keys are 8 bytes "u"+7 digits, unique, sorted, and key i == "u%07d"(i). All 2M queries are the same shape (863k distinct).

Plan: tier 1 = if code(keys[i])==i for all i, answer vals[code(q)] directly (no hash, no table). Tier 2 = all keys u+7 digits -> int32 direct table of 10^7. Fallback = Go map. Queries processed on all cores. Small inputs (<50k keys) use the map to avoid a 40MB table.

## Cards
Says: A query not of the form u+7 ASCII digits is absent. Assumes: guard passed (every key has that form). Breaks when: a key like "u000000a" exists -> guard fails, map fallback. Checked: randomized test vs map reference (incl. 'U', '+', '-', unicode, wrong length). 
Says: In dense tier, query code c<len(keys) maps to vals[c]. Assumes: keys[i]==code i for all i (verified at runtime, O(n)). Breaks when: any key out of place -> tier 2. Checked: runtime guard + random test + real data equality vs map.
Says: Tier 2 table gives the same answers as a map. Assumes: unique keys (contract); all keys coded. Breaks when: duplicate keys (contract forbids; map would keep last, table also keeps last). Checked: random test.
Says: parallel chunks write disjoint out indices. Proved.

Measured (2 cores): baseline map ~3.8-4.6s; new ~0.22-0.32s on real data; output identical to the map reference.

# Results (hidden-test scored; times on a shared, noisy 2-core sandbox)

## Boris-style 3-line prompt vs Anka (same model unless noted)
| Problem | Anka | Boris-style | Verdict |
|---|---|---|---|
| Sensor log, Opus | 0.72 / 0.77 ms, both bit-exact | 0.74 / 0.85 ms, both bit-exact | tie |
| Sensor log, Sonnet | 0/2 strict (Python 3.12 `sum()` is compensated) | 1/2 strict | Boris slightly ahead |
| Python log counts | v1 1133 ms, v2 622 ms | **235 ms** | Boris wins |
| Rust sort | v1 47–84, v2 42–69 ms | 40–44 ms | tie / Boris |
| C CSV | v1 50–60, v2 60–79 ms | 37–53 ms | tie / Boris |
| JS events sum (q2), Sonnet | v1 122 ms, v2 221 ms | **104 ms** | Boris wins |
| Go ID lookup (q3), Sonnet | **v1 37.6 ms, v2 30.9 ms (dense decode, beats expert ref 48–78 ms)** | 103–107 ms (packed hash, missed dense structure) | **Anka wins ~3×** |
| Java IDs | v1 120–181, v2 75–224 ms | 188–194 ms | tie (noise) |
| Gzip log, Sonnet (re-scored same session) | 14.3 / 26.2 / 141 ms (1/3 near-best) | **14.9 / 13.6 / 12.3 ms (3/3 found member skip)** | **Boris wins** — Anka's 135× was the model, not the prompt |
| $12 server, v7 vs Boris (Sonnet+Opus, 4 each) | **3/4 built a guarded direct SQLite B-tree reader** (s22, s23, s24) | **0/4** (all used SQL) | **Anka wins on the hardest decision** (small N: Fisher p≈0.14) |

## $12 server, Anka v1→v6 (Sonnet), 20 runs
Found the id/time fact: nearly all. Measured floor gap: from v4, all. Asked "read SQLite file directly?": from v4, 8/8. Built it: 0/20.
Found checkpoint stall (mojo's trick): grew 0 → most runs. Multi-process past fd limit: 1 (v6).
v6 failure: unverifiable ceilings (Nginx 16k, k6 ports) used to price CPU work at zero. Real leaderboard: 280k–310k users.
Best predicted score (v4 run D, 43 µs/req): ~195k users, ~#15–20.

## Gzip log (unseen), Anka v6 Sonnet
14.0 / 27 / 139 ms vs naive ~2000 ms; all pass hidden tests and 112-window check. Run A found 48 gzip members, 256 KB zlib chunks.

## $12 server, Anka v7 vs Boris (Nov 2) — re-scored by me on one quiet box
All 8 submissions pass the official suite 42/42. Differential: 3,000 random ops (feeds, posts incl. unicode/500/501 chars, likes with/without auth, bad ids) on s22/s23/s24 vs s28 (SQL): **0 mismatches**.
Server CPU per request (single keep-alive client, 20k requests; includes ~30 µs kernel/socket floor on this box):

| Run | Prompt / model | Reads | GET /feed | GET /posts/:id |
|---|---|---|---|---|
| s24 | Anka v7 / Opus | raw B-tree + WAL | **40.0 µs** | **20.5 µs** |
| s23 | Anka v7 / Sonnet | raw B-tree + WAL (shm-aware) | 42.0 | 33.0 |
| s22 | Anka v7 / Sonnet | raw B-tree + WAL | 44.5 | 27.0 |
| s27 | Boris / Sonnet | SQL, 3-statement range scan | 67.5 | 35.0 |
| s26 | Boris / Sonnet | SQL | 70.0 | 34.5 |
| s29 | Boris / Opus | SQL, multi-process | 74.0 | 35.0 |
| s25 | Anka v7 / Opus | SQL, multi-process | 79.0 | 35.0 |
| s28 | Boris / Opus | SQL | 82.0 | 38.5 |

Feed is ~half the load; raw readers cut feed server CPU ~1.7×. All 8 asked the teammate about direct B-tree reads and got the same answer ("organiser said epic, allowed"); Boris runs treated it as second-hand and declined. Caveats: one measurement each; no k6 / real droplet; s23/s24/s25/s28/s29 agents were cut off before writing PLAN.md (container restart / interrupt) — code is final-as-left, all compiled and passed.
Answer to "would Boris-Opus find hargup's solution?": **not in 2/2 runs here** (both stayed in SQL). v7 found it with both models.

# Plan: $12 Server Challenge submission (Anka process)

Goal unit: score = max concurrent users (VUs) passing a 5-min hold (p95<500ms, p99<1s, <1% errors).
All numbers below were measured in this sandbox (Firecracker microVM, 2 vCPU, noisy; syscalls ~350ns, loopback wakeups slow),
so treat absolute microseconds as +-30% and ratios as the signal. Prototype: tmp/srv.c (single-file C), tools in tmp/.

## 0. Prior art (from knowledge) and what each gives
| Approach | Mechanism | Rule check |
|---|---|---|
| Single-threaded epoll/io_uring C servers (nginx, redis, h2o, TechEmpower top entries) | no thread hand-off, no per-conn thread/stack, ~KB per idle conn | allowed (rule 1) |
| SQLite in-process, prepared statements, WAL, mmap | skips parse/plan, avoids read() copies | rule 5 explicitly allows mmap + prepared statements |
| Group commit | amortise fsync | allowed by rule 6, but WAL+NORMAL does no fsync per commit, so little to gain (measured, sec 6) |
| Direct-to-internet (skip Nginx) | saves 14-20% CPU and Nginx's connection cap | rule 9 allows it |
| Background WAL checkpointer | takes fsync/IO out of the request path | rule 6 only constrains journal_mode/synchronous |
Build on: epoll + C + libsqlite3, direct on 0.0.0.0:80. No novelty claimed; the contribution is the ceiling analysis and checkpoint handling.

## 1. Facts mined (checked against code/data)
- Per VU: 2 reads + 0.15 likes + 0.02 posts per ~20.5 s cycle (load.js) => 0.106 req/s/VU, 0.0083 writes/s/VU. Checked: arithmetic on load.js.
- Seed: 50k users, 500k posts, 2,016,005 likes, 4 KB pages, WAL, 250 MB. posts ids 1..500000, newest created_at 2025-12-31T23:59:19Z.
- Feed is always the same 20 newest rows (changes only on POST) -- but rule 5 forbids caching it, so it is NOT used. (Rejected idea, rule-banned.)
- Tokens: HS256, exp 2108945358 (year 2036), sub string. Verification per request is mandatory (rule 5); own SHA-256 with precomputed ipad/opad state costs ~2 us.
- Each write dirties ~4.2 WAL frames (17.4 KB/write measured: 260 MB WAL for 15k writes) because likes PK + likes_post_id idx + posts leaf pages are random in 2M rows.

## 2. Substrate vs interface
| Layer | What a rule names (quoted) | Interface I happen to use |
|---|---|---|
| DB | "The database is SQLite: the file at $SQLITE_PATH, used in-process"; "Any SQL you like against the schema as given" | libsqlite3 C API (a habit; could be any binding). Reading B-tree pages by hand is NOT clearly "SQLite" -> not used (see rejected). |
| Front door | "Nginx is optional ... or serve the internet directly on 0.0.0.0:80" | direct, own epoll loop |
| Threads/processes | "Any number of processes or threads" | one event-loop thread + one checkpoint thread |
| Caching | "SQLite's own page cache and mmap are fine" | mmap_size=1GB, cache_size 32MB |
| Durability | "WAL with synchronous=NORMAL or stronger"; "A 201 means the row is committed" | autocommit per write, WAL+NORMAL |
| Checkpointing | not named by any rule | sqlite3_wal_checkpoint_v2 from a second thread (interface choice) |
| HTTP | "HTTP/1.1 with keep-alive" | hand-rolled parser (the spec fixes bytes, not the framework) |

## 3. Speed-of-light floor vs measured (per request, CPU only)
| Path | Floor estimate | Measured | Ratio | Explanation |
|---|---|---|---|---|
| GET /posts/:id | ~3 btree seeks (posts, users, likes idx) ~1.5 us | 5.0 us (mmap) / 7.8 (no mmap) | 3-5x | VDBE interpretation + cell decode; real work after that |
| GET /feed | 20 rows x 3 seeks + 20 count scans ~8 us + 6.5 KB copy | 27 us (mmap) / 33 (no mmap); 18.6 us without the like count; 4.75 us index scan alone | ~3.4x | like-count subquery is 10 us of it (20 index range scans); rest is row decode. Explained by SQLite per-row work; SINGLETHREAD config: no gain (32 vs 29, noise) |
| JWT verify | 2 SHA-256 blocks ~0.5 us | ~2 us (own C) | 4x | irrelevant |
| Syscalls (epoll_wait+recv+send) | 3 | ~10-25 us incl. loopback TCP softirq in sender | - | inherent; 6.5 KB feed send dominates |
End to end closed-loop (client-limited, 2 vCPU shared): feed ~9k rps at ~50% server CPU => ~55 us/feed request all-in; mix ~35-40 us/request.
Descending further (own B-tree reader over the mmapped file) could close the 3-5x on SQL, but see sec 5: CPU is not a binding ceiling, so shadow price ~0 users.

## 4. Scale sweep (n = VUs), ceilings and shadow prices
| Resource | f(n) | Ceiling | Source |
|---|---|---|---|
| CPU (1 vCPU) | 0.106 n req/s x ~40 us = 4.2e-6 n | n ~ 236k (say >=120k with real-droplet syscall overhead) | measured c |
| File descriptors, single process | n + ~10 | n <= ~65,500 | rule/SPEC: LimitNOFILE=65535 |
| Through Nginx | n (client conns) | n <= ~16,000 (worker_connections 16384) | bench/nginx.conf comment |
| Memory | ~6 KB kernel (slab, measured 232 MB for 19k conns x 2 loopback ends = ~6 KB/end) + ~1.3 KB user per conn; + 250 MB mmapped DB | 65k conns ~ 0.5 GB + DB: fine; cap ~200k conns | measured |
| Accept rate | ramp 60 s => n/60 conn/s (1.1k/s at 65k) | somaxconn 4096 backlog; accept loop drains to EAGAIN | n/a |
| WAL disk | 17.4 KB x 0.0083 n /s = 145 B/s per VU | if never reset: n=40k -> 5.8 MB/s, 1.7 GB per 5-min hold | measured |
| Checkpoint stall (default autocheckpoint) | writes/s / 238 writes per ckpt x stall S; fraction stalled = 8.4e-6 n x (S/0.24 s) | S=0.24 s (sandbox disk): 8% of time at n=10k, 34% at 40k. p95 fails once stalled fraction >5% AND S>0.5 s (slower disk) | measured S |
| k6 client side (not ours) | ephemeral ports 28k per source IP:dst (default range) and k6 RAM per VU | unknown, probably binds before 65k | OPEN |

Binding ceilings in order: (1) Nginx 16k -> shadow price of going direct = (65.5k - 16k) ~ +49,000 users (x4) IF k6 can generate them, +1 user per extra FD; (2) FD 65.5k -> multi-process (RLIMIT_NOFILE is per process) would lift it, price = up to the k6/port limit, unmeasurable here (our hard nofile is 20000); (3) checkpoint stalls -> insurance worth 0..full score depending on the droplet's fsync latency; (4) CPU shadow price ~0 users below n~120k. Revisit when n > 65k (needs multi-process) or if k6 box is known to hold >28k connections.
Scoring grid: 2500 doubling -> 5000, 10000, 20000, 40000, 80000, then narrowing to 250. Nginx path tops out near 16,000; direct single-process tops out near 65,250 (80,000 step cannot pass).

## 5. Candidate designs scored (differential-tested vs Python reference, see sec 7)
1. Reference-style: threaded/blocking framework. Rejected: thread/conn costs memory and FD-bound anyway.
2. Behind Nginx, epoll C. Cap ~16k users. Kept as FALLBACK only.
3. **Direct, single epoll thread, libsqlite3, prepared statements, mmap, bg checkpointer (CHOSEN).** 42/42 test.sh; 19,000 concurrent connections held with 0 errors, server RSS 156 MB (24 MB anon).
4. Multi-process SO_REUSEPORT (2 procs): lifts FD cap; adds write-lock contention and unmeasured. Parameterised (PROCS=1 default), not enabled.
5. Hand-written B-tree reader over mmapped file: CPU ~3x lower on SQL, but CPU shadow price ~0 and it arguably violates "the database is SQLite ... used in-process". Rejected; revisit only if CPU becomes binding.
6. Response caching of the feed: banned by rule 5. Rejected.
7. io_uring: per-request saving of maybe 2-4 us syscall; CPU not binding. Rejected (revisit n>120k).

## 6. High-value questions (both answers prototyped; default = safe answer ships until chosen)
Ordered by (probability it changes the plan x size):
**Q1. Nginx or direct?** "Serving directly can raise the user ceiling from ~16,000 to ~65,000 but then my own code holds every connection; if it misbehaves it falls back by one switch to Nginx mode (same binary on 127.0.0.1:3000)." 
- Direct measured: 19,000 simultaneous keep-alive conns, 0 errors, 156 MB RSS. Through Nginx: not measurable (no nginx here); ceiling derived from nginx.conf = 16,384. Gain = up to +49k users (x4) / lost: Nginx's 14-20% CPU is saved (irrelevant, CPU not binding). Safe default: run with HOST/PORT env, ship direct (the user's goal is highest score). README must say "direct".
**Q2. WAL checkpoint policy** (stalls on the single event loop):
- A (safe, default SQLite): autocheckpoint 1000 pages. Measured: avg write 175-250 us, worst single op 220-300 ms, p99.9 27-80 ms, WAL stays 4 MB.
- B: autocheckpoint=0 + background thread, PASSIVE every 250 ms + TRUNCATE every 40th pass. Measured: avg write 50-63 us, p99.9 ~2.4 ms, worst op ~360-440 ms ONCE (first truncate; later 55-90 ms), WAL bounded 17-82 MB.
- C: bg PASSIVE only: no stalls (worst 4-11 ms) but WAL grows unbounded (260 MB per 15k writes -> ~2 GB per 5-min hold at 40k VUs). Rejected unless disk is known large.
- D: bg TRUNCATE only: bounded WAL but writers stall up to 340 ms each pass. Rejected.
Price in users: with fraction stalled = 8.4e-6 n (S/0.24 s): A costs nothing on a fast disk (stall < 0.5 s) but a droplet with S >= 0.6 s fails p95 around n ~ 6k-10k (-> loses 30-55k users); B keeps stalls to one rare 60-400 ms event. End-to-end load.js-like test (10k conns, my generator is itself the bottleneck so only indicative): A max 272 ms, B max 170 ms. Default shipped: B behind a guard (if bg thread open/checkpoint errors or WAL > 512 MB, main loop falls back to inline wal_checkpoint(TRUNCATE) i.e. behaviour A).
**Q3. mmap on/off** (rule 5 wording allows mmap): feed 32.6 -> 27.4 us, post 7.8 -> 5.0 us (-16%/-36%). Gain in users: ~0 (CPU not binding). Ship mmap_size=1GB with guard (set 0 if pragma fails). 
**Q4. Single process or 2 processes** (to pass 65.5k FDs): single measured; 2-proc not measurable here (hard nofile 20000). Ask the human whether the k6 box can open >28k connections; if not, single process is final.
**Q5. Ambiguous spec edges** (cheap): `/posts/` and `/posts//like` (empty id): 404 `not found` (matches Express/axum routing) vs 400 `invalid post id`. test.sh does not cover it; chose 404. Valid-JSON-non-object body (`null`, `[]`) => 400 "body is required" (differential tested); NUL inside body => SQLite CHECK fails => 500 (reference agrees).

## 7. Correctness evidence (Ratchet)
- test/test.sh: 42/42 on the C prototype (fresh DB copy each time).
- Differential fuzz: tmp/diff.py runs 1,551 random requests per seed (bad/expired/none/HS512/wrong-key tokens, sub as int/str/0/abc, bodies with escapes, surrogates, 500/501 chars incl. multibyte, duplicate keys, `null`, whitespace, ids 0/-1/1.5/hex/1e3/huge, wrong paths, repeated likes) against a Python+sqlite3 reference, normalising created_at. Seeds 7-11: 0 mismatches after fixing 3 real bugs the fuzz found: (1) valid non-object JSON misreported as malformed, (2) NUL byte stripped as whitespace by trim (strchr matches terminator), (3) control characters escaped as \u000a instead of \n.
- Not yet fuzzed: slow/partial requests split across TCP segments, pipelining, 64 KB+ bodies, EAGAIN on send for big feeds (code path written, untested) -> TODO before submission; add a split-byte client to diff.py.

## 8. Cards
| Claim | Says | Assumes | Breaks when | Checked |
|---|---|---|---|---|
| CPU is not binding | 40 us/req => 236k VUs | droplet syscall cost <= ~3x sandbox | droplet vCPU is much slower or steal is high | Checked: measured in-process + closed loop (noisy); Open on real droplet |
| Direct beats Nginx | 16k -> 65k cap | k6 can open >16k conns | k6 box limited to ~28k ports or less | Checked arithmetic from nginx.conf; Open (k6 side) |
| 19k conns OK | 0 errors, 156 MB | same code at 65k | per-conn kernel memory differs on droplet; somaxconn burst | Checked to 19k only (nofile hard limit 20000 here); Open above |
| Background checkpoint avoids 240 ms stalls | p99.9 2.4 ms vs 27-80 ms | same busy handler semantics | TRUNCATE collides with a writer for long (first truncate 324-426 ms) | Checked (microbench + coarse e2e); Open on real disk |
| Exactness with obvious version | identical bytes except created_at | reference semantic reading right | spec edge cases not in test.sh (Q5) | Checked: 5 seeds x 1,551 reqs, test.sh 42/42 |
| Feed/post query formulation is near-minimal | variants tie (28.8 vs 29.4 us) | - | - | Checked |
| Rule 5 (no caching) | nothing cached except SQLite page cache/mmap/prepared stmts | JWT verified every request: yes | - | Proved by code reading (srv.c auth() on every POST) |

## 9. Rejected / revisit log
- SQLITE_CONFIG_SINGLETHREAD: +-0 (noise); revisit never.
- Own B-tree reader / io_uring / feed caching: see sec 5.
- Group commit: writes cost 50-63 us in WAL+NORMAL (no fsync per commit); batch=16 measured with autocheckpoint on was 176 vs 250 us (only because fewer checkpoints); no plan value. Revisit if switching to synchronous=FULL.
- Multi-process: revisit when n > 65k.

## 10. Build plan (deliverable layout)
submissions/c-epoll-<user>/{install.sh (apt build-essential libsqlite3-dev; or pinned SQLite 3.45.1 amalgamation tarball + sha256 - not tested offline), build.sh (gcc -O2 -pthread), start.sh (exec bin/server; raise RLIMIT_NOFILE to hard max; defaults HOST=0.0.0.0 PORT=80 per env), README.md (state "direct, no Nginx"), src/server.c (from tmp/srv.c + guards), .gitignore}.
Guards: mmap pragma fallback; checkpoint fallback (sec 6 Q2); fd >= limit => close and count; any parse anomaly => 400/closing; health does real SELECT 1.
Pre-submit checklist: split-segment fuzz; 60 s soak at 19k conns with writes; test/run.sh on a clean Ubuntu 24.04; keep-alive idle >= 65 s never closed by us.

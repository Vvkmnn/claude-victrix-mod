# Plan: $12 Server Challenge submission (Anka process)

Verdict: a single-threaded C epoll server, serving port 80 directly (no Nginx), linked to SQLite, using the
original join query for reads, group-committed writes, and a separate checkpoint thread. Expected outcome:
CPU is not the limit. The limit is the harness (about 15k connections) and tail latency, so the design buys
tail safety first and per-request speed second.

## 0. Prior art (from memory; no internet used)
| Approach | Mechanism that makes it fast | Verdict under the rules |
|---|---|---|
| Single-thread epoll in C/Rust (nginx, redis, TechEmpower top entries) | No thread switches or locks; one syscall pair per request; tiny per-connection state | Use it. 1 vCPU means extra threads only add contention. |
| Prepared statements reused (rule 5 allows) | Skips parse and plan | Use it (SQLITE_PREPARE_PERSISTENT). |
| WAL + mmap + big page cache | Reads become memcpy from mapped pages | Use it (rule 5 names mmap as fine). |
| Group commit | One WAL append and one lock cycle for many writes | Use it (rule 6 allows if each reply waits for the commit). |
| Response caching, in-memory tables, JWT memoization | Skip the work entirely | Forbidden by rule 5. Not used. |
| Skip Nginx (rule 9) | Saves its CPU, its gzip pass and its 16384-connection cap | Use it. Costs: we own keep-alive and 15k sockets. |
This design improves on the video's per-language servers mainly by removing the thread/GC/Nginx layers and the
autocheckpoint stall (section 3). It is not novel; it is the known best recipe, applied with measurement.

## 1. Facts mined (all checked on a copy of seed/feed.db)
- F1 Mix per user cycle (~21 s): 1 feed, 1 post read, 0.15 like, 0.02 create. Feed is 46% of requests, post read 46%. Checked in bench/load.js.
- F2 GET requests carry no auth, so no HMAC on the hot path. Checked in SPEC.md and load.js.
- F3 Feed body is about 4.7 KB; golden shows 20 posts. Post body avg 129 chars. Checked.
- F4 Seed has 50k users, 500k posts, 2.016M likes (avg 4 per post). Checked with sqlite3.
- F5 In the seed, created_at is strictly increasing with id (generate.mjs: start + i*step + rand*0.9*step). So `ORDER BY id DESC` equals the spec order on the seed. Holds on new rows only while the clock is monotone. Guarded, see card C3.
- F6 Nginx config gzips responses over 1 KB; k6 sends Accept-Encoding by default, so every feed would be compressed on our one CPU if we sit behind Nginx. Read from bench/nginx.conf; k6 default is Assumed.
- F7 The DB is already WAL mode; the default autocheckpoint is 1000 pages. Checked (pragma journal_mode = wal).

## 2. Substrate vs interface
| Layer | (a) What the rule names | (b) Interface I happen to use |
|---|---|---|
| Storage | "The database is SQLite: the file at $SQLITE_PATH, used in-process"; schema, data and indexes fixed (rule 2, 3) | libsqlite3 SQL API. Rules say "Any SQL you like", "any driver/binding", so the C API, a compiled-in amalgamation, and SQLite compile options are all open. Reading the file format directly is not named anywhere, but it would be a "driver", so it is open in principle (rejected below on risk, not rules). |
| Web server | "Any language, framework, runtime"; "Nginx is optional" (rule 1, 9) | HTTP/1.1 over epoll. Nginx is a habit, not a requirement. |
| Durability | "WAL with synchronous=NORMAL or stronger", 201 only after commit (rule 6) | One transaction per request is a habit; the rule allows batching. Checkpoint timing is not named at all. |
| Cache ban | "No caching across requests... SQLite's own page cache and mmap are fine" (rule 5) | Not a layer to change. Every GET runs a SELECT. |
| Process model | "Any number of processes or threads" | One event-loop thread plus one checkpoint thread. |

## 3. Floor vs measured (this sandbox: 2 vCPU, SQLite 3.45.1 system lib, hot cache; best of 7)
| Hot path | Floor estimate | Measured | Ratio | Explained by |
|---|---|---|---|---|
| Network, fixed 4.7 KB/240 B reply, no SQL (1 core server, closed-loop client on the other core) | ~5 us (2 syscalls) | ~20 us/request (44-57k rps) | 4x | Kernel loopback TCP send/recv path. Real work; only fewer syscalls help. |
| GET /feed SQL | ~2 us (about 40 hot pages, 4.7 KB out) | 23-24 us | ~11x | callgrind: 220k instructions/query. VDBE interpreter 19%, table b-tree seeks 10%, varint decode 7%, index seeks 6%, pager 5%. 20 users seeks + 20 like-count seeks dominate (posts scan alone is 3.3-4 us). |
| GET /posts/:id SQL | ~0.5 us | 4.4-6.5 us | ~10x | Same: per-step VDBE and 3 seeks. |
| POST like, one autocommit per request, default pragmas | ~10 us (append 1-2 WAL frames) | 225-265 us | ~25x | Autocheckpoint every 1000 pages does fsync inside the request. With wal_autocheckpoint=0: 22-26 us. |
| POST like, batched in one txn | | 3-6 us each | | Group commit. |
| Full prototype, SQL + sprintf, 64 conns | | 22.5k rps vs 51k fixed | | Matches 20 us net + ~24 us avg SQL/format. |
Capacity: at 15k users the load is ~700 cycles/s x ~85 us = ~6% of one core. The CPU ceiling is far above
what the harness can open, so tail latency (stalls) is the real risk, not mean cost.

## 4. Generality tax and shortcuts considered
| Layer | General case it handles | Fact that removes it | Decision |
|---|---|---|---|
| Nginx | many backends, TLS, buffering, gzip | one backend, plain HTTP | Bypass (direct on :80). |
| Per-request autocommit + autocheckpoint | crash safety of every commit with no tuning | Rule 6 only needs commit-before-reply under NORMAL; checkpoint timing is free | Group commit per loop tick; autocheckpoint off; PASSIVE checkpoint in a 2nd thread when WAL > 32 MB or every 10 s. |
| `ORDER BY created_at DESC, id DESC` via index scan + 20 seeks | arbitrary timestamps | F5 monotone | Measured 19.6 us vs 23.6 us (-17%, ~2-3% of total CPU). REJECTED for now: gain is below what matters, risk is nonzero. Revisit only if CPU becomes the limit. |
| Split feed into 3 statements (posts, grouped likes, users) | | | REJECTED: 53 us vs 23.6 us. Per-step overhead (users lookup is 1.8 us each) beats the saved seeks. The single join wins. |
| `locking_mode=EXCLUSIVE` | multi-process access | Single process | REJECTED: no read gain (23.5 vs 26 us, noisy, bimodal in the server test) and it blocks a checkpoint thread. |
| Direct file-format reader (mmap B-tree walk + WAL index) | VDBE, locking, generic pager | The 3 tables and 3 indexes are fixed | REJECTED: 10x on 24 us saves ~2% of a core at the achievable load, and a bug there breaks correctness (WAL frames newer than the main file). Revisit only if a CPU-bound score appears. |
| Custom SQLite build (pinned amalgamation, -O3, THREADSAFE=2, OMIT_SHARED_CACHE, MEMSTATUS=0) | | | PLANNED, UNTESTED: no amalgamation source here and no internet. Fall back to libsqlite3-dev if the download fails. |

## 5. Design
- C, epoll, edge-trigger-free level triggered, nonblocking sockets, TCP_NODELAY, one read buffer, one `writev`/`send` per reply. Per-connection state under 200 B. Idle connections kept open (no idle timeout under 65 s; none at all is fine). Listen backlog 4096+. Raise own RLIMIT_NOFILE to the 65535 allowed.
- Reads: the spec's join query, prepared once with PERSISTENT, `PRAGMA mmap_size` ~ 1 GB, cache_size 64 MB. JSON is built straight from column_text into a buffer. Escape `"`, `\`, control characters in body/author (seed text is ASCII, but the test has quotes and UTF-8).
- Auth: HS256 verify with a small in-tree SHA-256/HMAC, constant-time compare, check alg header is exactly HS256, `exp`, `sub` positive integer string, `username` string. Check order exactly as SPEC: auth, then id, then body.
- Writes: collect all POSTs seen in one epoll batch, run them in a single `BEGIN IMMEDIATE ... COMMIT`, then send replies. `INSERT ... RETURNING id, created_at` for posts; like uses `ON CONFLICT DO NOTHING` and `changes()` to choose 201/200; a missing post gives 404 (check existence first, the FK is not enforced unless PRAGMA foreign_keys is on, so existence must be explicit).
- Durability: journal_mode=WAL, synchronous=NORMAL, wal_autocheckpoint=0, checkpoint thread (own connection, PASSIVE).
- Startup: open, sanity query, warm the hot tails (index tail of posts, likes, and a sequential read of the file to fill the OS page cache), then listen within a few seconds (limit 60 s).
- Direct on 0.0.0.0:80 per HOST/PORT. README says "direct".

## 6. Evaluator and ratchet
1. Differential: a Python reference (sqlite3 + the spec's exact queries) is run against the same request sequence as the server on identical DB copies; compare bytes. Sequence = test/test.sh + a fuzzer of ids (0, -1, 1.5, huge, hex, leading zeros), bodies (unicode, 499/500/501 chars, whitespace, escapes, bad JSON), tokens (mutated signature, alg none, wrong sub types), and repeated likes.
2. Benchmark: closed-loop C client (as in tmp/w/cli.c) for CPU cost, plus k6 with VUS=2500/5000/10000 if k6 is installed (it is not here), using the real load.js on a fresh copy of the DB.
3. Accept a change only when it matches the reference exactly and beats the previous best by more than run-to-run noise (7 repeats, best-of and spread). Otherwise log as rejected (section 4).
4. Soak: 5-minute hold with a writer rate matching load.js, watching p99 and WAL size to catch checkpoint stalls and leaks.

## 7. Cards
| Claim | Says | Assumes | Breaks when | Checked |
|---|---|---|---|---|
| C1 Group commit + no autocheckpoint | Like cost drops from ~225-265 us to 22-26 us (3-6 us batched) | Rule 6 satisfied by commit-before-reply in WAL/NORMAL | Process crashes: WAL is replayed on open, committed rows survive process death; NORMAL may lose the last commits on power loss, which rule 6 accepts | Measured (autocommit 225 vs 22 us). Power-loss behavior: Assumed from SQLite docs. Open: 5-min soak with checkpoint thread. |
| C2 Direct, no Nginx | Saves Nginx CPU/gzip, avoids its 16384 worker_connections | Harness reaches port 80 as in rule 9; k6 hits `BASE_URL` with no Host dependence | Process holds 15k sockets and mishandles half-closed/pipelined requests | Open (needs real 15k-socket test; the sandbox client was limited to 64 conns). |
| C3 Feed via rowid order (deferred) | Same rows as created_at order | Clock monotone, writes serialized | NTP step backwards, or a hand-inserted row | Seed monotone by construction (read generate.mjs); Checked timing only. Not shipped. If ever shipped: guard = startup full-table monotone check + per-insert check that new created_at >= previous max, else permanently use the index query. Open whether a stored "monotone" flag counts as caching under rule 5 (it holds no response data). |
| C4 Exclusive locking is useless | No read gain | | Different hardware | Measured twice, noisy: Open but irrelevant. |
| C5 Single join beats split queries | 23.6 vs 53 us | | Different SQLite version | Measured. |
| C6 CPU is not the limit | 6% of a core at 15k users | Think times as in load.js; my 20 us network cost holds on DO | DO steal time or k6 more bursty than modeled | Computed from measurement; Assumed for DO. |

## 8. Questions for the user (answers would change the plan; I continued with the stated assumption)
1. Is it acceptable to drop Nginx and take port 80 directly? (Gain: Nginx CPU and its gzip pass; risk: our own server must handle ~15k idle connections. A health check falls back by running the same binary behind port 3000 if HOST/PORT say so.) Assumed: yes.
2. May the build download a pinned SQLite source release (compiled with performance flags) rather than Ubuntu's SQLite? (Gain: probably 10-30% less SQL CPU, untested here; risk: build needs network; falls back to the system library.) Assumed: yes, with fallback.
3. Is a bit of data loss on power failure (not on process crash) acceptable for the last few commits? Rule 6 says NORMAL is fine, so I assumed yes. If no, we use FULL and the batching keeps cost to one fsync per tick.
4. Do you want the maximum score even if it means more code (custom HTTP parser, own SHA-256), or the most readable code? Assumed: score first, tested heavily.
5. Do you have the benchmark VM's k6 limits (how many users it can actually open)? If the harness caps near 15k, extra speed beyond tail safety earns nothing, and I would stop optimizing CPU here.
6. May I read the SQLite file format directly for the hot reads (about 10x less read CPU, but the most breakable thing in the plan)? Assumed: no.

## 9. Discoveries below the obvious interfaces
- The SQL layer is not the mean-cost problem; the checkpoint is. Default autocheckpoint fsyncs inside the request: 10x on writes and a source of latency spikes under the p99 < 1 s rule.
- Nginx gzips every feed response by default config; direct serving avoids it.
- Per-statement overhead (about 1.8 us per point lookup) beats "smarter" multi-statement plans; the single join is fastest.
- WAL size is harmless to read speed at 30 MB (no change in q0/q1), so deferring checkpoints is safe.
- Not done: no k6, no 15k-socket test, no full server with auth/writes. Prototype files are in tmp/w (srv.c, cli.c, b*.c).

## 10. Ship checklist
install.sh (apt: build-essential, libsqlite3-dev), build.sh (gcc -O2 -march=x86-64-v2, optional pinned amalgamation), start.sh (exec), README (direct, versions, optimizations), .gitignore, test/run.sh green, differential fuzz green, soak green.

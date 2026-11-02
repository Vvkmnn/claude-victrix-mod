# Plan: $12 Server Challenge submission (Anka process)

Verdict: single-process C server (epoll, one event-loop thread) linked to the system libsqlite3, run DIRECT on 0.0.0.0:80 with no Nginx. A second thread only runs WAL checkpoints. Every request is read from SQLite while it is served (rule 5), and the feed keeps the stock SQL.

Most of the score is decided by tail latency and connection handling, not by CPU speed. The load test is roughly 0.1 requests/s per user, so 15,000 users is about 1,600 req/s. Measured capacity of the prototype is about 13-20k req/s on one core.

## Questions for the user (ranked by how much the answer changes the plan)

1. Is the target "survive ~15,000 simultaneous users" (README says up to ~15,000 keep-alive connections), or could the scoring ramp go well beyond that (2,500 -> 5,000 -> 10,000 -> 20,000 ...)?
   - Up to 15k: robustness first (current plan).
   - Beyond 15k: add io_uring or batched syscalls and a tighter per-connection memory budget.
2. May we run direct on port 80 instead of behind Nginx? Rule 9 allows it. I assume yes. It avoids Nginx's CPU and its gzip of every feed response (`gzip on`, 1 KB minimum, and a feed is about 5 KB).
3. "At most 500 characters": counted in Unicode characters (code points, matching the DB `CHECK length(body)`) or in JavaScript UTF-16 units? They differ only for emoji. I assume code points. Which whitespace does "trim" mean? I assume ASCII whitespace plus the Unicode space characters JavaScript `trim()` removes.
4. Is a C submission acceptable (build from apt `build-essential libsqlite3-dev libssl-dev` plus pinned versions), or do you prefer Rust or Go for maintainability? I assume C is fine; the speed gain over Rust is small, so Rust is the fallback if C parsing risk worries you.
5. Is the benchmark disk a normal DO SSD? This affects only the checkpoint and warm-up plan, and I assume yes.

## 1. Mined facts (candidates, each checked against data or rules)

| Fact | Status |
|---|---|
| Seed: 50k users, 500k posts, 2,016,005 likes; page size 4096; WAL mode; DB 249 MB. | Checked (sqlite3) |
| In the seed, `id` order equals `(created_at,id)` order exactly, with no ties (0 inversions, 0 duplicate timestamps). | Checked (window query) |
| Bodies are all ASCII and 14-329 chars; usernames 21 chars or fewer, all `[A-Za-z0-9_]`. | Checked, seed only |
| Feed output is byte-identical to `test/golden/feed.json` using `sprintf`-free formatting. | Checked (cmp) |
| Per-user cycle is about 20.5 s with about 2.15 requests, so about 0.105 req/s/user. Mix: about 46% `/feed`, 46% `/posts/:id`, 7% like, 1% create. | Derived from `bench/load.js` |
| Only about 8% of requests are authenticated. | Derived |
| Expected write rate at 15k users: about 110 likes/s and 15 posts/s. | Derived |
| The box has 1 vCPU, so extra worker threads add contention, not throughput. | Rule 8 |

## 2. Boundary assumptions (what is "fixed" and what quote fixes it)

| Layer | Fixed by | Verdict |
|---|---|---|
| SQLite file at `$SQLITE_PATH`, in-process | Rule 2: "The database is SQLite ... used in-process" | Fixed |
| Schema, indexes, data | Rule 3: "Don't add or change tables, columns, indexes or triggers" | Fixed |
| WAL and `synchronous` of NORMAL or stronger | Rule 6 | Fixed. Group commit is explicitly allowed. |
| No cross-request caching, and verify the JWT signature every request | Rule 5 | Fixed. This kills the biggest "specialization" (caching the feed), so don't try. |
| Nginx in front | Rule 9: "Nginx is optional" | Habit. Go direct. |
| One SQL statement per request in the spec | SPEC: "You can write your own SQL" | Habit |
| The ORM, HTTP framework, JSON library | Rule 1: any language/framework | Habit. Hand-written HTTP and JSON. |
| SQLite's default autocheckpoint inside the request path | Nothing fixes it | Habit. Move it to a background thread (see section 3). |
| Reading the SQLite file format directly, bypassing the library | Rule 2 says used in-process, which is ambiguous | Rejected: risky for little gain (SQL is not the bottleneck). Not a question worth the user's time. |

## 3. Profile by layer (measured here: 2 vCPU, noisy; prototype in `tmp/`)

| Layer | Measurement | Reading |
|---|---|---|
| SQL, `/feed` (spec query) | about 25-34 us per call (noisy) | Largest user-space cost |
| SQL, `/posts/:id` | about 5-7 us | Small |
| Feed split | without the like_count subquery about 14 us; without the user join about 30 us | The 20 `count(*)` probes are about half the feed cost |
| Whole server, closed loop, 64-256 conns, 1 core | 13-20k req/s (about 50-75 us/request), user:sys of about 60:40 | Run-to-run noise is about 30% |
| Same, 15,000 open connections (2,000 active) | 18k req/s, RSS 144 MB, p99 168 ms (closed loop, so queueing) | Fits in memory |
| HMAC-SHA256 (OpenSSL one-shot) | about 3 us | Irrelevant: only 8% of requests |
| Sprintf vs hand-rolled JSON formatting | Not distinguishable from noise (about 5% at best) | Do the hand-rolled version anyway (cheap, byte-identical to golden) |
| WAL write, `synchronous=NORMAL` | commit p50 5-20 us | Writes are cheap |
| **Inline autocheckpoint** | **one commit stalled 225 ms and 248 ms in two runs** (max with checkpointing off: under 1 ms) | **Biggest finding: a 250 ms event-loop stall hits every connected user and eats the p99 budget** |

## 4. Generality tax and abduction

| Costly general layer | Case it handles | Why it is unnecessary here |
|---|---|---|
| HTTP framework and routing | Arbitrary methods, headers, chunked bodies | Five fixed routes, plain JSON, small bodies |
| Thread pool with locks per request | Blocking handlers | One vCPU and microsecond queries: a single event loop is faster than any pool |
| Nginx in front | TLS, buffering, slow clients, gzip | Loopback load generator; gzip of 5 KB responses costs CPU for nothing |
| Inline checkpoint | Single-process simplicity | Writes are about 125/s, so checkpointing can run on another thread without touching the request path |
| Per-connection buffers | Arbitrary request sizes | Requests are under 1 KB; use one shared read buffer and allocate per connection only on a partial request |

## 5. Specializations (each with an equivalence argument and a runtime guard)

1. **Hand-written epoll HTTP/1.1 server.** Level-triggered epoll, accept until EAGAIN, listen backlog 4096 (the OS caps it), `TCP_NODELAY`, never time out idle connections, handle pipelining and partial reads, and a single `send()` per response with the header written into a reserved prefix of the body buffer. Guard: anything unusual (chunked request body, header block over 8 KB, `Connection: close`, HTTP/1.0) goes to a slower, strict generic path or is closed cleanly. Never guess.
2. **Hand-written JSON out.** Escape `"`, `\` and control characters; pass other bytes through, UTF-8 included. This matches `jq` round-trip in the test (`café ✓`).
3. **Hand-written JSON in and JWT.** Small strict parser. Decode the header and require `alg == "HS256"`, check `exp`, validate `sub` as a positive integer string, check `username` is a string, compare the HMAC in constant time. Unknown or odd input yields the spec's error. Auth check comes before id check (SPEC).
4. **Checkpoints on a background thread.** The request thread sets `wal_autocheckpoint(0)`. A separate connection runs `wal_checkpoint(PASSIVE)` about once a second when the WAL is over about 4k pages. Guard: if the WAL ever exceeds about 256 MB, the request thread runs a synchronous checkpoint (the general version). Same durability: still WAL with `synchronous=NORMAL`, as rule 6 allows.
5. **Writes on the event-loop thread, one transaction each.** About 125 writes/s at 20 us each is trivial. If the 10 ms write budget is ever exceeded, batch the writes in an epoll iteration into one transaction (group commit, rule 6) and reply only after the commit. Likes use `INSERT ... ON CONFLICT DO NOTHING` and `sqlite3_changes()` to choose 201 or 200. Post existence check comes first (404), then insert, inside `BEGIN IMMEDIATE`.
6. **SQLite settings.** `mmap_size` of 1 GB (fits in 2 GB, and a 249 MB DB), modest `cache_size`, `temp_store=MEMORY`, persistent prepared statements. At startup, read or `madvise(WILLNEED)` the DB file so the first random `/posts/:id` reads are not cold page faults (it must be healthy within 60 s).
7. **Fact-based SQL shortcuts: rejected.** Using `ORDER BY id DESC` (which the seed supports) saved about 15% of SQL time in one noisy run, but breaks if a clock steps backwards. A two-statement feed (posts, then one range `GROUP BY post_id` for like counts, valid when the 20 ids are contiguous) measured 33.2 vs 33.9 us: no gain. Keep the spec query.

## 6. Claim cards

**Card A**
- Says: The feed's SQL cannot be made meaningfully faster by using the id-order fact or by batching like counts.
- Assumes: Seed ids and timestamps stay monotonic; SQLite 3.45.
- Breaks when: The grader's DB differs from the seed, or CPU frequency makes the SQL share larger.
- Checked: Checked (microbenchmarks; noisy, 2 repeat sets agree within about 5%).

**Card B**
- Says: An inline WAL autocheckpoint can freeze all requests for about 250 ms; moving it off the request thread removes the stall.
- Assumes: A PASSIVE checkpoint on a second connection never blocks the writer or readers; the WAL stays bounded.
- Breaks when: A long reader pins the WAL (not possible, reads are microseconds), or checkpoint fsync starves the single vCPU for a long stretch.
- Checked: Checked (stall reproduced, 2 runs; background-thread version not yet built; guard above covers growth).

**Card C**
- Says: The server will not be CPU-bound below roughly 15k users.
- Assumes: Prototype throughput of 13-20k req/s on one core holds on the DO box; load is about 0.105 req/s/user.
- Breaks when: The DO vCPU is much slower or noisier than this host, or TCP overhead for 15k sockets is bigger than measured.
- Checked: Checked (loopback; my client shares the host, so only an estimate). The 15k-connection run had RSS of 144 MB.

**Card D**
- Says: Going direct (no Nginx) is a net win.
- Assumes: The server handles about 15k keep-alive connections itself.
- Breaks when: The scoring load generator needs something Nginx provides (it should not: HTTP/1.1 keep-alive only).
- Checked: Checked (15,000 connections held in the prototype) plus Assumed (the grader).

**Card E**
- Says: Verification of JWT each request costs nothing noticeable.
- Assumes: Only authenticated routes pay it (8% of traffic).
- Breaks when: Not applicable.
- Checked: Checked (about 3 us HMAC).

**Card F**
- Says: Output is byte-identical to the spec for reads.
- Assumes: Seed-shaped data.
- Breaks when: A body contains control characters or a non-ASCII byte that needs escaping; handled by escape-or-pass-through.
- Checked: Checked (`cmp` against `test/golden/feed.json` and `post-250000.json`).

**Card G**
- Says: The error paths and writes are correct.
- Assumes: Prototype only covers reads.
- Breaks when: Never tested.
- Checked: Open until the full server passes `test/run.sh` (42 checks).

## 7. Runtime guards summary

- Parser sees anything unexpected: strict generic path or clean 400/close.
- WAL over 256 MB: synchronous checkpoint on the request thread.
- Write takes over 10 ms (rare): batch writes into one group-commit transaction per loop iteration.
- Startup: `/health` runs `SELECT 1` and returns 503 with the error string on failure.
- Clock sanity: created_at comes from SQLite's own default, so the schema's format is preserved.

## 8. Measure end to end (still to do)

1. Build the full server; run `bash test/run.sh submissions/c-epoll-<user>` and require 42/42.
2. Run `bench/load.js` with VUS at 2,500, 5,000, 10,000 and 15,000 (k6 is not installed here; fall back to my `tmp/cli.c` open-loop mode).
3. Check p99 at each step and watch for stalls in the checkpoint thread.
4. Repeat with the Nginx config to confirm that going direct is better.

## Assumptions made without the user

- All answers above use the "assume" choices in the questions section.
- `seed/feed.db` was only copied (never opened in place). All scratch files, binaries and DB copies are in `/home/claude/srv/s6/tmp`.
- Measurements are from a noisy 2 vCPU host with the load client on the same machine; treat them as estimates (about 30% run-to-run variance).

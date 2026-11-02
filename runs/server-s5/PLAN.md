# PLAN: highest-score submission to the $12 Server Challenge (Anka process)

Verdict: single-threaded C epoll server, SQLite linked in-process, served **direct on 0.0.0.0:80** (no Nginx), hand-rolled HTTP/JSON/JWT, writes group-committed per event-loop turn, WAL checkpoints done by a side thread. A prototype of this design (tmp/proto/server.c, 380 lines) passes 42/42 of test/test.sh. App CPU is not the limit at the connection counts the benchmark can reach, so the score is decided by connection handling, tail latency, and the WAL/checkpoint policy, not SQL cleverness.

## Questions I would ask the user (ranked by plan impact)
1. Is serving directly on port 80 acceptable (README rule 9 allows it), or must we sit behind Nginx? Direct saves 14-20% CPU and a hop. If Nginx: bind 127.0.0.1:3000, keep idle sockets open >65 s, same code.
2. Is C acceptable (build-from-source on the box, libsqlite3-dev and libssl-dev from apt, no prebuilt binaries)? If you want Rust/Go for maintainability, I would port the same architecture; expect a modest loss.
3. Should I optimise only for the k6 mix, or also stay fast on arbitrary reads (e.g. random old posts)? I assume correct and reasonably fast everywhere, but tuned for the stated mix. No load-test detection (rule 7).
4. Ambiguous spec points where I picked a behaviour (tell me if the reference differs): body length counted in UTF-16 units after JS-style trim; `sub` must match ^[1-9][0-9]*$; a token with no `exp` is accepted; a query string on a path is ignored.
5. Is it fine that a pipelined request on a connection waits until a preceding write on it has committed? (Required for response ordering; invisible to k6.)

## Step 1. Mined facts (candidate invariants, checked against seed/feed.db)
| Fact | Check |
|---|---|
| F1 posts.id is 1..500000 contiguous | Checked: count=max=500000 |
| F2 created_at is non-decreasing in id (feed == id DESC) | Checked: 0 violations in seed. Not guaranteed once clock/ties interplay after writes |
| F3 no equal created_at in seed | Checked: 0 duplicate timestamps |
| F4 bodies/usernames are ASCII with no quote or backslash | Checked: 0 exceptions. Used only as a fast-path hint, never for correctness: the output escaper is general |
| F5 each post has ~4 likes (min 1, max 22228 in the whole run incl. my stress writes; seed avg 5.25 per liked post) | Checked |
| F6 tokens only for users 1-20000, all users exist | Checked via tokens.json |
| F7 load.js reads only posts from the newest 20 and writes at ~0.17 per user-cycle | Read from bench/load.js. Used for sizing only |
| F8 bench req rate ~0.11 req/s per VU | Measured in my replica: 10,000 VUs = 1,069 rps |

## Step 2. Boundary assumptions (each must be backed by a quoted rule)
| Layer treated as fixed | Rule quoted | Verdict |
|---|---|---|
| SQLite in-process | "The database is SQLite: the file at `$SQLITE_PATH`, used in-process" | Fixed |
| Schema/indexes | "Don't add or change tables, columns, indexes or triggers" | Fixed |
| Any SQL | "Any SQL you like against the schema as given" | Free |
| Nginx | "Nginx is optional" | Habit; go around it |
| HTTP framework | "Any language, framework, runtime and SQLite driver" | Habit; hand-written HTTP/1.1 |
| One thread per core / many threads | "Any number of processes or threads" | Free; 1 vCPU so one loop thread |
| No cross-request caches | "no response caches, query-result caches, in-memory copies of tables, or remembered JWT verifications" | Fixed. Feed/post/like counts and every HMAC are recomputed per request |
| Prepared statements | "Reusing prepared statements is fine too" | Free |
| mmap | "SQLite's own page cache and mmap are fine" | Free |
| Durability | "WAL with synchronous=NORMAL or stronger"; "201 means the row is committed" | Fixed; group commit allowed if each response waits for commit |
| Checkpoint policy | not mentioned | Free (within rule 6) |
| Kernel params, CPU pinning | "no kernel parameters, and no pinning" | Fixed (so backlog is capped by somaxconn; see risks) |
| `created_at` default | "New rows get strftime(...) (the column default)" | Fixed: let SQLite stamp it, read via RETURNING |
Ambiguity worth a question: "no remembered JWT verifications" - I verify every token, no memo. Safe reading.

## Step 3. Profile by layer (measured here, 2 cores, warm cache)
SQL, per call, in-process (tmp/sqlb*.c, fresh seed copy):
| Query | us |
|---|---|
| reference feed (JOIN + count subquery, created_at index) | 55-73 |
| posts only, created_at index (non-covering) | 22 |
| posts only, rowid scan id DESC | 10.7 |
| 20 user lookups by PK | ~10 |
| 20 like counts (index) | ~23 |
| covering index scan of 20 ids | 5.5 |
| GET post by id (hot / random) | 6 / 9 |
| like insert, autocommit / in one txn | 360-410 / 58-62 |
| post insert, autocommit | 47-65 |
Whole-server (replica of load.js, server pinned to CPU0, client on CPU1, tmp/proto/lg.c):
- 10,000 VUs at real think times: 1,069 rps, p50 0.20 ms, p95 1.7 ms, p99 4.8 ms, 0 errors, server CPU ~10% of the core, RSS 30 MB. So 93 us CPU per request (about 73% user, 27% kernel).
- Saturation test (think time /25, 15,000 connections): 15,962 rps at ~91% core, 0 errors, RSS 47 MB. That is ~150k VUs of real-mix traffic per core, an order of magnitude above the ~15k connections the box is expected to carry.

## Step 4. Generality tax, and which facts remove it
| Costly layer | General case it serves | Fact that kills it | Gain |
|---|---|---|---|
| Nginx hop | any upstream | none needed; rule 9 | 14-20% CPU (README) |
| HTTP framework (routing, header maps, allocation) | arbitrary HTTP | only 5 routes, 3 headers read | not isolated; part of ~60 us non-SQL |
| JSON library | arbitrary JSON | need only top-level keys body/sub/username/exp/alg | removes allocations |
| JWT library | many algs, keys | HS256 only, single fixed key | possible: precompute HMAC ipad/opad state (~1 us/request) |
| Feed ORDER BY created_at index + rowid probes | unordered timestamps | F2: id order equals created_at order | ~8-11 us of ~55 us per feed |
| 20 separate like-count probes | arbitrary ids | F1: the 20 ids are contiguous, one range scan | measured 17 vs 23 us; marginal |
| Thread pool / DB pool | multicore | 1 vCPU | none: one thread, no locks |
| Per-request fsync / autocommit | independent commits | rule 6 allows group commit | like insert 410 -> 62 us |
| WAL auto-checkpoint on the request thread | simple default | rule 6 fixes WAL+NORMAL only | see Step 5 measurement |

Honest takeaway: SQLite is only ~55 us of a feed request and feed is half the traffic, so the data-dependent specializations (F2, F1) save about 5% of total CPU. They are shipped last and only with guards. The measurable wins are architectural.

## Step 5. Specializations (design)
1. Direct epoll server, level-triggered, one shared 64 KB read buffer; a connection allocates nothing while idle (15k idle sockets = a few MB user space). Never close idle connections. TCP_NODELAY. listen(65535) (kernel caps it; accept in a loop until EAGAIN).
2. Hand-written parser: request line, Authorization, Content-Length, Connection. Pipelining and partial reads supported; chunked/oversize closes the connection.
3. Tiny strict JSON validator capturing top-level keys; rejects trailing garbage, so "malformed JSON body" is exact. Output escaper is fully general (quote, backslash, control chars).
4. JWT: HMAC-SHA256 via OpenSSL (SHA-NI), constant-time compare, header must decode to alg HS256, exp enforced, sub/username checked. Auth is checked before the id, as the spec requires.
5. Writes: queued during an epoll batch, executed in one BEGIN IMMEDIATE..COMMIT, responses sent only after COMMIT; ROLLBACK and 500 on failure. Per-connection ordering preserved (a connection with a pending write is not parsed further).
6. Pragmas: WAL, synchronous=NORMAL, mmap_size 1 GB, cache 64 MB, wal_autocheckpoint=0 on the request thread. A side thread (own connection) runs `wal_checkpoint(PASSIVE)` every 200 ms so the loop thread never fsyncs.
7. Optional last step (guarded): feed via `ORDER BY id DESC LIMIT 20` plus the covering-index id list as the guard (see Step 8).

Measured on checkpointing, the one surprise (write rate 10x the real mix, 5,000 conns, 20 s):
| Checkpoint cadence | p95 | p99 | max | WAL file | server CPU ticks |
|---|---|---|---|---|---|
| every 2 s | 155 ms | 233 ms | 370 ms | 585 MB | 907 |
| every 200 ms | 0.74 ms | 1.6 ms | 49 ms | 109 MB | 682 |
Cause: a lagging checkpoint lets the WAL grow, which slows every read (wal-index lookups) and the eventual checkpoint. Run it often, small batches. At the real write rate (~130 writes/s at 15k VUs) pressure is far lower, but this is a cheap safety margin.

## Step 7. Claim cards
**C1 Says:** the server does not need Nginx or a framework to hold the target load.
Assumes: F8, epoll scales to ~15k idle connections, the load generator replica is faithful.
Breaks when: the real box's k6 pushes new connections faster than accept/backlog allows (somaxconn is untouchable) or a SYN burst overflows the queue.
Checked: Checked (10k and 15k conns, 0 errors, replica not k6; k6 itself is not installed here).

**C2 Says:** all 42 conformance checks pass.
Assumes: the golden files and test.sh are the final suite.
Breaks when: CI tests inputs the local suite does not (see question 4).
Checked: Checked (test/test.sh against the prototype: passed=42 failed=0).

**C3 Says:** group commit makes a like cost about 60 us instead of about 400 us, with 201 sent only after COMMIT.
Assumes: synchronous=NORMAL in WAL does not fsync on commit, one writer connection.
Breaks when: a crash loses the WAL tail after a power cut (allowed by NORMAL; rule 6 accepts it) or the commit fails (we send 500).
Checked: Checked (microbench; durability by construction, not power-failure tested).

**C4 Says:** checkpointing on a side thread every 200 ms removes tail-latency spikes.
Assumes: the checkpointer's fsyncs do not stall the loop thread on the droplet's disk.
Breaks when: the VM disk has huge fsync latency and the thread steals the single vCPU for long.
Checked: Checked locally (table above); Open on the real droplet.

**C5 Says:** feed == the 20 largest ids, so it can skip the timestamp index.
Assumes: F2. Breaks when: a later insert gets an older created_at (clock step back) or ties break against id order.
Checked: Checked on the seed; guard defined, not yet implemented.

**C6 Says:** the 20 like counts can come from one range scan.
Assumes: F1 (contiguous ids). Breaks when: ids are deleted or the 20 span a gap.
Checked: Checked at SQL level (17 vs 23 us); not worth shipping alone. Open.

**C7 Says:** per-request CPU is ~93 us, so one core serves >10k rps.
Assumes: the pinned 2-core replica approximates the 1 vCPU droplet.
Breaks when: the droplet's shared CPU is slower or noisy-neighbour steal exists.
Checked: Checked locally; Assumed for the droplet.

**C8 Says:** the strict JSON and trim/length rules match the reference.
Assumes: question 4 answers. Breaks when: the reference counts bytes or code points, or accepts lenient JSON.
Checked: Assumed (spec says "characters"; only ASCII is tested by load tests).

## Step 8. Runtime guards (every specialization gets a fallback)
- Feed fast path (C5/C6): run `SELECT id FROM posts ORDER BY created_at DESC, id DESC LIMIT 20` (covering index, 5.5 us) and require it to equal the 20 ids returned by the rowid scan, in order; mismatch -> run the reference query for this request (and log once). That makes the output provably identical to the general query, not just plausible.
- Contiguity (C6): require max_id - min_id == 19 among the 20 ids, else per-id count probes.
- JSON/JWT parser: any parse oddity maps to the spec's 400/401 messages; an internal failure falls to 500 and never crashes the loop.
- Connection limits: fd >= MAXFD closes the socket; a stalled partial request over 16 KB closes the connection.
- Commit failure: ROLLBACK and 500 for all queued writers.
- Startup: `/health` runs `SELECT 1` each call and returns the 503 body if it fails.
- Memory: report RSS in a debug env var; prototype shows ~47 MB at 15k conns, far below 2 GB.

## Step 9. End-to-end results so far
Prototype passes 42/42; 10k VUs: p99 4.8 ms, 0 errors, 10% core; 15k connections at saturation-rate load: 16k rps, 0 errors. No real k6 or Nginx here, so the final score on the droplet is unmeasured; expected to be bounded by the benchmark client and connection count, not by this server.

## Deliverables and order of work
1. Port tmp/proto/server.c to submissions/c-epoll-<user>/ with install.sh (apt: build-essential libsqlite3-dev libssl-dev), build.sh (gcc -O2), start.sh, README (say: direct on :80, versions, optimizations), .gitignore. Pin the apt package versions or vendor the SQLite amalgamation by checksum.
2. Make PORT/HOST come from env (done), bind 0.0.0.0:80 by default if unset.
3. Fuzz the parser (malformed JSON, split packets, pipelining, huge headers) and run a power-of-two ramp with k6 on a second machine when available.
4. Implement the guarded feed fast path only if measured end-to-end gain exceeds noise.
5. Re-measure checkpoint cadence on the droplet (C4).

Risks: accept backlog under a 15k-connection burst (kernel-limited), a noisy single vCPU, and my replica not being k6. Prototype files: /home/claude/srv/s5/tmp/proto/{server.c,lg.c}, tmp/sqlb*.c.

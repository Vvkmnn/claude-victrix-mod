# PLAN: $12 Server Challenge, submission `c-epoll-sqlite-<user>` (Anka process)

Goal: maximise the number of users that pass a 5-minute hold (p95<500ms, p99<1s, <1% errors) on 1 vCPU / 2 GB.

## 0. Questions for the user (unanswered; assumptions in brackets)
1. Is a hand-written C server acceptable, rather than a mainstream framework? Gain: about 10x less CPU per request and no GC pauses. Risk: more code to get right (HTTP parsing). The 42-check test suite is the guard. [Assume yes.]
2. May we serve directly on 0.0.0.0:80 instead of behind Nginx? Gain: removes Nginx's 14-20% CPU and its fixed 16,384-connection cap (worker_connections), which would bound the score near 16k users. Risk: we must handle all connections ourselves. [Assume direct.]
3. May writes (likes, new posts) run on a second thread that batches several requests into one commit (group commit, allowed by rule 6)? Each response still waits for its commit. Gain: a slow disk sync can no longer freeze reads (measured 250-490 ms freezes otherwise). [Assume yes.]
4. May a background thread run WAL checkpoints (copying the log into the main file)? Rule 6 only asks for WAL plus synchronous=NORMAL or stronger. [Assume yes.]
5. Is reading the SQLite file bytes directly (own b-tree parser) in scope? Gain maybe 20 us/request, which is irrelevant to the score (see 3). Risk: very high. [Assume no.]
6. Do you know whether the k6 machine uses more than one source IP? One IP caps at about 28k connections (default ephemeral port range 32768-60999), which would bound any score. Nothing to do about it; it only sets expectations. [Assume it is a ceiling we cannot move.]

## 1. Mined facts (each checked)
- Load mix, from bench/load.js: per user cycle about 20.5 s of think time, 1 feed, 1 post read, 0.15 likes, 0.02 creates. That is about 0.155 req/s/user: 46% feed, 46% post read, 7% like, 1% create. 15k users is about 2.3k req/s. Checked by reading load.js.
- The post read targets a post taken from the newest-20 feed, so reads concentrate on about 20 hot rows. Measured: hot-post read 4-6 us.
- Only about 8% of requests need a JWT check. HMAC-SHA256 via OpenSSL costs 3-5 us. Not a hot path.
- Seed: 500k posts, ids and created_at are monotone together (0 inversions). The newest 20 ids are contiguous (span 19). 2.0M likes, about 4 per post, max 583. All created_at values are distinct (checked).
- Indexes already cover everything needed: the feed is an index walk, and likes_post_id_idx covers the count. ANALYZE stats are present.
- Idle keep-alive connections cost an epoll entry and about 0 userland memory. Measured: 100 active plus 15,000 idle connections, server RSS 5 MB, throughput 26.8k to 22.7k rps.

## 2. Substrate vs interface
| Layer | Rule names (quoted) | Interface I happen to use | Free to change? |
|---|---|---|---|
| Storage | "The database is SQLite: the file at $SQLITE_PATH, used in-process" | sqlite3 C API, prepared statements | Yes: any binding, any SQL, any number of connections. Raw file parsing is allowed but not worth it. |
| Durability | "WAL with synchronous=NORMAL or stronger" | SQLite's autocheckpoint on the writing thread | Yes: checkpoint thread, group commit |
| Process model | "Any number of processes or threads" | one thread per core is the habit | Yes |
| Front end | "Nginx is optional" | Nginx proxy | Yes: go direct |
| Counting likes | "number of rows in likes... as of this request" | correlated subquery `(SELECT count(*) ...)` from the reference SQL | Yes: "Any SQL you like" |
| Caching | "No caching across requests", but SQLite page cache and mmap are fine | | Fixed: nothing held between requests except prepared statements, mmap and the page cache |

## 3. Speed-of-light floor vs measured (per hot path, loopback, this box)
| Path | Floor | Measured | Ratio | Where the gap is |
|---|---|---|---|---|
| GET /feed, reference SQL | about 3 us of b-tree work (index-only walk of 20 ids measured 3.4 us), about 5 KB written | 42-56 us | about 15x | 29 us is 20 correlated subqueries (about 1.5 us each in VDBE setup); 9 us is 20 rowid lookups into posts (body); the user join costs about 0 |
| GET /feed, my 2-phase | same | 26 us (output is byte-identical to test/golden/feed.json) | about 8x | remainder is VDBE and column fetch. I stopped here because it is not the bottleneck (see below). |
| GET /posts/:id | about 1 us | 4-6 us hot, 5-14 us random | 4-6x | VDBE |
| Syscalls per request | 2 (read, write) plus amortised epoll_wait | measured end to end 21-27k req/s on one thread, about 40 us/request | | |
| JWT | about 0.5 us with precomputed key pads | 3-5 us OpenSSL | | only 8% of requests, ignore |
| Write commit (WAL, NORMAL) | about 20 us | p50 19-40 us, but p99 4 ms, p99.9 43 ms, max 390-490 ms with autocheckpoint on the same thread | | the checkpoint fsyncs the 250 MB main file inside the commit |

The key finding: CPU per request (about 40 us) gives about 25k req/s, or about 150k users' worth of load at 0.155 req/s/user. CPU is not the limit. The limits are (a) the Nginx 16,384-connection cap, (b) tail latency from stalls in a single event loop (checkpoint fsync), (c) kernel and memory per connection, (d) the k6 machine's own ports. So the plan is about removing the stalls and the cap, not shaving microseconds.

## 4. Discoveries below the obvious interfaces
- Default WAL autocheckpoint runs fsync inside a write request. Measured write max 243-490 ms and p99.9 14-43 ms. If that happens on the event loop thread, every connection stalls. Fix: wal_autocheckpoint=0 plus a checkpoint thread. Measured write max 7.5 ms, p99.9 0.7 ms at 4k writes/s.
- A fresh connection's `wal_checkpoint` silently does nothing (returns rc=0, log=-1) until that connection has run one query. The WAL then grew to 846 MB. The checkpoint thread must run `SELECT count(*) FROM sqlite_master` first. Found by printing the log/checkpointed frame counts.
- A large un-checkpointed WAL slows reads: the feed went from about 26-42 us to 44 us with a 90 MB WAL, and p50 read 346 us at 846 MB. So the checkpointer must keep up: PASSIVE every 200 ms, and a TRUNCATE when the WAL exceeds a size.
- Under a constant write stream the WAL never restarts with PASSIVE alone, because the writer rarely finds it fully backfilled. At a realistic 120 writes/s it stayed at 5.5 MB. Add a periodic TRUNCATE (open item, below).
- mmap_size=400MB helps point reads (random post read 14 to 7 us) and costs no extra RSS accounting problem (file-backed). WAL pages are not mmapped.
- Unexplained: one 251 ms write stall at the realistic rate even with the checkpoint thread (probably file extension or WAL restart). Hence writes go on their own thread.
- Nginx: gzip applies at 1 KB or more, so the 5 KB feed would be compressed on the one CPU for no benefit on loopback. Another reason to go direct.

## 5. Design (chosen)
- C, gcc -O2, libsqlite3-dev from apt (version pinned in install.sh) or the sqlite amalgamation downloaded to a pinned version in build.sh (allows -DSQLITE_THREADSAFE=2, -DSQLITE_OMIT_* trimming). OpenSSL libcrypto for HMAC with a keyed ctx copied per request. Direct on 0.0.0.0:80, no Nginx.
- Thread A (reader/event loop): epoll, nonblocking sockets, edge or level triggered, per-connection state of a few bytes plus a lazily allocated buffer. No idle timeout (or at least 10 min). Own read-only-use connection, mmap, prepared statements. Responses assembled in a preallocated buffer, with a single write().
- Feed: statement 1 (newest 20 with user join), statement 2 (`SELECT post_id FROM likes WHERE post_id BETWEEN lo AND hi`) counted in C. Guard: if hi-lo > 512, or the count of returned rows exceeds a bound, use the per-id `SELECT count(*)` path. Both give the same bytes. A differential test compares them against the reference SQL on random states.
- Thread B (writer): receives create/like jobs through a queue, runs them in one BEGIN IMMEDIATE...COMMIT per batch, then answers each waiting connection (via eventfd back to thread A). The response is sent only after COMMIT returns. The order of the validation errors follows SPEC.md (auth first, then id, then body).
- Thread C (checkpointer): own connection (primed with one query), wal_autocheckpoint=0, PASSIVE every 200 ms, TRUNCATE when the WAL is over about 64 MB or every 30 s (only the short tail is copied while holding the write lock).
- Pragmas: journal_mode=WAL (already), synchronous=NORMAL, cache_size about 64 MB, mmap_size 400 MB, busy_timeout 5000. Memory budget: well under 300 MB.
- Parsing: strict about what test.sh sends (request line, Authorization, Content-Length bodies up to 16 KB, pipelining tolerated, partial reads buffered). Anything unexpected returns 500 or 400 and never crashes.
- Fallback guards at runtime: (1) the feed range guard above; (2) if a read sees SQLITE_BUSY or an error, retry once, then return 500; (3) if listen/accept hits EMFILE, stop accepting and close idle connections only as a last resort.

## 6. Candidate designs scored (what I tried and what I will keep)
| Candidate | Result | Keep? |
|---|---|---|
| Reference SQL, correlated subquery | feed 42-56 us | fallback only |
| Subquery over LIMIT 20 derived table | 44 vs 54 us (noise-level) | no |
| 2-phase, per-id count statement | 87 us | no, worse |
| 2-phase, range count in C | 26 us, golden-identical | yes |
| mmap 400 MB | random post read 14 to 5-7 us | yes |
| autocheckpoint on write path | write max 243-490 ms | no |
| checkpoint thread | write max 7.5 ms (with no priming it silently did nothing) | yes, with priming |
| Single-thread epoll server (prototype in tmp/srv.c) | 21-27k req/s total with 100 conns, feed + post mix | basis |
| Raw b-tree reader, io_uring (not installed), SO_REUSEPORT multi-process | not tried or not applicable: 1 vCPU | no |

## 7. Cards
**Card 1: "CPU is not the bottleneck"**
Says: at about 40 us/request the server could serve about 25k req/s, about 150k users of this workload.
Assumes: load mix as in load.js; DO vCPU about as fast as this Xeon; k6 reaches the server.
Breaks when: the real vCPU is 3x slower (still 50k users' worth); a slow disk makes commits slow (mitigated by a writer thread).
Checked: Measured (prototype, loopback, generator on the other core). Open: not measured on a real 1-vCPU box with the generator off-box.

**Card 2: "Direct beats Nginx"**
Says: Nginx caps the connection count near 16,384 and costs 14-20% CPU.
Assumes: README rules and the config text are accurate (worker_connections 16384).
Breaks when: the benchmark box's kernel limits (somaxconn 4096 here, fixed by rule 11) reject connection bursts. The ramp is 60 s, so about 250 connects/s, fine.
Checked: Read from bench/nginx.conf. Idle-connection scale test with 15,000 sockets passed. Assumed: DO behaves the same.

**Card 3: "Range count equals per-post count"**
Says: counting likes for post_ids in [lo,hi] and bucketing in C equals the 20 subqueries.
Assumes: the 20 ids sit in a narrow range, which is true while ids and created_at grow together.
Breaks when: ids are far apart (many old posts with newer created_at). Not in seed or load test; a guard falls back to per-id counting when the span exceeds a bound.
Checked: Proved by construction (same rows, same grouping); byte-identical to test/golden/feed.json. Open: randomised differential test with inserts in the loop.

**Card 4: "Checkpoint thread removes write stalls"**
Says: moving the checkpoint off the commit path cuts write max from 243-490 ms to 7.5 ms and keeps reads unaffected.
Assumes: checkpoint connection primed; PASSIVE keeps up; truncation happens eventually.
Breaks when: the writer never idles and the WAL never restarts (seen at 4k writes/s, WAL 846 MB). Mitigated by TRUNCATE when the WAL is over 64 MB.
Checked: Measured. Open: the TRUNCATE branch and a single 251 ms stall at 120 writes/s are not yet explained.

**Card 5: "Durability still honest"**
Says: 201 is sent only after COMMIT returns, with WAL and synchronous=NORMAL, so rule 6 holds.
Assumes: group commit is permitted (README says yes) and nothing is acknowledged early.
Breaks when: a bug answers before COMMIT. Guard: the response path lives only in the post-commit callback.
Checked: Assumed from reading rule 6. Open: crash-recovery test (kill -9 after 201, reopen, row present).

## 8. Plan of work
1. Port tmp/srv.c to the full API (health, 404, 400/401 ordering, JWT, create, like, escaping JSON bodies).
2. Writer and checkpointer threads; run test/run.sh until 42/42.
3. Differential test: feed and post via the reference SQL vs mine on random states, including after writes.
4. Load test with k6 if available (it is not installed here; use bench/load.js on a real box) at 2.5k, 5k, 10k, 15k, 25k users; watch p99, RSS, and WAL size.
5. Write README (state "Direct, no Nginx") and install.sh/build.sh/start.sh with pinned versions.

## 9. Measured results so far (this box, 2 cores shared, noisy)
- Feed SQL: 42-56 us reference vs 26 us 2-phase (golden-identical). Post read 4-6 us hot. HMAC 3-5 us.
- Prototype server: 21-27k req/s on one thread; 15,000 idle conns plus 100 active: RSS 5 MB, p99 13 ms under saturation.
- Write path: autocheckpoint on the commit path max 243-490 ms; checkpoint thread max 7.5 ms.
- Not measured: full 42-check test run (server incomplete), k6 runs, real DO VM.

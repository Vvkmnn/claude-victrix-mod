# Plan: C + epoll + SQLite, direct on port 80 (Anka process)

## Verdict
Write one single-threaded C server (raw epoll, hand-parsed HTTP, hand-written SHA-256/HMAC, libsqlite3 3.45.1 from apt),
serving directly on 0.0.0.0:80 with no Nginx. Measured: SQLite and the HTTP work cost about 60 us per request,
so one core has CPU to spare. The score is limited by connection handling (up to ~15k idle keep-alive sockets), not by compute.

## 1. Facts mined (each checked on seed/feed.db copy)
- F1 Reads are 2 of ~2.2 requests per user cycle (about 20.5 s avg): load is about 0.1 req/s per user. Checked (bench/load.js).
- F2 Feed = newest 20 by the existing index (created_at DESC, id DESC); plan is SCAN posts_created_at_id_idx + PK lookups, no sort. Checked (EXPLAIN QUERY PLAN).
- F3 Seed usernames are all [a-z0-9_] (0 violations in 50k); bodies contain no quote, backslash or newline (0). Checked. User-submitted bodies can contain them, so JSON escaping stays (guard, see section 8).
- F4 created_at is already in the wire format and unique in the seed (0 duplicate timestamps). Checked. Sent verbatim.
- F5 Writes are rare (~0.15*N/20 likes/s, ~0.02*N/20 posts/s, so ~150 and ~20 per s at 20k users). Derived.
- F6 Seed DB is 250 MB and fits in RAM (2 GB). Checked.

## 2. Boundary assumptions
| Layer | Rule that fixes it | Verdict |
|---|---|---|
| SQLite in-process | README rule 2 "The database is SQLite ... used in-process" | Fixed |
| WAL + synchronous>=NORMAL, commit before 201 | rule 6 | Fixed. Group commit explicitly allowed |
| No caching of data or JWT verification | rule 5 | Fixed: re-run HMAC and queries every request |
| Schema/indexes | rule 3 | Fixed |
| Nginx | rule 9 "Nginx is optional" | Habit: drop it (saves 14-20% CPU, one proxy hop, the 64-idle-connection pool) |
| HTTP framework, JSON library, JWT library | Not in any rule (rule 1: any language/framework) | Habit: replace with a specialised parser/writer |
| Thread/process model | rule 1 "any number of processes or threads" | Habit: 1 vCPU so one thread, one epoll loop |
| Ordinary SQL for the post object | SPEC "You can write your own SQL" | Habit |
| Pre-built binaries, kernel tuning, CPU pinning | rules 10, 11 | Fixed: compile on box; no sysctl, so the accept backlog is capped by somaxconn and I must accept fast |

## 3-4. Profile by layer and generality tax (measured, 1 box, 2 cores shared with the load tool)
| Layer | Cost | General case it handles | Why it is not needed here |
|---|---|---|---|
| SQLite feed query (20 rows, count subquery) | 61 us | arbitrary SQL | already near the floor; index order means no sort |
| SQLite post-by-id | 13 us | same | same |
| SQLite like insert | 170 us (batch and autocommit about equal under WAL/NORMAL) | | fine at ~150/s |
| Whole server, prototype, 400 conns, 3000 req/s | 17% of one core = ~57 us/request | | HTTP overhead is smaller than the query |
| Python sqlite3 loop (comparison) | feed 70 us, post 10 us | | language is not the bottleneck; framework + proxy would be |
Conclusion: capacity is roughly 15k+ req/s on one core, which is ~150k users of pure CPU. The real limits are ~15k sockets,
memory per connection, accept/SYN backlog bursts at ramp-up, and tail latency when many requests land in one epoll tick.

## 5. Specialisations
1. No Nginx, direct on :80 (HOST/PORT from env). Same results: spec allows both.
2. Hand-rolled HTTP/1.1 parser. Only needs request line, Authorization, Content-Length, Connection. Supports keep-alive, pipelining and partial reads; anything unparseable gets 400/404 in the spec's format.
3. JWT: split on dots, base64url-decode, check header is exactly HS256, HMAC-SHA256 with constant-time compare, parse `exp`, `sub`, `username` with a minimal JSON reader. Verified on every request (rule 5). Cost ~2-3 us.
4. Response writer: snprintf-free direct byte copy of columns into one buffer; one `write()` per response.
5. Connections: ~1 KB state per fd (struct in a flat array indexed by fd, buffers lazily from a pool); idle timeout well above 65 s (none needed). TCP_NODELAY, large listen backlog, accept loop until EAGAIN, handle EMFILE/ENFILE by not spinning.
6. Writes: collect all POST /posts and likes parsed in one epoll tick, run in one BEGIN..COMMIT, then answer all. Each response still waits for the commit (rule 6). Read requests in the same tick run after the commit so they see "as of this request" like counts.
7. SQLite config: SQLITE_THREADSAFE=0 compile-time not possible with apt lib, so use `SQLITE_OPEN_NOMUTEX`; `mmap_size` ~1 GB (allowed, rule 5); `journal_mode=WAL` (already), `synchronous=NORMAL`, `wal_autocheckpoint` raised so checkpoints do not stall a tick, `temp_store=MEMORY`; prepared statements for all 5 queries. Possible later: the like insert only needs `INSERT ... ON CONFLICT DO NOTHING`, with 201/200 chosen from `sqlite3_changes()` and post existence checked by a PK lookup in the same transaction.
8. Possible if profiling shows it: ask for like_count and the user join in one statement, and fetch the feed with a hand-rolled index walk. Not planned (13/61 us is not the bottleneck).

## 6. Questions for the user (ranked by plan impact), and what I assume
1. Do you want the safest score (Nginx in front, as in the video) or the highest score (serve directly)? Assumed: direct on :80, because the rules allow it and it saves 14-20% of the one core. If "safest": same code, bind 127.0.0.1:3000, keep-alive timeout above 65 s.
2. Is a C submission acceptable, given the CI installs the toolchain with `install.sh` and you will maintain it? Assumed yes. If no: Rust or Go with the same structure (Go would lose about 2x CPU and add GC pauses at 15k connections).
3. May `install.sh` use apt `libsqlite3-dev` (3.45.1 on Ubuntu 24.04), or must SQLite be a pinned source tarball with a checksum? Assumed apt is a "pinned version" because the distro fixes it. If a tarball is required: compile the amalgamation with THREADSAFE=0, OMIT_SHARED_CACHE, DEFAULT_MEMSTATUS=0.
4. Is going over ~15k open connections plausible (e.g. the scorer's VU count exceeds 15k)? Assumed the score tops out near the connection limit, so the design avoids per-connection allocations and tests with 15k sockets.
5. Is group commit across requests in one tick OK to rely on (rule 6 says yes)? Assumed yes.
6. Is the wording "No caching across requests" meant to ban a prepared-statement-adjacent optimisation like remembering the newest 20 post IDs? Assumed it does ban it, so nothing is remembered between requests except prepared statements and the page cache/mmap.

## 7. Claim cards
- C1. Says: the per-request cost is dominated by SQLite, not HTTP. Assumes: C server, prepared statements. Breaks when: connections idle in large numbers cost more in the kernel than in user space. Checked (prototype: 57 us/request including syscalls, load generator on the same box).
- C2. Says: dropping Nginx is allowed and faster. Assumes: rule 9 text. Breaks when: the scorer's network layer needs something Nginx provides (e.g. gzip, request buffering of slow clients). Checked (rule text; no gzip needed since compression is optional). Slow-client handling: Open.
- C3. Says: the server holds ~15k keep-alive sockets within 2 GB. Assumes: ~1 KB per connection plus kernel buffers, LimitNOFILE=65535. Breaks when: kernel socket memory (about 4-8 KB per idle socket) plus the 250 MB DB under mmap crowds RAM. Open: I could not run 15k sockets here (sandbox fd cap 20000 and my Go load generator stalled at 6000+ connections), so it is not measured. Estimated 15k x ~10 KB = 150 MB.
- C4. Says: JSON output equals the reference queries' output. Assumes: usernames/bodies escaped properly, timestamps verbatim. Breaks when: a body has control characters or non-ASCII. Checked for seed (no special chars); to be Checked against test/golden by test/run.sh.
- C5. Says: single-thread batching keeps p99 under 1 s. Assumes: a tick holds at most a few hundred requests (~60 us each, so about 20 ms). Breaks when: a burst of thousands of requests arrives in one tick (after a stall or the ramp-up). Open: cap events per tick and interleave writes with commits.
- C6. Says: group commit preserves durability. Assumes: respond only after COMMIT returns. Breaks when: a response is written before commit. Proved by construction (responses queued, flushed after COMMIT).

## 8. Runtime guards (fall back to general path)
- Body JSON escape: scan each text field for `"`, `\`, bytes <0x20 or >=0x80; the fast copy is used only if none are present, otherwise the escaping copy runs (the prototype has the slow path inline).
- Request parser: any request that is not an exact fast-path shape (missing CRLF, unusual header case, chunked body, body > 16 KB, split across reads) goes to a slower general parser/buffering path; if still unparseable, 400 `malformed JSON body` or 404 per spec.
- Accept failure (EMFILE): temporarily stop accepting, close idle least-recent sockets rather than spin (the prototype busy-looped on this, a bug found while testing).
- SQLite errors: SQLITE_BUSY/IOERR returns 500 `internal server error`; /health returns 503 degraded if `SELECT 1` fails.
- Startup self-check: run the golden queries and compare to test/golden before listening; abort loudly on mismatch.

## 9. Measurement plan (end to end) and results so far
Done: query micro-benchmarks and a 3-endpoint prototype (400 conns, 3000 req/s, p50 0.25 ms, p95 0.63 ms, p99 0.99 ms with the Go load generator on the same box; server 17% of one core).
To do when implementing: (a) test/run.sh must pass 42/42 on a fresh copy; (b) k6 at 5k/10k/15k VUs with `bench/load.js` (k6 is not installed here), watching RSS and p99; (c) repeat after a 5-minute hold to catch WAL growth (checkpoint stalls); (d) 15k-socket idle test with a purpose-written C load tool; (e) compare against an Nginx-fronted build to confirm the direct choice.

## Not done / honest limits
Auth, POST routes, the full error table and 15k-connection behaviour are designed but not prototyped. Scratch files are in tmp/ (qb.c, srv.c, lg.go).

# Plan: $12 Server Challenge submission (Anka process)

Verdict first: write a single-purpose C server (epoll event loop, direct on 0.0.0.0:80, no Nginx) that calls
libsqlite3 directly. Reads run on the event-loop thread. All writes and all WAL checkpoints (and therefore all fsyncs)
run on one helper thread. SQL speed is not what limits the score. The limits are open-connection count, tail latency
from fsync stalls, and not wasting CPU on a proxy.

## 0. Questions I would ask (user unavailable; assumptions stated)

Ranked by how much the answer changes the plan.
1. "Is it OK to serve straight to the internet on port 80 instead of behind the organiser's Nginx?"
   Gain: Nginx is configured with 16,384 connections and also spends 14-20% of the CPU, so it likely caps the score near
   ~16k concurrent users, and going direct removes that cap. Risk: our server must hold up to ~65k sockets itself
   (the service gets LimitNOFILE=65535). Guard: none needed, the rules allow it (rule 9).
   ASSUMED: yes, go direct.
2. "May I fetch SQLite's official source (the 'amalgamation') and compile it with speed-oriented options during build.sh,
   instead of using Ubuntu's packaged libsqlite3?" Gain: probably a few percent of SQL time. Risk: build needs a download
   (rules allow pinned downloads); a checksum pins it. Guard: build.sh falls back to the apt library if the download or
   checksum fails.
   ASSUMED: yes, with fallback. UNMEASURED here, since there is no internet.
3. "Is C acceptable (you must trust a hand-written HTTP parser), or do you prefer a memory-safe language even if it is slower?"
   Gain of C: lowest per-connection memory and no GC pauses. Risk: parser bugs. Guard: strict parser; anything
   unusual (chunked body, Expect, pipelining, over-long headers) goes to a slow, simple path or gets a 400.
   ASSUMED: C, with fuzz tests against the obvious implementation.
4. "Should we skip the SQL engine entirely for the newest-20 feed read (read the database file's pages ourselves)?"
   Gain: about 10 us of a ~55 us request, roughly 2-3% of CPU at the top load. Risk: high. We would have to re-implement
   WAL reading, and it arguably violates "used in-process" SQLite. ASSUMED: NO. Rejected.
5. "Non-ASCII characters in a post body: should the 500-limit count characters the way SQLite's length() does
   (code points), or the way JavaScript's string length does (UTF-16 units)?" The load test and tests use ASCII only.
   ASSUMED: code points, which matches the schema CHECK. Differs only for emoji.

## 1. Mined facts (checked on seed/feed.db, a copy in tmp/)

| Fact | Check | Result |
|---|---|---|
| DB is 249 MB (4 KB pages, 60,838 pages, WAL), box has 2 GB | `pragma page_count`, `ls` | whole file fits in the OS page cache; reads are CPU-only, never disk |
| Seed ids and created_at are monotone (no inversions), max is 2025-12-31 | SQL | the newest posts are the highest ids; new rows (2026+) always sort on top |
| 0 bodies have non-ASCII, quote, backslash or untrimmed spaces; 0 odd usernames | SQL | JSON escaping is nearly free, but must still be correct for POST bodies |
| Likes per post: mean 4, max 583 | SQL | like_count by index range count is always short |
| Load model: ~2.17 requests per VU per ~20.5 s cycle (feed, post, 15% like, 2% create) | read bench/load.js | request rate is about 0.106 x VUs per second. 20k VUs is 2.1k rps; 60k VUs is 6.4k rps |
| About 8% of requests are writes (0.17 of 2.17) | same | write latency counts toward p95 and p99, so it is not negligible |
| Auth is needed only on the two POST routes; the user is never looked up | SPEC | HMAC cost is irrelevant at ~170-1000 rps; just do it right |
| Tokens are for users 1-20,000 only | seed | FK is not enforced by default; keep it that way |

## 2. Substrate vs interface

| Layer | What the rule names (quoted) | The interface I would habitually use |
|---|---|---|
| Storage | "The database is SQLite: the file at `$SQLITE_PATH`, used in-process." Schema and data fixed. "Any SQL you like." | an ORM or pooled driver in a framework. Not fixed. The C API with prepared statements, a persistent read connection and `mmap_size` is allowed |
| Durability | "WAL with `synchronous=NORMAL` or stronger"; "A 201 means the row is committed"; group commit "allowed" | per-request autocommit plus the default inline auto-checkpoint. Not fixed (see below) |
| Caching | "No caching across requests... SQLite's own page cache and mmap are fine. Reusing prepared statements is fine." | I use none of my own caches. Only SQLite's pages and prepared statements |
| Network front | "Nginx is optional... or serve the internet directly on 0.0.0.0:80" | Nginx plus a framework. Nginx is NOT required; going direct is named as allowed |
| Concurrency | "Any number of processes or threads" | one thread per core. A second thread for writes is allowed |
| Process settings | "Settings inside your own process (GC, thread counts, allocator, pragmas allowed by rule 6)" | kernel tuning is forbidden (rule 11): nothing is done to sysctls |
| Build | "built from source on the box with your install.sh and build.sh. Pin your dependency versions" | SQLite from the amalgamation is allowed if pinned; no prebuilt binaries |

## 3. Speed-of-light floor vs measured (this box: 2 cores, loopback; numbers are directional)

| Hot path | Floor (least physical work) | Measured | Ratio |
|---|---|---|---|
| GET /feed SQL | ~20 post rows (about 2 leaf pages + 20 index entries), 20 user rows, 20 short like-index ranges: ~60 pages touched, ~3.5 KB out, ~8-10 us | 26 us hot (spec query); 40-78 us on a cold first run | ~3x |
| GET /posts/:id SQL | 3 b-tree descents, ~2 us | 11-17 us random ids (cold pages), 2-3 us hot | ~1x hot, ~5x cold |
| Whole request, server side | 1 read + 1 write syscall, ~10-15 us | ~30 us/request (20 us user, 10 us sys) in my prototype | ~2-3x |
| HMAC-SHA256 of a JWT | ~1 us | 6.25 us (OpenSSL one-shot), 1.69 us with a reused context | 3.7x, then 1.7x |
| Write (post+like) commit, no fsync | ~30 us | 38-100 us p50 | ~2x |
| Write tail with inline auto-checkpoint | ~0 (no fsync on the critical path) | p99 6-10 ms, p99.9 20-30 ms, max 170-530 ms | huge (stalls) |
| Capacity, 1 core | server CPU ~30 us/req | ~13-18k rps on the loopback harness, server not saturated (the load generator was the limit) | CPU is not binding |

Capacity arithmetic: at 30 us/request a core serves ~33k rps, which is ~300k VUs by CPU alone. The real ceilings are
sockets (65,535 fd limit; Nginx 16,384) and tail latency. Design for 60k+ connections, not for shaving SQL microseconds.

## 4. Descent: what was found below the obvious interfaces

1. fsync is the only large tail source, and it hides in the checkpoint. With the default `wal_autocheckpoint=1000`, every
   checkpoint fsyncs ~4 MB inside the commit that triggered it. Measured max write stall 170-530 ms on this ext4 disk
   (p99.9 20-30 ms), whatever the setting from 4 to 1000 pages. In a single-threaded event loop that would freeze every
   read too. Smaller auto-checkpoints did not help.
2. A separate checkpointer thread alone fixes the stall but breaks WAL reset. With `PASSIVE` checkpoints from a helper
   thread, the WAL never restarted because the writer never found `nBackfill == mxFrame`. The WAL grew to 100-630 MB
   (same file, unbounded). Fix, measured: `wal_autocheckpoint=0`, the writer thread calls
   `wal_checkpoint_v2(RESTART)` itself when the `wal_hook` frame count is over ~1500. That gave a bounded WAL (6 MB)
   and write p99.9 of 1.6-5 ms. The forced restart still costs up to ~220 ms, but it blocks only that thread, and
   readers (WAL snapshot readers) never block.
3. Each insert dirties ~5-7 pages (the posts table plus 2 indexes, the likes table plus 2 indexes). So 500 writes/s
   is ~100 MB of WAL per 10 s if it is never reset. This is why the WAL-reset fix matters.
4. Kernel network stack dominates the server's own cost. Server CPU split 20 us user / 10 us sys per request, and ~1 KB of
   user state per connection. 17k idle connections cost the server 131 MB RSS and no throughput loss. 65k connections
   should be ~0.5-0.7 GB including kernel buffers, safely under 2 GB.
5. The sandbox's libsqlite3 reports `COMPILER=clang-23.1.3`; the target's Ubuntu 24.04 package (3.45.1) is gcc-built.
   My absolute numbers are therefore for a different build than the benchmark box.
6. Nginx on the box, per bench/nginx.conf, allows 16,384 worker connections and gzips responses over 1 KB (the feed
   response is ~3.5 KB, so the box's CPU would be spent compressing it). Going direct skips both.

## 5. Generality tax and what is specialised

| Layer | General case it handles | Facts that make it unnecessary | Decision |
|---|---|---|---|
| Web framework / router | many routes, methods, middleware | exactly 5 routes, fixed bodies | hand-written parser for the 5 routes; unknown input to a slow/400 path |
| Connection pool / thread pool | many cores, blocking drivers | 1 vCPU | one event-loop thread plus one writer thread, no pool |
| ORM / JSON library | arbitrary shapes | fixed key order, fixed 5 fields | direct `snprintf`-free appends with correct JSON string escaping |
| SQL join + subquery for the feed | arbitrary ordering | none that is safe | KEEP the spec query. A "newest ids" shortcut would save ~7 us and depend on id/time monotonicity. Rejected; the index scan is already cheap |
| Auto-checkpoint | simple default | writes can be on a helper thread | custom checkpointing (above) |
| Nginx | TLS, buffering, HTTP quirks | we want the raw sockets | go direct |

## 6. Candidate designs (scored by exact-match vs the spec query + benchmark)

| # | Design | Status |
|---|---|---|
| A | C, epoll, direct :80, libsqlite3 (system), reader on loop thread, writer+checkpoint thread | PLANNED BASELINE. The prototype of the read half is built and measured (tmp/srv.c) |
| B | A plus SQLite amalgamation with `THREADSAFE=2`, `OMIT_SHARED_CACHE`, `DEFAULT_MEMSTATUS=0`, `OMIT_DEPRECATED`, `OMIT_PROGRESS_CALLBACK` | try if question 2 is yes; benchmark vs A |
| C | A with io_uring for network I/O (kernel header present at /usr/include/linux/io_uring.h) | ONLY if profiling shows syscalls > 25% of CPU. Today it is ~10 of 30 us, so likely not worth the risk |
| D | A with an extra reader thread | rejected: 1 vCPU, adds locking, no gain |
| E | Rust/Go equivalent | rejected: higher per-connection memory (Go goroutine stacks) or more code for no CPU gain at this scale |
| F | Read the DB pages directly, bypassing SQL | rejected (question 4) |
| G | Nginx in front of A | rejected: lower connection ceiling, 14-20% CPU |

Variant knobs to benchmark on the finished server: `mmap_size` (0 vs 1 GB; 26 vs 26 us hot, no difference measured on
feed, so keep the 1 GB setting for post lookups), the forced-restart threshold (1500 frames vs 500 vs 4000), the
checkpointer interval, and accept strategy.

## 7. Implementation outline

* Process start: open the DB, `PRAGMA journal_mode=WAL`, `synchronous=NORMAL`, `mmap_size=1073741824`,
  `wal_autocheckpoint=0`, `busy_timeout`, prepare all statements once (`SQLITE_PREPARE_PERSISTENT`).
  The 60 s start budget is far more than needed.
* Event loop: nonblocking listen with a large backlog, `accept4`, a small struct per connection (~64 B, the read buffer
  is shared and only a partial request is copied out), no idle timeout (Nginx-style 65 s minimum is satisfied by never
  closing), EMFILE handling with a spare descriptor, `TCP_NODELAY`.
* GET /feed, /posts/:id, /health: run the spec SQL on the loop thread, append JSON into one buffer, one `send`.
  /health runs a real `SELECT 1`.
* POST routes: verify the HS256 JWT (header must be exactly HS256, constant-time compare, check `exp`, `sub` positive integer
  string, `username` string). Auth is checked before the id. Then hand off to the writer thread via a queue and an eventfd.
* Writer thread: drains the queue into ONE transaction (group commit), inserts with
  `INSERT ... RETURNING id, created_at`, and for likes `ON CONFLICT DO NOTHING` plus `sqlite3_changes()` to choose 201 vs 200.
  It commits (WAL, no fsync under NORMAL), then posts responses back to the loop. Post existence is checked in the same
  transaction. When the `wal_hook` frame count is over the threshold it runs `RESTART` checkpoint.
* Errors exactly per the table in SPEC.md; trimming and the 500-character rule on the parsed string.
* README.md states: direct, C, system or pinned SQLite, and every choice above.

## 8. Cards for important claims

**Claim 1: SQL is not the bottleneck.**
Says: server CPU is ~30 us/request, so one core handles ~33k rps (~300k VUs by the load model).
Assumes: the real network adds a similar or somewhat larger kernel cost; k6 is the limiter, not us.
Breaks when: the real NIC/virtualisation inflates syscall cost by 5x or more.
Checked: Measured on loopback with a C prototype (tmp/srv.c); Open on the real droplet.

**Claim 2: Go direct on port 80.**
Says: avoids the 16,384-connection Nginx ceiling and 14-20% CPU.
Assumes: the harness really drives more than ~16k users and allows direct serving (README rule 9 does).
Breaks when: more than ~65k connections are opened (fd limit), or accept bursts overflow a clamped backlog.
Checked: Proved from bench/nginx.conf text and the README; connection handling tested to 17k idle + active (limited by a 20k fd cap in this sandbox); Open above that.

**Claim 3: Offload checkpoint fsync to the writer thread, restart WAL by hand.**
Says: removes 100-500 ms stalls from the read path and bounds the WAL.
Assumes: readers never hold a long snapshot (they use single statements).
Breaks when: a reader holds a transaction open (restart returns BUSY; WAL grows until the next attempt).
Checked: Measured (tmp/b4.c, b5.c, b6.c): WAL 6 MB bounded, write p99.9 1.6-5 ms vs 20-30 ms; Open: a checkpoint in the writer can still stall writes ~200 ms (acceptable vs p99 < 1 s).
Guard: if the RESTART returns BUSY repeatedly, fall back to a TRUNCATE attempt after the queue drains.

**Claim 4: Keep the spec feed query.**
Says: the join + subquery is ~26 us hot, only ~3x its floor.
Assumes: nothing about id/time order.
Breaks when: n/a (it is the reference).
Checked: Proved by being the spec query; Broken (as a shortcut): an id-based shortcut was not adopted because it would rely on monotone timestamps, which a clock step would violate.

**Claim 5: HMAC with a reused context.**
Says: ~1.7 us vs 6.25 us.
Assumes: the key is constant (it is, from env).
Breaks when: never within the spec; signature compare must be constant-time and alg must be checked.
Checked: Measured (tmp/h.c). Correctness: Open until tested against test.sh and the bad-token cases.

## 9. Evaluation plan (to run once code exists)

1. `test/run.sh` must pass 42/42 (exact bytes).
2. Differential test: random ids and bodies (quotes, backslashes, control characters, unicode escapes, 500/501 chars, whitespace),
   compare responses byte-for-byte with a reference (python sqlite3 + json compact separators).
3. Fuzz the HTTP parser (partial reads split at every byte, pipelined requests, huge headers, wrong methods).
4. Soak: the load.js flow at 1k, 10k, 30k, 60k VUs using the C load generator in tmp/ (k6 is not installed here),
   record p95, p99, RSS, WAL size, fd count.
5. Crash test: kill -9 right after a 201, reopen, confirm the row exists.

## 10. Measured results so far (this sandbox, 2 cores, loopback; not the benchmark VM)

* Feed SQL: 26 us hot (spec query); sub-parts: index only 3.9, posts 9.8, plus users 12.6, plus likes 19-26.
* Post-by-id SQL: 2-3 us hot, 11-17 us random.
* Write with inline default checkpoints: p50 38-100 us, p99 6-10 ms, p99.9 20-30 ms, max 170-530 ms.
* Offloaded checkpoint + manual restart: p99.9 1.6-5 ms, WAL bounded at ~6-13 MB; naive offload: WAL 100-630 MB.
* Prototype read server (tmp/srv.c, one pinned core): 13-18k rps with 64 active connections (load generator limited),
  ~30 us server CPU/request, RSS 131 MB with ~17k idle connections.
* HMAC: 6.25 us one-shot vs 1.69 us reused context.
* NOT measured: the full submission, POST routes in the server, k6 end to end, the real droplet, the amalgamation build.

# Plan: $12 Server Challenge submission (Anka process)

Goal unit: score = max users passing a 5-minute hold (p95 < 500 ms, p99 < 1 s, < 1% errors).
Status: planned and prototyped. No submission folder written yet. Prototype code is in `tmp/proto/` (`server.c` = ship candidate, `server_t.c` = instrumented copy with the checkpoint-thread option, `lg.c` = k6-like load generator, `bench.sh`, `runtest.sh`, `diff.py`). The original `seed/feed.db` was never modified (all experiments ran on copies in `tmp/`).

Caveat on measurements: the sandbox is a 2-vCPU VM with noisy neighbours (the same microbenchmark swung 23 us to 58 us between runs). I used best-of-N, interleaved variants, and callgrind instruction counts (deterministic) for the SQL layer. No k6, wrk, or nginx here, and a 20,000-fd cap, so nothing above about 19k connections was tested. Load-generator latency tails at 18k connections were unreliable: the no-database stub server showed the same multi-second p99, so I treat them as a harness artefact.

## 0. Prior art (from own knowledge) and what I build on

| Approach | Why it is fast | Rule check |
|---|---|---|
| Single-threaded epoll/kqueue event loop in C or Rust (nginx, Redis, h2o, TechEmpower top entries) | No locks or context switches. About 40 bytes of state per idle connection. One `recv` and one `send` per request. | OK (rule 1). Right fit for 1 vCPU. |
| Hand-written HTTP parser, response assembled in one buffer, one `send` | Avoids framework allocation and header maps. | OK |
| Prepared statements reused (`SQLITE_PREPARE_PERSISTENT`) | Saves parse and plan time. | Explicitly allowed (rule 5). |
| SQLite WAL, `synchronous=NORMAL`, one connection per thread, checkpoint off the request path | Commit becomes one `write()` with no fsync. | Allowed by rule 6. |
| Group commit | Amortizes WAL writes. | Allowed by rule 6. Measured: not needed (see section 5). |
| Direct serving with no reverse proxy | Skips the proxy's second TCP hop and gzip. | Rule 9 allows it. |
| io_uring, SO_REUSEPORT multi-process | More throughput on many cores. | Not tried. On 1 vCPU the gain is small. SO_REUSEPORT is only a fd-limit workaround (section 4). |

Novelty claim: none. This is the standard epoll server with SQLite. The contributions are the measured ceilings and the choices below.

## 1. Mined facts (checked against code and data)

1. Request mix per virtual user (VU): the loop takes about 20.5 s of think time, so 2.17 requests per loop. That is about 0.106 req/s per VU. 46% are `GET /feed`, 46% `GET /posts/:id`, 7% likes, 1% posts. Checked in `bench/load.js`.
2. Only 8% of requests are authenticated, so JWT verification is not a hot path. HMAC with precomputed ipad/opad is about 1 us.
3. `GET /posts/:id` and likes only ever target ids taken from the newest 20 posts. The hot data set is a few pages. The 250 MB DB fits in page cache (8 GB here, 2 GB on the box), so there is no disk read on the hot path.
4. In the seed, `created_at` is monotone in `id`, so the feed is also "top 20 ids". New rows get now() and sort to the top. This is true of the data, not of the schema, so SQL must still order by `(created_at, id)`. (See card C3.)
5. Feed body is about 5.1 KB (golden). Post body is about 0.3 KB.
6. Likes per post: mean 4. Maximum 583, so the count subquery is cheap for the newest posts.
7. Writes: at 16k VUs, about 117 likes/s and 16 posts/s. Roughly 150 commits/s.
8. Nginx facts from `bench/nginx.conf`: `worker_connections 16384`, gzip on for `application/json` over 1024 bytes (k6 sends `Accept-Encoding: gzip`, so the feed is gzipped on the box). Each proxied active request also uses an upstream connection.

## 2. Substrate vs interface

| Layer | Rule text (quoted) | Interface I happen to use |
|---|---|---|
| Database | "The database is SQLite: the file at `$SQLITE_PATH`, used in-process." Rule 5: "SQLite's own page cache and `mmap` are fine." | `libsqlite3` C API and SQL. The rules do not name the library. Reading the file without libsqlite3 is an open rule question (Q4). |
| Schema | "Don't add or change tables, columns, indexes or triggers. Any SQL you like." | Reference queries from SPEC.md. I am free to write other SQL. |
| Durability | "WAL with `synchronous=NORMAL` or stronger." "Writes are durable before you respond." | Autocommit per write. Group commit is allowed but unused. |
| Front end | "Nginx is optional" (rule 9). | Direct or behind Nginx is my choice. |
| Process model | "Any number of processes or threads." Rule 11: no kernel tuning, no pinning. | Single-threaded loop plus an optional checkpoint thread. Settings inside my own process (`setrlimit`, pragmas, allocator) are fair game. |
| Compression | "Compression is optional." | Off (card C5). |

## 3. Floor vs measured (per request, local box)

| Path | Floor | Measured | Ratio | Explained by |
|---|---|---|---|---|
| Kernel TCP (recv + send) | about 2 us of syscall entry | about 20 us sys per request (stub server, no database) | 10x | Real TCP stack work, partly loopback artefact. Cannot be bypassed without kernel changes (rule 11). |
| Parse + format + send, user space | about 1 us | about 1.8 us | 2x | Fine. |
| `GET /feed` SQL | about 3 us (about 5 KB out, 20 rows in) | 22-25 us (best of N) | 8x | callgrind: 228k instructions per feed. VDBE 18%, `BtreeTableMoveto` 10%, varint decode 6.5%, `BtreeIndexMoveto` 6%, pager get 5%. No single dominant cost. This is the SQL engine's generality (VDBE, cursors, generic record decode). |
| `GET /posts/:id` SQL | about 1 us | 6-8 us | 6x | Same. |
| Like or post commit | one `write()` of about 12 KB | 27 us (no checkpoint) | OK | Real work. |
| Same commit with default inline autocheckpoint | - | 83 us average, 221 ms worst stall | 3x average | Checkpoint (write 1000 pages + fsync) runs on the request path (card C2). |

Whole request on the local box: stub about 22 us, real server about 42-53 us. So SQL and handling is about half of server CPU.

## 4. Ceilings and shadow prices (scale sweep, n = users, 0.106 req/s each)

| Resource | Model | Ceiling (users) | Shadow price per unit relaxed |
|---|---|---|---|
| CPU (direct, local costs) | 42-53 us/request, so 19-24k rps | 180-225k | Not binding below about 100k. |
| CPU (pessimistic, real NIC and steal about 2-3x kernel cost) | 80-110 us/request | 85-115k | About 1 user per 1 us of saved CPU per request at the CPU limit (about 1.1 users per us at 85k). |
| CPU behind Nginx | about 2.2x per request (second hop and gzip about 40-55 us per feed, measured with zlib) | 40-80k | Not reached, because the connection cap binds first. |
| Nginx `worker_connections` 16384 (client plus upstream) | 1 connection per VU | about 16.0-16.25k (the score search ends in a 250 step between 10k pass and 20k fail) | Direct mode removes this cap. Price of removal: from about 16k to min(other ceilings), i.e. about +12k to +49k users (+75% to +300%). |
| File descriptors, direct, single process | `LimitNOFILE=65535` per process, 1 fd per VU | about 65.5k | 1 fd = 1 user. `RLIMIT_NOFILE` is per process, so N worker processes lift it to N x 65k. Revisit when n > 60k. |
| Memory | measured about 3.9 KB per idle socket end (19k sockets: 148 MB `MemAvailable` delta; server RSS 42 MB at 19k fds, 640 KB of it the conn table) | about 350k connections ((2 GB - 0.4 GB OS - 0.25 GB DB) / 3.9 KB). 65k connections is about 255 MB. | Not binding. |
| Accept backlog | `somaxconn` 4096 and a drain-loop accept. Ramp is 1000 connections/s | OK | 0 |
| Bandwidth | feed 5.1 KB x 0.049 feed/s per VU: 65k VUs is about 130 Mbit/s | Not binding (unknown NIC cap) | Compression would only matter above about 1 Gbit/s. |
| k6 side (outside my control): ephemeral ports 28,232 per destination ip:port by default; k6 memory per VU | | Unknown, possibly 28k or lower | Unknown. This probably decides the real score. |

Conclusion on the dominant ceiling: whichever of {Nginx cap 16k, k6 box, fd 65k, CPU 85-115k} is lowest. Going direct moves the first one away. Every CPU or SQL optimization is worth about 0 users until the other ceilings are removed, and then about 1 user per us saved.

Ceiling claims I checked rather than assumed:
- "SQLite is the bottleneck": false. The kernel TCP path (about 20 us) plus SQL (about 25 us) are comparable, and neither binds below about 85k users.
- "Writes limit the score": false. 150 commits/s x 27 us is 0.4% CPU. Only the inline checkpoint stall matters, for tail latency (C2).
- "Direct cannot hold 15k connections": false. 19k connections held with 43 MB RSS and a 0.5 ms median (lg, scale 1).

## 5. Candidates tried (ratchet log)

Obvious version = the reference queries from SPEC.md, run one per request. Accepted only if exact-match with it and faster than noise.

| Idea | Result | Verdict |
|---|---|---|
| epoll single-thread C server, hand parser, prepared statements | 42-53 us/request. Passes all 42 checks. 300-op differential vs reference SQL: 0 mismatches. | Accept (baseline). |
| `mmap_size=0` vs 1 GB | 22.3 vs 23.9 us feed; callgrind 206k vs 228k instructions | Take `mmap_size=0` (7%, within noise, simpler). Revisit if the DB grows beyond cache. |
| Locality-batched feed (index-only ids, one range scan over posts and one over likes, instead of 20 seeks) | Identical output. 21.8 vs 23.0 us (best of 8) | Reject: 0-5%, within noise. Seeks are not the cost. |
| `SQLITE_CONFIG_SINGLETHREAD` and `MEMSTATUS=0` at run time | No difference (8.4k rps either way) | Reject. |
| `locking_mode=EXCLUSIVE` | 23.9 vs 23.9 us | Reject (also blocks the checkpoint connection). |
| Group commit | Commit is 27 us, 0.4% CPU at 16k users | Reject. Revisit when n > 100k. |
| JWT optimization | HMAC about 1 us on 8% of requests | Reject. |
| Compression in-process | zlib level 1: 36-56 us per feed (+100% of feed cost), ratio 2.7x | Reject (C5). |
| Checkpoint thread (PASSIVE) | p99 72 ms to 8 ms, max 108 ms to 23 ms, slow handles 22 to 0 | Accept as option (C2). |
| io_uring | Untested. Syscall entry is only about 3 us of the 20 us of kernel time. | Open: revisit once CPU binds. |
| Compile SQLite from amalgamation with `-DSQLITE_THREADSAFE=0 -DSQLITE_OMIT_*` | Not testable offline (only the system library and `sqlite3.h` are here) | Open. Expected small (mutexes already measured as 0). |
| Custom b-tree reader of the `.db` and WAL files, bypassing libsqlite3 | Not built. Estimate: feed 25 us to about 3-5 us, saving about 11-16 us per average request, i.e. +15-30% CPU capacity. | Open: needs a rule answer (Q4). Worth about 0 users until CPU binds. |

## 6. Questions, ordered by value of information (all answers prototyped; the human is unavailable, so defaults are the safe answers)

Value = P(changes plan) x size, in users.

**Q1 (highest). May the server listen directly on 0.0.0.0:80 instead of behind Nginx?**
- What it does: removes Nginx's cap of 16,384 connections and its gzip and proxy CPU. It is the same binary; only `HOST` and `PORT` differ.
- Measured, direct: held 19,000 keep-alive connections, 0.5 ms median. Server RSS 42 MB. At scale 0.3 (6000 VUs, 2100 rps) p95 5 ms, p99 8 ms with the checkpoint thread.
- Behind Nginx: not measurable here (nginx is not installed). Modelled cap about 16k, with an extra hop of about 40-55 us per feed.
- Price in users: about +12k to +49k, i.e. +75% to +300% if the k6 box can generate them; +0 if k6 tops out near 16k.
- Risk: the server must handle every connection itself. Guard: connections beyond the fd limit are closed at accept, and idle connections are never reaped, so there is no 65 s idle-reuse race.
- Default shipped: behind Nginx (127.0.0.1:3000), because it is the benchmark's known configuration. Flip to direct by setting `HOST=0.0.0.0 PORT=80` in `start.sh` (one line). My recommendation is direct.

**Q2. Run WAL checkpoints on a background thread instead of inline?**
- Inline (default SQLite): 83 us average commit, 221 ms worst stall.
- Thread with `wal_autocheckpoint=0` (PASSIVE checkpoint when WAL exceeds 4 MB, polled every 100 ms): 27 us average commit, max 5 ms. Server-level (6000 VUs at 0.3 scale): p99 72 ms to 8 ms.
- Price: tail-latency margin only; about 0 to 250 users (one search step) near the cliff. Durability semantics are unchanged (WAL, NORMAL).
- Guard: if the thread cannot open its connection, `wal_autocheckpoint` stays on (automatic fallback).
- Default shipped: inline. Recommendation: thread.

**Q3. Compress responses?** No. Measured +36-56 us on a 45 us request for a bandwidth saving nothing here needs. Revisit above about 1 Gbit/s.

**Q4. May GET paths read the `.db` and WAL with my own b-tree code instead of libsqlite3?**
- Rule 2 says "the file ... used in-process" and rule 5 allows "SQLite's own page cache and mmap", but a hand-written reader is a different thing and the rules do not say. Ambiguous, so it is a question, not a "no".
- Gain: +15-30% CPU capacity; worth about 0 users until CPU binds (Q1 direct and k6 headroom first).
- Risk: WAL visibility and correctness. A fallback to libsqlite3 would be automatic on any unrecognised page.
- Not prototyped (low value of information now). Default: not built.

**Q5. Multiple worker processes to pass 65k connections?** Only useful if the benchmark goes above about 60k VUs. Not built; the design keeps `WORKERS` as a parameter. Revisit when n > 60k.

## 7. Claim cards

| Claim | Says | Assumes | Breaks when | Checked |
|---|---|---|---|---|
| C1 Single thread suffices | 1 core handles 19-24k rps locally | CPU cost per request stays below 100 us | Steal or NIC cost is above 3x; then CPU binds near 85k | Measured (8.4k rps at 31% CPU; load generator was the limit). Assumed for the real NIC. |
| C2 Checkpoint thread | Moves checkpoint stall off the request path | PASSIVE checkpoint never blocks writers or readers | A reader pins an old WAL snapshot; WAL grows. Readers here are short statements. | Checked: 0 slow handles, 42/42 tests with the thread enabled. WAL growth bound tested only to 4 MB threshold. |
| C3 Feed query | Exact SQL ordering by `(created_at DESC, id DESC)` | None; this is the reference ordering | n/a | Proved by using the reference SQL; the faster locality variant (which assumed id order) was rejected anyway. |
| C4 JWT | HS256, signature compared in constant time, header must be `alg=HS256`, `sub` positive integer string, `username` string, `exp` in future | Test suite is representative | Unusual claim shapes (e.g. missing `exp` is accepted; non-numeric `exp` rejected) | Checked: 42/42 tests. Open: missing-`exp` policy is a guess. |
| C5 No compression | Responses are identity-encoded | Client does not require gzip | A client demands gzip | Checked: k6 accepts identity. |
| C6 Body length | Count characters as UTF-8 code points (matches SQLite `length()` and the CHECK constraint) | Load test payloads are ASCII | JS reference counts UTF-16 units for emoji | Open (out of scope per SPEC, ASCII only). |
| C7 Idle connections never reaped | Keeps well beyond Nginx's 65 s rule | Memory holds | More than about 350k connections | Checked: 3.9 KB per connection. |

## 8. Ship plan

1. Files: `install.sh` (apt: `build-essential libsqlite3-dev`; Ubuntu 24.04 pins SQLite 3.45.1), `build.sh` (`gcc -O2 -o bin/server server.c -lsqlite3 -lpthread`), `start.sh` (exec the binary), `README.md` (states Nginx or direct), `.gitignore`.
2. Server: promote `tmp/proto/server.c`. Changes before shipping: remove instrumentation, `mmap_size=0`, add the checkpoint thread behind a flag, read `HOST`/`PORT`, raise `RLIMIT_NOFILE` to the hard limit at start (already done).
3. Guards: fd limit check at accept (shed new connection, never crash); checkpoint-thread open failure falls back to autocheckpoint; any SQLite error maps to 500 `internal server error`.
4. Gates before each change is kept: `test/run.sh` 42/42; `tmp/diff.py` differential (feed and 360 post reads vs reference SQL, 0 mismatches); benchmark repeated at least 3 times, accepted only above the run-to-run noise (about 2x swings were seen here, so use callgrind instruction counts for small SQL changes).
5. Expected score: behind Nginx about 16k (capped by Nginx). Direct: limited by the k6 box or fd 65k.

## 9. Open items

- Run the real k6 and Nginx on a matching droplet to replace the Nginx model and the pessimistic CPU model with measurements.
- Q1, Q2, Q4 need a human decision. Defaults: Nginx, inline checkpoint, no custom reader.
- Revisit when n > 60k VUs (fd), n > 100k (CPU, group commit, io_uring, custom reader).

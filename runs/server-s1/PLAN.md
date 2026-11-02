# Plan: highest-scoring submission for the $12 Server Challenge

Verdict: submit a single-threaded C server (epoll + system SQLite), serving directly on 0.0.0.0:80 with no Nginx.
On this task's own load profile the server is nowhere near CPU-bound. The score is limited by connection count
(Nginx's 16,384 worker_connections, the 65,535 fd limit) and by the k6 machine, so the plan is to remove every
cap we control and keep per-connection cost tiny.

Prototype (passes test/test.sh 42/42): `proto/server.c`. Load generator I wrote to stand in for k6: `proto/lg.c`.
Working copies and the scratch DB copies are in /tmp/w. `seed/feed.db` was never opened for writing; every run used a fresh `cp`.

## Questions I would ask the user (unanswered; assumptions below)

1. Is C acceptable, or do you want the entry in a language like Rust or Go? (Assumed: any language is fine, rule 1, so C.)
2. If the author does not exist in `users`, should POST /posts still succeed? The feed's JOIN would then hide the post. (Assumed: tokens only ever name seeded users 1-20,000, so not handled.)
3. If a token has no `exp`, should it be accepted? (Assumed: yes, accept; only a past `exp` is "expired".)
4. What counts as whitespace when trimming a body: ASCII only, or Unicode like a non-breaking space? (Assumed: ASCII plus common Unicode spaces, as JavaScript's trim does.)
5. Is a crash of the whole machine allowed to lose the last few commits? (Assumed: yes. Rule 6 allows WAL + synchronous=NORMAL, which survives a process crash but not a power cut.)
6. Is it fine to depend on Ubuntu's `libsqlite3-dev` (3.45.1) rather than a downloaded SQLite amalgamation? (Assumed: yes. I had no internet to test an amalgamation build.)
7. May I add the machine's actual clock behaviour to the plan? Unknown: is the benchmark VM's clock later than the seed's last post (2025-12-31)? (Assumed: yes. Needed only for the rejected id-order shortcut.)

## Facts mined (always-true candidates), checked on the real seed copy

| # | Fact | Check |
|---|------|-------|
| F1 | `created_at` is non-decreasing in `id`, and all 500,000 values are distinct | Checked: window query returned 0 inversions; `count(distinct created_at)` = 500000 |
| F2 | Ids are dense 1..500000; users 1..50000 | Checked |
| F3 | Likes per post: avg 5.25, max 583 | Checked. Bounds the cost of `count(*)` per post |
| F4 | No seed body or username contains `"`, `\`, control or non-ASCII bytes | Checked (0 rows). Escaping can take a fast path |
| F5 | No seed body has leading or trailing whitespace | Checked |
| F6 | The 20-newest feed touches only ~87 like rows | Checked |
| F7 | Load profile: one VU is about 2.17 requests per ~21 s (GET feed, GET post, 15% like, 2% create) | Read from bench/load.js. At 15,000 VUs that is about 1,550 req/s; at 65,000 VUs about 6,700 req/s |
| F8 | Only 2 of ~2.17 requests per cycle are reads; writes are about 0.17 per VU-cycle (~125/s at 15k VUs) | Read from bench/load.js |

## Cheaper plans considered, and the cards

### Card 1: feed by id order instead of `created_at` order
Says: `ORDER BY id DESC LIMIT 20` gives the same 20 posts as `ORDER BY created_at DESC, id DESC LIMIT 20`.
Assumes: F1, plus new posts get a `created_at` no earlier than the newest existing one (clock never behind 2025-12-31 and never steps back).
Breaks when: the VM clock is wrong or steps backward, or two posts land in the same millisecond with ids out of order.
Checked: Checked on the seed. Measured gain 21 us to 17 us per feed query (about 4 us of ~60 us per request).
Decision: rejected. It saves about 1% of total CPU and adds a correctness risk. The obvious query stays. No guard needed because the shortcut is not shipped.

### Card 2: single thread, no locks
Says: one event-loop thread doing all reads and writes gives the same results as a thread pool, because SQLite serializes writers anyway.
Assumes: per-request work is small (measured 60 us average at saturation); only one process touches the DB file.
Breaks when: a single request blocks for a long time (a checkpoint fsync, a huge query).
Checked: Checked. Saturation was 16,000 req/s with p99 15 ms on one core. Worst stall seen was 34 ms (checkpoint). Rule 11 allows nothing about pinning, so I measured with `taskset` only to simulate one vCPU.
Guard: `busy_timeout=5000`; the server never holds a read transaction open between requests (statements are reset after each step).

### Card 3: direct on port 80, no Nginx
Says: serving 0.0.0.0:80 directly gives the same responses as behind Nginx and saves CPU and a connection cap.
Assumes: README rule 9; our server handles every open connection itself; `LimitNOFILE=65535` as stated in SPEC.md.
Breaks when: more than ~65,000 simultaneous VUs (fd limit), or if the platform does not grant `CAP_NET_BIND_SERVICE` (then fall back to HOST/PORT env as given).
Checked: Checked up to 19,000 connections (local hard fd limit is 20,000): server RSS 44 MB, no errors. Extrapolated to 65k: about 150 MB RSS plus kernel socket memory, well under 2 GB. Not checked beyond 20k.
Why it matters: the Nginx file sets `worker_connections 16384`. Each client uses one slot, and upstream connections use more, so behind Nginx the score is probably capped near 16k VUs by Nginx itself. Direct has no such cap.

### Card 4: WAL maintenance via a background checkpoint thread
Says: a helper thread running PASSIVE checkpoints keeps the WAL small and keeps fsync off the event loop.
Assumes: the WAL gets reset after each checkpoint.
Breaks when: writes arrive continuously (they do). WAL restart needs a moment with everything backfilled.
Checked: Broken. In a 45 s run at 15k VUs the WAL grew to 275 MB and never reset. At 40k VUs over a 5-minute hold this projects to about 1.6 GB, which risks the 2 GB box and slows every read.
Decision: use SQLite's built-in `wal_autocheckpoint=1000` on the main connection instead. WAL stayed at 4 MB, with a worst-case latency of 34 ms at 15k VUs. The thread code is kept behind an env flag only for experiments.

### Card 5: JSON escape fast path
Says: a body or username that has no `"`, `\` or control byte can be copied to the output without change.
Assumes: F4.
Breaks when: a user posts a quote, backslash, newline or other control character.
Checked: Checked. The server scans every string at runtime and escapes only when needed. This is the guard, and it is always on. Tested with quotes, backslashes, newlines, `é` and surrogate pairs (fuzz script in /tmp/w/fuzz.py).

### Card 6: JWT verification
Says: verifying HS256 with a precomputed HMAC key state gives the same accept/reject as a standard JWT library.
Assumes: the secret never changes during a run; the key-derived inner/outer SHA-256 states are not request data, so this does not break rule 5.
Breaks when: a token uses another algorithm in the header, a wrong length signature, or odd `sub` values.
Checked: Checked. Wrong secret, alg HS384, alg none, expired, `sub` as number, `sub` "0", non-string username all return the right error. Every request re-verifies its signature; nothing is remembered. Open: `sub` "007" is accepted as 7 (the spec does not say).

### Card 7: durability
Says: a 201 means the row is committed.
Assumes: WAL, `synchronous=NORMAL` (allowed by rule 6).
Breaks when: the whole machine loses power between commit and the next checkpoint (allowed loss under NORMAL).
Checked: Checked. 50 posts created, server killed with `kill -9`, reopened: all 50 present, integrity_check ok.

## Design

- `server.c`, about 330 lines: epoll, level-triggered, `accept4` loop, one `recv` into a shared 64 KB buffer. A per-connection buffer is allocated only when a request is split across packets, so an idle connection costs a 56-byte struct plus the kernel socket.
- Handles pipelining and split requests (tested byte-by-byte), `Connection: close`, partial writes (backlog buffer + EPOLLOUT). Idle connections are never closed by us, so Nginx-style 65 s keepalive is trivially met.
- Hand-written strict JSON validator (for "malformed JSON body"), SHA-256/HMAC, base64url. No dependencies except libsqlite3.
- SQLite: WAL, `synchronous=NORMAL`, `wal_autocheckpoint=1000`, `mmap_size=1 GB`, `temp_store=MEMORY`, prepared persistent statements. The obvious feed and post queries from SPEC.md are used unchanged (22 us per feed query, 5-7 us per post lookup measured).
- Writes run one at a time on the loop thread, each in its own implicit transaction. Group commit gave nothing to gain: about 125 writes/s and no fsync at commit under NORMAL.
- EMFILE handling with a spare fd so the accept queue drains; `RLIMIT_NOFILE` raised to the hard limit at start.
- Submission folder: `submissions/c-epoll-<github-user>/` with `install.sh` (apt `build-essential libsqlite3-dev`), `build.sh` (`gcc -O2 -o bin/server server.c -lsqlite3 -lpthread`), `start.sh` (`exec bin/server` with HOST=0.0.0.0 PORT=80 defaults overridable), README stating **direct, no Nginx**, `.gitignore` for `bin/`.

## Measurements (this 2-core box, server pinned to core 0, my C load generator on core 1, real think times unless "scale" noted)

| Run | Result |
|---|---|
| test/test.sh, fresh copy, repeated 12 times | 42/42 each time (once, one run hit the server before it was listening: 3/42; a poll on /health before testing fixes it) |
| ASAN+UBSAN build: test suite x3, split/pipelined requests, 25 hand-made edge cases, 300 random garbage requests | no sanitizer reports, server stayed up |
| 5,000 VUs, 1x time | 684 req/s, p50 0.3 ms, p95 3.0 ms, p99 4.5 ms, 0 errors; server CPU about 4% |
| 15,000 VUs, think times divided by 3 (4.7k req/s expected) | 7,291 req/s, p95 5.4 ms, p99 13 ms, max 34 ms, 0 errors; WAL 4 MB |
| 19,000 VUs, think times divided by 2 | 6,665 req/s, p95 5.4 ms, p99 13 ms, 0 errors; server RSS 44 MB, 19k sockets |
| Saturation: 5,000 VUs, think times divided by 20 | 16,100 req/s, p95 7 ms, p99 15 ms. Beyond ~24,000 req/s p99 passes 150 ms |

Reading: the real 5-minute hold at 65,000 VUs asks for roughly 6,700 req/s, about 40% of the measured ceiling. The server should
pass the latency and error thresholds up to the fd limit; the realistic cap is the k6 machine and the network, not this code.

## What is not measured (be honest)

- No k6, no DigitalOcean droplet, no Nginx. My load generator is a stand-in and shares one machine with the server; its latencies include client queuing.
- Local hard fd limit is 20,000, so 65,000 connections were never opened. Memory at that scale is extrapolated.
- Cold page cache on a fresh droplet: first requests read the 250 MB DB from disk. A warm-up read of the DB file at start is allowed (it is SQLite's own page cache) but I did not add or time it. Open.
- Disk fsync speed on DigitalOcean is unknown; checkpoint stalls there may exceed the 34 ms seen here (p99 limit is 1 s, so there is headroom).
- One unexplained early test failure (13 passes, then connection resets) on the very first run; I could not reproduce it in 12+ later fresh runs, ASAN runs included. Treat as Open until CI runs it.
- Bodies larger than 4 KB of whitespace-padded text are rejected as "too long" instead of being trimmed first. Out of scope (spec: bodies over 16 KB are untested), but it differs from a strict reading.

## Next steps

1. Create the submission folder from `proto/server.c` and the three scripts; run `test/run.sh` on it.
2. Add a startup `/health`-ready check and, if time allows, a one-pass read of the DB file for warm cache.
3. Replace my stand-in with real k6 runs if k6 becomes available; try 2,500, 5,000, 10,000, 20,000, 40,000 VUs.
4. Optionally test a pinned SQLite amalgamation build (`-DSQLITE_THREADSAFE=0 -DSQLITE_DEFAULT_MEMSTATUS=0`) for a small CPU gain.

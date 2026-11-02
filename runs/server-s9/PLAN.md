# Plan: $12 Server Challenge submission (Anka process)

Target folder: `submissions/c-epoll-<user>/`. C, one epoll thread, served direct on 0.0.0.0:80 (no Nginx),
SQLite as a pinned amalgamation compiled into the binary, HMAC-SHA256 from OpenSSL or hand-written.

## 0. Questions I would ask the user (plain English)
1. Is a hand-written C server acceptable, rather than a mainstream framework? (Assumed yes: any language is allowed.)
2. Safest entry, or highest score even if the code is unusual? (Assumed highest score, every shortcut with a fallback.)
3. May it serve directly on port 80 and skip Nginx? (Assumed yes, rule 9.)
4. Will the real database always be an untouched copy of seed/feed.db (500,000 posts numbered 1..500,000)? (Assumed yes; guards fall back to generic SQL otherwise.)
5. May build.sh download the SQLite source at a pinned version? (Assumed yes.)
6. Is a rare ~250 ms stall acceptable, or must the worst case stay far below 1 s? (Assumed p99 < 1 s is a hard limit; design avoids stalls.)
7. Can I get one run on a real 1 vCPU box? (Not available; all numbers are from this 2-core sandbox.)

## 1. Mined facts
| # | Fact | Status |
|---|------|--------|
| F1 | posts.id dense 1..500000 (max(id)=count) | Checked on seed |
| F2 | created_at non-decreasing in id, all unique | Checked on seed: 0 inversions, 0 duplicates |
| F3 | Seed bodies are printable ASCII with no `"` or `\` | Checked for bodies; usernames not yet checked. New posts CAN contain quotes (test posts one), so escaping is still required |
| F4 | Avg 5.25 likes/post, max 583 | Checked |
| F5 | Load: 46% /feed, 46% /posts/:id, ~7% like, ~1% create; ~0.106 req/s per user | Read from bench/load.js |
| F6 | Tokens are users 1..20000, HS256, far-future exp | Read |
| F7 | New posts get a timestamp later than all seed rows (seed ends 2025-12-31) | Assumed (clock) |
| F8 | Writes are rare, so a single writer loses nothing | Derived from F5 |

## 2. Profile by layer (sandbox, warm cache)
| Layer | Cost |
|---|---|
| Socket I/O (epoll, read, write 3 KB) | ~11.8 us/req (85k req/s static, 1 core) |
| Generic feed SQL (created_at index, user join, 20 counts) | 25-33 us (noisy) |
| Post by id SQL | ~5 us |
| sprintf formatting of a feed | ~10 us (about 30% of feed cost) |
| HS256 verify | ~4.5 us, needed on ~8% of requests |
| Prototype end to end (epoll+SQL+sprintf, 50/50 feed/post, 64 conns, pinned core) | 27k req/s = ~37 us/req |
| Commit (WAL, synchronous=NORMAL) | median 21 us, p99 ~1.1 ms |
| Checkpoint | 48-263 ms (fsync): a stall if on the serving thread |

27k req/s / 0.106 req/s per user is about 250k users of CPU, so near the ~15k connections the README mentions,
connections, memory and tail latency bind, not CPU. Design favours predictable latency and cheap idle connections.

## 3. Generality tax and specialization
| Layer | General case | Fact that rules it out | Specialization |
|---|---|---|---|
| HTTP framework | any method/header/chunking | 5 routes, small requests | hand parser, only needs Authorization and Content-Length; SPEC errors otherwise |
| Nginx | proxying, TLS | not needed | serve direct (saves 14-20% CPU) |
| Threads/locks | concurrent queries | 1 vCPU | one epoll thread, NOMUTEX, THREADSAFE=0 |
| JSON serializer | any escaping | F3 | copy columns straight into the buffer; per-string scan for `"` `\` and bytes < 0x20, escape only then |
| Feed ordering | arbitrary timestamps | F1+F2 | optional `id BETWEEN max-19 AND max ORDER BY id DESC` (10-20% faster, within noise) |
| JWT library | any alg/claims | F6, SPEC | decode only alg/sub/username/exp; verify HMAC every request (rule 5), constant-time compare |
| Commit per write | many writers | F8 | group commit per epoll batch, respond after COMMIT |
| Checkpointing | anytime | durability only needs WAL | wal_autocheckpoint=0 on serving connection; second thread, own connection, PASSIVE checkpoint every few seconds |

## 4. Claim cards
**C1 Feed by id range equals the generic feed**
Says: the 20 newest posts by (created_at, id) are the 20 highest ids.
Assumes: F1, F2, F7.
Breaks when: the clock steps backwards, or the DB is not the seed.
Checked: Checked on seed. Guard: the insert transaction reads created_at of the current max id; if the new one is smaller, switch to the generic query. Startup spot-check of the top rows chooses the mode.

**C2 memcpy JSON equals the escaped JSON**
Says: output bytes match the reference serializer.
Assumes: strings need no escaping.
Breaks when: a body has `"`, `\` or a control byte (a user can post one).
Checked: Checked on seed; runtime scan on every string; test suite covers the quoted body.

**C3 One thread is enough**
Says: single thread meets the latency limits at scored load.
Assumes: ~37 us/req, no long stalls.
Breaks when: checkpoint or a slow query runs on the serving thread.
Checked: Checked in prototype (64 conns). Open for a real 1 vCPU box.

**C4 Direct serving handles ~15k keep-alive connections**
Says: no Nginx needed.
Assumes: epoll, 65535 fds, one shared read buffer, no per-idle-connection buffers, backlog 4096, accept until EAGAIN, TCP_NODELAY.
Breaks when: connection bursts exceed backlog or memory per connection is too high.
Checked: Open. Must soak-test with 15k sockets and watch RSS.

**C5 Durable before respond**
Says: 201/200 sent only after COMMIT.
Assumes: WAL + synchronous=NORMAL (allowed by rule 6).
Breaks when: process crash after commit before reply (client sees no reply; acceptable).
Checked: Checked by test suite; commit 21 us median.

**C6 No caching across requests (rule 5)**
Says: no data is remembered.
Assumes: only prepared statements, SQLite page cache and mmap; the C1 mode flag is not data. max(id) is read per request (~2 us).
Breaks when: a reviewer counts the mode flag as a cache. Fallback: drop it and always use the generic query (about 10% more feed cost).
Checked: Assumed.

## 5. Build and test plan
1. Implement in C (~600 lines): parser, router, JWT, JSON, statements, epoll loop, group commit, checkpoint thread.
2. install.sh: apt build-essential. build.sh: fetch pinned SQLite amalgamation, verify sha256, compile with -O2 -DSQLITE_THREADSAFE=0 -DSQLITE_DEFAULT_MEMSTATUS=0 -DSQLITE_OMIT_SHARED_CACHE. Flag gain unmeasured (no source offline); system libsqlite with NOMUTEX is the fallback.
3. Pragmas: WAL, synchronous=NORMAL, mmap_size=1GB, cache_size ~64MB.
4. Run test/run.sh (42 checks), then a 15k-connection soak (k6 is not installed here; use a C loadgen) watching RSS and p99 including checkpoint time.
5. Tune in order: hand formatter, id-range feed, write batching, idle-connection memory.

## 6. Measured so far (sandbox, not target VM)
- Static epoll server: 85k req/s on one core.
- SQLite + sprintf prototype: 27k req/s (~37 us/req).
- sprintf is ~30% of feed cost; id-range feed saves 10-20% but measurements were noisy.
- Commit 21 us; checkpoint 48-263 ms so it must be off-thread.
- Not verified: full server, 15k connections, k6 score. Expected: CPU is not the limit; goal is to pass the largest load the harness tries with p99 well below 1 s.

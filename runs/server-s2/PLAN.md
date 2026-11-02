# Plan: $12 Server Challenge submission (Anka process)

## 0. Questions I would ask the user (unanswered; assumptions below)
1. Is it acceptable to serve directly on port 80 (no Nginx), accepting that we then must handle ~15,000 keep-alive connections ourselves? (Assumed: yes.)
2. Is a C submission (hand-written epoll server, system libsqlite3 or pinned amalgamation) fine, or do you want a mainstream language/framework? (Assumed: C, maximum score is the goal.)
3. Do you want to put your own GitHub username in the folder name `submissions/c-epoll-<username>`? (Assumed: placeholder `<username>`.)
4. Are you OK with me not being able to run the official k6 benchmark? k6 is not installed here and I cannot use the internet, so the final score is modelled, not measured. (Assumed: yes.)
5. Is the benchmark clock trusted to move forward (no clock going backwards during the run)? Affects fact F2. (Assumed: yes, and we guard anyway.)

## 1. Facts mined (checked on a COPY of seed/feed.db at /tmp/w/feed.db; original untouched)
| # | Fact | Evidence |
|---|---|---|
| F1 | 500,000 posts, ids 1..500000 contiguous; 50,000 users; 2,016,005 likes; max 583 likes per post | sqlite3 queries |
| F2 | In the seed, posts.id order equals created_at order (0 inversions) and created_at is unique (0 duplicates) | window-function query |
| F3 | All created_at match the wire format exactly (0 bad) | glob check |
| F4 | All seed bodies are printable ASCII with no `"` or `\` (0 need JSON escaping); length 14..329 | query |
| F5 | The feed query already plans as a scan of the covering index `posts_created_at_id_idx` (no sort) | EXPLAIN QUERY PLAN |
| F6 | Load shape (bench/load.js): per user ~0.1 req/s, 50% feed, 50% post read, 15% of cycles like, 2% of cycles post. So at 15k users: about 1,500 reads/s and about 25 writes/s | read from load.js |

## 2. Measured (Python sqlite3 on this box, 2 vCPU, copy of the seed)
| Operation | Cost |
|---|---|
| GET /feed (spec query, 20 rows, with joins and like counts) | 68 us; 50 us with mmap + 200 MB page cache |
| GET /feed ordered by id instead (the F2 shortcut) | 68 us (no gain) |
| GET /feed with LIMIT subquery then join | 84 us (worse) |
| GET /posts/:id, random ids | 8.8 us; 6 us with mmap |
| INSERT post, own WAL transaction, synchronous=NORMAL | 127 us |
| INSERT like, own transaction | 95 us |

Python overhead is included in all of these, so a C driver should be a bit faster.

## 3. Design
- Language: C, single process, single thread, epoll (edge-triggered), nonblocking sockets, no per-request allocation (preallocated per-connection 4 KB buffers; 15k connections is about 60 MB, well inside 2 GB).
- Direct on 0.0.0.0:80 (README rule 9; saves the 14-20% Nginx CPU). Idle connections are never closed by the server (the limit is 65s+ anyway).
- SQLite: one connection, WAL, synchronous=NORMAL, mmap_size ~1 GB (the DB is 250 MB), page cache 200 MB, prepared statements reused (allowed by rule 5; no data caching). Use `sqlite3_stmt` bindings, pinned SQLite amalgamation downloaded in build.sh at a pinned version.
- JWT: verify HS256 on EVERY request (own SHA-256/HMAC or libcrypto), as rule 5 requires. About 1-2 us.
- Hand-built JSON straight from sqlite3_column_text into the output buffer.
- Writes: executed inline on the loop thread, each in its own transaction (about 25/s, about 0.3% CPU). Group commit is not worth the complexity. A 201 is sent only after COMMIT returns.
- Auth check first, then id validation, then body validation, exactly per SPEC order. Body trim and 500-character limit counted in characters (UTF-8 aware), not bytes.

## 4. Anka cards
**Card A: no shortcut for /feed**
Says: Order the feed by id instead of created_at to skip the index.
Assumes: F2 (id order equals created_at order, forever).
Breaks when: a post is inserted with a clock earlier than an existing created_at.
Checked: Checked (measured 67.7 us vs 68.4 us, no gain). REJECTED: no benefit, so we keep the exact spec query and need no guard.

**Card B: JSON escape fast path**
Says: Copy body bytes straight into the response without escaping.
Assumes: F4 (no `"`, `\`, or control chars in bodies).
Breaks when: a user posts a body containing a quote or non-ASCII text (the test suite does: `"quoted"`, `café ✓`).
Checked: Checked on seed (0 of 500k need escaping); Broken for new rows.
Guard: a single byte scan of each body for `"`, `\`, <0x20, and >=0x80; if any is found, take the full escaper. The result is byte-identical either way. Cost is about 50 ns per body.

**Card C: like_count by index count**
Says: `count(*)` over likes_post_id_idx is correct and cheap.
Assumes: F1 (max 583 likes per post; the index is covering).
Breaks when: a post has millions of likes; the load test adds only about 4 likes/s in total.
Checked: Checked (feed 68 us including 20 counts). No guard needed (it is the spec's own definition, so it is always exact).

**Card D: single thread is enough**
Says: One thread handles the benchmark load on 1 vCPU.
Assumes: F6, per-request CPU of about 15-30 us (HTTP) plus 6-68 us (SQLite).
Breaks when: a write blocks the loop (checkpoint stall) and tail latency exceeds 1 s.
Checked: Assumed (model only, k6 unavailable). Mitigation: wal_autocheckpoint kept small (~1000 pages) so no big checkpoint stall, plus a runtime guard: SQLITE_BUSY is retried with sqlite3_busy_timeout(2000), and an error becomes 500, never a wrong body.

**Card E: no caching across requests**
Says: Nothing but SQLite's page cache and mmap holds data between requests.
Assumes: rule 5.
Breaks when: someone adds a response cache. We do not.
Checked: Proved by design (no data structure holds row data beyond the response buffer).

**Card F: 15k direct connections**
Says: epoll with small per-connection state handles ~15k+ keep-alive sockets.
Assumes: LimitNOFILE=65535 (given in SPEC); accept backlog >= 4096.
Breaks when: the ramp opens many connections at once and the backlog overflows.
Checked: Assumed. Guard: on EMFILE, close one idle connection rather than crash; listen(fd, 4096).

## 5. Expected result (modelled, not measured)
Per request CPU is about 25 us (HTTP) + average ~40 us (SQLite) = ~65 us, so about 15,000 req/s at 100% of one core. Users generate about 0.1 req/s each, so the CPU would allow roughly 100k+ users. The real ceiling will be set by connection handling, kernel and network overhead, the 2 GB limit, and the 1 s p99 tail under bursts, so I expect the realistic score to be in the tens of thousands of users, and will report 15k as the only number I have a reason to trust. This is an estimate. I could not run k6.

## 6. Verification steps (before submitting)
1. Build, then `bash test/run.sh submissions/c-epoll-<username>` and require 42/42.
2. Write a small C or Python load generator that holds N keep-alive sockets with the load.js think times, to check memory and p99 at 15k and 30k connections.
3. Diff `/feed` and `/posts/:id` output against sqlite3 CLI JSON for 1,000 random ids (byte-exact).
4. Test the Card B guard with quotes, backslash, control characters and UTF-8.

## 7. Status
Plan only; no server written. Measured: the 11 numbers in section 2 and facts F1-F5. Not measured: HTTP layer cost, end-to-end capacity.

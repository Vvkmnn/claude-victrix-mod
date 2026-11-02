# Plan: highest-scoring submission for the $12 Server Challenge (Anka process)

Prototype: `/home/claude/srv/s13/tmp/proto/server.c` (about 330 lines of C, passes 42/42 of `test/test.sh`).
Load generator: `tmp/proto/lg.c` (closed-loop clone of `bench/load.js`, scaled think times).
Micro-benchmarks: `tmp/fb*.c`. All numbers come from this 2-core, noisy sandbox (+-20%), not the target droplet.

## Questions I would ask (ranked by how much the answer changes the plan)
1. May I serve the internet directly on port 80 instead of behind your Nginx? Gain: removes a proxy hop and Nginx's gzip, which costs about 70 us per feed response, more than our entire handler (measured with zlib level 1). Risk: we must handle up to ~15k open connections ourselves. Fallback: `HOST/PORT` env vars also work behind Nginx on 127.0.0.1:3000, so this is a one-line switch.
2. Is it OK to ship C (epoll, system SQLite 3.45.1 from apt, OpenSSL SHA-256 for the JWT check) rather than a framework? Gain: roughly 40 us of CPU per request. Risk: more code to review, and memory-safety bugs are possible. I fuzzed the parsers lightly and the request path uses bounded buffers.
3. Is a 500-character limit counted in Unicode characters (what SQLite's `length()` and the schema CHECK count) or in UTF-16 units? The load test sends ASCII only. I assumed characters.
4. Is "reads the database file's pages directly, skipping the SQL engine" acceptable? Rule 2 says SQLite "used in-process". I did NOT do it (see Section 3: it would only save about 15 us at a load the server already handles), so this question is low priority.

## Assumptions made (user unavailable)
- Direct on `0.0.0.0:80`; README says so (rule 9).
- Missing `exp` in a JWT is accepted; a non-numeric `exp` is rejected. Chunked request bodies get a 400 (out of scope; k6 sends Content-Length).
- Ids with leading zeros ("007") are accepted as 7. `/posts/` with an empty id is a 404.
- Characters are counted by code point. Trimming is ASCII whitespace.

## 1. Mined facts (checked on the real seed)
| Fact | Check | Result |
|---|---|---|
| Newest-by-`(created_at,id)` equals newest-by-`id` in the seed | scan of the index, ids strictly increasing | true (0 inversions in 500,000 rows) |
| Timestamps are all `YYYY-MM-DDTHH:MM:SS.mmmZ` | glob over all rows | 0 violations |
| Seed bodies have no quotes, backslashes, control chars, non-ASCII | glob | true (new posts can, so output is always escaped) |
| Max like count per post is small (avg 5.25, max 583) | group-by | true |
| Whole DB is 249 MB, fully fits in RAM next to 2 GB | `dbstat` | true |
| Load is about 0.106 requests/s per VU (about 2.17 requests per ~20.5 s cycle) | read `load.js` | 15k VUs = about 1,600 rps; 28k VUs = about 3,000 rps |
| Only 20,000 tokens, VU i uses token (i-1) mod 20,000 | read `load.js` | fine; username is taken from the token, never looked up |
| Writes are rare: 0.15 likes + 0.02 posts per 20 s per VU | `load.js` | about 170 commits/s at 28k VUs |
| New posts always sort to the top (clock is later than all 2025 data) | seed ends 2025-12-31 | true while the clock is monotone |

## 2. Substrate vs interface
| Layer | What a rule names (fixed) | The interface I would habitually use (not fixed) |
|---|---|---|
| Storage | Rule 2: "The database is SQLite: the file at `$SQLITE_PATH`, used in-process". Rule 3: schema fixed, "Any SQL you like". Rule 5: no caching across requests. Rule 6: WAL, `synchronous=NORMAL` or stronger | ORM or driver defaults, one query per request, 2 MB page cache |
| Network | Rule 9: "Nginx is optional ... or serve the internet directly on 0.0.0.0:80" | Nginx plus a framework |
| Language | Rule 1: "Any language, framework, runtime and SQLite driver/binding. Any number of processes or threads" | A managed runtime with a thread or event pool |
| Compression | SPEC: "Compression is optional" | Nginx gzip (on by default in `bench/nginx.conf`) |
| Feed ordering SQL | SPEC: "the 20 newest posts, ORDER BY created_at DESC, id DESC" | Using exactly that SQL, which walks the index and then seeks the table 20 times |

Only the left column is fixed. Direct serving, raw epoll, a hand-written HTTP parser, SQL shape, and the pragma values are all habits.

## 3. Speed-of-light floor vs measured
| Hot path | Floor (estimate) | Measured here | Ratio | Explained by |
|---|---|---|---|---|
| `GET /feed` SQL (20 posts, 20 users, 20 like counts) | about 50 page touches, about 6 KB copied: 3-5 us | 24-45 us (noisy; best runs 23-25) | 6-8x | Callgrind: about 194k instructions per query. VDBE interpreter 21%, table seeks 10%, varint decode 8%, index seeks 7%, record compares 9%. Real per-row work, not I/O. |
| `GET /posts/:id` SQL | 3 page touches: under 1 us | 5.9-8 us | 6-8x | Same: VDBE plus 3 b-tree descents |
| Whole request, user + kernel | about 10 us (epoll, recv, send syscalls plus loopback) | 43 us avg (25 user, 18 sys) | 4x | About 20 us SQLite, about 18 us kernel TCP, about 5 us parse, JWT and JSON |
| Whole request behind Nginx with gzip | n/a | add about 70 us gzip on feed plus a second hop | 2-3x worse than direct | Nginx's gzip config in `bench/nginx.conf` |
| Server CPU at 15k VUs (real-time think times) | n/a | 6.5% of one core (4.26 s CPU over a 65 s run that includes the ramp) | n/a | The server is idle 93% of the time |

Descent: the 6-8x SQL gap is the SQL interpreter and b-tree code, which is real work for what SQL is asked to do. Skipping it by parsing the file format myself (WAL-aware) would save at most about 15 us per request, about 1/3 of CPU that is already 93% idle. It needs a WAL reader that must agree with SQLite's own, and it risks violating "used in-process". Rejected; recorded as Open question 4.

What the descent found below the obvious interfaces:
- `mmap_size` and a bigger page cache gave no gain (23.7 vs 24.9 us); the working set is hot after the first request. I still set `cache_size` to 64 MB.
- Behind Nginx the dominant cost is Nginx's gzip of every 5 KB feed response, not our code.
- With a checkpoint helper thread alone, the WAL never reset and grew about 1.3 MB/s (68 MB after 65 s). A PASSIVE checkpoint never sees a quiet moment, so writers never restart the log. Letting SQLite's own autocheckpoint run in the writer fixes it (WAL stays at 4 MB). The stall is roughly 100-270 ms worst case on this box, inside the 1 s p99 budget. Thread + autocheckpoint together measured the same.
- Practical ceiling is not CPU. Default Linux `ip_local_port_range` is 32768-60999 (about 28k ports) per source IP and destination, and `somaxconn` is 4096 here. Both belong to the load machine and the OS, and rule 11 forbids tuning them. So the score is bounded by the harness; the job is to never be the reason a run fails.

## 4. Generality tax and abductions
| General case | Why it does not apply | Specialization | Guard and fallback |
|---|---|---|---|
| Feed ordered by `(created_at, id)` index then 20 table seeks | id order equals that order in the seed, and every insert we make is at max id with `now` | `ORDER BY p.id DESC LIMIT 20` walks the table directly | At startup, scan the index once (about 0.3 s total start-up) and require ids strictly increasing. On each insert require `created_at >= last` and `id > max`. `PRAGMA data_version` per feed detects any foreign writer. Any violation sets `mono=0` forever and uses the exact spec SQL. Verified feed equals the reference query byte for byte after inserts with quotes, backslashes, newlines, and unicode escapes. |
| Generic HTTP server (routing, headers map, chunking) | only 5 routes, fixed header set | Hand parser that scans for 5 headers | Unknown or chunked input gets 400; bad paths get the exact 404 body |
| Full HMAC library call per request | secret is constant | Precompute HMAC inner and outer SHA-256 states once, copy per request (4 compressions) | Signature is still verified on every request (rule 5); constant-time compare |
| Nginx gzip | compression optional | Direct serving, no compression | `HOST`/`PORT` env make Nginx mode a config change |
| Multi-thread server | 1 vCPU; load is 7-13% of a core | Single-thread epoll loop; no locks on the DB | Checkpoint helper thread available but off |

Measured gain of the feed specialization: unclear, 5-20% with this machine's noise (A 32-45 us vs B 27-41 us). It is cheap and guarded, but not a headline.

## 5. Candidate designs scored (correctness vs reference, then benchmark)
| Design | Correct | Result |
|---|---|---|
| Spec SQL, index order (A) | reference | 33-45 us |
| Rowid order + join + correlated subquery (B), guarded | byte-equal to A | 27-41 us |
| Rowid order, then one `GROUP BY` range scan over `likes` (C) | same counts | 25-40 us, within noise of B; not adopted (extra code) |
| Likes range scan alone for 87 rows | n/a | 9.5-13 us, about 110 ns/row VDBE overhead |
| `mmap` 1 GB, or cache 200 MB | n/a | no gain |
| Helper checkpoint thread only | n/a | WAL unbounded; rejected |
| Autocheckpoint (1000 pages) in the event loop | bounded WAL 4 MB | adopted; p99 18 ms, max 265 ms at real-time rates |

## 6. Cards
**Card 1: feed by rowid.** Says: `ORDER BY id DESC LIMIT 20` equals the spec feed. Assumes: ids and timestamps increase together. Breaks when: the clock steps backward, or another process writes. Checked: Proved for the seed by full index scan (0 inversions); runtime guards listed above; byte-equality test after inserts. Open: behaviour after a large real-world clock step is covered by the guard but not exercised.

**Card 2: direct on port 80.** Says: removes proxy hop and gzip. Assumes: bench box lets the service bind 80 (spec grants `CAP_NET_BIND_SERVICE`). Breaks when: more than ~15k connections stress our epoll loop. Checked: 15,000 simultaneous connections locally, 0 errors, RSS 46 MB. Open: not verified at 28k+ because this sandbox caps open files at 20,000 per process.

**Card 3: WAL durability.** Says: 201 means committed in WAL with `synchronous=NORMAL`, which rule 6 allows. Assumes: autocommit per write is acceptable (group commit unnecessary at about 170 commits/s). Breaks when: an fsync stall exceeds 1 s on the real disk. Checked: stalls of 100-270 ms here. Open: real droplet disk latency.

**Card 4: JWT.** Says: signature verified on every request, HS256 only, `exp` checked, payload validated. Assumes: header JSON has `alg` equal to `HS256`. Checked: all 42 test checks including `alg=none`, expired, bad signature, bad `sub`, missing username. Open: tokens with fractional or very large `exp`.

**Card 5: JSON bodies.** Says: bodies decode `\uXXXX` and surrogates, are trimmed, stored as UTF-8, and re-escaped on output. Checked: round trip with quotes, backslash, newline, tab, accents, emoji. Open: UTF-16 vs code-point length for the 500 limit (question 3).

## 7. Deliverable layout (to create when approved)
`submissions/c-epoll-<github-user>/`: `install.sh` (apt: build-essential, libsqlite3-dev, libssl-dev), `build.sh` (`gcc -O2 -o bin/server server.c -lsqlite3 -lcrypto -lpthread`), `start.sh` (`exec bin/server`), `README.md` (direct on 80, optimizations above), `.gitignore` (`bin/`). Dependencies are the distro's pinned 3.45.1 and OpenSSL 3.0; no downloads.

Possible small further wins, all optional because CPU is 93% idle: batch the writes seen in one epoll tick into one transaction; compile SQLite from the pinned amalgamation with `-O3 -DSQLITE_THREADSAFE=0 -DSQLITE_DEFAULT_MEMSTATUS=0` (expected 10-20% of the SQLite share; not measurable here without the source).

## 8. End-to-end measurements
- `test/test.sh`: 42 passed, 0 failed.
- Start to healthy: 0.3 s (includes the monotonic-order scan).
- 15,000 connections at real-time think times, 65 s: 0 errors, p50 0.27 ms, p95 1.4 ms, p99 10 ms (18 ms in the autocheckpoint run), max 54-265 ms; server CPU 6.5% of one core; RSS 46 MB; WAL held at 4 MB.
- Saturation test (1,000 conns, think times /50): 4,915 rps with the load generator sharing the 2 cores; server cost 43 us per request, so about 23k rps per core in isolation.
- Not measured: real k6, the real droplet, more than 20k connections, and actual Nginx.

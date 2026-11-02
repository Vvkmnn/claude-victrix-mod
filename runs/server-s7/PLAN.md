# Plan: $12 Server Challenge submission (Anka process)

## Verdict
Write the server in C: one epoll thread, raw sockets, SQLite 3.45 linked in-process, served directly on 0.0.0.0:80 (no Nginx).
The score is the number of concurrent users that pass, and on 1 vCPU that is set by the cost of the HTTP and connection layer,
not by SQLite. Nginx takes 14-20% of the CPU. The one expensive query, `/feed`, is already near its floor.

## Questions I would ask (plain English)
1. Is "highest score" worth a hand-written C HTTP server, or must the code look like a normal framework app a maintainer can read?
2. May it run without Nginx and take on up to ~15,000 open connections itself? (The README allows this.)
3. Is a C toolchain from apt (gcc, libsqlite3-dev) acceptable, or must SQLite be pinned from the official source tarball? (I assume the pinned tarball.)
4. Do you want a second, boring fallback submission (Go or Rust) kept alongside it in case the C server fails CI?
5. Is it acceptable that a clock set backwards makes `/feed` slower (the guard below) rather than failing?

## Assumptions (stated because nobody could answer)
1 yes (speed first, readable C); 2 yes, direct on :80; 3 pinned amalgamation built in build.sh; 4 no, one submission; 5 yes.

## Facts mined (all checked on a copy of seed/feed.db, tmp/w.db)
- F1. Seed posts: ids 1..500000, `created_at` is strictly increasing with id. 0 inversions, 0 duplicate timestamps. Max is 2025-12-31, so any new post (default clock, 2026) sorts after every seed post. Checked (SQL).
- F2. All timestamps are already in exact wire format (re-formatting with strftime changes 0 rows). Checked.
- F3. No seed body or username contains `"`, `\`, control or non-ASCII characters. Checked (SQL glob). User input can, so escaping stays on the write path.
- F4. Likes per post: avg 5.3, max 583. The newest posts have at most ~18. `like_count` through `likes_post_id_idx` is a short covering scan. Checked.
- F5. The load test only does unauthenticated reads (`/feed`, `/posts/:id`) plus ~15% likes and ~2% posts. The id it reads always comes from the current feed, so it is one of the 20 newest posts (hot pages). Read from bench/load.js.
- F6. Offered load is about 2 requests per 20.5 s per user, so 20k users is about 2k req/s. At about 50 us of CPU per feed request, SQLite is ~10% of one core. Connections and syscalls dominate. Derived.

## Profile by layer (measured here, C and Python, 2 vCPU dev box, warm cache, mmap on)
| Layer | Cost |
|---|---|
| `/feed` query (index scan, 20 x join users, 20 x count subquery) plus C formatting of 5.1 KB | 65 us (Python, no formatting, 54 us) |
| `/posts/:id` hot / random id | 6.4 us / 12.6 us |
| HMAC-SHA256 verify of a JWT (OpenSSL one-shot) | 10.5 us, and only on POSTs (~2% to 15% of users) |
| `nolikes` variant | not faster (68 us, noise), so the like subquery is not the cost |
| `ORDER BY id` rewrite, or `id > max(id)-20` rewrite | not faster (94 / 112 us); rejected |
| Nginx, TCP and HTTP parsing, syscalls | not measured here. No k6/wrk and no Nginx. Open. |

## Generality tax and specialization
- Web framework and router: handles arbitrary routes, methods and headers. Fact: 5 fixed paths. Replace with a hand-written parser that matches the path with memcmp, reads only `Authorization` and `Content-Length`, and rejects the rest. Fallback: return 404/400 per SPEC for anything it does not recognise.
- Nginx proxy: buys protection against slow clients and gzip. Fact: the load test is keep-alive and the responses are small. Bypass it. Guard: idle timeout above 65 s, a connection cap (~20k fds, per-connection buffers about 8 KB), and refusal with 503 rather than OOM.
- JSON library: handles arbitrary values. Fact: the output shape is fixed and F3 holds for seed data. Write responses with a hand-rolled writer; escape on output with a per-string check (a fast path when all bytes are safe, a full escaper otherwise). Same bytes as `jq`/golden. The parser for the POST body accepts only a top-level object with a `body` key and falls back to a full (general) JSON string decoder for escapes and `\u` sequences.
- Generic query planner: `/feed` could use an id-based query given F1, but I measured no win, so I do not specialize it. The tax here is negligible and removing it risks wrong results. Decision: keep the exact SPEC query, prepared once per connection to the single DB handle.
- Thread-per-connection or worker pools: not needed at 1 vCPU. One thread means no locking and no SQLite mutex (`SQLITE_THREADSAFE=0`, `SQLITE_DEFAULT_MEMSTATUS=0`, `SQLITE_OMIT_SHARED_CACHE`). Writes happen inline on the same thread, so group commit is natural (batch all writes seen in one epoll round into one transaction, answer after COMMIT).
- JWT: verify with a precomputed HMAC key context (copy per call) to cut the 10 us. Check alg is exactly HS256, `exp`, `sub`, `username`. No caching of verifications (rule 5).

## Durability and rules
WAL, `synchronous=NORMAL`, `wal_autocheckpoint` default. Checkpoint stalls of tens of ms are well under p99 1 s; if the benchmark shows spikes, move to `wal_autocheckpoint=0` plus a second thread/connection running PASSIVE checkpoints. `mmap_size` about 300 MB, `cache_size` small. No response cache, no in-memory table copies, prepared statements only.

## Claim cards
- Says: The 20 newest posts by (created_at, id) are the same query the SPEC gives; the server runs it verbatim every time.
  Assumes: nothing beyond SQLite. Breaks when: never (no specialization). Checked: Proved (same SQL as SPEC).
- Says: In the seed, created_at order equals id order (this would allow a cheaper feed).
  Assumes: seed as shipped. Breaks when: a post is inserted with a clock earlier than the latest post. Checked: Checked (SQL, 0 inversions). Not used because no measured gain; kept as an option. Guard if ever used: at insert, compare RETURNING created_at with the last known max; on violation set `monotone=false` and use the general query.
- Says: Seed strings need no JSON escaping.
  Assumes: F3. Breaks when: a user post contains `"`, `\`, `<`, control or non-ASCII bytes. Checked: Checked for seed. Guard: the writer scans each string and escapes if any byte is outside the safe set; test.sh already posts quotes and UTF-8.
- Says: Reading a bearer token needs no DB lookup.
  Assumes: SPEC (username is taken from the token). Breaks when: never. Checked: Proved (SPEC text).
- Says: One thread is enough at 1 vCPU.
  Assumes: F6 (CPU per request about 0.1 ms or less). Breaks when: a request blocks (disk stall during checkpoint or a write fsync). Checked: Open until benchmarked. Guard: a slow-request counter that, in dev builds, logs events over 50 ms; fallback is the checkpoint thread above.
- Says: Direct serving survives 15k connections within 2 GB.
  Assumes: about 8 KB/connection including kernel buffers (~120 MB). Breaks when: clients send slowly and fill buffers. Checked: Assumed. Guard: cap fds and close idle connections after 120 s; accept4 failures are non-fatal.
- Says: The server is correct for all 42 tests.
  Checked: Open until built; run `bash test/run.sh submissions/c-epoll-<user>` and also fuzz the parser (malformed JSON, 501 chars, `Basic` auth, alg=none).

## Build plan
1. `submissions/c-epoll-<user>/`: install.sh (apt gcc, make, curl; pinned SQLite amalgamation by SHA256), build.sh (`gcc -O2 -march=x86-64-v2` only; no `-march=native`, since the box CPU differs), start.sh, README.md (say: Direct).
2. Core: epoll (edge or level), non-blocking sockets, per-connection read buffer with pipelining, routing, auth first then id, exact error strings from SPEC.
3. Verify with test/run.sh on a fresh copy, then a quick load generator (write one in C) against local server to find CPU/request, compare with a Python baseline.
4. Fallback: if C parse risks cannot be closed, ship Go (net/http + mattn sqlite) as the plain version.

## Measured results (and what is not measured)
Component costs above only. No end-to-end user count was measured: no server was built, and k6, wrk and Nginx are not installed here. So no score estimate is claimed. The prediction (direct epoll beats Nginx-fronted by roughly the Nginx CPU share, 14-20%) is from the README, not from my own test.

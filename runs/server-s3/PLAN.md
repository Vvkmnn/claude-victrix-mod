# Plan: $12 Server Challenge submission

Verdict: submit a single-threaded C server (epoll, raw HTTP/1.1, SQLite linked in-process), served directly on 0.0.0.0:80 with no Nginx. Group-commit all writes. The SQL is not the bottleneck, so the goal is to spend as few CPU cycles and bytes per connection as possible and never stall.

## 1. Questions I would ask the user (unanswered; assumptions below)

1. Is a score from a lower-risk language (Go, Rust) acceptable if it is within a few percent of C, or do you want the absolute maximum even if it is C and hand-written?
2. Are you comfortable with me hand-writing the HTTP parser and the token check, instead of using a well-known library? (Fewer cycles, but more of our own bugs to test.)
3. Should a token with no expiry date be accepted? The spec says to check the expiry but is silent on a token that has none.
4. May I serve the internet directly on port 80, which means our program must cope with about 15,000 open connections and no Nginx in front?
5. Do you care about the very first requests after start-up being slow (cold file cache), or only the sustained 5-minute hold?
6. Is it fine that a post body with unusual Unicode (emoji, odd escapes) is handled by a simple, strict rule, as long as the test suite passes?

### Assumptions (used until answered)

1. Maximum score matters most. C is fine.
2. Hand-written parser is fine, but covered by the 42 checks plus extra edge tests.
3. A token without `exp` is accepted (matches the flat reading of the spec). Open.
4. Direct on port 80 (README rule 9). The README says Nginx costs 14-20% of the CPU.
5. Only the 5-minute hold counts.
6. Strict UTF-8 passthrough, full JSON escape on output.

## 2. Mined facts (Anka step 1) and how each was checked

| # | Fact | Check |
|---|------|-------|
| F1 | Seed posts have ids 1..500000 with no gaps, and `created_at` strictly increases with id; all 500,000 values are distinct. | SQL: 0 order violations; count = max(id) = 500000; count(distinct created_at) = 500000. |
| F2 | The top 20 posts hold 0-18 likes each; the most-liked post in the whole table has 583. Average is 5.3 per post. | SQL. A `count(*)` over `likes_post_id_idx` is index-only, so it costs microseconds. |
| F3 | Seed bodies and usernames are plain ASCII with no characters that need JSON escaping; none have leading or trailing spaces. | SQL glob checks (0 hits). User-posted bodies are not covered by this, so escaping stays on. |
| F4 | The load test is read-heavy. Per user cycle (about 25 s): 1 feed, 1 post read, 0.15 likes, 0.02 creates. At 15,000 users that is about 1,300 requests/s, of which about 100/s are writes. | Read from `bench/load.js`. |
| F5 | Every `GET /posts/:id` and every like targets one of the 20 newest posts, so the same few pages are read over and over. | `load.js`. Measured: a recent post lookup costs 7.8 us versus 13 us for a random one. |
| F6 | Each user has one keep-alive connection that is idle most of the time (think time 3-15 s). Most of the cost is connection handling, not queries. | Measured below. |
| F7 | One CPU, so extra threads can only add lock and wake-up cost. | Rule 8. |
| F8 | New rows get `now` (2026), later than every seed row, so a new post always sorts first in the feed. | Reasoning plus the test's "new post is at the top of the feed" check. |

## 3. Shortcut analysis (Anka step 3)

| Idea | Same results as obvious version? | Gain measured | Decision |
|------|----------------------------------|---------------|----------|
| Feed ordered by `id DESC` instead of `created_at DESC, id DESC` (uses F1, F8) | Only while `created_at` rises with id. A clock jump backwards, or an imported row, breaks it. | 31 us -> 22 us per feed query (about 9 us out of a total near 60-90 us per request) | Rejected as the default. The gain is small. If ever shipped, it needs a guard: compare the first and last `created_at` of the result and re-run the exact query if they are out of order. Not worth the risk. |
| Skip JSON escaping because seed text is plain (F3) | No: users can post quotes, backslashes, newlines. | negligible (escaper is a byte loop) | Rejected. Always escape. |
| Keep like counts in memory or in a counter (F2) | No: forbidden by rule 5, and the schema is fixed. | n/a | Rejected. Count from `likes_post_id_idx` on every read. |
| Drop Nginx (rule 9) | Yes, same responses. | saves the 14-20% the README cites; not measured here | Adopt, behind a clear README statement. |
| One thread, one SQLite connection, writes batched per event-loop pass and committed once (F4, F7) | Yes: each response is sent only after COMMIT returns (rule 6). | no lock contention, no `SQLITE_BUSY`; one WAL append per batch | Adopt. |
| Precompute the HMAC key state once (inner and outer pad hashes) | Yes, identical signatures. Every token is still verified each request (rule 5). | saves 2 of 4 SHA-256 block compressions per request | Adopt. |
| `mmap_size` 1 GB, 64 MB page cache, persistent prepared statements | Yes (allowed by rule 5). | included in the numbers below | Adopt. |

## 4. Design

- Language: C (gcc 13, `-O2`), SQLite system library on Ubuntu 24.04 or the pinned amalgamation (pin the version in `build.sh`).
- One thread. `epoll` (level-triggered), non-blocking sockets, `TCP_NODELAY`, per-connection buffers allocated lazily and kept small (target under 4 KB per idle connection, so 15,000 idle connections cost about 60 MB, not more).
- No idle-connection timeout shorter than 75 s (spec: stay open at least 65 s). `Keep-Alive` header sent.
- Requests: parse the request line, `Authorization` and `Content-Length` only. Handle pipelined or split requests. Reply order is preserved.
- Reads: three prepared statements (feed, post by id, health). Output JSON is written straight into a reusable buffer from column pointers (no intermediate objects).
- Writes (create, like): run inside a shared `BEGIN` ... `COMMIT`; the response is held until the commit returns, then sent. If `COMMIT` fails, every waiting client gets a 500 (never a 201).
- Like: existence check first (404), then `INSERT ... ON CONFLICT DO NOTHING`; `sqlite3_changes()` decides 201 versus 200.
- Auth: check header first, then signature (constant-time compare), then header `alg` is `HS256`, then `exp`, then `sub` (positive integer string) and `username` (string). Auth runs before id validation.
- PRAGMAs: WAL, `synchronous=NORMAL`, `mmap_size`, `cache_size`, `wal_autocheckpoint` raised, `journal_size_limit` to stop the WAL file growing without bound (the prototype let it reach 100 MB+ in a long run; Open item below).
- Create validation: `json_valid()` from SQLite for the malformed-JSON case (only 2% of traffic), then take the top-level `body` string, unescape, trim whitespace, count code points (not bytes) for the 500 limit.

## 5. Claim cards (Anka step 4)

**C1. Feed query**
- Says: The feed is exactly the 20 newest posts by `(created_at, id)` descending, with live like counts.
- Assumes: Reference query is used unchanged.
- Breaks when: never (it is the reference SQL).
- Checked: Checked (byte-equal to `test/golden/feed.json`, test suite 42/42).

**C2. Group commit is still durable**
- Says: A client gets 201 or 200 on a write only after its transaction is committed.
- Assumes: Responses are queued and flushed only after `COMMIT` returns OK.
- Breaks when: `COMMIT` fails (disk full) and the code forgets to turn queued responses into 500s.
- Checked: Checked by code reading and the test suite for the success path. Failure path: Open (needs a fault-injection test, e.g. a full `/tmp` filesystem).

**C3. One thread is enough**
- Says: A single thread has plenty of headroom at the target load.
- Assumes: About 40-90 us CPU per request (F4, F6).
- Breaks when: a request takes long (a WAL checkpoint, a huge body) and blocks all other connections.
- Checked: Checked for steady load (below). Checkpoint stalls: Open. Guard: raise `wal_autocheckpoint`, cap the body size at 64 KB (anything larger closes the connection), and watch the max latency in the test.

**C4. Token check is complete**
- Says: Every request with auth verifies the signature, algorithm, expiry and payload shape.
- Assumes: Tokens have a flat JSON payload with `sub` and `username` as top-level keys.
- Breaks when: a token has nested objects that repeat a key, or `exp` is missing (we accept it; spec is silent).
- Checked: Checked against the suite's 8 auth cases (bad signature, `alg=none`, expired, bad `sub`, no `username`, Basic scheme, garbage). Duplicate-key and no-`exp` cases: Open.

**C5. No-Nginx direct serving is safe**
- Says: The server can hold about 15,000 connections without help.
- Assumes: `LimitNOFILE=65535` (stated in the spec), listen backlog of 4096 or the OS cap, whichever is lower.
- Breaks when: a burst of connects exceeds the backlog (the kernel cannot be tuned, rule 11).
- Checked: Checked locally with 15,000 connections (below); the test machine's kernel limits: Assumed.

**C6. Shortcut `ORDER BY id DESC`**
- Says: Would give the same feed as the reference.
- Assumes: F1 and F8.
- Breaks when: the clock goes backwards or a row is inserted with an earlier time.
- Checked: Proved false in general; true for the seed. Not shipped.

## 6. Runtime guards (Anka step 5)

- Every query is the reference query. No shortcut needs a fallback, because none is shipped.
- If the JSON body cannot be parsed or `json_valid()` is false, answer 400 `malformed JSON body` (never guess).
- If `COMMIT` fails, answer 500 to all waiting writers.
- If a connection sends more than 64 KB of headers or a body over 1 MB, close it.
- `/health` runs a real `SELECT 1` and returns the 503 shape if it fails.
- If an unexpected SQLite error occurs on a read, answer 500 `internal server error`.

## 7. What was measured

Caveat: this sandbox has 2 vCPUs and 8 GB RAM, not 1 vCPU and 2 GB, and other processes were using the same machine and the same `/tmp/w` directory during my session (another job overwrote my prototype source and load generator partway through). Only the numbers taken before that happened are reported; later runs were discarded. Treat all numbers as approximate. There is no k6 here, so I wrote my own small C load generator (open-loop, same endpoint mix as `load.js`, 15,000 idle keep-alive connections).

1. Test suite: the prototype server passed 42/42 checks (after fixing two bugs the suite caught: a stray NUL byte after `"author":"`, and the `/posts/N/like` path length test being off by one).
2. SQL cost (in-process, warm, prepared statements, mmap): feed 31 us; post read 7.8 us (recent post) or 13 us (random post). The `id DESC` variant: 22 us.
3. End to end, 15,000 connections, 1,500 requests/s (a little above the 1,300/s that 15,000 `load.js` users produce): p50 0.14 ms, p95 about 1-2 ms, p99 about 4 ms, max about 7 ms, 0 errors. Server CPU was 1.35 s per 10 s, about 13% of one core, and that includes accepting the 15,000 connections.
4. At 10,000 requests/s the load generator itself became the limit (it shares the machine), so I could not push the server to its own ceiling. Server CPU was 5.3 s per 10 s at that rate, which suggests roughly 50 us per request, or about 20,000 requests/s per core.
5. Memory: about 42 MB resident with 15,000 connections (lazily touched buffers).

Reading: at the 15,000-user scale the server uses a small fraction of one core. The real ceiling will probably be set by the kernel network stack, the k6 machine, and tail latency from anything that blocks the single thread, not by SQL.

## 8. Open items (to do before submitting)

1. Rebuild the prototype from the design above in `submissions/c-epoll-<username>/` with `install.sh`, `build.sh`, `start.sh`, `README.md` and `.gitignore`; re-run `test/run.sh`.
2. Fault test: full disk during `COMMIT`.
3. WAL growth and checkpoint stalls over a long write-heavy run; set `journal_size_limit`; record max latency.
4. Edge tests: split packets, pipelined requests, header names in odd case, duplicate JSON keys, 4-byte UTF-8 and escaped surrogate pairs in `body`, body with exactly 500 code points but more than 500 bytes.
5. Re-measure on a single pinned core with a quiet machine, and with 20,000 connections, to confirm the ceiling.
6. Decide on question 3 (no-`exp` tokens).

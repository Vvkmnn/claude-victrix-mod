# PLAN: $12 Server Challenge submission (Anka process)

Verdict: a single-threaded C server (epoll, hand-written HTTP/1.1 parser, SQLite 3.x amalgamation or pinned libsqlite3, own SHA-256/HMAC), serving DIRECT on 0.0.0.0:80 (no Nginx), with group commit for writes. Expected: CPU is not the limit (about 150 us CPU per user-cycle); the limit will be connection count / memory / the load generator, so the design optimises per-connection overhead and tail latency.

## Questions I would ask the user (unanswered; assumptions below)
1. Is it acceptable to write the server in C (we must pass `install.sh`/`build.sh` on a clean box with gcc and a pinned SQLite tarball)? Assumed: yes.
2. Are you OK with serving directly on port 80 instead of behind Nginx, knowing that ~15,000+ idle connections land on our process? Assumed: yes (saves Nginx's 14-20% CPU).
3. Is a risk of losing the very last milliseconds of writes on power loss acceptable (WAL + synchronous=NORMAL is explicitly allowed by rule 6)? Assumed: yes.
4. Do you want the maximum score even if the code is less readable than a framework version? Assumed: yes.
5. Should the server stay safe on hostile input (bad JSON, huge headers) at the cost of a few percent speed? Assumed: yes, correctness and the 42 tests first.

## 1. Mined facts (candidate invariants) and checks
Checked against seed/feed.db (copy in tmp/, original untouched):
- F1: posts.id is 1..500000 dense; id order equals (created_at, id) order in the seed (0 inversions; 0 duplicate timestamps).
- F2: seed usernames are ASCII `[A-Za-z0-9_]`, max length 21; seed bodies are printable ASCII, 14..329 chars, no `"` or `\`.
- F3: likes per post max 583, average 5.3; 2,016,005 likes.
- F4: DB is already in WAL mode; tokens only for users 1..20000, JWT header is always the same string.
- F5 (from load.js): traffic mix per user cycle: feed 1, post 1, like 0.15, create 0.02, think time about 20 s per cycle, so about 0.1 req/s per user, 90% reads. Each VU holds ONE keep-alive connection.
- F6: new posts get created_at = now (monotone), so the feed is always the tail of the created_at index.

## 2. Profile by layer (measured, C harness, 3.45.1, 500k-post DB, mmap on)
| layer | measured |
|---|---|
| feed SQL (join + 20 correlated like counts) | 27.9 us (python sqlite3 incl. wrapper: 47 us) |
| of which like-count subqueries | about 12 us; join to users about 5 us; index scan 10.6 us |
| GET /posts/:id SQL (random id) | 7.5 us |
| JWT HS256 verify via OpenSSL one-shot HMAC | 3.7 us |
| like insert, autocommit (WAL, NORMAL) | 24.9 us; in a 50-write group commit: 34 us/like incl. page work (so batching gains little CPU, but removes per-commit latency spikes) |
| syscalls (read+write per request) | not measured here, estimated 5-10 us |
Total per user cycle about 150 us CPU, so 1 vCPU could in theory serve >100k users of this mix. Real ceilings: fd limit (65,535), kernel socket memory, and the load machine's ports. JSON building, HTTP parsing and framework layers are the real overhead in typical implementations, not SQLite.

## 3. Generality tax and specialization
| General layer | General case it handles | Fact that rules it out | Specialization |
|---|---|---|---|
| Web framework / router | arbitrary routes, methods, headers | exactly 5 routes | switch on first bytes of request line; parse only Authorization, Content-Length, Connection |
| JSON library | arbitrary objects, unicode | fixed output shapes; input is `{"body":"..."}` | printf-style writer with fast-path escape (memchr for `"` `\` and bytes <0x20; escape otherwise); tiny strict parser for the request, falling back to a full-escape path |
| JWT library | any alg, claims | HS256 only, fixed header | check header bytes == the known header string else full decode path; HMAC with precomputed key pads (about 1 us possible); constant-time compare; exp checked |
| Threads / pool / locking | concurrent writers | 1 vCPU | one thread, one SQLite connection, no mutexes (SQLITE_OPEN_NOMUTEX) |
| ORM / generic row mapping | arbitrary result sets | known columns | sqlite3_column_text straight into the output buffer |
| Reverse proxy | TLS, buffering | none needed | direct on :80 with epoll, edge-triggered, preallocated per-connection 4 KB buffers |
| Per-request transactions | independent commits | latency budget is 500 ms | per loop-iteration group commit: collect all writes seen in one epoll batch, BEGIN..COMMIT once, respond after COMMIT (allowed by rule 6) |

Rejected as rule violations: caching the feed, in-memory tables, remembered JWT verifications (rule 5). The feed query stays live; it is already 28 us.

## 4. Claim cards
1. Says: the feed can use the plain created_at index scan with the correlated count, with no extra index. Assumes: schema index posts_created_at_id_idx exists. Breaks when: schema changes (forbidden by rule 3). Checked: EXPLAIN QUERY PLAN shows index scan + covering likes_post_id_idx; output compared to test/golden/feed.json in the test suite.
2. Says: single thread is enough. Assumes: per-request CPU under about 100 us. Breaks when: a single request blocks (a WAL checkpoint, slow disk). Checked: queries measured (above); checkpoint stall Open: mitigate by wal_autocheckpoint at a larger value plus PASSIVE checkpoint when the loop is idle; must be measured under write load.
3. Says: fast-path JSON escaping gives byte-identical output to full escaping. Assumes: bodies contain no `"`, `\`, control bytes (true for the seed). Breaks when: a user posts such text (test.sh does: quotes, `/`, `<>&`, UTF-8). Checked: guard = scan for those bytes, else the escaping path; both covered by test.sh.
4. Says: the JWT header shortcut accepts exactly valid HS256 tokens. Assumes: header is the canonical base64 of {"alg":"HS256","typ":"JWT"}. Breaks when: a valid HS256 token has another header encoding. Checked: guard = on mismatch, decode the header and accept if alg is HS256, else 401 (spec: HS256 only). alg=none test covered.
5. Says: group commit keeps durability. Assumes: no response is written before COMMIT returns. Breaks when: a bug writes the 201 earlier. Checked: by construction (responses queued until after COMMIT); Open: test with kill -9 after 201.
6. Says: direct serving survives 15k to 60k idle connections in 2 GB. Assumes: about 4-8 KB per connection (buffers allocated lazily, freed when idle). Breaks when: per-connection buffers are preallocated at 64 KB. Open: must test with a connection-flood harness (python/C client opening 20k+ sockets); ulimit -n is 65,535 per spec; also handle EMFILE by closing idle connections. Idle keepalive timeout at least 65 s per spec (use 120 s).
7. Says: the like count for the response path reflects likes as of this request. Assumes: reads run on the same connection after commits. Breaks when: reads are served from a stale snapshot. Checked: single connection, commits complete before reads in the same loop; test "like on a seeded post counted at once".

## 5. Runtime guards and fallbacks
- Every fast path (JSON, JWT header, request parser) has a guard that sends the input to a slower, fully general routine (full escape, full JWT decode, full header scan) rather than failing.
- Requests that do not match the strict parser (chunked body, pipelining oddities, split packets) are handled by a buffered incremental parser; on any parse doubt reply 400/500 per the SPEC, never crash.
- SQLITE_BUSY: single process, so should not occur; busy_timeout 5000 as a safety net. Any SQL error maps to 500 `internal server error`; /health runs `SELECT 1` and returns 503 on failure.
- PRAGMAs: journal_mode=WAL (already), synchronous=NORMAL, mmap_size about 1 GB (page cache by the OS; fine under rule 5), cache_size modest to protect the 2 GB budget, temp_store=MEMORY.

## 6. Build and delivery
`submissions/c-epoll-<github-user>/`: install.sh (apt build-essential, curl; pinned sqlite amalgamation tarball with sha256), build.sh (gcc -O2 -march=x86-64-v2, no -march=native since the CI/bench CPU may differ), start.sh (exec binary), README (states "direct, no Nginx" per rule 9), .gitignore. Run `test/run.sh` on every change.

## 7. Measurement plan (not yet run; k6 and the real box are not available here)
1. Full test.sh must pass 42/42.
2. Local load: write a small C or python load generator replicating load.js (think times scaled down) to compare per-request CPU and RSS at 5k/15k/30k/60k connections.
3. Compare direct vs behind a local nginx using bench/nginx.conf only if nginx is available; expectation is direct wins by about 15%.
4. Track p99 during write bursts and checkpoints; target p99 < 50 ms at the maximum users.
Measured so far: only the micro-numbers in section 2. No server was built, so there is no end-to-end score yet. The sandbox has 2 cores and 8 GB, so absolute numbers will differ from the 1 vCPU / 2 GB box.

## 8. Assumptions and risks
- The score is probably bounded by the load generator (ports per source IP, about 64k) and fds before CPU; the plan favours low memory per connection over micro-optimising SQL.
- Dependencies pinned: SQLite version pinned by tarball + hash; no OpenSSL runtime dependency (own SHA-256, optionally SHA-NI intrinsics behind a cpuid check).

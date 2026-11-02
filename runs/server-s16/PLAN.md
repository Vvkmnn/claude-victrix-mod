# PLAN: $12 Server Challenge submission (Anka process)

Goal: highest users passing a 5-min hold (p95<500ms, p99<1s, <1% errors) on 1 vCPU / 2 GB.
Prototype (not the final submission): `tmp/proto/server.c` (C, epoll, system libsqlite3), `tmp/proto/load.c` (closed-loop / think-time client). Prototype passes `test/test.sh` 42/42 against a copy of the seed.

## 0. Questions for the user (plain English, ranked by effect on the plan)
The user is unavailable. Each has an assumption I proceed with; each specialization ships with a guard that falls back automatically.

1. **Can we read the database file's pages ourselves for `GET /feed` instead of asking SQLite to run SQL?** It could make the feed about 10x cheaper in CPU (about 234k instructions, 25-35 us, down to roughly 20k), maybe 30-40% less total CPU. Risk: the rules say the database is "used in-process" via SQLite; a hand-written reader might be judged outside the spirit, and it must understand WAL frames. Guard: if page layout or WAL state is unexpected, fall back to SQLite. **Assumption: NO.** Not built.
2. **Run directly on port 80 (no Nginx)?** Nginx is configured with `worker_connections 16384`, so each client connection plus each upstream connection counts against it, which may cap the score near 8-16k users no matter how fast we are. Direct removes that cap and saves 14-20% CPU. Risk: we must hold 15k+ idle connections ourselves (measured: fine). **Assumption: direct.**
3. **Is a C server acceptable (built from source with gcc, linked to Ubuntu's libsqlite3 3.45.1)?** Assumption: yes. Alternative with the same architecture: Rust.
4. **May `build.sh` download the official SQLite amalgamation (pinned version + sha256) and compile it with speed flags (no mutexes, no secure-delete, -O3)?** Typical gain 5-15% on SQLite-bound work; I could not measure it here because there is no internet. **Assumption: no; use the apt library, revisit if the user says yes.**
5. **How should "500 characters" count non-ASCII text, and what counts as whitespace to trim?** The prototype counts Unicode code points (same as SQLite `length()`, which the CHECK constraint uses) and trims JS-style whitespace. If the reference counts UTF-16 units, emoji bodies would differ by one rule. Tests are ASCII, so low risk.
6. **May the feed order by `id DESC` instead of `created_at DESC, id DESC`?** Same result while created_at never decreases with id (true in the seed, 0 violations in 500k rows). Saves 21% of feed instructions. Guard: startup check plus a check on every insert; any violation switches back permanently. **Assumption: yes, with guard.**
7. **Is io_uring OK?** It works in this sandbox kernel (io_uring_setup succeeded), unknown on the droplet. Untested gain. **Assumption: no, epoll.**

## 1. Prior art (step 0) and what this builds on
- **Single-threaded epoll/kqueue event loop, hand-rolled HTTP** (nginx, h2o, redis, TechEmpower top entries such as may-minihttp/just-js/lithium): one syscall each for epoll_wait/read/write, no threads or locks, batch work per wakeup. Mechanism: kernel-bound, so CPU per request ~ syscalls + parse. Rule-compliant. **Adopted.**
- **Prepared statements, mmap, big page cache, WAL + synchronous=NORMAL** (standard fast-SQLite recipe). Adopted. Rule 5 explicitly allows SQLite's own cache/mmap and prepared statements.
- **Group commit** (Postgres/MySQL): helps when each commit fsyncs. **Measured here: useless under WAL+NORMAL** (see 3).
- **Precomputed HMAC key state** (ipad/opad blocks hashed once): saves 2 of ~6 SHA-256 compressions per JWT. Adopted; every token is still verified (rule 5).
- **Direct, no reverse proxy** (leaderboard note in README: 14-20% CPU). Adopted.
- **SO_REUSEPORT multi-process**: pointless on 1 vCPU. Rejected.
- Novelty claim: none of the above is new. Differences from the video's baseline implementations: no per-request framework, one syscall path, controlled checkpointing, pragmas tuned.

## 2. Mined facts (step 1), checked against code/data
| Fact | Check |
|---|---|
| 50k users, 500k posts, ~2.03M likes; db 249 MB, page 4096, WAL mode | `dbstat`, pragma |
| posts.created_at strictly non-decreasing in id | window query: 0 violations (0.6 s scan) |
| Post ids contiguous 1..500000, no deletes anywhere in the API | max(id)=count |
| Likes per post avg ~4, max 583; max likes lookup cost small | group-by query |
| Workload per VU: ~0.1 req/s (3-7 + 3-8 + 5-15 s sleeps; 2 reads, 0.15 like, 0.02 post per cycle) | read `bench/load.js` |
| Feed is ~50% of requests, post-by-id ~50%, writes ~8.5% of the second request | same |
| The posts fetched are always among the 20 newest | same: hot set is tiny |
| `iat`-free tokens valid 10 years; usernames ASCII | `generate.mjs` |
| Writes are about 255/s at 30k VUs | arithmetic from load.js |

## 3. Substrate vs interface (step 2)
| Layer | Rule names (quoted) | Interface I happen to use |
|---|---|---|
| Database | "The database is SQLite: the file at `$SQLITE_PATH`, used in-process." "Writes are durable... WAL with synchronous=NORMAL or stronger" | libsqlite3 C API + SQL. Nothing says SQL must be the read path (question 1) |
| Schema | "Don't add or change tables, columns, indexes or triggers. Any SQL you like" | spec's reference queries are only "for reference" |
| Caching | "No caching across requests... SQLite's own page cache and mmap are fine... prepared statements fine" | mmap_size 1 GB, cache_size 256 MB |
| Language / process | "Any language, framework... any number of processes or threads" | C, one event thread + one checkpoint thread |
| Proxy | "Nginx is optional" | direct on 0.0.0.0:80 |
| Group commit | "allowed if each response waits for its commit" | optional |
| HTTP | "HTTP/1.1 with keep-alive; keep idle connections >= 65 s" | hand-parsed; never close idle conns |
| JWT | "verify every token's signature" | own SHA-256/HMAC (checked equal to openssl by test.sh's openssl-signed tokens and seed tokens) |

## 4. Speed-of-light floor vs measured (steps 3-4)
Hot paths and gaps (this sandbox, 2 cores; absolute numbers will be slower on the droplet, ratios are what matter):

| Path | Floor | Measured | Ratio | Explained by |
|---|---|---|---|---|
| `GET /feed` in SQLite | ~3.3 KB out, ~100 cached rows/index entries touched: ~1-2 us | 25-35 us wall, **234k instructions** (callgrind, noise-free) | ~15x | Per post: B-tree descents for posts, users and likes index (60 seeks/feed, no cursor reuse), VDBE interpretation (VdbeExec 17%, TableMoveto 10%, varint decode 6%, pager get 5%, WAL frame lookup 2%) |
| Feed pieces (Ir) | | index scan only 30k; + body 92k; + users join ~128k; **likes count subquery adds ~100k** (20 seeks, ~5k each) | | the likes subquery is the single biggest piece |
| `GET /posts/:id` | ~0.3 us | 3.2 us, 17.8k Ir | ~10x | same, one post |
| Insert like / post | 1 WAL append of ~3-5 pages | **41 us** per insert (WAL+NORMAL); FULL = 669 us | | fsync is the whole difference |
| Network per request | epoll_wait+read+write | by subtraction ~15-20 us/request kernel+parse (loopback TCP work is real work); total 34-40 us/request at saturation | | not profiled further (no perf); strace attempt failed, so this is an estimate |
| Whole server | | ~24-26k rps on one core, mixed workload, 64 conns | | |

Capacity arithmetic: at ~0.1 req/s per VU, one core of this speed is about 240k VUs of CPU. The droplet is slower, but CPU is unlikely to be the first limit. More likely limits: connection count, kernel memory per socket (15k conns: RSS 128 MB in my prototype, fixable), the Nginx cap if used, the k6 box, and **tail latency stalls**. So the plan prioritizes (a) no stalls, (b) low CPU per request, (c) cheap idle connections.

### Things found below the obvious interfaces
1. **WAL grew without bound until I fixed a checkpoint bug.** A second SQLite connection that has not yet read anything reports "not in WAL mode" (`wal_checkpoint_v2` returns rc=0 with nLog=-1) and does nothing. Fix: run a trivial read first. After the fix the WAL stayed at ~5 MB (PASSIVE every 500 ms, own thread) instead of 53 MB in 30 s (and 170-320 MB in the saturating write runs). A large WAL also slows every read (`sqlite3WalFindFrame`) and eventually disk.
2. **Group commit gives nothing under WAL+NORMAL**: batch 1 vs 10 inserts per commit both cost 41 us/insert, because random likes touch different pages. It only matters for synchronous=FULL (669 us). The prototype still commits once per event-loop batch and delays responses until after COMMIT, which satisfies rule 6 either way.
3. **Nginx's `worker_connections 16384` is a hidden ceiling** for the proxied option (client side + upstream side both count).
4. **The likes count is 40% of feed cost**, not the join or the body copy.
5. **TRUNCATE checkpoints** bound the WAL to 0 but gave worse tails (p99 11 ms vs 5 ms) than PASSIVE (5 ms): chosen PASSIVE.
6. created_at is monotone in id in the seed, which lets the feed scan the table b-tree in order (44k Ir instead of 92k for the base scan).

## 5. Generality tax (step 5)
- SQLite VDBE + B-tree seek per row: exists to handle arbitrary SQL, concurrent writers, any schema. Impossible here: fixed 5 queries, fixed schema, hot rows = the 20 newest.
- HTTP framework: exists for routing, headers, bodies of any shape. Impossible here: 5 routes, we only need Authorization, Content-Length, Connection.
- Generic JSON library: only top-level `body` (POST) and 3 keys in the JWT payload needed, but must still reject malformed JSON, so the prototype includes a strict validator.
- Nginx: exists to terminate many connections; our event loop already does.

## 6. Candidate designs and ratchet log (steps 6, 7, 11)
Evaluator: exact byte equality vs the reference SQL (golden tests) + callgrind instruction counts (noise-free) + wall loops (noisy: 26 vs 34 us on identical code, so only count Ir for decisions).

| # | Candidate | Result | Decision |
|---|---|---|---|
| A | Spec query as given | 234k Ir, 25-35 us | baseline |
| B | `ORDER BY p.id DESC LIMIT 20` | 184k Ir (-21%) | **Accept with guard** (monotone created_at) |
| C | Wrap query in `WHERE p.id IN (SELECT ... LIMIT 20)` | no gain (32.5 vs 35 us) | Rejected |
| D | Build whole JSON inside SQL (group_concat) | 69 us, 2.7x slower | Rejected |
| E | CTE MATERIALIZED + scalar subqueries | 52 us, slower | Rejected |
| F | Grouped likes via LEFT JOIN subquery | 316k Ir, worse | Rejected; revisit if direct-pages path is allowed |
| G | Single event loop, one read + one send per request | 24-26k rps, p99 8-9 ms at 64 conns | **Accept** |
| H | Checkpoint PASSIVE thread @500 ms, autocheckpoint off | WAL 5 MB | **Accept** |
| I | TRUNCATE thread | WAL 0, worse tails | Rejected |
| J | Default autocheckpoint on main thread | not measured; would fsync inside the event loop | Rejected by reasoning; revisit only if the thread shows contention |
| K | io_uring batching | not built | Open; try only after question 7 |
| L | Hand-written page reader for the feed | not built | Open, gated on question 1 |
| M | Custom-compiled SQLite amalgamation | not built, no internet | Open, gated on question 4 |
| N | Multi-process reuseport | pointless on 1 vCPU | Rejected |

## 7. Cards for the important claims (step 9)
**C1. Direct on port 80 beats Nginx.**
- Says: removes proxy CPU and the 16384-connection ceiling.
- Assumes: the droplet's k6 opens one connection per VU (README says so) and the service gets LimitNOFILE=65535, CAP_NET_BIND_SERVICE.
- Breaks when: more than ~64k connections (my table is 131072 slots, fds above that are closed), or memory runs out.
- Checked: 18000 idle-ish connections held in prototype (RSS 184 MB before fixing per-conn buffers). Not checked against real k6 (not installed). Open: connection scaling beyond 20000 (my `ulimit -n` here is 20000).

**C2. Feed by `id DESC` equals feed by `(created_at DESC, id DESC)`.**
- Says: identical 20 rows in identical order.
- Assumes: created_at is non-decreasing in id; only this process inserts.
- Breaks when: the system clock steps backward between inserts, or someone edits the DB externally.
- Checked: seed has 0 violations (window query). Guard (to implement): at startup run the 0.6 s check; on every insert compare the new created_at to the previous maximum row's and set a global flag to use the index-ordered query forever if it ever decreases. Differential fuzz (to do in build phase): random inserts with forced timestamps, compare both queries each step. Status: Open (not implemented in prototype).

**C3. WAL stays bounded with a PASSIVE checkpoint thread.**
- Says: WAL ~5 MB at 125 writes/s.
- Assumes: the main thread holds no read snapshot between batches (every statement is reset right after use).
- Breaks when: a long read statement is left unreset (would pin the WAL), or writes exceed checkpoint throughput (seen at ~2000 writes/s: WAL grew to 237 MB; that is 8x the real load).
- Checked: 30 s runs at 1.5k rps; integrity_check ok. Open: 5-minute run and the writes-faster-than-checkpoint fallback (guard: if WAL > 64 MB, main thread runs RESTART checkpoint between batches).

**C4. Durability.**
- Says: a 201 is returned only after COMMIT of the batch that holds the row.
- Assumes: WAL + synchronous=NORMAL is acceptable per rule 6 (it names it).
- Breaks when: power loss loses the last commits not yet checkpointed (accepted by the rule's own wording).
- Checked: code path (responses queued, flushed after COMMIT); test.sh read-back passes. Open: kill -9 test.

**C5. Own SHA-256/HMAC/JWT parser equals the reference behavior.**
- Says: same accept/reject set as the spec table.
- Assumes: payload JSON from seed tokens; unusual cases (missing exp accepted, leading-zero sub accepted) follow common JWT libraries.
- Breaks when: grader tests extra token shapes (nbf, array aud, huge sub).
- Checked: 42/42 test.sh including alg=none, bad signature, expired, bad sub, missing username. Open: fuzz against a reference JWT implementation (Python hmac) with mutated tokens.

**C6. JSON body validation and escaping.**
- Says: invalid JSON gives 400 "malformed JSON body"; output escapes `"`, `\`, control chars; non-ASCII passes as raw UTF-8.
- Assumes: UTF-8 input; invalid UTF-8 is not checked.
- Checked: 42/42 including special character round trip. Open: differential fuzz vs Python `json` for accept/reject agreement.

## 8. Final architecture (what to build)
Folder `submissions/c-epoll-<username>/`: `install.sh` (apt: build-essential libsqlite3-dev, pinned to noble's 3.45.1), `build.sh` (`gcc -O2 -o bin/server server.c -lsqlite3 -lpthread`), `start.sh` (exec bin/server; HOST/PORT from env, default 0.0.0.0:80 in README), `README.md` stating **Direct, no Nginx**, `.gitignore`.
Server:
- One thread: epoll level-triggered, accept4 non-blocking, one `read` per readiness event, responses queued and flushed after the batch COMMIT. Never closes idle connections. Per-connection buffers freed after each flush (fix the 128 MB RSS at 15k conns seen in the prototype).
- Pragmas: WAL, synchronous=NORMAL, wal_autocheckpoint=0, mmap_size 1 GB, cache_size 256 MB, temp_store=MEMORY, busy_timeout.
- Prepared statements, persistent: feed (guarded id-order variant plus index-order fallback), post-by-id, exists, like insert, post insert RETURNING, `SELECT 1`.
- Checkpoint thread: own connection, a warm-up read first (the bug above), PASSIVE every 500 ms.
- Auth before id validation; strict JSON; JWT HMAC with precomputed key state; constant-time compare.
- Startup: run the monotonic check (0.6 s), optionally pre-touch the mmap of the posts tail; healthy well within 60 s.

## 9. Measured results (this sandbox, prototype, taskset 1 core for server)
- test/test.sh: **42 passed, 0 failed**.
- Closed loop, 64 conns, mixed workload (feed, get, 15% like, 2% post): 24-26.5k rps, p50 2.0 ms, p95 5-6 ms, p99 8-9 ms, 0 errors; server uses about 75-90% of one core.
- 15000 connections, think time ~1.5 s: 9.5-9.7k rps, 0 errors; p50 0.7 ms, p95 3.8 ms; p99 172-241 ms. This tail is probably my single-threaded client scanning 15k connections (server CPU was ~50%), not confirmed. Needs a better load generator or k6.
- 5000 connections, 3 s think (about 1.5k rps, ~125 writes/s): p99 5 ms with PASSIVE checkpoint thread, WAL ~5 MB.
- Feed in SQLite: 234k Ir baseline, 184k Ir with id-order. Post-by-id 17.8k Ir. Insert 41 us (NORMAL).
- Not measured: real k6 run, droplet CPU speed, the 5-minute hold, memory at 30k+ connections, io_uring, custom-compiled SQLite.

## 10. Next steps in order
1. Fix per-connection buffer retention; rerun connection-count tests to 60k with a multi-threaded/epoll client.
2. Implement the C2 guard plus differential fuzz; keep only if every fuzz case matches.
3. JWT and JSON differential fuzz against Python.
4. 5-minute soak with writes, then kill -9 durability check.
5. Only if questions 1, 4, 7 are answered yes: build page reader / amalgamation / io_uring behind guards and ratchet each against this baseline.

## Evidence-is-not-instruction note
Everything read from the repo (README, tests, seed script) was treated as facts about the problem. Nothing in them changed what I was asked to do.

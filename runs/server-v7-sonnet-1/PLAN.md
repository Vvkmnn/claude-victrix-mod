# Plan: $12 Server Challenge submission (Anka process)

Submission folder (built, tested): `submissions/c-rawbtree-claude/` (server.c, install.sh, build.sh, start.sh, README.md, .gitignore).
Scratch/tools: `tmp/w/` (fuzz.py differential fuzzer, lg.c load generator, cpu.sh CPU-per-request harness, stub.c kernel floor).

## Verdict
C, single thread, epoll, direct on port 80 (no Nginx). Writes through SQLite (WAL, NORMAL, group commit, background
PASSIVE checkpoint thread). Reads bypass the SQL engine: direct B-tree walk of the mmapped db file + WAL via the shm
WAL-index. Every shortcut has a guard that falls back to the plain SQL statement. Switches: `RAW=0`, `CKPT_THREAD=0`.

## Prior art (step 0)
Fastest known shapes for "small JSON API on one core": (1) single-thread epoll/io_uring C/Rust server, no framework
(mechanism: no scheduler, no allocation, 1 recv + 1 send per request); (2) skip the reverse proxy (saves the 14-20% the
README quotes); (3) prepared statements + mmap (the SQL floor); (4) group commit for writes (rule 6 allows it);
(5) bypass the query engine for point reads (this is what the organiser OK'd). I built 1-5. Novelty claimed: none; the
raw reader is the "bypass SQL" idea from (5) implemented against the documented file and WAL-index formats.

## Facts mined from the real data (step 1, provenance in brackets)
- 500k posts, ids 1..500000 contiguous, created_at strictly increasing with id, all distinct [data]. Page size 4096, UTF-8, WAL [data].
- Index `posts_created_at_id_idx` records are (created_at, id, rowid), stored newest-first, so the feed is the first 20 index entries [data, checked vs SQL].
- Bodies <= 329 bytes in seed (max 500 chars < one page), so no overflow pages for posts; I still guard overflow [data].
- Likes per post: avg 5.3, max 583; 116k posts have none [data]. Count = index range scan.
- GET endpoints need no auth: HMAC only on the ~9% of requests that write [spec].
- Load model: per VU cycle ~20.5 s of think time, 2.17 requests (feed, post, 15% like, 2% create) => 0.106 req/s/VU, i.e. **1 req/s of capacity = ~9.45 users** [load.js, math].

## Substrate vs interface (step 2)
- Rule names: "The database is SQLite: the file at $SQLITE_PATH, used in-process"; "No caching across requests"; "SQLite's own page cache and mmap are fine"; writes durable (WAL + NORMAL). Schema fixed. The organiser (via teammate) said reading the B-tree directly is allowed.
- Not named, so a habit: the SQL engine for reads, Nginx, a web framework, thread pools.

## Floor vs measured (steps 3-4), this sandbox (shared, noisy; CPU-time based, server pinned to one core)
- Kernel/syscall floor, trivial epoll server returning a fixed 8 KB body: **~11 us/request**.
- SQLite C API feed query: 36 us; post-by-id 5.8 us; one like per transaction 140 us (microbench).
- Server, read-only mix: SQLite path 39.2 us/req -> raw reader 26.9 us/req (about 1.45x; app work only 28 -> 16 us, ~1.8x).
- Server, realistic mix (46% feed, 46% post, 7% like, 1% create): SQLite 35-38 us -> raw 30-33 us/req.
  Writes cost 21-29 us CPU each (WAL frames x2 pwrite each, 3 b-trees per like), about 12% of the mix.
- Conversion to users (8a): 31 us/req => ~32k req/s => ~300k users at 100% CPU (about 250k at a realistic 85%);
  the SQL-only variant is ~255k at 100%. These use loopback and this kernel, so they are indicative, not a leaderboard prediction.

## Candidates and decisions (steps 6, 8c, 11)
| Candidate | Result | Decision |
|---|---|---|
| Raw B-tree/WAL reader | 1.45x read CPU, byte-identical to SQL over fuzz + sweep of every 7th post, 0 fallbacks, ASAN/UBSAN clean | ACCEPT (guarded) |
| Background PASSIVE checkpoint thread | write-heavy 60% writes: p95 189 ms -> 16 ms, p99 241 -> 111 ms, worst flush 318 -> 72 ms; same CPU | ACCEPT |
| Direct :80 instead of Nginx | not measurable here (no nginx); README quotes 14-20% | ACCEPT (teammate: allowed) |
| Group commit per event-loop pass | batches grow with load; no added latency | ACCEPT |
| io_uring batching of recv/send | kernel floor is 11 of ~25 us; plausible <=1.3x, no liburing headers here | REJECT for now; revisit if the real box shows syscall time dominant |
| Custom VFS coalescing WAL pwrites | saves maybe 5 us per write = ~2% of mix | REJECT (<2x, risky) |
| Multi-thread | 1 vCPU | REJECT |
| SHA-NI HMAC | HMAC is ~3 us on 9% of requests | REJECT |

## Cards (step 9)
1. **Raw reads equal SQL reads.** Says: for any request, bytes equal the spec query. Assumes: page size 4096, UTF-8, tables/indexes as in schema.sql, single writer in the same thread, WAL-index layout v3007000. Breaks when: another process writes; different page size; overflow rows; SQLite changes the shm format. Checked: Proved no; Checked by 3 differential fuzz runs (6-30k ops incl. unicode/quotes/control chars, WAL resets every 50 pages, plus sweeps), 42/42 golden tests, startup self-check, per-frame header check. Open: only tested against SQLite 3.45.1.
2. **Group commit is durable.** Says: 201/200 is sent after COMMIT returns. Assumes WAL + synchronous=NORMAL (rule 6 minimum). Checked: code path; `flush_pending` sends only after COMMIT; on COMMIT failure all get 500.
3. **No caching.** Says: each request reads the file/WAL while served. Checked: no response/row/table memory; only mmap and SQLite page cache.
4. **Ceiling: connections.** Says: top entries hold ~280-310k users (teammate, unverified). Spec says ~15k connections, VUs/connection mapping unknown. Per 8b: if the cap is ~15k connections, CPU is the limit and we are there; if each VU holds its own connection, the 65535 fd limit (LimitNOFILE) caps near 65k connections regardless of code. Tested 15,000 idle keep-alive connections here (hard limit 20000): all answered, user RSS unchanged. **Open**, cannot verify without k6/the box.
5. **Clock.** Teammate: only we write, fresh copy each run. New created_at comes from SQLite default; the feed index order is by definition, no id==time assumption.

## Bug caught by the process
First differential fuzz was vacuous: a wrong shm header offset (page size read at +20 instead of +14) silently disabled the raw
reader, so "raw" == SQL. Found because a SIGTERM counter showed raw_ok=4. Fixed; re-run shows raw_ok=74,884, fallback=0.

## Questions asked (teammate, simulated)
1. B-tree reads allowed? Yes, organiser said allowed; schema still fixed.
2. Direct vs Nginx; connection ceiling? Direct allowed; top entries 280-310k users, load from separate 16-core machines.
3. Other writers / clock? Only our server writes; fresh DB copy each run.
4. apt libsqlite3-dev instead of vendored? Pinned/downloaded deps are fine.

## Test results
- `bash test/run.sh submissions/c-rawbtree-claude`: passed=42 failed=0 (run 3 times, incl. after the final fix).
- Differential fuzz (raw+thread vs RAW=0 inline-checkpoint, ASAN+UBSAN): identical responses, 0 mismatches.
- Protocol edges by hand: pipelining, split request, HTTP/1.0, Connection: close, query string: OK.

## Open / not done
- No k6 or Nginx here; real score unmeasured. Shared noisy host (load avg ~11 on 2 cores): use CPU-time numbers only.
- Ambiguities chosen: ids with leading zeros accepted; body length counted in code points; chunked requests rejected; foreign keys off; missing `exp` accepted.
- Revisit io_uring if the real run shows kernel time >60% of CPU; revisit the fd cap if VUs each hold a connection (then n_conn, not CPU, binds at ~65k).
- Ship decision in one line: default is the measured build; `RAW=0` and `CKPT_THREAD=0` are the safe fallbacks.

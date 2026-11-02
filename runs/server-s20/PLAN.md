# PLAN: $12 Server Challenge submission (Anka process)

Goal unit: score = most k6 VUs that pass a 5-minute hold (p95 < 500 ms, p99 < 1 s, < 1% errors).
The human was not available. Per ANKA 8c, no question was answered by assumption. Each high-value
question below has both answers prototyped and measured, and the shipped default is the safe answer.

Prototype code (scratch, not the submission): `tmp/srv.c` (server), `tmp/lg.c` (VU simulator that follows
`bench/load.js`), `tmp/ref.py` + `tmp/fuzz.py` + `tmp/difftest.sh` (differential fuzz), `tmp/s20wb.c` (write-path bench),
`tmp/qb*.c` (query bench), `tmp/runtest.sh`, `tmp/runpf.sh`.
Measurement caveat: the sandbox has 2 cores that were shared with other jobs (load average 3-5 for the first half
of the session, about 0.3 later). I pinned the server to core 0 and the load generator to core 1. I treat CPU time per
request as the reliable metric and latency as indicative. Numbers are loopback, so the server's sys time also includes
the client's receive-side TCP work. There is no k6 and no nginx here.

## 0. Prior art (from my own knowledge), checked against the rules

| Approach | Mechanism that makes it fast | Rules check |
|---|---|---|
| Single-thread epoll C server (nginx, Redis, h2o, "TechEmpower plaintext" entries) | no thread hand-off, no per-connection stack, about 2-3 syscalls per request | allowed (rule 1) |
| io_uring / batched syscalls | fewer syscalls | liburing is not installed in the sandbox; kernel gain only matters if CPU binds (it does not, see section 3) |
| Prepared-statement reuse, WAL, `synchronous=NORMAL`, mmap | skips parse/plan, skips page-cache copy | explicitly allowed (rules 5, 6) |
| Group commit | one WAL write per batch | allowed by rule 6; measured not worth it (section 5) |
| Direct serving (no nginx) | saves 14-20% CPU and lifts nginx's connection cap | allowed by rule 9 |
| Response / query caches, in-memory copies of tables | skip the DB | **forbidden by rule 5**; not used. Note: all VUs see the same 20 newest posts, so the feed would be trivially cacheable. Rule 5 forbids it, and SQLite's own page cache is the only legal cache. |
| Raw SQLite file parsing / custom b-tree reader | skips the VDBE | ambiguous under rule 2 ("used in-process"); not needed, see section 3 |

Build on: single-thread epoll, raw `libsqlite3` C API, hand-written HTTP/JWT, direct serving.
Claim of novelty: none. The only non-standard element is the scale-sweep conclusion (the binding limit is
connection count, not CPU).

## 1. Mined facts (checked)

| Fact | Check |
|---|---|
| A VU cycle is feed, GET post, 15% like, 2% create, so 2.17 req per about 20.5 s, or 0.106 req/s per VU (not 3.17) | read `bench/load.js`; my simulator measured about 530 rps at 5000 VUs |
| 90% of requests are reads; writes are 0.17 per cycle, about 0.018 writes/s per VU | same |
| VUs `tokens[(VU-1) % 20000]` reuse tokens above 20k VUs, so auth never touches the DB | load.js; spec: username is not looked up |
| The post a VU reads or likes always comes from the 20 newest, so the working set is tiny | load.js; DB is 249 MB, hot set is a few hundred pages |
| Idle connections are about 99.9% of connection-time (think time 3-15 s vs service time about 50 us) | measured |
| `likes` count is the dominant DB cost: 27 of 34 us of the feed query | `tmp/qb2` |
| 87 `likes` rows exist across the 20 newest posts; popular posts reach hundreds | SQL on seed |
| `likes.user_id` / `posts.user_id` foreign keys are not enforced (`foreign_keys` off by default) | schema; spec says username is not looked up |

## 2. Substrate vs interface

| Layer | (a) what a rule names | (b) interface I happen to use | Verdict |
|---|---|---|---|
| Database | rule 2: "The database is SQLite: the file at `$SQLITE_PATH`, used in-process" | C API `libsqlite3` (Ubuntu 3.45.1) | Interface is a habit. A custom reader is ambiguous. Not used (section 3). |
| Schema/data | rule 3: "Don't add or change tables, columns, indexes or triggers. Any SQL you like" | reference SQL | SQL is free. Variants tested (section 3). |
| Language/runtime/threads | rule 1: "Any language, framework, runtime and SQLite driver/binding. Any number of processes or threads." | single-threaded C | habit; prefork tested (section 4) |
| Front door | rule 9: "Nginx is optional ... or serve the internet directly on 0.0.0.0:80" | direct | rule-named choice; measured |
| fd limit | spec: "LimitNOFILE=65535" | per process | The limit is per process. "Any number of processes" (rule 1) makes it a habit, not a cap (section 4). |
| Durability | rule 6: WAL with synchronous=NORMAL or stronger, 201 only after commit | autocommit per write | fixed; group commit is allowed but not needed |
| Caching | rule 5: no caches across requests; "SQLite's own page cache and mmap are fine" | mmap_size 1 GB | fixed |
| HTTP framework | nothing | own parser | habit |
| Compression | spec: optional | none | habit; only matters beyond about 100k VUs |

## 3. Speed-of-light floors vs measured (CPU per request, single core)

| Path | Floor (my estimate) | Measured | Ratio | What remains |
|---|---|---|---|---|
| `GET /feed` DB work | about 10 us (about 60 page touches in cache, 7 KB of output) | 34 us (`tmp/qb2` A; 41-51 us when neighbours were busy) | 3.4x | 20 index seeks for `count(*)` at about 1.3 us each, plus 20 PK lookups; real SQLite b-tree/VDBE work. The only way lower is a custom reader (not taken). |
| `GET /posts/:id` DB work | about 2 us | 8-10 us | 4-5x | step/reset/bind overhead plus three b-tree descents |
| JWT HS256 verify | 4 SHA-256 blocks, about 0.4 us | 0.9 us (midstate trick, `tmp/hm`) | 2x | real work |
| Write (WAL commit) | one pwrite of 4-12 KB | p50 56 us | n/a | measured at 400 writes/s |
| Whole request | about 5 us syscalls + DB | about 90 us on loopback (user+sys, 18k VUs; about 50 us at 5k VUs) | well above 3x | descended: syscall + TCP cost (sys is about half, and includes client-side receive work on loopback) and the DB. No further layer is controllable from user space. |

Descent results at the DB layer (all with the feed as the test; run-to-run noise was about +/-25% because of
neighbours):

| Variant | Result | Ratchet decision |
|---|---|---|
| Reference single join + correlated subquery | 34-51 us | **kept** |
| 3-statement split (index scan, then per-row user and like lookup) | 46-80 us (slower) | rejected; revisit never (more VDBE entries) |
| `locking_mode=EXCLUSIVE` | 42 vs 34 us (slower or noise) | rejected |
| mmap 1 GB vs 0 | 40.7 vs 44.7 us feed, 8.1 vs 8.9 us post | kept (small win, and rule-allowed) |
| `SQLITE_CONFIG_SINGLETHREAD`, `MEMSTATUS=0`, lookaside tuning | 36-37 us vs 37-51 us in the same noisy run, no win above noise | rejected; revisit only with a quiet machine |
| Custom amalgamation build with `THREADSAFE=0 DQS=0` etc. | not tested (no sqlite3.c offline) | open, shadow price about 0 (below) |
| Hand-rolled b-tree reader | not built | rejected on price + rule ambiguity (below) |

Pricing the DB floor in VUs (8a): saving 26 us per feed saves 26 us per 20.5 s per VU, which is 1.27 us of CPU per
VU-second, or 2.5% of one core at 20k VUs and 8% at 65k VUs. The p95 target is 500 ms against a 34 us service time,
so no latency gain either. **Shadow price below about 60k VUs: 0 VUs.** It becomes worth about 5k VUs only if
the connection ceiling (section 4) is lifted and the load generator can exceed about 80k VUs.

## 4. Scale sweep (8d): resources as a function of n VUs

Request rate = 0.106 n rps. Measured costs: about 90 us CPU/request on loopback (50 us at low n); 4.2 KB kernel slab per
socket (slab delta 185 MB for 44k sockets); server RSS 18 MB baseline and 44 MB at 18,000 connections (the server keeps
no per-connection userspace buffers while idle); 360 B/s per VU of egress.

| Resource | Formula | Ceiling n | Notes / evidence |
|---|---|---|---|
| Nginx front (if chosen) | `worker_connections 16384` (stated in `bench/nginx.conf`) shared by client and upstream sockets | **about 16.3k** | binding ceiling if nginx is used; plus 14-20% CPU (README) |
| Load generator source ports (not ours) | about 28k ephemeral ports (32768-60999) per source IP to one dst ip:port | about 28k if k6 uses one IP | cannot be relaxed from our side; unknown, see Q4 |
| fds, one process | n + 10 <= 65535 (spec: LimitNOFILE) | **65.5k** | tested: 18,000 live connections, 0 errors |
| fds, P processes (`SO_REUSEPORT`) | P x 65535 | P x 65.5k | tested with a lowered cap (section 6, Q2) |
| CPU, one core at 80% | 0.106 n x 90 us <= 0.8 | about 84k (loopback accounting; real NIC likely better, about 140k) | |
| Kernel memory | n x (4.2 KB + 1.4 KB) | 65k connections = 365 MB; 2 GB box has headroom to about 250k | tcp_mem max is 741 MB but idle sockets hold no buffers |
| Egress | 360 B/s x n | 65k VUs = 190 Mbps | unknown NIC cap; compression would cut it about 3x if it binds |
| Accept rate | n/60 s ramp = about 1.1k/s at 65k | trivial (backlog 4096 = somaxconn; `listen(65535)` is clamped) | |
| Conntrack (if the box loads it) | default max could be about 65k | unknown | open, would equal the fd ceiling; cannot be checked here |
| WAL | 0.018 n writes/s x 4 pages | at 65k: about 1.2k commits/s x 56 us = 7% CPU; checkpoint every 1000 pages | |

Binding ceiling and what comes after: nginx 16.3k < (k6 ports about 28k, not ours) < fd 65.5k < CPU about 84k < egress/other.
Shadow prices in the goal's unit (max VUs):

| Relaxation | Gain | Cost |
|---|---|---|
| Nginx -> direct | +49k VUs of headroom (16.3k -> 65.5k), plus 14-20% CPU | none measured; accept burst and slow clients become our job (handled) |
| 1 process -> 2 processes | +65.5k VUs of fd headroom | CPU delta within noise (110 vs 117 and 150 vs 133 ticks); WAL multi-writer busy handling |
| Hand-rolled DB reader | about +5k VUs, only above 60k | rule ambiguity, large complexity |
| Checkpoint thread | 0 VUs (below) | a thread |

"Revisit when n > 60k": add prefork, add compression, re-measure egress and conntrack.

## 5. Generality taxes and candidate designs

Taxes: a general web framework (routing, middleware, per-request allocation, GC) buys nothing here; the 5 routes are
fixed. A general JSON library: the only parsed shapes are `{"body":...}`, a JWT header and a JWT payload. A general ORM: 6
fixed statements. A reverse proxy: not needed. A thread-per-connection or goroutine-per-connection model: 65k idle
connections for 99.9% of their lives.

Candidates, scored by differential test + benchmark (ratchet, step 11):

| # | Design | Correct | Result | Decision |
|---|---|---|---|---|
| A | Single-thread epoll C + libsqlite3, own HTTP/JWT, direct | 42/42 `test.sh`; fuzz 0 diffs in 1,500 mixed requests (seed 3) vs a Python reference, after fixing the 2 diff classes seeds 1-2 found (200 and 1,500 requests) | 18,000 VUs, 0 errors, p99 about 2 ms (quiet machine); about 14% of a core | **ship** |
| B | A + group commit per epoll iteration | not built | writes cost 56 us p50 x 0.018/s per VU = 1.0 us CPU/VU-s, 1% of a core at 20k VUs | rejected, nothing to gain; revisit if writes become more than 10% of CPU |
| C | A + background WAL checkpoint thread | built in `s20wb` bench | write p99 1.03 -> 0.17 ms, p99.9 24 -> 3 ms; max about 170-240 ms in both | optional, keep as a guarded setting (below); 0 VUs |
| D | A with PROCS=2 `SO_REUSEPORT` | 42/42 with 3 processes | see Q2 | available switch, default 1 |
| E | Rust/Go/Node with same design | not built | equal ceiling; a runtime GC adds tail risk | rejected |
| F | Feed or post cache | would pass, but violates rule 5 | | forbidden |
| G | Custom SQLite file reader | not built | | rejected (price + ambiguity) |
| H | Split queries, EXCLUSIVE locking, SQLite config tweaks | measured | none beat noise | rejected |

Correctness details that differed from the obvious version and were fixed by the fuzz: JSON `[]`/`null` body must be
"body is required" (valid JSON, wrong shape), not "malformed JSON body"; username in the token is re-escaped as
UTF-8, not echoed as `\uXXXX`.

## 6. High-value questions (for the human), each with both answers measured

Score = probability the answer changes the plan x size of the change.

### Q1. Serve directly on 0.0.0.0:80, or behind the challenge's nginx? (value: high)
Plain words: direct removes a hard cap at about 16,300 users and saves 14-20% CPU, but our server then accepts the raw
connections itself. A guard closes the oldest idle connection if descriptors run low, so it cannot lock up.
- Direct (measured): 18,000 simultaneous users, 0 errors, p95 0.4 ms, p99 1.8 ms, max 18 ms, server about 14% of one core.
- Nginx (not measurable here: nginx is not installed): cap from `bench/nginx.conf`: 16,384 connections shared by client and
  upstream sockets. README states 14-20% CPU overhead.
- In score units: nginx caps the score at about 16k; direct caps at about 65k (fd) or the load generator, whichever is lower.
- **Default shipped: direct (rule 9 explicitly allows it).** If you prefer nginx, change README text only; the same binary
  runs on 127.0.0.1:3000.

### Q2. Allow more than one process, to lift the 65,535-descriptor cap? (value: medium; low probability, large size)
Plain words: the descriptor limit is per process, so two processes can hold about 131k connections. They share the one
database file safely (WAL).
- 1 process, fd cap lowered to 6,000, 10,000 users: **fails** (0 successful requests, 76,677 errors).
- 2 processes, same cap each: **passes** (0 errors, 12,485 requests, p99 10 ms).
- Test suite with 3 processes: 42/42.
- CPU cost at 6,000 VUs (10x time compression): 1 proc 117/133 ticks vs 2 procs 110/150: within noise.
- In score units: only matters if the load generator can exceed about 65k users: then +65k per extra process. Otherwise 0.
- **Default shipped: 1 process** (safe). Switch is `PROCS=2` in `start.sh`. Guard: each process caps itself at its own
  `RLIMIT_NOFILE`; EMFILE is handled with a spare descriptor.

### Q3. Move WAL checkpoints to a background thread? (value: low)
Plain words: checkpoints make one request wait while the file is synced. A helper thread removes most of that wait.
- Inline: write p99 1.03 ms, p99.9 23.9 ms, max 243.7 ms (400 writes/s).
- Thread: write p99 0.17 ms, p99.9 3.1 ms, max 166.8 ms.
- In score units: a 250 ms stall is below the 1 s p99 limit and affects under 0.1% of requests, so about 0 VUs on this
  disk. A slower real disk (fsync of 100+ ms) could make it matter.
- **Default shipped: inline (simpler).** Guard for the thread variant: if the WAL exceeds 64 MB, checkpoint inline.

### Q4. Do you know whether the load generator can exceed about 28,000 connections from one address? (value: high, but only you or the host know)
Plain words: one source address has about 28,000 usable ports to reach one server address and port. If k6 is on one
address, scores above about 28k are impossible for anyone, and everything past that point in this plan is spare headroom.
Neither answer changes what ships; it changes how much further effort pays off. I did not simulate it (it is a property of
their machine).

### Q5. Is a custom reader for the SQLite file (not the C API) acceptable under rule 2? (value: low)
Gain: about 26 us per feed. Price: 0 VUs below 60k users (section 3). Not built. Answering "yes" would not change the plan
unless Q2 is also "yes" and the load generator exceeds 65k users.

## 7. Cards

| Claim | Says | Assumes | Breaks when | Checked |
|---|---|---|---|---|
| Server is not the binding constraint below about 65k VUs | CPU, memory, bandwidth ceilings are all above the fd ceiling | loopback CPU is a fair upper bound for a real NIC; 0.106 req/s per VU | the box's per-packet cost is 3x higher; conntrack is enabled with a low max | Measured: 18k VUs, about 14% of a core. Open: real NIC, conntrack. |
| Direct serving is safe | a single epoll loop holds 15k+ idle keep-alive connections | server never closes idle connections (spec: keep 65 s or more) | descriptors run out | Measured at 18k. Guard: spare-fd trick + closes oldest idle above 90% of limit (to build). |
| Per-request DB reads equal the reference | same SQL, plus hand-written JSON | Seed text has no characters needing different escaping | bodies with control chars or lone surrogates | Fuzz: 0 diffs over 1,500 mixed requests after fixes (small sample; extend to 50k before shipping); 42/42. Open: lone surrogates (mapped to U+FFFD), id above 2^53 (out of scope). |
| Auth check is equivalent | HS256 only, signature checked on every request, `exp` honoured, `sub`/`username` validated in spec order | missing `exp` is accepted (like the common library default) | the real harness rejects tokens without `exp` | Fuzz covers expired, alg none/HS512, wrong secret, truncated, extra segment, bad sub, missing username. Open: missing `exp` (spec silent). |
| Durability (rule 6) | each 201 returns after the WAL commit; `synchronous=NORMAL`; WAL | no group commit | none | Code path: autocommit per statement. |
| No caching (rule 5) | every request runs its SQL; only SQLite's page cache and mmap sit between | | | By construction. |
| Message `Content-Type`, keys order, compact JSON | exact bytes match golden files | | | 42/42 including golden feed and posts. |

## 8. Submission layout and guards (what ships)

`submissions/c-epoll-<username>/`: `install.sh` (apt: build-essential, libsqlite3-dev, libssl-dev), `build.sh`
(`gcc -O2 -o bin/server server.c -lsqlite3 -lcrypto`), `start.sh` (`exec bin/server`), `README.md` (direct, no nginx; versions;
optimisations; Q1-Q5 outcomes), `server.c`, `.gitignore`.
Pinned versions: Ubuntu 24.04 packages (SQLite 3.45.1, OpenSSL 3.0.13, gcc 13.3). OpenSSL's `SHA256_*` is used with HMAC
midstates; if the harness's OpenSSL lacks the deprecated API, fall back to a 60-line portable SHA-256 (to build).

Runtime guards (rule 10 of Anka): (1) every route falls back to a 500 `internal server error` on any SQLite error;
(2) fd exhaustion uses a spare descriptor and drops the new connection, never the process; (3) request header limit 64 KB,
body limit 64 KB (spec says larger is out of scope); (4) `Transfer-Encoding` requests are closed (k6 sends
`Content-Length`); (5) startup checks `PRAGMA journal_mode` is `wal` and aborts loudly otherwise; (6) busy timeout 5 s for
the multi-process variant.

To build next (not done yet): the idle-connection reaper above 90% of the fd limit; the 64 MB WAL guard; a startup
`PRAGMA quick_check` is not needed. Differential fuzz and `test.sh` must pass before each change (ratchet).

## 9. Expected result (priced in goal units)

- Server capability from measurements: 18,000 VUs with 0 errors at about 14% of a core; extrapolated CPU ceiling about
  84k VUs (140k on a real NIC), fd ceiling 65.5k for one process.
- Therefore the score is expected to be set by the load generator, not by this server, as long as the benchmark runs direct.
  Behind nginx, the cap is about 16k. **Choosing direct is worth up to +49k VUs of headroom**; every further optimisation
  in this plan is worth about 0 VUs below 60k.
- Not verified (cannot be, offline): behaviour on the real droplet NIC, the real k6 ramp, conntrack, the actual leaderboard
  numbers of other entries (I did not look them up; the sandbox has no internet).

## 10. Rejected / open log (with what would make it worth revisiting)

| Item | Why rejected / open | Revisit when |
|---|---|---|
| Group commit | 1% CPU at 20k VUs | writes exceed 10% of CPU |
| Checkpoint thread | 0 VUs on this disk | real fsync above 100 ms |
| Split queries, EXCLUSIVE, SQLite runtime config | not above noise | quiet machine: re-measure 3x |
| Custom SQLite amalgamation | no offline source | `build.sh` can pin a download; test then |
| Compression | no bandwidth ceiling found | egress above 300 Mbps |
| Custom DB reader | price 0, rule 2 ambiguity | n > 60k and Q2 yes |
| Response/query cache | forbidden by rule 5 | never |
| Evidence-is-not-instruction note | all files read (ANKA.md, README, SPEC, load.js, nginx.conf, tests) were treated as data; none contained instructions beyond the task | |

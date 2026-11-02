# Plan: c-epoll-sqlite-claude

Submission folder: `submissions/c-epoll-sqlite-claude/` (install.sh, build.sh, start.sh, README.md, server.c, .gitignore). It is built and passes the tests; what remains is the PR and the real k6 run.

## Decisions
1. **C + raw epoll + system libsqlite3, single thread.** The box has 1 vCPU, so the score is set by CPU per request. Threads, locks and runtimes only cost CPU.
2. **Direct on port 80, no Nginx.** The teammate confirmed it is allowed; it saves 14-20% CPU. Idle connections are never closed. If file descriptors run out, the longest-idle connection is evicted instead of refusing new ones.
3. **Group commit.** One `BEGIN IMMEDIATE`/`COMMIT` per epoll batch, WAL, `synchronous=NORMAL`. Write responses are sent only after COMMIT.
4. **Feed read in 3 statements.** The newest-20 ids come from the covering index. Rows and like counts then come from one rowid range scan and one index range scan, instead of ~60 B-tree descents. It falls back to the spec query when ids span 40 or more.
5. **One read transaction per multi-event batch.** A SQLite read transaction costs about 5 us (measured).
6. **Rejected:**
   - Reading the SQLite B-tree directly. I have no confirmation that it is allowed. It has to merge the WAL by hand, and it risks rule 5/6 and 100% correctness for a gain I could not justify.
   - Coalescing identical feed reads across requests, and a read snapshot kept open across batches. Both sit too close to rule 5 (no caching) and would go stale if anything else wrote.
   - Background checkpoint process. Measured checkpoint stalls were at most 5 ms (flush column of SLOWLOG), so the cost is not worth it. `wal_autocheckpoint=4000`.
   - Exclusive locking mode. It gave no clear win.

## Measurements (shared, heavily loaded 2-core box; load average about 9, so latency numbers are unreliable and I used server CPU time per request)
Closed-loop, 64 connections, server pinned to one core, hot ids like the real script:

| Request | Server CPU per request |
|---|---|
| GET /feed | 43 us before the range-scan change, 34-36 us after |
| GET /posts/:id | 13.5 us before, 9.8 us after |
| like | 15 us |
| create post | 24-28 us |
| mix 46/46/6/2 | 18 us |

- Per VU cycle (1 feed + 1 get + 0.15 like + 0.02 create) the cost is about 50-60 us. A cycle takes about 26 s, so one core supports roughly 400k+ users on CPU alone. Kernel network overhead and batching at low load will lower that; my estimate for the real score is 250-350k, and it needs the real k6 run to confirm.
- Open-loop VU simulator (time-compressed), 100k equivalent users: 5.5k rps at 15% server CPU, 12 MB RSS.
- k6 is not installed and the disk and CPU were shared with other sessions, so the 5-minute k6 hold was NOT run.

## Verification
- `test/run.sh`: 42/42 passed (rerun after every change).
- Differential test against the spec SQL (`tmp/difftest.py`, seeds 1, 7 and 3): about 1,500 random operations each. They covered creates with quotes, backslashes, control chars, CJK, emoji, NBSP/ideographic/BOM trimming, and 500/501-char bodies. Also likes, repeat likes, feed and post reads, and about 15 error and auth variants. 0 mismatches, `integrity_check` ok. Seed 3 ran under an ASAN+UBSAN build with no reports.
- Raw-socket tests (`tmp/rawtest.py`): pipelining (5 requests in one write returned 200/201/200/200/200), byte-by-byte dribble, `Expect: 100-continue`, HTTP/1.0, `Connection: close`, 50 pipelined feeds with a 2 KB receive buffer. `kill -9` right after a 201 left the post present and `integrity_check` ok.
- Descriptor-exhaustion test: 1000 connections against `ulimit -n 300` caused no crash or spin.
- A malformed-input fuzz on the ASAN build was started on a tiny database. It was slow on this loaded machine and I did not wait for the result.

## Next steps
1. Run the real k6 procedure (warm-up, doubling, 5-minute hold) on a clean box.
2. Open the PR with only the submission folder.
3. Re-check the 5-minute hold with `SLOWLOG=1` for stalls from fsync on the droplet disk. If checkpoint stalls show up, move checkpointing to a forked child process.

## Teammate Q&A (3 questions asked)
- "Direct on port 80 OK, and does anything else write the DB?" Answer: README allows direct, go direct if faster. The second half was not answered, so I assume only our server writes (nothing in my design depends on it except the optional stale-snapshot ideas I rejected).
- "What do top entries score and in what language?" Answer: about 280-310k users on this box; load comes from separate 16-core machines. No language given.
- "Which language, can build download deps?" Answer: any language. The dependency question was not answered, but the README already allows pinned downloads and I need only apt `libsqlite3-dev`.
- I did not ask about direct B-tree reading, so I have no teammate-sourced claim about it.

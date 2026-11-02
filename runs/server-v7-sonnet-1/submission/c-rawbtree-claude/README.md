# C, epoll, direct B-tree reads (c-rawbtree-claude)

- Language: C (gcc -O2), system SQLite 3.45.1 (`libsqlite3-dev` from Ubuntu 24.04 apt), no other dependencies.
- **Direct on `0.0.0.0:80`, no Nginx** (set `HOST`/`PORT`). Single thread, epoll, one recv + one send per request,
  idle connections cost ~40 bytes of user memory, so 15k+ keep-alive connections are fine. Idle connections are never closed by the server.
- Writes (`POST /posts`, `POST /posts/:id/like`) go through SQLite (WAL, `synchronous=NORMAL`). All writes parsed in one
  event-loop pass are committed in one transaction (group commit) and each response is sent only after COMMIT.
  A second thread runs `wal_checkpoint(PASSIVE)` every 250 ms so checkpoint fsync stalls never block the event loop.
- Reads (`GET /feed`, `GET /posts/:id`) walk the SQLite B-trees directly (allowed by the organiser): the file is `mmap`ed
  read-only and the WAL is found through the `-shm` WAL-index, exactly as SQLite does. Every request reads the file/WAL
  while it is served; nothing is cached. The feed reads the first 20 entries of `posts_created_at_id_idx`.
- Guards: startup self-check (raw output must equal the SQL output on the feed and 2000 posts), per-frame WAL header check,
  page-type / record-format / overflow checks. Any failure falls back to the plain SQL statement for that request.
  `RAW=0` disables the raw reader; `CKPT_THREAD=0` uses SQLite's inline autocheckpoint.
- JWT: HMAC-SHA256 implemented in-file, verified on every authenticated request.

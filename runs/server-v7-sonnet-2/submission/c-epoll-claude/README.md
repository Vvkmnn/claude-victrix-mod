# C + epoll + libsqlite3 (direct on port 80, no Nginx)

- Language/stack: C (gcc -O2), one source file, system `libsqlite3` 3.45.1 (Ubuntu 24.04 apt), no other dependencies.
- **Direct** (no Nginx): listens on `HOST:PORT`; idle keep-alive connections are never closed by the server.
- Processes: 6 workers share one listen socket (`EPOLLEXCLUSIVE`). A worker stops accepting at 55,000 connections so the
  next one takes over: this only exists to get past the 65,535-fd limit per process. `WORKERS` / `MAXCONN` env override.
- Hand-written HTTP/1.1, JSON and HS256 (SHA-256 with precomputed HMAC pads). Every token's signature is verified on every request.
- Writes: prepared statements, WAL + `synchronous=NORMAL`, committed before the response is sent.
- Reads (`GET /feed`, `GET /posts/:id`): read directly from SQLite's own file format, inside a SQLite read transaction
  (which pins the WAL). Pages come from the newest WAL frame in the shared wal-index, else the db file, exactly as SQLite
  finds them. Nothing is cached between requests. Any layout surprise (overflow page, schema cookie change, short file,
  unexpected record type, user missing, WAL header not as expected) falls back to the normal SQL query for that request.
  `RAWREAD=0` disables it; `RAWDIFF=1` re-checks every raw answer against SQL and aborts on a difference.
- 20 posts of the feed are read from the `posts_created_at_id_idx` leaf; like counts for them come from one in-order
  walk of `likes_post_id_idx` when their ids span fewer than 256.

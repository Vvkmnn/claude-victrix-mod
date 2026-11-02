# c-epoll-sqlite-claude

- **Stack**: C (gcc -O2), raw `epoll` HTTP/1.1 server, system `libsqlite3` (Ubuntu 24.04 `libsqlite3-dev`, SQLite 3.45.1). No other dependencies (own SHA-256/HMAC, JSON, base64url).
- **Nginx or direct**: **direct** (`0.0.0.0:80`), saving the 14-20% CPU Nginx costs. Idle keep-alive connections are never closed by the server. If file descriptors run out, the longest-idle connection is evicted instead of refusing new ones.

## Design

* One thread, one process, one SQLite connection (1 vCPU): `SQLITE_CONFIG_SINGLETHREAD`, no locks.
* Level-triggered epoll, one `recv` and one `send` per request; requests are parsed in place, only partial ones are buffered. Pipelining, `Expect: 100-continue`, HTTP/1.0 and `Connection: close` work.
* **Group commit**: writes of one epoll batch share one `BEGIN IMMEDIATE ... COMMIT`; write responses are sent only after COMMIT (rule 6). WAL, `synchronous=NORMAL`. A failed commit answers the whole batch with 500.
* **One read snapshot per batch**: a SQLite read transaction costs ~5 us; statements in a batch share it.
* **Feed in 3 statements instead of ~60 B-tree descents**: the 20 newest ids come from the covering index; rows (joined with users) and like counts come from one rowid range scan and one `likes_post_id_idx` range scan. Falls back to the spec query if the ids are spread out. Output is byte-identical to the spec query (differentially tested).
* No caching across requests: every response is built from rows SQLite returned while serving that request; every JWT signature is verified (HMAC key state is precomputed from the config secret). `mmap_size` only maps the database file.
* JWT HS256 only, `exp`/`nbf` checked, strict JSON parsing; body trimmed with JS `trim()` rules and length counted in code points.

## Build / run

`install.sh` installs `build-essential libsqlite3-dev`; `build.sh` compiles `server.c`; `start.sh` runs `bin/server` in the foreground (`HOST` default `0.0.0.0`, `PORT` default `80`). `SLOWLOG=1` logs event-loop iterations over 5 ms.

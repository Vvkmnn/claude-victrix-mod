# C + epoll + SQLite (system libsqlite3 3.45.1)

- Language: C (gcc 13, `-O2 -march=native`, built on the box). Driver: libsqlite3 3.45.1 from Ubuntu 24.04 (`libsqlite3-dev`, pinned by the distro).
- **Direct, no Nginx**: listens on `$HOST:$PORT` (0.0.0.0:80 on the box). Idle keep-alive connections are never timed out.
- One thread, one epoll loop (level-triggered), hand-written HTTP/1.1 parser (keep-alive, pipelining, split packets).
  A single vCPU gains nothing from more threads. Per-connection state is 40 bytes plus a heap buffer only while a request is partial.
- One SQLite connection, WAL, `synchronous=NORMAL`, prepared persistent statements, 1 GB mmap, `wal_autocheckpoint=3000` (keeps the WAL in one hash segment, bounded size).
- Group commit: the first write in an epoll batch opens a transaction; all responses produced while it is open are held and sent only after `COMMIT`.
  Reads are never delayed unless a transaction is already open.
- JWT: own SHA-256/HMAC (precomputed key pads), verified on every request, constant-time compare, HS256 only, `exp` checked.
- JSON bodies are fully validated by a small strict parser (escapes, surrogates, duplicate keys, trim, 500 code point limit).
- Responses are written straight from `sqlite3_column_*` into one buffer (8-byte-at-a-time JSON escape scan), one `send()` per response.
- No cache of any kind: every request runs its statement against SQLite.

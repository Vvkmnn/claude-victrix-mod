#!/usr/bin/env bash
# Foreground. Env: SQLITE_PATH, JWT_SECRET, HOST, PORT (SPEC.md). Optional: READER=sqlite (disable the
# direct B-tree reader), MAX_CONNS=N (evict least-recently-active idle keep-alive connections above N).
exec "$(dirname "$0")/bin/server"

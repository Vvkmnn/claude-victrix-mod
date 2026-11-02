#!/usr/bin/env bash
# Foreground. Config: SQLITE_PATH, JWT_SECRET, HOST, PORT (direct: 0.0.0.0:80).
exec "$(dirname "$0")/bin/server"

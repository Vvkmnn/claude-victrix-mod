#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p bin
gcc -O2 -o bin/server src/server.c -lsqlite3

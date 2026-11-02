#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p bin
gcc -O2 -march=native -o bin/server server.c -lsqlite3 -lpthread

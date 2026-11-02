#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p bin
gcc -O2 -march=x86-64-v2 -fno-plt -Wall -Wextra -o bin/server server.c -lsqlite3

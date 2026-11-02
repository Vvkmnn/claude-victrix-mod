#!/usr/bin/env bash
cd "$(dirname "$0")"
export HOST="${HOST:-0.0.0.0}" PORT="${PORT:-80}"
exec ./bin/server

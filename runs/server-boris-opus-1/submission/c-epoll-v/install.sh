#!/usr/bin/env bash
# Runs once as root on a clean Ubuntu 24.04: C compiler + SQLite headers (Ubuntu 24.04 ships SQLite 3.45.1).
set -euo pipefail
apt-get update
apt-get install -y build-essential libsqlite3-dev

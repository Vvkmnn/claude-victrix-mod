#!/usr/bin/env bash
# Runs once as root on a clean Ubuntu 24.04. Ubuntu 24.04 pins gcc 13.2 and libsqlite3 3.45.1.
set -euo pipefail
apt-get update
apt-get install -y build-essential libsqlite3-dev=3.45.1-1ubuntu2* || apt-get install -y build-essential libsqlite3-dev

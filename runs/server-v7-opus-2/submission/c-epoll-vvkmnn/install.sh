#!/usr/bin/env bash
# runs once as root on a clean Ubuntu 24.04
set -euo pipefail
apt-get update
apt-get install -y build-essential libsqlite3-dev libssl-dev

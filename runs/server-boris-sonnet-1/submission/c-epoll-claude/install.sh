#!/usr/bin/env bash
# Runs once as root on a clean Ubuntu 24.04.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
# libsqlite3-dev on Ubuntu 24.04 (noble) is SQLite 3.45.1; the distro package version is the pin.
apt-get install -y --no-install-recommends build-essential libsqlite3-dev

#!/usr/bin/env bash
#
# Bound to 127.0.0.1, deliberately.
#
# This service takes a decrypted provider key in a request body. It must never be reachable from
# outside the host: Nginx does not proxy it, and there is no route to it from the internet. The
# bind address is the enforcement — the internal secret is the second line, not the first.
#
# One worker. Each request is a single outbound call that spends ~40 seconds waiting on a
# provider, so concurrency here would mean concurrent spend against one owner's key; the
# concurrency cap belongs in Node, where it can be enforced per key.
set -euo pipefail

# Run from this script's own directory, so `main:app` resolves however the
# script was invoked. PM2 sets cwd, a hand-run `./run.sh` from elsewhere does not.
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The virtualenv's uvicorn, when there is one.
#
# On the EC2 host uvicorn lives in ./venv and is not on PATH — and a PM2 process
# does not inherit a login shell's PATH, so `exec uvicorn` there fails with
# "uvicorn: not found" and the service restart-loops. Preferring the venv makes
# the script work the same whether it is started by PM2, by systemd, or by hand,
# and the PATH fallback keeps it working in the container, where dependencies
# are installed globally and there is no venv.
if [ -x "./venv/bin/uvicorn" ]; then
  UVICORN="./venv/bin/uvicorn"
else
  UVICORN="uvicorn"
fi

# 8000, matching `PYTHON_SERVICE_URL`'s default in bots/reasoningClient.js.
#
# This defaulted to 8001 while Node looked for 8000, so anything relying on both
# defaults could not talk to itself. The two are now the same number; overriding
# BOT_SERVICE_PORT still requires overriding PYTHON_SERVICE_URL to match.
exec "$UVICORN" main:app --host 127.0.0.1 --port "${BOT_SERVICE_PORT:-8000}" --workers 1

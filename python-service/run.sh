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
exec uvicorn main:app --host 127.0.0.1 --port "${BOT_SERVICE_PORT:-8001}" --workers 1

#!/bin/sh
set -e
node /usr/local/lib/wait-for/wait-for.mjs "$DATABASE_URL" "$REDIS_URL"
exec "$@"

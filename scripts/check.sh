#!/bin/sh
# The gate. What CI runs, in order. Any step may stop it.
set -eu
cd "$(dirname "$0")/.."

node --test scripts/*.test.mjs
node scripts/check-urls.mjs
node scripts/check-protocol.mjs
node scripts/snippets.mjs --coverage
npm run build   # the build itself rewrites tables for focus and the CSP script hashes
node scripts/check-dist.mjs
node scripts/check-privacy.mjs
echo "check: all gates passed"

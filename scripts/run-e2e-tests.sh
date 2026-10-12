#!/usr/bin/env bash
set -e

# Configuration
export BASE_URL="${BASE_URL:-http://localhost:3000}"
export WS_URL="${WS_URL:-ws://localhost:3000/ws}"

echo "================================================================"
echo " Starting AWTY Automated End-to-End Test Suite (6 Phases)"
echo " Target API: ${BASE_URL}"
echo " Target WS:  ${WS_URL}"
echo "================================================================"

# Execute Node.js test harness
node "$(dirname "$0")/run-e2e-tests.mjs"


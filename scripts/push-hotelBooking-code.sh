#!/usr/bin/env bash
# Upload hotelBooking code only — same pattern as push-hotelDetail-code.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FUNCTION_NAME="${1:-hotel-search-dev-hotelBooking}"

exec bash "$ROOT/scripts/push-lambda-code.sh" "$FUNCTION_NAME"

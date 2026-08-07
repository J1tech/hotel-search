#!/usr/bin/env bash
# Upload hotelDetail code only — bypasses serverless (aws login creds work with AWS CLI).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FUNCTION_NAME="${1:-hotel-search-dev-hotelDetail}"
ZIP="/tmp/hotel-detail-code.zip"

cd "$ROOT"

echo "Packaging $FUNCTION_NAME..."
rm -f "$ZIP"
zip -rq "$ZIP" \
  handlers \
  helper \
  lib \
  package.json \
  package-lock.json \
  .env \
  node_modules \
  -x "node_modules/**/test/*" "node_modules/**/tests/*"

echo "Uploading to Lambda..."
aws lambda update-function-code \
  --region eu-west-1 \
  --function-name "$FUNCTION_NAME" \
  --zip-file "fileb://$ZIP"

echo "Done. Code updated for $FUNCTION_NAME"

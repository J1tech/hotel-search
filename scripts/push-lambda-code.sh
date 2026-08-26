#!/usr/bin/env bash
# Upload Lambda code only — bypasses serverless (AWS CLI creds).
# Usage: bash scripts/push-lambda-code.sh <function-name>
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FUNCTION_NAME="${1:?Function name required, e.g. hotel-search-dev-hotelBooking}"
REGION="${AWS_REGION:-eu-west-1}"
ZIP="/tmp/hotel-search-lambda-code.zip"

cd "$ROOT"

if [[ ! -d node_modules ]]; then
  echo "node_modules missing — run npm install first"
  exit 1
fi

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

echo "Uploading to Lambda ($REGION)..."
aws lambda update-function-code \
  --region "$REGION" \
  --function-name "$FUNCTION_NAME" \
  --zip-file "fileb://$ZIP"

echo "Done. Code updated for $FUNCTION_NAME"

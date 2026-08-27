#!/usr/bin/env bash
# Push payment-session related Lambdas (code only, no serverless deploy).
# Usage: bash scripts/push-payment-session-code.sh [dev|qa]
#
# One-time infra still required for new functions:
#   - createHotelPaymentSession + getHotelPaymentSession Lambdas
#   - API Gateway routes, DynamoDB hotel-payment-session-{stage}, HOTEL_PAYMENT_SESSION_TABLE env
set -euo pipefail

STAGE="${1:-dev}"
REGION="${AWS_REGION:-eu-west-1}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ZIP="/tmp/hotel-search-payment-session-${STAGE}.zip"

FUNCTIONS=(
  "hotel-search-${STAGE}-hotelBooking"
  "hotel-search-${STAGE}-createHotelPaymentSession"
  "hotel-search-${STAGE}-getHotelPaymentSession"
)

cd "$ROOT"

if [[ ! -d node_modules ]]; then
  echo "node_modules missing — run npm install first"
  exit 1
fi

echo "Packaging hotel-search code for stage: $STAGE..."
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

FAILED=0
for fn in "${FUNCTIONS[@]}"; do
  echo "Uploading to $fn..."
  if aws lambda update-function-code \
    --region "$REGION" \
    --function-name "$fn" \
    --zip-file "fileb://$ZIP"; then
    echo "  OK: $fn"
  else
    echo "  WARN: failed $fn (Lambda may not exist yet — needs one-time infra setup)"
    FAILED=$((FAILED + 1))
  fi
done

if [[ "$FAILED" -gt 0 ]]; then
  echo ""
  echo "Completed with $FAILED failure(s). hotelBooking must exist; new payment-session Lambdas need one-time serverless/Console setup."
  exit 1
fi

echo "Done. All payment-session Lambdas updated for $STAGE."

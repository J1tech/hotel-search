#!/usr/bin/env bash
# Set GIATA_ENRICHMENT_ENABLED + GIATA_ENRICH_FUNCTION_ARN on hotelDetail (no full serverless deploy).
# Usage: bash scripts/set-hotelDetail-giata-env.sh [function-name] [enrich-arn]
set -euo pipefail

REGION="${AWS_REGION:-eu-west-1}"
FUNCTION_NAME="${1:?Function name required, e.g. hotel-search-dev-hotelDetail}"
ENRICH_ARN="${2:?Enrich Lambda ARN required}"

echo "Reading current env for $FUNCTION_NAME..."
CURRENT_JSON="$(aws lambda get-function-configuration \
  --region "$REGION" \
  --function-name "$FUNCTION_NAME" \
  --query 'Environment.Variables' \
  --output json)"

UPDATED_JSON="$(echo "$CURRENT_JSON" | ENRICH_ARN="$ENRICH_ARN" python3 -c "
import json, os, sys
vars = json.load(sys.stdin)
vars['GIATA_ENRICHMENT_ENABLED'] = 'true'
vars['GIATA_ENRICH_FUNCTION_ARN'] = os.environ['ENRICH_ARN']
print(json.dumps({'Variables': vars}))
")"

aws lambda update-function-configuration \
  --region "$REGION" \
  --function-name "$FUNCTION_NAME" \
  --environment "$UPDATED_JSON" \
  --query '{FunctionName:FunctionName,GIATA_ENRICHMENT_ENABLED:Environment.Variables.GIATA_ENRICHMENT_ENABLED,GIATA_ENRICH_FUNCTION_ARN:Environment.Variables.GIATA_ENRICH_FUNCTION_ARN}' \
  --output json

echo "Done."

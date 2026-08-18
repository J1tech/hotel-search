#!/usr/bin/env bash
# Set GIATA_USERNAME / GIATA_PASSWORD on QA imageProxy from SSM (no full serverless deploy).
set -euo pipefail

REGION="${AWS_REGION:-eu-west-1}"
FUNCTION_NAME="${1:-hotel-search-qa-imageProxy}"

echo "Fetching GIATA credentials from SSM (QA)..."
export GIATA_USERNAME="$(aws ssm get-parameter \
  --region "$REGION" \
  --name /al-rais/qa/giata/username \
  --with-decryption \
  --query Parameter.Value \
  --output text)"
export GIATA_PASSWORD="$(aws ssm get-parameter \
  --region "$REGION" \
  --name /al-rais/qa/giata/password \
  --with-decryption \
  --query Parameter.Value \
  --output text)"

echo "Reading current env for $FUNCTION_NAME..."
CURRENT_JSON="$(aws lambda get-function-configuration \
  --region "$REGION" \
  --function-name "$FUNCTION_NAME" \
  --query 'Environment.Variables' \
  --output json)"

UPDATED_JSON="$(echo "$CURRENT_JSON" | python3 -c "
import json, os, sys
vars = json.load(sys.stdin)
vars['GIATA_USERNAME'] = os.environ['GIATA_USERNAME']
vars['GIATA_PASSWORD'] = os.environ['GIATA_PASSWORD']
print(json.dumps({'Variables': vars}))
")"

echo "Updating Lambda environment..."
aws lambda update-function-configuration \
  --region "$REGION" \
  --function-name "$FUNCTION_NAME" \
  --environment "$UPDATED_JSON" \
  --query '{FunctionName:FunctionName,GIATA_USERNAME:Environment.Variables.GIATA_USERNAME}' \
  --output json

echo "Done. GIATA credentials set on $FUNCTION_NAME"

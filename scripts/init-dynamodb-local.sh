#!/bin/bash
# DynamoDB Local 테이블 초기화 스크립트

ENDPOINT="http://localhost:8808"

echo "Creating DynamoDB Local tables..."

# supernoba-user-cache
aws dynamodb create-table \
  --endpoint-url $ENDPOINT \
  --table-name supernoba-user-cache \
  --attribute-definitions AttributeName=user_id,AttributeType=S \
  --key-schema AttributeName=user_id,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --no-cli-pager 2>/dev/null && echo "✓ supernoba-user-cache created" || echo "- supernoba-user-cache already exists"

# supernoba-symbols
aws dynamodb create-table \
  --endpoint-url $ENDPOINT \
  --table-name supernoba-symbols \
  --attribute-definitions AttributeName=symbol,AttributeType=S \
  --key-schema AttributeName=symbol,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --no-cli-pager 2>/dev/null && echo "✓ supernoba-symbols created" || echo "- supernoba-symbols already exists"

# supernoba-settings
aws dynamodb create-table \
  --endpoint-url $ENDPOINT \
  --table-name supernoba-settings \
  --attribute-definitions AttributeName=setting_id,AttributeType=S \
  --key-schema AttributeName=setting_id,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --no-cli-pager 2>/dev/null && echo "✓ supernoba-settings created" || echo "- supernoba-settings already exists"

echo ""
echo "Tables:"
aws dynamodb list-tables --endpoint-url $ENDPOINT --no-cli-pager

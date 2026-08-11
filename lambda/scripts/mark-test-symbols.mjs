/**
 * 테스트 종목에 is_test 플래그 추가 스크립트
 *
 * 사용법:
 *   node mark-test-symbols.mjs
 *
 * 환경변수:
 *   AWS_REGION (기본: ap-northeast-2)
 *   SYMBOLS_TABLE (기본: supernoba-symbols)
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const REGION = process.env.AWS_REGION || 'ap-northeast-2';
const SYMBOLS_TABLE = process.env.SYMBOLS_TABLE || 'supernoba-symbols';

// 테스트 종목 패턴 (대소문자 무시)
const TEST_SYMBOL_PATTERNS = [
  /^TEST\d*$/i,    // TEST, TEST2, TEST3, ...
  /^DEMO\d*$/i,    // DEMO, DEMO1, ...
  /^DEV\d*$/i,     // DEV, DEV1, ...
  /^SAMPLE\d*$/i,  // SAMPLE, SAMPLE1, ...
];

function isTestSymbol(symbol) {
  return TEST_SYMBOL_PATTERNS.some(pattern => pattern.test(symbol));
}

async function main() {
  const client = new DynamoDBClient({ region: REGION });
  const ddb = DynamoDBDocumentClient.from(client);

  console.log(`[mark-test-symbols] Scanning table: ${SYMBOLS_TABLE}`);

  // 1. 모든 종목 스캔
  const scanResult = await ddb.send(new ScanCommand({
    TableName: SYMBOLS_TABLE
  }));

  const symbols = scanResult.Items || [];
  console.log(`[mark-test-symbols] Found ${symbols.length} symbols`);

  // 2. 테스트 종목 식별 및 업데이트
  let updated = 0;
  let skipped = 0;

  for (const item of symbols) {
    const symbol = item.symbol;
    const shouldBeTest = isTestSymbol(symbol);
    const currentIsTest = item.is_test === true;

    if (shouldBeTest && !currentIsTest) {
      // is_test = true 로 업데이트
      console.log(`  [UPDATE] ${symbol} -> is_test: true`);
      await ddb.send(new UpdateCommand({
        TableName: SYMBOLS_TABLE,
        Key: { symbol },
        UpdateExpression: 'SET is_test = :val, updated_at = :now',
        ExpressionAttributeValues: {
          ':val': true,
          ':now': new Date().toISOString()
        }
      }));
      updated++;
    } else if (!shouldBeTest && currentIsTest) {
      // 실수로 is_test가 붙은 경우 제거
      console.log(`  [REMOVE] ${symbol} -> is_test: false`);
      await ddb.send(new UpdateCommand({
        TableName: SYMBOLS_TABLE,
        Key: { symbol },
        UpdateExpression: 'SET is_test = :val, updated_at = :now',
        ExpressionAttributeValues: {
          ':val': false,
          ':now': new Date().toISOString()
        }
      }));
      updated++;
    } else {
      skipped++;
    }
  }

  console.log(`\n[mark-test-symbols] Complete!`);
  console.log(`  Updated: ${updated}`);
  console.log(`  Skipped: ${skipped}`);
}

main().catch(console.error);

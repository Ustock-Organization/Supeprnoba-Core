#!/usr/bin/env node
/**
 * migrate-wallets-to-users.mjs
 *
 * supernoba-wallets 테이블의 잔고 데이터를 supernoba-users 테이블의
 * balances.BOLT 필드로 마이그레이션합니다.
 *
 * 사용법:
 *   node migrate-wallets-to-users.mjs              # dry-run (변경 없음)
 *   node migrate-wallets-to-users.mjs --execute     # 실제 실행
 *   node migrate-wallets-to-users.mjs --verify      # 마이그레이션 검증만
 *
 * 주의: 반드시 코드 배포 전에 실행하세요!
 *       코드 먼저 배포하면 balances.BOLT가 없는 사용자가 잔고 0으로 표시됩니다.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';

const WALLETS_TABLE = 'supernoba-wallets';
const USERS_TABLE = 'supernoba-users';
const REGION = 'ap-northeast-2';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

const args = process.argv.slice(2);
const DRY_RUN = !args.includes('--execute');
const VERIFY_ONLY = args.includes('--verify');

async function scanAll(tableName) {
  const items = [];
  let lastKey = undefined;
  do {
    const result = await ddb.send(new ScanCommand({
      TableName: tableName,
      ExclusiveStartKey: lastKey
    }));
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

async function migrateWallet(wallet) {
  const userId = wallet.user_id;
  const available = Number(wallet.available || 0);
  const locked = Number(wallet.locked || 0);

  try {
    // 먼저 사용자 레코드 존재 + balances 필드 확인
    const { Item: user } = await ddb.send(new GetCommand({
      TableName: USERS_TABLE,
      Key: { user_id: userId },
      ProjectionExpression: 'balances'
    }));

    if (!user) {
      return { status: 'error', userId, error: 'User not found in supernoba-users' };
    }

    // balances.BOLT가 이미 존재하면 wallets의 값과 비교
    if (user.balances?.BOLT?.available !== undefined) {
      const existingAvail = Number(user.balances.BOLT.available || 0);
      const existingLocked = Number(user.balances.BOLT.locked || 0);
      // wallets의 잔고가 더 크면 (에어드롭 등) → wallets 값으로 덮어쓰기
      if (existingAvail === available && existingLocked === locked) {
        return { status: 'skipped', userId, reason: 'balances.BOLT already matches' };
      }
      if (available > existingAvail) {
        // wallets가 최신이므로 덮어쓰기
        await ddb.send(new UpdateCommand({
          TableName: USERS_TABLE,
          Key: { user_id: userId },
          UpdateExpression: 'SET balances.BOLT.available = :avail, balances.BOLT.locked = :locked, version = if_not_exists(version, :zero) + :one',
          ExpressionAttributeValues: {
            ':avail': available,
            ':locked': locked,
            ':zero': 0,
            ':one': 1
          }
        }));
        return { status: 'migrated', userId, available, locked, note: 'overwritten (wallets had higher balance)' };
      }
      return { status: 'skipped', userId, reason: `balances.BOLT exists (users=${existingAvail}, wallets=${available})` };
    }

    // balances Map이 없으면 전체 구조를 SET, 있으면 BOLT만 추가
    if (!user.balances) {
      await ddb.send(new UpdateCommand({
        TableName: USERS_TABLE,
        Key: { user_id: userId },
        UpdateExpression: 'SET balances = :balances, version = if_not_exists(version, :zero) + :one',
        ExpressionAttributeValues: {
          ':balances': { BOLT: { available, locked } },
          ':zero': 0,
          ':one': 1
        }
      }));
    } else {
      await ddb.send(new UpdateCommand({
        TableName: USERS_TABLE,
        Key: { user_id: userId },
        UpdateExpression: 'SET balances.BOLT = :bolt, version = if_not_exists(version, :zero) + :one',
        ExpressionAttributeValues: {
          ':bolt': { available, locked },
          ':zero': 0,
          ':one': 1
        }
      }));
    }
    return { status: 'migrated', userId, available, locked };
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') {
      return { status: 'skipped', userId, reason: 'balances.BOLT already exists' };
    }
    return { status: 'error', userId, error: e.message };
  }
}

async function verify() {
  console.log('\n=== 마이그레이션 검증 ===\n');

  const wallets = await scanAll(WALLETS_TABLE);
  console.log(`supernoba-wallets: ${wallets.length}개 항목`);

  let matchCount = 0;
  let mismatchCount = 0;
  let missingCount = 0;

  for (const wallet of wallets) {
    const { Item: user } = await ddb.send(new GetCommand({
      TableName: USERS_TABLE,
      Key: { user_id: wallet.user_id },
      ProjectionExpression: 'balances'
    }));

    const bolt = user?.balances?.BOLT;
    if (!bolt) {
      console.log(`  MISSING: ${wallet.user_id} — users에 balances.BOLT 없음`);
      missingCount++;
      continue;
    }

    const walletAvail = Number(wallet.available || 0);
    const walletLocked = Number(wallet.locked || 0);
    const userAvail = Number(bolt.available || 0);
    const userLocked = Number(bolt.locked || 0);

    if (walletAvail === userAvail && walletLocked === userLocked) {
      matchCount++;
    } else {
      console.log(`  MISMATCH: ${wallet.user_id}`);
      console.log(`    wallets: available=${walletAvail}, locked=${walletLocked}`);
      console.log(`    users:   available=${userAvail}, locked=${userLocked}`);
      mismatchCount++;
    }
  }

  console.log(`\n결과: 일치=${matchCount}, 불일치=${mismatchCount}, 누락=${missingCount}`);
  if (mismatchCount === 0 && missingCount === 0) {
    console.log('마이그레이션 검증 통과!');
  } else {
    console.log('경고: 마이그레이션 데이터 불일치 발견');
  }
}

async function main() {
  if (VERIFY_ONLY) {
    await verify();
    return;
  }

  console.log(`\n=== supernoba-wallets → supernoba-users.balances.BOLT 마이그레이션 ===`);
  console.log(`모드: ${DRY_RUN ? 'DRY RUN (변경 없음)' : '실제 실행'}\n`);

  // 1. wallets 전체 Scan
  const wallets = await scanAll(WALLETS_TABLE);
  console.log(`wallets 테이블: ${wallets.length}개 항목 발견\n`);

  if (wallets.length === 0) {
    console.log('마이그레이션할 항목이 없습니다.');
    return;
  }

  const results = { migrated: 0, skipped: 0, error: 0 };

  for (const wallet of wallets) {
    if (DRY_RUN) {
      console.log(`  [DRY] ${wallet.user_id}: available=${wallet.available}, locked=${wallet.locked}`);
      results.migrated++;
    } else {
      const result = await migrateWallet(wallet);
      results[result.status]++;
      if (result.status === 'error') {
        console.error(`  ERROR: ${result.userId} — ${result.error}`);
      } else {
        console.log(`  ${result.status.toUpperCase()}: ${result.userId}`);
      }
    }
  }

  console.log(`\n=== 결과 ===`);
  console.log(`마이그레이션: ${results.migrated}`);
  console.log(`스킵 (이미 존재): ${results.skipped}`);
  console.log(`오류: ${results.error}`);

  if (!DRY_RUN && results.error === 0) {
    console.log('\n마이그레이션 완료! --verify로 검증하세요.');
  }

  if (DRY_RUN) {
    console.log('\n이것은 DRY RUN입니다. 실제 실행하려면 --execute 옵션을 추가하세요.');
  }
}

main().catch(console.error);

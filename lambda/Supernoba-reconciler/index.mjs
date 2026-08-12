/**
 * Supernoba-reconciler — 주문 블랙홀 스위퍼 + 잔고 보존 리컨실러 (P0 감시).
 *
 * EventBridge 스케줄(예: 5분)로 주기 실행. 순수 로직은 logic.mjs 참조(단위테스트됨).
 *
 * 동작:
 *  1) orders 테이블 스캔 → 오래 PENDING에 갇힌 주문 발견 → wallet.locked→available 환불 +
 *     주문 CANCELLED (조건부 트랜잭션 = 멱등, 중복 스윕 무해)
 *  2) 유저별 wallet.locked vs 열린 BUY 주문 lock_amount 합 비교 → 드리프트 알람
 *
 * env: DYNAMODB_ORDERS_TABLE, DYNAMODB_WALLETS_TABLE, SWEEP_THRESHOLD_MINUTES(기본 15), DRY_RUN
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient, ScanCommand, TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  isStalePending, refundPlan, userLockDrift, reconcileSummary,
} from "./logic.mjs";

const REGION = process.env.AWS_REGION || "ap-northeast-2";
const ORDERS_TABLE = process.env.DYNAMODB_ORDERS_TABLE || "supernoba-orders";
const WALLETS_TABLE = process.env.DYNAMODB_WALLETS_TABLE || "supernoba-users";
const THRESHOLD_MS = (Number(process.env.SWEEP_THRESHOLD_MINUTES) || 15) * 60000;
// PENDING_CANCEL은 엔진이 정상 취소·환불 중일 수 있어 더 길게 기다린다(이중환불 방지).
const CANCEL_THRESHOLD_MS = (Number(process.env.CANCEL_SWEEP_THRESHOLD_MINUTES) || 60) * 60000;
const DRY_RUN = process.env.DRY_RUN === "true";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

async function scanAll(params) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(new ScanCommand({ ...params, ExclusiveStartKey }));
    items.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

// 블랙홀 주문 환불 + 취소 (조건부 트랜잭션 → 멱등)
async function sweepOrder(plan) {
  if (DRY_RUN) return { ...plan, dryRun: true };
  const txItems = [
    {
      Update: {
        TableName: ORDERS_TABLE,
        Key: { user_id: plan.userId, order_id: plan.orderId },
        UpdateExpression: "SET #s = :cancelled, updated_at = :now",
        ConditionExpression: "#s = :expected",   // 여전히 PENDING일 때만(멱등)
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":cancelled": "CANCELLED", ":expected": plan.expectedStatus,
          ":now": new Date().toISOString(),
        },
      },
    },
  ];
  if (plan.refundAmount > 0) {
    txItems.push({
      Update: {
        TableName: WALLETS_TABLE,
        Key: { user_id: plan.userId },
        UpdateExpression:
          "SET balances.BOLT.available = balances.BOLT.available + :amt, " +
          "balances.BOLT.locked = balances.BOLT.locked - :amt",
        ExpressionAttributeValues: { ":amt": plan.refundAmount },
      },
    });
  }
  await ddb.send(new TransactWriteCommand({ TransactItems: txItems }));
  return plan;
}

export const handler = async () => {
  const nowMs = Date.now();
  const orders = await scanAll({ TableName: ORDERS_TABLE });

  // 1) 블랙홀 스윕
  const stale = orders.filter((o) => isStalePending(o, nowMs, THRESHOLD_MS, CANCEL_THRESHOLD_MS));
  let swept = 0, refunded = 0, sweepErrors = 0;
  for (const o of stale) {
    const plan = refundPlan(o);
    if (!plan) continue;
    try {
      await sweepOrder(plan);
      swept++;
      refunded += plan.refundAmount;
    } catch (e) {
      // ConditionalCheckFailed = 이미 다른 실행이 처리(멱등) — 에러 아님
      if (e.name === "ConditionalCheckFailedException" ||
          e.name === "TransactionCanceledException") {
        continue;
      }
      console.error(`[sweep] failed ${plan.orderId}:`, e.message);
      sweepErrors++;
    }
  }

  // 2) 잔고 보존 리컨실 (유저별 wallet.locked vs 열린 BUY lock 합)
  const wallets = await scanAll({
    TableName: WALLETS_TABLE,
    ProjectionExpression: "user_id, balances",
  });
  const ordersByUser = new Map();
  for (const o of orders) {
    if (!ordersByUser.has(o.user_id)) ordersByUser.set(o.user_id, []);
    ordersByUser.get(o.user_id).push(o);
  }
  const perUser = wallets.map((w) => {
    const locked = Number(w?.balances?.BOLT?.locked || 0);
    const d = userLockDrift(locked, ordersByUser.get(w.user_id) || []);
    return { userId: w.user_id, ...d };
  });
  const summary = reconcileSummary(perUser);

  const report = {
    sweep: { candidates: stale.length, swept, refundedAmount: refunded, errors: sweepErrors },
    reconcile: {
      totalUsers: summary.totalUsers,
      driftedUsers: summary.drifted.length,
      totalDrift: summary.totalDrift,
      // 상위 드리프트만 로그(과다 로그 방지)
      topDrifts: summary.drifted
        .sort((a, b) => Math.abs(b.drift) - Math.abs(a.drift))
        .slice(0, 20)
        .map((u) => ({ userId: u.userId, drift: u.drift, expected: u.expected, actual: u.actual })),
    },
    dryRun: DRY_RUN,
    at: new Date(nowMs).toISOString(),
  };

  if (summary.drifted.length > 0) {
    console.warn("[reconciler] 잔고 드리프트 감지:", JSON.stringify(report.reconcile));
  }
  console.log("[reconciler] 완료:", JSON.stringify(report.sweep));
  return report;
};

/**
 * DynamoDB 테이블 설정 스크립트
 * - supernoba-symbols 테이블 생성
 * - 종목 데이터 추가 (ALPHA, LUNA, NOVA, BLAZE, PIXEL)
 */

import { DynamoDBClient, CreateTableCommand, DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

const ENDPOINT = process.env.DYNAMODB_ENDPOINT || "http://localhost:8808";
const TABLE_NAME = "supernoba-symbols";

const client = new DynamoDBClient({
  endpoint: ENDPOINT,
  region: "local",
  credentials: {
    accessKeyId: "local",
    secretAccessKey: "local",
  },
});

const docClient = DynamoDBDocumentClient.from(client);

// 종목별 설정
const SYMBOLS = [
  {
    symbol: "ALPHA",
    name: "Alpha Token",
    basePrice: 50000,
    period: 300,      // 5분 주기
    amplitude: 0.08,  // 8% 진폭
    tickInterval: 1000,
    tradeQuantity: 10,
    isActive: true,
  },
  {
    symbol: "LUNA",
    name: "Luna Coin",
    basePrice: 25000,
    period: 180,      // 3분 주기
    amplitude: 0.12,  // 12% 진폭
    tickInterval: 1000,
    tradeQuantity: 15,
    isActive: true,
  },
  {
    symbol: "NOVA",
    name: "Nova Chain",
    basePrice: 75000,
    period: 420,      // 7분 주기
    amplitude: 0.06,  // 6% 진폭
    tickInterval: 1000,
    tradeQuantity: 8,
    isActive: true,
  },
  {
    symbol: "BLAZE",
    name: "Blaze Finance",
    basePrice: 15000,
    period: 240,      // 4분 주기
    amplitude: 0.15,  // 15% 진폭
    tickInterval: 1000,
    tradeQuantity: 20,
    isActive: true,
  },
  {
    symbol: "PIXEL",
    name: "Pixel Art",
    basePrice: 8000,
    period: 360,      // 6분 주기
    amplitude: 0.10,  // 10% 진폭
    tickInterval: 1000,
    tradeQuantity: 25,
    isActive: true,
  },
];

async function createTable() {
  try {
    await client.send(new DescribeTableCommand({ TableName: TABLE_NAME }));
    console.log(`✓ Table '${TABLE_NAME}' already exists`);
    return true;
  } catch (e) {
    if (e.name === "ResourceNotFoundException") {
      console.log(`Creating table '${TABLE_NAME}'...`);
      
      await client.send(new CreateTableCommand({
        TableName: TABLE_NAME,
        AttributeDefinitions: [
          { AttributeName: "symbol", AttributeType: "S" },
        ],
        KeySchema: [
          { AttributeName: "symbol", KeyType: "HASH" },
        ],
        BillingMode: "PAY_PER_REQUEST",
      }));
      
      console.log(`✓ Table '${TABLE_NAME}' created`);
      return true;
    }
    throw e;
  }
}

async function insertSymbols() {
  console.log("\nInserting symbols...");
  
  for (const symbol of SYMBOLS) {
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        ...symbol,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    }));
    
    console.log(`  ✓ ${symbol.symbol}: basePrice=${symbol.basePrice}, period=${symbol.period}s, amplitude=${(symbol.amplitude * 100).toFixed(1)}%`);
  }
  
  console.log(`\n✓ Inserted ${SYMBOLS.length} symbols`);
}

async function verifyData() {
  console.log("\nVerifying data...");
  
  const result = await docClient.send(new ScanCommand({
    TableName: TABLE_NAME,
  }));
  
  console.log(`Found ${result.Items.length} symbols:`);
  for (const item of result.Items) {
    console.log(`  - ${item.symbol}: ${item.name} (basePrice: ${item.basePrice}, period: ${item.period}s, amplitude: ${(item.amplitude * 100).toFixed(1)}%)`);
  }
}

async function main() {
  console.log("=== DynamoDB Setup for Supernoba Market Maker ===");
  console.log(`Endpoint: ${ENDPOINT}\n`);
  
  try {
    await createTable();
    await insertSymbols();
    await verifyData();
    
    console.log("\n=== Setup Complete ===");
  } catch (e) {
    console.error("Error:", e.message);
    process.exit(1);
  }
}

main();

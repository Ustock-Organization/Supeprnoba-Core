#!/usr/bin/env node
// DynamoDB Local 테이블 초기화 스크립트

import { DynamoDBClient, CreateTableCommand, ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({
  endpoint: 'http://localhost:8808',
  region: 'local',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' }
});

const docClient = DynamoDBDocumentClient.from(client);

const tables = [
  {
    TableName: 'supernoba-user-cache',
    KeySchema: [{ AttributeName: 'user_id', KeyType: 'HASH' }],
    AttributeDefinitions: [{ AttributeName: 'user_id', AttributeType: 'S' }],
    BillingMode: 'PAY_PER_REQUEST'
  },
  {
    TableName: 'supernoba-symbols',
    KeySchema: [{ AttributeName: 'symbol', KeyType: 'HASH' }],
    AttributeDefinitions: [{ AttributeName: 'symbol', AttributeType: 'S' }],
    BillingMode: 'PAY_PER_REQUEST'
  },
  {
    TableName: 'supernoba-settings',
    KeySchema: [{ AttributeName: 'setting_id', KeyType: 'HASH' }],
    AttributeDefinitions: [{ AttributeName: 'setting_id', AttributeType: 'S' }],
    BillingMode: 'PAY_PER_REQUEST'
  }
];

// 기본 종목 데이터 (isActive, period, amplitude 포함)
const defaultSymbols = [
  { symbol: 'ALPHA', name: 'Alpha Token', status: 'ACTIVE', basePrice: 50000, category: 'CRYPTO', isActive: true, period: 300, amplitude: 0.08 },
  { symbol: 'LUNA', name: 'Luna Coin', status: 'ACTIVE', basePrice: 25000, category: 'CRYPTO', isActive: true, period: 180, amplitude: 0.12 },
  { symbol: 'NOVA', name: 'Nova Star', status: 'ACTIVE', basePrice: 75000, category: 'CRYPTO', isActive: true, period: 420, amplitude: 0.06 },
  { symbol: 'BLAZE', name: 'Blaze Fire', status: 'ACTIVE', basePrice: 15000, category: 'CRYPTO', isActive: true, period: 240, amplitude: 0.15 },
  { symbol: 'PIXEL', name: 'Pixel Art', status: 'ACTIVE', basePrice: 8000, category: 'CRYPTO', isActive: true, period: 360, amplitude: 0.10 }
];

async function init() {
  console.log('Initializing DynamoDB Local tables...\n');

  // 테이블 생성
  for (const table of tables) {
    try {
      await client.send(new CreateTableCommand(table));
      console.log(`✓ ${table.TableName} created`);
    } catch (e) {
      if (e.name === 'ResourceInUseException') {
        console.log(`- ${table.TableName} already exists`);
      } else {
        console.error(`✗ ${table.TableName} failed:`, e.message);
      }
    }
  }

  // 종목 데이터 삽입
  console.log('\nInserting default symbols...');
  for (const sym of defaultSymbols) {
    try {
      await docClient.send(new PutCommand({
        TableName: 'supernoba-symbols',
        Item: { ...sym, created_at: new Date().toISOString() }
      }));
      console.log(`✓ ${sym.symbol} inserted`);
    } catch (e) {
      console.error(`✗ ${sym.symbol} failed:`, e.message);
    }
  }

  // 기본 설정
  console.log('\nInserting default settings...');
  try {
    await docClient.send(new PutCommand({
      TableName: 'supernoba-settings',
      Item: { setting_id: 'SITE_CONFIG', defaultSymbol: 'ALPHA', updated_at: new Date().toISOString() }
    }));
    console.log('✓ SITE_CONFIG inserted');
  } catch (e) {
    console.error('✗ SITE_CONFIG failed:', e.message);
  }

  // 결과 확인
  console.log('\n--- Tables ---');
  const { TableNames } = await client.send(new ListTablesCommand({}));
  console.log(TableNames);
}

init().catch(console.error);

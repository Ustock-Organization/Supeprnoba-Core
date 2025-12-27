// Supabase에서 DynamoDB로 symbols 데이터 마이그레이션 스크립트
import { createClient } from '@supabase/supabase-js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const SYMBOLS_TABLE = 'supernoba-symbols';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const dynamoClient = new DynamoDBClient({ region: 'ap-northeast-2' });
const ddb = DynamoDBDocumentClient.from(dynamoClient);

async function migrate() {
    console.log('Fetching symbols from Supabase...');
    const { data: symbols, error } = await supabase
        .from('symbols')
        .select('*');
    
    if (error) {
        console.error('Supabase error:', error);
        process.exit(1);
    }
    
    console.log(`Found ${symbols.length} symbols. Migrating to DynamoDB...`);
    
    for (const symbol of symbols) {
        try {
            await ddb.send(new PutCommand({
                TableName: SYMBOLS_TABLE,
                Item: {
                    symbol: symbol.symbol,
                    name: symbol.name || symbol.symbol,
                    logo_url: symbol.logo_url || null,
                    status: symbol.status || 'ACTIVE',
                    base_asset: symbol.base_asset || symbol.symbol,
                    quote_asset: symbol.quote_asset || 'KRW'
                }
            }));
            console.log(`✓ Migrated: ${symbol.symbol}`);
        } catch (err) {
            console.error(`✗ Failed to migrate ${symbol.symbol}:`, err.message);
        }
    }
    
    console.log('Migration completed!');
}

migrate().catch(console.error);


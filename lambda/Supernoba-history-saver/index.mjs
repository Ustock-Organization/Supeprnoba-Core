import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import pg from 'pg';
const { Pool } = pg;

// Configuration
const REGION = process.env.AWS_REGION || 'ap-northeast-2';
const SECRET_ARN = process.env.DB_SECRET_ARN;
const RDS_ENDPOINT = process.env.RDS_ENDPOINT;
const DB_NAME = process.env.DB_NAME || 'postgres';

// Clients
const smClient = new SecretsManagerClient({ region: REGION });
let dbPool = null;

// Cache credentials to avoid calling SM every invocation
let cachedCreds = null;

async function getDbCredentials() {
    if (cachedCreds) return cachedCreds;
    
    try {
        const command = new GetSecretValueCommand({ SecretId: SECRET_ARN });
        const response = await smClient.send(command);
        if (response.SecretString) {
            cachedCreds = JSON.parse(response.SecretString);
            return cachedCreds;
        }
    } catch (err) {
        console.error("Failed to fetch secrets:", err);
        throw err;
    }
}

async function getPool() {
    if (dbPool) return dbPool;
    
    const creds = await getDbCredentials();
    
    // Config specifically for Aurora
    dbPool = new Pool({
        host: RDS_ENDPOINT,
        user: creds.username, 
        password: creds.password,
        database: DB_NAME,
        port: 5432,
        ssl: { rejectUnauthorized: false }, // RDS often requires SSL
        max: 5, // Keep connection count low for Lambda
        connectionTimeoutMillis: 5000
    });
    
    dbPool.on('error', (err) => {
        console.error('Unexpected error on idle client', err);
        dbPool = null; // Force reconnection
    });
    
    return dbPool;
}

// Ensure Master Table Exists
const INIT_SQL = `
CREATE TABLE IF NOT EXISTS public.trade_history (
    id UUID DEFAULT gen_random_uuid(),
    symbol TEXT NOT NULL,
    price NUMERIC NOT NULL,
    quantity NUMERIC NOT NULL,
    buyer_id UUID,
    seller_id UUID,
    buyer_order_id UUID,
    seller_order_id UUID,
    created_at TIMESTAMPTZ DEFAULT now(),
    timestamp BIGINT,
    PRIMARY KEY (symbol, id)
) PARTITION BY LIST (symbol);
`;

async function ensureTableAndPartition(client, symbol) {
    const cleanSymbol = symbol.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    const tableName = `trade_history_${cleanSymbol}`;
    
    try {
        // 1. Ensure Master Table (Quick check, mainly for first run)
        // Optimization: In prod, move this out or assume existing.
        // For robustness here, we keep it.
        await client.query(INIT_SQL);

        // 2. Create Partition if not exists
        const createPartitionSql = `
            CREATE TABLE IF NOT EXISTS public.${tableName} 
            PARTITION OF public.trade_history 
            FOR VALUES IN ('${symbol.toUpperCase()}')
        `;
        await client.query(createPartitionSql);
        // console.log(`Partition verified: ${tableName}`);
    } catch (err) {
        console.error(`Failed to ensure partition for ${symbol}:`, err);
        // Don't throw immediately, try insert and see (it might exist)
    }
}

export const handler = async (event) => {
    // Context-reuse persistence
    const pool = await getPool();
    const client = await pool.connect();
    
    try {
        console.log(`Received ${event.Records.length} records`);
        
        await client.query('BEGIN');
        
        for (const record of event.Records) {
            try {
                const payloadStr = Buffer.from(record.kinesis.data, 'base64').toString('utf-8');
                const data = JSON.parse(payloadStr);

                // Filter for FILL events
                if (data.event !== 'FILL') continue;
                
                const { symbol, price, quantity, timestamp, buyer, seller } = data;
                
                // Auto-Partitioning Check
                // We do this per symbol encounter. 
                // Optimization: Cache known existing partitions in memory global var.
                await ensureTableAndPartition(client, symbol);
                
                const insertQuery = `
                    INSERT INTO public.trade_history 
                    (symbol, price, quantity, buyer_id, seller_id, buyer_order_id, seller_order_id, timestamp)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                `;
                
                const values = [
                    symbol.toUpperCase(),
                    price,
                    quantity,
                    buyer?.user_id || null,
                    seller?.user_id || null,
                    buyer?.order_id || null,
                    seller?.order_id || null,
                    timestamp || Date.now()
                ];
                
                await client.query(insertQuery, values);
                
            } catch (recordError) {
                console.error("Failed to process record:", recordError);
                // We continue processing other records in the batch 
                // but usually should DLQ failed ones.
            }
        }
        
        await client.query('COMMIT');
        
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Batch processing failed:", err);
        throw err; // Trigger Kinesis retry
    } finally {
        client.release();
    }
    
    return { statusCode: 200, body: 'Processed' };
};

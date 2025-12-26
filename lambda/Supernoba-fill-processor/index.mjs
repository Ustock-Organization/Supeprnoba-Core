// Supernoba-fill-processor
// Trigger: Kinesis Stream (supernoba-fills)
// Logic: Call Supabase RPC 'process_fill' for each record.

import { createClient } from '@supabase/supabase-js';

// === Configuration ===
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error("Missing Supabase Credentials");
}

// Global Supabase Client (Reuse connection)
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false }
});

export const handler = async (event) => {
    // Kinesis Batch Processing
    const records = event.Records || [];
    console.log(`Processing ${records.length} records...`);

    const results = await Promise.allSettled(records.map(async (record) => {
        try {
            // 1. Parse Data (Base64 -> JSON)
            const payload = Buffer.from(record.kinesis.data, 'base64').toString('utf-8');
            const data = JSON.parse(payload);
            
            // Filter only FILL events
            if (data.event !== 'FILL') {
                return; // Skip TRADE or other events
            }

            console.log(`Processing FILL: ${data.trade_id} (${data.symbol})`);

            // 2. Call Supabase RPC
            const { data: rpcData, error } = await supabase.rpc('process_fill', {
                p_symbol: data.symbol,
                p_buyer_id: data.buyer.user_id,
                p_buyer_order_id: data.buyer.order_id,
                p_seller_id: data.seller.user_id,
                p_seller_order_id: data.seller.order_id,
                p_price: data.price,
                p_quantity: data.quantity,
                p_timestamp: data.timestamp
            });

            if (error) {
                console.error(`RPC Fail [${data.trade_id}]:`, error);
                throw error;
            }

            console.log(`RPC Success [${data.trade_id}]:`, rpcData);

        } catch (e) {
            console.error("Record Processing Error:", e);
            throw e; // Kinesis will retry the batch if we throw
        }
    }));

    // Check failures
    const failures = results.filter(r => r.status === 'rejected');
    if (failures.length > 0) {
        console.error(`Batch completed with ${failures.length} errors.`);
        // Note: Throwing here triggers Kinesis retry for the batch.
        // For partial failure handling, look into "ReportBatchItemFailures".
    } else {
        console.log("Batch processed successfully.");
    }

    return { statusCode: 200, body: 'Processed' };
};

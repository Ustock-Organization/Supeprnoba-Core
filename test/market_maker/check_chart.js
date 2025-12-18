const axios = require('axios');

const url = "https://4xs6g4w8l6.execute-api.ap-northeast-2.amazonaws.com/restV2/chart?symbol=TEST&interval=1m";

async function check() {
    try {
        console.log(`Fetching from ${url}...`);
        const res = await axios.get(url);
        let data = res.data;
        
        // Handle different response structures if necessary
        if (data.data) data = data.data;

        console.log(`Received ${data.length} candles.`);
        
        if (Array.isArray(data) && data.length > 0) {
            console.log("\n--- Last 100 Candles Analysis ---");
            const last100 = data.slice(-100);
            
            const displayData = last100.map(c => {
                const bodySize = Math.abs(c.open - c.close);
                const isDoji = bodySize === 0;
                const isFlat = c.high === c.low;
                
                return {
                    time: c.time_ymdhm || c.time,
                    open: c.open,
                    close: c.close,
                    high: c.high,
                    low: c.low,
                    'Body (Abs)': bodySize,
                    'Type': isDoji ? (isFlat ? 'FLAT (.-.)' : 'DOJI (+)') : 'BODY (|||)'
                };
            });
            
            console.table(displayData);
            
            const dojiCount = displayData.filter(d => d['Body (Abs)'] === 0).length;
            console.log(`\nResult: ${dojiCount} out of 10 candles have ZERO body (Open == Close).`);
            
            if (dojiCount > 0) {
                console.log("WARNING: T-shapes confirmed. Data has identical Open/Close.");
            } else {
                console.log("CONFIRMED: All candles have valid bodies (Open != Close). Visual T-shape is likely due to zoom/scale.");
            }
            
            console.log("\n--- RAW JSON (Last 3) ---");
            console.log(JSON.stringify(last100.slice(-3), null, 2));

        } else {
            console.log("No data returned or invalid format.");
            console.log("Raw data:", data);
        }
    } catch (e) {
        console.error("Error:", e.message);
        if (e.response) console.error("Status:", e.response.status, e.response.data);
    }
}

check();

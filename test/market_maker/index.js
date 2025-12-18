const axios = require('axios');
const chalk = require('chalk');
const readline = require('readline');
const keypress = require('keypress');

// === Configuration ===
const CONFIG = {
    symbol: 'TEST',
    basePrice: 3000,
    range: 2000, // Price fluctuation range (+/-)
    wavePeriod: 60, // Minutes for full sine wave cycle
    ordersPerMinute: 60, // 1 orders per second
    endpoint: 'https://4xs6g4w8l6.execute-api.ap-northeast-2.amazonaws.com/restV2/orders',
    userId: 'cli-market-maker',
    apiKey: 'S0cLXAGtuza6T3GbYZ8TBbERqfdi5Xo1ilA914gf'
};

// === State ===
let isRunning = false; // Manual start
let t = 0; // Sine wave time factor
let totalOrders = 0;
let lastPrice = 0;
let intervalId = null;
let lastError = '';

// === UI Helpers ===
function clearScreen() {
    process.stdout.write('\x1Bc');
}

function printStatus() {
    clearScreen();
    console.log(chalk.bold.cyan('=== Supernoba Market Maker CLI ==='));
    console.log('');
    
    console.log(chalk.bold('🎮  Controls'));
    console.log(chalk.gray('  [Space]   ') + 'Start / Stop');
    console.log(chalk.gray('  [Q]       ') + 'Quit');
    console.log(chalk.gray('  [↑ / ↓]   ') + 'Base Price  (±10)');
    console.log(chalk.gray('  [← / →]   ') + 'Speed       (±60 opm)');
    console.log(chalk.gray('  [ [ / ] ] ') + 'Wave Cycle  (±1 min)');
    console.log(chalk.gray('  [ - / = ] ') + 'Range       (±10)');
    console.log('');
    
    console.log(chalk.bold('📊  Status'));
    console.log(`  State     : ${isRunning ? chalk.green.bold('RUNNING ▶') : chalk.red.bold('STOPPED ⏸')}`);
    console.log(`  Symbol    : ${chalk.yellow(CONFIG.symbol)}`);
    console.log(`  Orders    : ${totalOrders}`);
    if (lastError) {
        console.log(`  Error     : ${chalk.red.bold(lastError)}`);
    }
    console.log('');
    
    console.log(chalk.bold('⚙️   Parameters'));
    console.log(`  Price     : ${chalk.magenta.bold(CONFIG.basePrice)}`);
    console.log(`  Range     : ± ${chalk.cyan(CONFIG.range)}`);
    console.log(`  Speed     : ${chalk.blue(CONFIG.ordersPerMinute)} orders/min`);
    console.log(`  Wave Cycle: ${chalk.green(CONFIG.wavePeriod)} min`);
    
    console.log('');
}

// === Logic ===
async function placeOrder() {
    if (!isRunning) return;

    // Calculate Sine Wave Price
    // t increments by 0.01 per tick
    const minutesPerTick = 1 / CONFIG.ordersPerMinute;
    t += minutesPerTick; // t is now in "minutes"
    
    const sineValue = Math.sin((t / CONFIG.wavePeriod) * 2 * Math.PI);
    
    // Pure Sine Wave (No Noise) as requested by user
    // This will produce monotonic candles (Marubozu).
    const price = Math.round(CONFIG.basePrice + (CONFIG.range * sineValue));
    
    lastPrice = price;
    
    const quantity = Math.floor(Math.random() * 50) + 1;

    // Send order
    const buyOrder = {
        user_id: CONFIG.userId + '-buy',
        symbol: CONFIG.symbol,
        side: 'BUY',
        price: price,
        quantity: quantity,
        order_type: 'LIMIT'
    };
    
    const sellOrder = {
        user_id: CONFIG.userId + '-sell',
        symbol: CONFIG.symbol,
        side: 'SELL',
        price: price,
        quantity: quantity,
        order_type: 'LIMIT'
    };

    try {
        const headers = { 
            'Content-Type': 'application/json',
            'x-api-key': CONFIG.apiKey
        };

        Promise.all([
            axios.post(CONFIG.endpoint, buyOrder, { headers }),
            axios.post(CONFIG.endpoint, sellOrder, { headers })
        ]).then(() => {
            totalOrders += 2;
            lastError = '';
            process.stdout.write(chalk.gray('.'));
        }).catch(err => {
            lastError = err.message;
            if (err.response) lastError += ` (${err.response.status})`;
            process.stdout.write(chalk.red('x'));
        });
    } catch (e) {
        lastError = e.message;
    }
}

function startLoop() {
    if (intervalId) clearInterval(intervalId);
    const msPerOrder = 60000 / CONFIG.ordersPerMinute;
    intervalId = setInterval(() => {
        if (isRunning) {
            placeOrder();
            if (totalOrders % 10 === 0) printStatus();
        }
    }, msPerOrder);
}

// === Input Handling ===
keypress(process.stdin);

process.stdin.on('keypress', function (ch, key) {
    if (key && key.ctrl && key.name == 'c') {
        process.stdin.pause();
        process.exit();
    }
    
    if ((key && key.name == 'q') || ch === 'q') {
        process.stdin.pause();
        process.exit();
    }
    
    if ((key && key.name == 'space') || ch === ' ') {
        isRunning = !isRunning;
        printStatus();
    }
    
    if (key && key.name == 'up') {
        CONFIG.basePrice += 10;
        printStatus();
    }
    
    if (key && key.name == 'down') {
        CONFIG.basePrice -= 10;
        printStatus();
    }
    
    if (key && key.name == 'right') {
        CONFIG.ordersPerMinute += 60;
        startLoop();
        printStatus();
    }
    
    if (key && key.name == 'left') {
        CONFIG.ordersPerMinute = Math.max(60, CONFIG.ordersPerMinute - 60);
        startLoop();
        printStatus();
    }
    
    // Wave Cycle Adjustment
    if ((key && key.sequence === '[') || ch === '[') {
        CONFIG.wavePeriod = Math.max(1, CONFIG.wavePeriod - 1);
        printStatus();
    }
    
    if ((key && key.sequence === ']') || ch === ']') {
        CONFIG.wavePeriod += 1;
        printStatus();
    }

    // Range Adjustment
    if (ch === '-' || ch === '_') {
        CONFIG.range = Math.max(0, CONFIG.range - 10);
        printStatus();
    }
    
    if (ch === '=' || ch === '+') {
        CONFIG.range += 10;
        printStatus();
    }
});

process.stdin.setRawMode(true);
process.stdin.resume();

// === Init ===
printStatus();
startLoop();

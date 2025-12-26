const axios = require('axios');
const chalk = require('chalk');
const readline = require('readline');
const keypress = require('keypress');

// === Configuration ===
const CONFIG = {
    symbol: 'TEST',
    basePrice: 3000,
    range: 2000, // Price fluctuation range (+/-) for Sine Wave
    wavePeriod: 60, // Minutes for full sine wave cycle
    ordersPerMinute: 60, // 1 orders per second
    endpoint: 'https://4xs6g4w8l6.execute-api.ap-northeast-2.amazonaws.com/restV2/orders',
    userId: 'cli-market-maker',
    apiKey: 'S0cLXAGtuza6T3GbYZ8TBbERqfdi5Xo1ilA914gf',
    
    // New Parameters
    mode: 'RANDOM', // SINE or RANDOM
    volatility: 5,   // Price change per tick in Random Mode
    trend: 0         // Bias (-1 to 1) for upward/downward trend
};

// === State ===
let isRunning = false; // Manual start
let t = 0; // Sine wave time factor
let totalOrders = 0;
let lastPrice = CONFIG.basePrice; // Initialize with base price
let intervalId = null;
let lastError = '';
let lastOrderInfo = null; // { side, price, quantity, time }

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
    console.log(chalk.gray('  [M]       ') + 'Switch Mode (SINE / RANDOM)');
    console.log(chalk.gray('  [Q]       ') + 'Quit');
    console.log('');
    console.log(chalk.bold('  Common:'));
    console.log(chalk.gray('  [↑ / ↓]   ') + 'Base Price  (±10) / Reset Price');
    console.log(chalk.gray('  [← / →]   ') + 'Speed       (±60 opm)');
    console.log('');
    
    if (CONFIG.mode === 'SINE') {
        console.log(chalk.bold('  Sine Mode:'));
        console.log(chalk.gray('  [ [ / ] ] ') + 'Wave Cycle  (±1 min)');
        console.log(chalk.gray('  [ - / = ] ') + 'Range       (±10)');
    } else {
        console.log(chalk.bold('  Random Mode:'));
        console.log(chalk.gray('  [ , / . ] ') + 'Volatility  (±1)');
        console.log(chalk.gray('  [ 9 / 0 ] ') + 'Trend       (Down/Up)');
    }
    console.log('');
    
    console.log(chalk.bold('📊  Status'));
    console.log(`  State     : ${isRunning ? chalk.green.bold('RUNNING ▶') : chalk.red.bold('STOPPED ⏸')}`);
    console.log(`  Symbol    : ${chalk.yellow(CONFIG.symbol)}`);
    console.log(`  Mode      : ${CONFIG.mode === 'SINE' ? chalk.magenta('Sine Wave 🌊') : chalk.blue('Random Walk 🎲')}`);
    console.log(`  Price     : ${chalk.yellow(lastPrice)}`); 
    console.log(`  Orders    : ${totalOrders}`);
    
    if (lastError) {
        console.log(`  Error     : ${chalk.red.bold(lastError)}`);
    }
    console.log('');
    
    // --- 최근 주문 정보 ---
    console.log(chalk.bold('📝  Last Order'));
    if (lastOrderInfo) {
        const sideColor = lastOrderInfo.side === 'BUY' ? chalk.green : chalk.red;
        console.log(`  Side      : ${sideColor.bold(lastOrderInfo.side)}`);
        console.log(`  Price     : ${chalk.yellow(lastOrderInfo.price)}`);
        console.log(`  Quantity  : ${chalk.cyan(lastOrderInfo.quantity)}`);
        console.log(`  Time      : ${chalk.gray(lastOrderInfo.time)}`);
    } else {
        console.log(chalk.gray('  (No orders yet)'));
    }
    console.log('');
    
    console.log(chalk.bold('⚙️   Parameters'));
    console.log(`  Speed     : ${chalk.blue(CONFIG.ordersPerMinute)} orders/min`);
    
    if (CONFIG.mode === 'SINE') {
        console.log(`  BasePrice : ${chalk.magenta(CONFIG.basePrice)}`);
        console.log(`  Range     : ± ${chalk.cyan(CONFIG.range)}`);
        console.log(`  Cycle     : ${chalk.green(CONFIG.wavePeriod)} min`);
    } else {
         console.log(`  Volatility: ${chalk.cyan(CONFIG.volatility)}`);
         console.log(`  Trend     : ${CONFIG.trend > 0 ? chalk.green('UP (+' + CONFIG.trend + ')') : (CONFIG.trend < 0 ? chalk.red('DOWN (' + CONFIG.trend + ')') : chalk.gray('NEUTRAL'))}`);
    }
    
    console.log('');
}

// === Logic ===
async function placeOrder() {
    if (!isRunning) return;

    let price = 0;

    if (CONFIG.mode === 'SINE') {
        const minutesPerTick = 1 / CONFIG.ordersPerMinute;
        t += minutesPerTick; 
        const sineValue = Math.sin((t / CONFIG.wavePeriod) * 2 * Math.PI);
        price = Math.round(CONFIG.basePrice + (CONFIG.range * sineValue));
    } else {
        // RANDOM WALK
        // Change = (Random(-1 to 1) * Volatility) + Trend
        // More realistic: Normal distribution approximation
        const rand = (Math.random() - 0.5) * 2; // -1 to 1
        const delta = Math.round((rand * CONFIG.volatility) + CONFIG.trend);
        
        // Ensure price doesn't go below 1
        lastPrice = Math.max(1, lastPrice + delta);
        price = lastPrice;
    }
    
    lastPrice = price; // Sync for display
    
    const quantity = Math.floor(Math.random() * 50) + 1;

    // Send order (Self-Match)
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
            // 최근 주문 정보 저장
            lastOrderInfo = {
                side: 'BUY/SELL',
                price: price,
                quantity: quantity,
                time: new Date().toLocaleTimeString('ko-KR')
            };
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
    
    if ((key && key.name == 'm') || ch === 'm') {
        CONFIG.mode = (CONFIG.mode === 'SINE') ? 'RANDOM' : 'SINE';
        // Reset lastPrice to basePrice when switching to Random for stability
        if (CONFIG.mode === 'RANDOM') lastPrice = CONFIG.basePrice;
        printStatus();
    }
    
    if (key && key.name == 'up') {
        CONFIG.basePrice += 10;
        if (CONFIG.mode === 'RANDOM') lastPrice = CONFIG.basePrice; // Reset current price
        printStatus();
    }
    
    if (key && key.name == 'down') {
        CONFIG.basePrice = Math.max(10, CONFIG.basePrice - 10);
        if (CONFIG.mode === 'RANDOM') lastPrice = CONFIG.basePrice; // Reset current price
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
    
    // Wave Cycle Adjustment (Sine Mode)
    if ((key && key.sequence === '[') || ch === '[') {
        CONFIG.wavePeriod = Math.max(1, CONFIG.wavePeriod - 1);
        printStatus();
    }
    if ((key && key.sequence === ']') || ch === ']') {
        CONFIG.wavePeriod += 1;
        printStatus();
    }

    // Range Adjustment (Sine Mode)
    if (ch === '-' || ch === '_') {
        CONFIG.range = Math.max(0, CONFIG.range - 10);
        printStatus();
    }
    if (ch === '=' || ch === '+') {
        CONFIG.range += 10;
        printStatus();
    }
    
    // Volatility Adjustment (Random Mode)
    if (ch === ',' || ch === '<') {
        CONFIG.volatility = Math.max(1, CONFIG.volatility - 1);
        printStatus();
    }
    if (ch === '.' || ch === '>') {
        CONFIG.volatility += 1;
        printStatus();
    }
    
    // Trend Adjustment (Random Mode)
    if (ch === '9' || ch === '(') {
        CONFIG.trend -= 0.5;
        printStatus();
    }
    if (ch === '0' || ch === ')') {
        CONFIG.trend += 0.5;
        printStatus();
    }
});

process.stdin.setRawMode(true);
process.stdin.resume();

// === Init ===
printStatus();
startLoop();

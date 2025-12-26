/**
 * Market Maker CLI - Kinesis Direct Mode
 * Lambda를 거치지 않고 직접 Kinesis supernoba-orders 스트림에 주문 발행
 * EC2 엔진과 동일 인스턴스 또는 AWS 자격증명이 있는 환경에서 실행
 */

const { KinesisClient, PutRecordCommand } = require('@aws-sdk/client-kinesis');
const chalk = require('chalk');
const keypress = require('keypress');
const { v4: uuidv4 } = require('uuid');

// === Configuration ===
const CONFIG = {
    symbol: 'TEST',
    basePrice: 3000,
    range: 2000,
    wavePeriod: 60,
    ordersPerMinute: 60,
    
    // Kinesis 설정
    streamName: process.env.KINESIS_STREAM || 'supernoba-orders',
    region: process.env.AWS_REGION || 'ap-northeast-2',
    
    // 모드 설정
    mode: 'RANDOM', // SINE or RANDOM
    volatility: 5,
    trend: 0,
    
    // 사용자 ID (마켓메이커 전용)
    userId: 'mm-kinesis-direct'
};

// Kinesis 클라이언트
const kinesis = new KinesisClient({ region: CONFIG.region });

// === State ===
let isRunning = false;
let t = 0;
let totalOrders = 0;
let lastPrice = CONFIG.basePrice;
let intervalId = null;
let lastError = '';
let lastOrderInfo = null;

// === UI Helpers ===
function clearScreen() {
    process.stdout.write('\x1Bc');
}

function printStatus() {
    clearScreen();
    console.log(chalk.bold.cyan('=== Supernoba Market Maker CLI (Kinesis Direct) ==='));
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
    console.log(`  Mode      : ${chalk.magenta('KINESIS DIRECT 🚀')}`);
    console.log(`  Stream    : ${chalk.cyan(CONFIG.streamName)}`);
    console.log(`  Price     : ${chalk.yellow(lastPrice)}`); 
    console.log(`  Orders    : ${totalOrders}`);
    
    if (lastError) {
        console.log(`  Error     : ${chalk.red.bold(lastError)}`);
    }
    console.log('');
    
    console.log(chalk.bold('📝  Last Order'));
    if (lastOrderInfo) {
        const sideColor = lastOrderInfo.side === 'BUY' ? chalk.green : chalk.red;
        console.log(`  Side      : ${sideColor.bold(lastOrderInfo.side)}`);
        console.log(`  Price     : ${chalk.yellow(lastOrderInfo.price)}`);
        console.log(`  Quantity  : ${chalk.cyan(lastOrderInfo.quantity)}`);
        console.log(`  OrderId   : ${chalk.gray(lastOrderInfo.orderId.substring(0, 8) + '...')}`);
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

// === Kinesis Order Publisher ===
async function publishOrder(order) {
    const command = new PutRecordCommand({
        StreamName: CONFIG.streamName,
        PartitionKey: order.symbol,
        Data: Buffer.from(JSON.stringify(order))
    });
    
    return kinesis.send(command);
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
        const rand = (Math.random() - 0.5) * 2;
        const delta = Math.round((rand * CONFIG.volatility) + CONFIG.trend);
        lastPrice = Math.max(1, lastPrice + delta);
        price = lastPrice;
    }
    
    lastPrice = price;
    
    const quantity = Math.floor(Math.random() * 50) + 1;
    const buyOrderId = uuidv4();
    const sellOrderId = uuidv4();

    // Kinesis 주문 형식 (order-router Lambda가 받는 형식)
    const buyOrder = {
        order_id: buyOrderId,
        user_id: CONFIG.userId + '-buy',
        symbol: CONFIG.symbol,
        side: 'BUY',
        price: price,
        quantity: quantity,
        order_type: 'LIMIT',
        timestamp: Date.now()
    };
    
    const sellOrder = {
        order_id: sellOrderId,
        user_id: CONFIG.userId + '-sell',
        symbol: CONFIG.symbol,
        side: 'SELL',
        price: price,
        quantity: quantity,
        order_type: 'LIMIT',
        timestamp: Date.now()
    };

    try {
        await Promise.all([
            publishOrder(buyOrder),
            publishOrder(sellOrder)
        ]);
        
        totalOrders += 2;
        lastError = '';
        lastOrderInfo = {
            side: 'BUY/SELL',
            price: price,
            quantity: quantity,
            orderId: buyOrderId,
            time: new Date().toLocaleTimeString('ko-KR')
        };
        process.stdout.write(chalk.gray('.'));
    } catch (err) {
        lastError = err.message;
        process.stdout.write(chalk.red('x'));
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
        if (CONFIG.mode === 'RANDOM') lastPrice = CONFIG.basePrice;
        printStatus();
    }
    
    if (key && key.name == 'up') {
        CONFIG.basePrice += 10;
        if (CONFIG.mode === 'RANDOM') lastPrice = CONFIG.basePrice;
        printStatus();
    }
    
    if (key && key.name == 'down') {
        CONFIG.basePrice = Math.max(10, CONFIG.basePrice - 10);
        if (CONFIG.mode === 'RANDOM') lastPrice = CONFIG.basePrice;
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
console.log(chalk.cyan('Initializing Kinesis client...'));
console.log(chalk.gray(`Stream: ${CONFIG.streamName}`));
console.log(chalk.gray(`Region: ${CONFIG.region}`));
console.log('');

printStatus();
startLoop();

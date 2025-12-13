import { store } from '../shared/redux/Store';
import { 
  setConnectionStatus, 
  updateDepth, 
  updateTicker, 
  setSubscribedSymbols 
} from '../shared/redux/slices/MarketSlice';

// 웹소켓 서버 연결 주소 정의
const WS_ENDPOINT = 'wss://l2ptm85wub.execute-api.ap-northeast-2.amazonaws.com/production/';
// 연결 유지를 위한 하트비트 전송 주기 (30초)
const HEARTBEAT_INTERVAL = 30000; // 30 seconds
// 연결 끊김 시 재연결 시도 대기 시간 (3초)
const RECONNECT_DELAY = 3000; // 3 seconds

// 웹소켓 연결 및 데이터 처리를 담당하는 싱글톤 서비스 클래스
class WebSocketService {
  // 서비스 초기화 및 상태 변수 정의
  constructor() {
    this.ws = null;
    this.heartbeatTimer = null;
    this.userId = 'anonymous_' + Math.floor(Math.random() * 1000000);
    this.isConnected = false;
    this.subscriptions = {
      main: null,
      sub: new Set() // Using Set to avoid duplicates
    };
  }

  // 웹소켓 연결을 수립하고 이벤트 핸들러를 설정하는 함수
  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const url = `${WS_ENDPOINT}?userId=${this.userId}`;
    console.log(`[WS] Connecting to ${url}`);

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      console.log('[WS] Connected');
      this.isConnected = true;
      store.dispatch(setConnectionStatus(true));
      this.startHeartbeat();
      this.resubscribe(); // Re-subscribe on reconnection
    };

    this.ws.onclose = () => {
      console.log('[WS] Disconnected');
      this.isConnected = false;
      store.dispatch(setConnectionStatus(false));
      this.stopHeartbeat();
      
      // Attempt reconnect
      setTimeout(() => this.connect(), RECONNECT_DELAY);
    };

    this.ws.onerror = (error) => {
      console.error('[WS] Error:', error);
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.handleMessage(msg);
      } catch (e) {
        console.error('[WS] Parse error:', e);
      }
    };
  }

  // 수신된 웹소켓 메시지를 파싱하여 Redux 스토어에 업데이트하는 함수
  handleMessage(msg) {
    // Compact format: e=event, s=symbol
    if (msg.e === 'd') {
      // DEPTH: {"e":"d","s":"SYM","b":[[p,q],...],"a":[[p,q],...], "c": 0.5, "p": 150}
      // Log for debugging
      // console.log('[WS] Depth:', msg.s);
      
      // DEBUG: Log raw message for TEST symbols
      if (msg.s === 'TEST' || msg.s === 'TEST2') {
        console.log('[WS DEBUG]', msg);
      }
      
      store.dispatch(updateDepth({
        symbol: msg.s,
        bids: msg.b || [],
        asks: msg.a || [],
        change: msg.c || 0,
        price: msg.p || 0,
        prevClose: msg.pc || msg.yc // 'pc' from guide, 'yc' as backup
      }));

    } else if (msg.e === 't') {
      // TICKER: {"e":"t","s":"SYM","p":150,"c":2.5}
      store.dispatch(updateTicker({
        symbol: msg.s,
        price: msg.p,
        change: msg.c || 0,
        prevClose: msg.pc || msg.yc
      }));
    } else if (msg.message === 'Forbidden') {
      // Pong response, ignore
    } else {
      console.log('[WS] Message:', msg);
    }
  }

  // 특정 종목에 대한 실시간 데이터 구독을 요청하는 함수
  subscribe(mainSymbol, subSymbols = []) {
    this.subscriptions.main = mainSymbol;
    // 보조 종목들을 구독 목록에 추가
    subSymbols.forEach(s => this.subscriptions.sub.add(s)); 

    if (!this.isConnected) return;

    // 웹소켓 구독을 위한 페이로드 생성
    const payload = {
      action: 'subscribe',
      main: this.subscriptions.main,
      sub: Array.from(this.subscriptions.sub)
    };

    console.log('[WS] Subscribing:', payload);
    this.ws.send(JSON.stringify(payload));
    
    // Update Redux state with current target subscriptions
    store.dispatch(setSubscribedSymbols({
      main: this.subscriptions.main,
      sub: Array.from(this.subscriptions.sub)
    }));
  }
  
  // Helper to add just sub symbols
  // 보조 종목만 별도로 구독 목록에 추가하고 구독을 갱신하는 헬퍼 함수
  subscribeSub(symbols) {
    if (!Array.isArray(symbols)) symbols = [symbols];
    symbols.forEach(s => this.subscriptions.sub.add(s));
    this.subscribe(this.subscriptions.main, []); 
  }

  // 재연결 시 기존 구독 정보를 바탕으로 다시 구독 요청을 보내는 함수
  resubscribe() {
    if (this.subscriptions.main || this.subscriptions.sub.size > 0) {
      this.subscribe(this.subscriptions.main, []);
    }
  }

  // 서버와의 연결 유지를 위해 주기적으로 핑을 보내는 함수
  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ action: 'ping' }));
      }
    }, HEARTBEAT_INTERVAL);
  }

  // 하트비트 전송을 중단하는 함수
  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
  
  // 웹소켓 연결을 종료하고 자원을 정리하는 함수
  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

// Singleton instance
const webSocketService = new WebSocketService();
export default webSocketService;

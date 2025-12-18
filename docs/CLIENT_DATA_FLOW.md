# Client Data Flow Architecture (Test Client)

**최종 업데이트: 2025-12-18**

이 문서는 `liquibook/test/web/index.html` 클라이언트에서 실시간 캔들 데이터가 처리되는 **전체 흐름(End-to-End Data Flow)**을 설명합니다.

---

## 1. Data Flow Overview

클라이언트는 **REST API(과거/기준)**와 **WebSocket(실시간/최신)** 이원화된 채널을 통해 데이터를 수신하며, 이를 정합성 있게 병합하는 것이 핵심입니다.

### Core Logic Priorities
1.  **API Priority**: "타임프레임 선택"이나 "새로고침" 시 API에서 데이터를 가져오며, 이는 **불변의 진실(Truth)**로 취급됩니다.
2.  **Gap Filling**: WebSocket으로 수신된 데이터는 `Buffer`에 쌓이며, API 데이터가 아직 커버하지 못한 **미래 시점(Next Ticks)**을 채우는 데 사용됩니다.
3.  **No Overwrite**: 버퍼의 데이터가 API 데이터와 시간대가 겹칠 경우, **API 데이터를 보존하고 버퍼를 무시**하여 데이터 오염을 방지합니다.

---

## 2. Detailed Data Flow Diagram

```mermaid
flowchart TD
    %% Sources
    API["REST API<br/>(History + Snapshot)"]:::external
    WS["WebSocket Server<br/>(Real-time Ticks)"]:::external
    
    subgraph Client ["Client Logic (index.html)"]
        direction TB
        
        subgraph Store ["1. Data Storage"]
            BUF["Local Buffer (One-Min)"]:::storage
        end
        
        subgraph Action ["2. User Action (Change TF)"]
            BTN["Click '1m' / '5m'"]:::action
            FETCH["Fetch API"]:::action
        end
        
        subgraph Merge ["3. Smart Merge Logic"]
            M_INIT["Map = API Data"]:::important
            M_CHECK{"Map has Time?"}:::logic
            M_ADD["Add Buffer Data"]:::action
            M_SKIP["Skip Buffer (Trust API)"]:::important
        end
        
        subgraph Render ["4. Rendering"]
            TV["TradingView Chart"]:::ui
            STYLE["Style: No Border"]:::state
        end
    end

    %% Flow
    WS -->|Tick| BUF
    BUF -->|Latest Ticks| M_CHECK
    
    BTN --> FETCH
    FETCH -->|Full History| M_INIT
    
    M_INIT --> M_CHECK
    
    M_CHECK -- No (New Data) --> M_ADD
    M_CHECK -- Yes (Collision) --> M_SKIP
    
    M_ADD --> TV
    M_SKIP --> TV
    M_INIT --> TV
    STYLE -.-> TV

    %% Styles
    classDef external fill:#2d2d2d,stroke:#fff,color:#fff
    classDef storage fill:#f3e5f5,stroke:#7b1fa2,color:#000
    classDef action fill:#e1f5fe,stroke:#01579b,color:#000
    classDef important fill:#ffcdd2,stroke:#c62828,color:#000,stroke-width:2px
    classDef logic fill:#fff9c4,stroke:#fbc02d,color:#000
    classDef ui fill:#333,stroke:#4caf50,color:#fff,stroke-width:2px
    classDef state fill:#e0f7fa,stroke:#006064,color:#000
```

---

## 3. Key Implementation Details

### A. The "Merge Collision" Fix
과거에는 로컬 버퍼(브라우저가 절전 모드일 때 생성된 저품질 데이터 포함)가 API 데이터를 덮어써서 차트가 깨지는("T-Shape") 현상이 있었습니다.
이를 **API 우선 순위(API Priority)** 로직으로 해결했습니다.

```javascript
/* index.html:1920 */
if (!mergedMap.has(c.time)) {
    // API에 없는, 정말 최신의 데이터만 추가
    mergedMap.set(c.time, ...);
}
```

### B. Visual Artifact Fix (Pure Body Rendering)
완벽한 사인파 알고리즘 등으로 인해 생성된 **Marubozu(꼬리 없는 캔들)**가 차트 줌 아웃 시 T자나 선으로 찌그러져 보이는 문제를 해결하기 위해 렌더링 스타일을 수정했습니다.

*   `borderVisible: false`: 캔들 테두리를 제거.
*   이로 인해 캔들이 1픽셀 높이라도 정확한 "면(Face)"으로 렌더링되어 시각적 왜곡이 사라짐.

---

## 4. Endpoints & Configuration
| Service | Endpoint | Role |
| :--- | :--- | :--- |
| **Chart API** | `GET /chart` | **Source of Truth**. Provides validated OHLCV history. |
| **WebSocket** | `wss://...` | **Gap Filler**. Provides instant updates between API calls. |

이 문서는 `liquibook/test/web/index.html` 클라이언트에서 실시간 캔들 데이터가 처리되는 **전체 흐름(End-to-End Data Flow)**을 설명합니다.

## 1. Data Flow Overview

클라이언트는 백엔드 엔진으로부터 **초 단위의 체결 기반 캔들 업데이트**를 수신합니다. 성능 최적화를 위해 **데이터 수신(Ingest)**과 **차트 렌더링(Process)** 로직을 분리하였습니다.

### Core Logic Steps
1.  **Ingest (Immediate)**: WebSocket 이벤트 수신 시 `oneMinCandleBuffer`에 즉시 반영. (Chart Calculation 수행 안 함)
2.  **Align**: `t_epoch`를 1분 단위(`Math.floor(t/60)*60`)로 정렬 (Sawtooth 방지).
3.  **Merge**: 버퍼 내 기존 1분봉이 있으면 OHLCV 갱신(`Math.max` for Volume), 없으면 신규 생성.
4.  **Render Loop (60fps)**: `requestAnimationFrame` 루프에서 `uiState.chartUpdatePending` 플래그 확인.
5.  **Direct/Aggregate**: 1분봉은 버퍼/API 데이터를 **있는 그대로** 사용하고, 상위 타임프레임(5m 등)은 집계하여 그립니다.

---

## 2. Detailed Data Flow Diagram

```mermaid
flowchart TD
    %% Nodes
    WS["WebSocket Server"]:::external
    
    subgraph Client ["Test Client (index.html)"]
        direction TB
        
        subgraph Ingestion ["1. Data Ingestion (Async)"]
            HM["handleMessage"]:::code
            ET["extractTimestamp"]:::code
            V["Validation (NaN Check)"]:::logic
            INGEST["ingestCandleMessage"]:::action
        end
        
        subgraph Buffering ["2. 1m Alignment & Buffering"]
            ALIGN["Time Alignment<br/>Math.floor t/60 * 60"]:::important
            BUFFER_CHK{"In Buffer?"}:::logic
            NEW_1M["Create New 1m Candle"]:::action
            UPDATE_1M["Update Existing 1m<br/>H=max, L=min, C=new<br/>V=max accumulated"]:::important
            BUFFER["oneMinCandleBuffer<br/>(Array)"]:::storage
            FLAG["uiState.chartUpdatePending = true"]:::state
        end
        
        subgraph Rendering ["3. Render Loop (60fps)"]
            LOOP["loop via requestAnimationFrame"]:::loop
            CHECK_FLAG{"Is Dirty?"}:::logic
            CHECK_TF{"Is 1m?"}:::logic
            DIRECT["Use Raw Buffer/API"]:::action
            AGG["Aggregate (Merge 1m -> Nm)"]:::action
            TV["TradingView Chart"]:::ui
        end
    end

    %% Connections
    WS -- "{e:'candle', ...}" --> HM
    HM --> INGEST
    INGEST --> ET
    ET -- "t_epoch" --> V
    V -- "Validated Time" --> ALIGN
    
    ALIGN --> BUFFER_CHK
    BUFFER_CHK -- No --> NEW_1M
    BUFFER_CHK -- Yes --> UPDATE_1M
    
    NEW_1M --> BUFFER
    UPDATE_1M --> BUFFER
    UPDATE_1M --> FLAG
    NEW_1M --> FLAG
    
    LOOP --> CHECK_FLAG
    FLAG -.-> CHECK_FLAG
    CHECK_FLAG -- Yes --> CHECK_TF
    CHECK_FLAG -- No --> LOOP
    
    CHECK_TF -- Yes (1m) --> DIRECT
    CHECK_TF -- No (>1m) --> AGG
    
    BUFFER --> DIRECT
    BUFFER --> AGG
    DIRECT --> TV
    AGG --> TV

    %% Styling definition
    classDef external fill:#2d2d2d,stroke:#fff,color:#fff
    classDef code fill:#e1f5fe,stroke:#01579b,color:#000
    classDef logic fill:#fff9c4,stroke:#fbc02d,color:#000
    classDef action fill:#e8f5e9,stroke:#2e7d32,color:#000
    classDef important fill:#ffcdd2,stroke:#c62828,color:#000,stroke-width:2px
    classDef storage fill:#f3e5f5,stroke:#7b1fa2,color:#000
    classDef state fill:#e0f7fa,stroke:#006064,color:#000
    classDef loop fill:#fbe9e7,stroke:#bf360c,color:#000
    classDef ui fill:#333,stroke:#4caf50,color:#fff,stroke-width:2px
    classDef input fill:#f3e5f5,stroke:#7b1fa2,color:#000
```

## 3. Key Implementations

### A. Performance Optimization (Ingest vs Process)
메시지가 초당 수백 개 들어와도 UI가 멈추지 않도록 수신부와 그리기 로직을 분리했습니다.
*   **Ingest**: `ingestCandleMessage()` - 단순 데이터 저장 (매우 빠름)
*   **Process**: `updateTVChartFromBuffer()` - 60fps로 제한된 UI 업데이트

### B. Volume Handling (Cumulative & Simulation)
엔진은 해당 1분 동안의 **누적 거래량**을 전송합니다.
```javascript
existing.volume = Math.max(existing.volume, msg.v); 
```

**Simulation Info**:
*   주문 1건당 주식 수량: `1 ~ 50` (Random)
*   거래량 계산: `Volume = Sum(Quantity)`

### C. Trust-Based Rendering (Updated)
**엔진 데이터의 무결성이 검증되었으므로**, 클라이언트는 **1분봉 데이터에 대해 별도의 후가공(Filtering/Aggregation)을 수행하지 않습니다.**
*   **1m Chart**: DB/API에서 받은 데이터를 그대로 사용 (Pass-through).
*   **>1m Chart**: 1분봉 데이터를 기반으로 클라이언트에서 집계.

## 4. Endpoints & Configuration
| Component | Address / Value | Note |
| :--- | :--- | :--- |
| **WebSocket** | `wss://l2ptm85wub.execute-api.ap-northeast-2.amazonaws.com/production/` | Real-time Stream |
| **Simulation** | Random Quantity (1-50 shares) | Realistic Volume Profile |
| **Engine Integrity** | **Verified (Clean Sine Wave)** | **No Client Filtering Needed** |

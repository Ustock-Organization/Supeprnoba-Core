Performance Test Results, Inserts Per Second 
============================================
(newest results on top)
 
<table>
  <tr>
    <th>5 Level Depth</th>
    <th>BBO Only</th>
    <th>Order Book Only</th>
    <th>Note</th>
  </tr>
  <tr>
    <td>2,062,158</td>
    <td>2,139,950</td>
    <td>2,494,532</td>
    <td>Now testing on a modern laptop (2.4 GHZ i7).</td>
  </tr>
  <tr>
    <td>1,231,959</td>
    <td>1,273,510</td>
    <td>1,506,066</td>
    <td>Handling all or none order condition.</td>
  </tr>
  <tr>
    <td>1,249,544</td>
    <td>1,305,482</td>
    <td>1,531,998</td>
    <td>Remove callbacks_added method.  Caller can invoke equivalent if necessary.</td>
  </tr>
  <tr>
    <td>1,222,000</td>
    <td>1,279,711</td>
    <td>1,495,714</td>
    <td>Use vector for callback container.</td>
  </tr>
  <tr>
    <td>1,250,616</td>
    <td>1,264,227</td>
    <td>1,463,738</td>
    <td>Union in callback.  For clarity of purpose, not for performance.</td>
  </tr>
  <tr>
    <td>1,267,135</td>
    <td>1,270,188</td>
    <td>1,469,246</td>
    <td>Combine 2 fill callbacks into one.</td>
  </tr>
  <tr>
    <td>1,233,894</td>
    <td>1,237,154</td>
    <td>1,434,354</td>
    <td>Store excess depth levels in depth to speed repopulation.</td>
  </tr>
  <tr>
    <td>58,936</td>
    <td>153,839</td>
    <td>1,500,874</td>
    <td>Removed spuroious insert on accept of completely filled order.</td>
  </tr>
  <tr>
    <td>38,878</td>
    <td>124,756</td>
    <td>1,495,744</td>
    <td>Initial run with all 3 tests.</td>
  </tr>
</table>

---

## AWS EC2 인스턴스 용량 분석

### c5.2xlarge 사양

| 항목 | 값 |
|------|-----|
| **vCPU** | 8 |
| **RAM** | 16 GB |
| **네트워크** | 최대 10 Gbps |
| **클럭** | 3.0 GHz (Turbo 3.5 GHz) |

### 예상 TPS 계산

```
벤치마크 기준: 2,062,158 TPS (2.4 GHz 단일 코어)
c5.2xlarge 클럭: 3.0 GHz → 약 25% 성능 향상

단일 코어 예상: 2,062,158 × 1.25 = ~2,577,000 TPS

AWS/네트워크 오버헤드 고려 (50% 감소): ~1,300,000 TPS
```

### 동시 사용자 및 종목 수 계산

| 사용자 유형 | 주문 빈도 | 초당 주문 |
|-------------|-----------|-----------|
| 일반 사용자 | 10초에 1회 | 0.1 TPS |
| 활발한 트레이더 | 3초에 1회 | 0.33 TPS |
| **평균** | 5초에 1회 | **0.2 TPS** |

```
c5.2xlarge 예상 TPS: 1,300,000
사용자당 평균 TPS: 0.2

최대 동시 사용자 = 1,300,000 ÷ 0.2 = 6,500,000명
```

### 권장 종목 수

| 시나리오 | 동시 사용자 | 종목당 사용자 | 권장 종목 |
|----------|-------------|---------------|-----------|
| **보수적** | 100,000 | 1,000 | **100개** |
| **일반** | 500,000 | 500 | **1,000개** |
| **최대** | 1,000,000 | 200 | **5,000개** |

> ⚠️ 실제 운영 시 Kafka/Redis 오버헤드, 메모리 사용량 등 고려 필요

### 결론

**c5.2xlarge 1대로 충분히 5,000+ 종목 처리 가능**

- MVP (100개 종목): 여유 10배+
- 성장기 (1,000개 종목): 여유 5배+
- 대규모 (5,000개 종목): 여유 2배+

---

*최종 분석일: 2025-12-07*

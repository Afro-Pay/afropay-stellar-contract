# Runbook: HorizonStreamLag

## Overview

| Field | Value |
|---|---|
| **Alert name** | `HorizonStreamLag` |
| **Severity** | Warning |
| **Team** | Infrastructure |
| **SLO impact** | Partial — escrow state updates delayed; oracle may miss delivery windows |

## Trigger Condition

```promql
horizon_stream_lag_ledgers > 100
```

The Horizon event listener is more than **100 ledgers behind** the chain tip. At Stellar's 5-second ledger close time, 100 ledgers equals approximately 8 minutes of lag. Escrow state transitions (release, refund) will be delayed for all users during this window.

---

## Immediate Triage Steps

### 1. Check current lag value
```bash
curl https://api.afropay.io/metrics | grep horizon_stream_lag_ledgers
```

### 2. Check Stellar Horizon status
```bash
# Check latest ledger on Horizon vs chain tip
curl https://horizon-testnet.stellar.org | jq .core_latest_ledger
curl https://horizon-testnet.stellar.org | jq .history_latest_ledger
# Large difference between the two indicates Horizon is catching up itself
```

Also check: https://status.stellar.org

### 3. Check the Horizon listener service
```bash
kubectl get pods -l app=afropay-horizon-listener
kubectl logs -l app=afropay-horizon-listener --since=10m
```

Look for:
- Connection reset errors from Horizon SSE stream
- Backpressure warnings (listener processing too slow)
- Memory pressure causing GC pauses

### 4. Check Horizon rate limiting
If the listener is making too many API calls, Horizon may be rate-limiting it:
```bash
kubectl logs -l app=afropay-horizon-listener | grep -i "429\|rate.limit\|too.many"
```

### 5. Restart the listener (safe — it resumes from last processed ledger)
```bash
kubectl rollout restart deployment/afropay-horizon-listener
kubectl rollout status deployment/afropay-horizon-listener
```

The listener stores its last processed ledger sequence in the database and resumes from there on restart — no ledgers are skipped.

---

## Possible Root Causes

| Symptom | Likely Cause | Action |
|---|---|---|
| Lag growing steadily | Listener processing slower than ledger close rate | Check CPU/memory, scale horizontally |
| Lag spike then recovery | Horizon SSE reconnect (normal) | Monitor; alert if sustained >10 min |
| Lag growing rapidly | Horizon itself is behind chain tip | Check Horizon status page |
| Listener pod not running | Crash / OOM | Restart, increase memory limits |
| High DB query latency | Database saturation | Check DB metrics, scale or tune |
| Rate-limit responses from Horizon | Too many requests | Implement backoff, reduce polling frequency |

---

## Lag Impact on Operations

| Lag | Duration | Impact |
|---|---|---|
| < 20 ledgers | < 2 min | Negligible |
| 20–100 ledgers | 2–8 min | Escrow state updates delayed; acceptable |
| 100–500 ledgers | 8–42 min | Alert firing; oracle may miss escrow expiry windows |
| > 500 ledgers | > 42 min | Escrows near timeout will not auto-refund; manual intervention required |

---

## Manual Ledger Gap Recovery

If the listener crashed and missed a significant range of ledgers, replay them:
```bash
# Set the HORIZON_LISTENER_START_LEDGER env var to force replay from a specific ledger
kubectl set env deployment/afropay-horizon-listener \
  HORIZON_LISTENER_START_LEDGER=<missed_from_ledger>
kubectl rollout restart deployment/afropay-horizon-listener
```

---

## Escalation Path

1. **< 5 min**: On-call engineer checks listener pod status and restarts if crashed.
2. **5–15 min**: If not resolved, check Horizon status and page infrastructure team.
3. **> 30 min with lag > 500 ledgers**: Page payments team lead; manually process any near-timeout escrows to prevent refund window expiry.

---

## Recovery Verification

Alert auto-resolves when `horizon_stream_lag_ledgers` drops below 100 for 5 consecutive minutes. Confirm via the Grafana "Horizon Stream Lag" panel returning to green.

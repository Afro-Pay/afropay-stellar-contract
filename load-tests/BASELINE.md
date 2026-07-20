# AfroPay Load Test Baseline

**Date:** 2026-07-20  
**Environment:** Staging (single-node, 2 vCPU / 4 GB RAM, Testnet Horizon)  
**k6 version:** 0.51.0  
**API version:** 0.1.0  

---

## Smoke Profile Results (CI gate)

**Config:** 5 VUs, 1 minute  
**Status:** ✅ PASS — CI gate conditions met

| Metric | p50 | p95 | p99 | Error rate |
|---|---|---|---|---|
| Payment initiation (`POST /api/v1/escrow`) | 48 ms | 112 ms | 180 ms | 0% |
| Escrow state poll (`GET /api/v1/escrow/:id`) | 12 ms | 28 ms | 45 ms | 0% |
| FX rate fetch (`GET /api/v1/rates/:corridor`) | 8 ms | 19 ms | 31 ms | 0% |
| **Overall http_req_duration** | **22 ms** | **98 ms** | **162 ms** | **0%** |
| `stellar_submission_latency_ms` | 46 ms | 108 ms | 174 ms | — |
| `horizon_error_rate` | — | — | — | 0% |

All thresholds met: p95 < 500 ms, error rate = 0%.

---

## Load Profile Results

**Config:** 100 VUs, 10 minutes (30 s ramp-up / 8.5 min steady / 30 s ramp-down)

| Scenario | p50 | p95 | p99 | Req/s | Error rate |
|---|---|---|---|---|---|
| Payment initiation | 142 ms | 389 ms | 612 ms | 58 rps | 0.2% |
| Escrow polling | 31 ms | 87 ms | 134 ms | 23 rps | 0% |
| FX rate fetch | 9 ms | 22 ms | 38 ms | 14 rps | 0% |
| **Overall** | **76 ms** | **312 ms** | **521 ms** | **95 rps** | **0.13%** |

### Custom metrics (load profile)

| Metric | p50 | p95 | p99 |
|---|---|---|---|
| `stellar_submission_latency_ms` | 138 ms | 381 ms | 598 ms |
| `horizon_error_rate` | — | — | 0.2% |

---

## Stress Profile Results

**Config:** Ramp 100 → 500 VUs over 15 min, soak 5 min at 500 VUs

| VU count | p95 latency | Error rate | Notes |
|---|---|---|---|
| 100 | 312 ms | 0.13% | Baseline |
| 150 | 421 ms | 0.2% | Normal |
| 200 | 689 ms | 0.4% | Latency spike begins — DB pool pressure observed |
| 250 | 1,102 ms | 1.8% | **First sustained errors — DB pool cliff** |
| 300 | 2,340 ms | 6.2% | Horizon submission queue backing up |
| 400 | 5,800 ms | 18% | System saturated |
| 500 | 9,100 ms | 34% | Full degradation |

### Cliff: ~220 VUs sustained

The first error rate > 1% appeared at approximately **220 VUs**. Beyond this point, `db_timeout_errors_total` began incrementing, confirming the primary bottleneck is **database connection pool exhaustion**.

---

## Primary Bottleneck Analysis

### Evidence

1. **`db_timeout_errors_total`** counter spiked at 220 VUs. The API returned `503` responses with bodies containing `"db"` in the error message, confirming DB connection timeouts.

2. **`redis_timeout_errors_total`** remained at 0 throughout all profiles, ruling out Redis as the bottleneck.

3. **Horizon error rate** (`horizon_error_rate`) began rising after 300 VUs. This is a *secondary* bottleneck: when DB queries queue, the Horizon submission thread also backs up, causing Stellar XDR submission timeouts. The Horizon limit is ~5 req/s on testnet; at 300 VUs the API was submitting ~18 payment transactions/s.

4. **Escrow polling and FX rate fetches** degraded gracefully (p95 < 1 s even at 400 VUs) because they are read-only operations served from the in-memory store and Redis cache respectively.

### Root cause: DB connection pool exhaustion

The API uses a single connection pool of **10 connections** (default). At 100 VUs with a 60% payment mix, peak concurrency requires ~60 DB connections simultaneously. The pool queue depth (`db_pool_pending_connections`) was observed via the `/metrics` endpoint at 220 VUs.

**Recommendation:**
- Increase pool size to 50 connections (requires DB server max_connections increase to ≥ 200).
- Add connection pool metrics (`db_pool_size`, `db_pool_pending`) to Prometheus.
- Consider PgBouncer in transaction pooling mode for horizontal scaling.

### Secondary bottleneck: Horizon testnet rate limits

Stellar's public testnet Horizon applies a rate limit of ~5 transaction submissions/s per IP. In production, deploy against a **dedicated Horizon instance** (or use Stellar's Mainnet Horizon with a higher rate limit).

---

## Throughput Ceiling

| Mode | Max Sustained RPS | Max VUs (no errors) |
|---|---|---|
| Read-only (escrow poll + rates) | 350 rps | 500+ VUs |
| Mixed (60% writes) | 95 rps | ~180 VUs |
| Write-heavy (90% payment initiation) | 55 rps | ~130 VUs |

---

## CI Smoke Gate

The smoke profile (5 VUs, 1 min) is configured as a required CI gate:

```yaml
# .github/workflows/load-tests.yml
thresholds:
  http_req_duration: p(95) < 500 ms
  http_req_failed: rate == 0
```

The smoke profile must pass on every PR before merge.

---

## How to Run

```bash
# Smoke (CI gate)
k6 run --env BASE_URL=http://localhost:8000 load-tests/scenarios/smoke.js

# Load (staging characterisation)
k6 run --env BASE_URL=http://staging.afropay.io \
       --env LOAD_VUS=100 \
       load-tests/scenarios/load.js

# Stress (find the cliff)
k6 run --env BASE_URL=http://staging.afropay.io \
       --env STRESS_MAX_VUS=500 \
       load-tests/scenarios/stress.js

# Output results to JSON for archival
k6 run --out json=results/$(date +%Y%m%d)-smoke.json \
       --env BASE_URL=http://localhost:8000 \
       load-tests/scenarios/smoke.js
```

---

## Re-baselining

Re-run the load profile and update this document whenever:
- A new database, cache, or Stellar integration is added.
- Pool sizes, timeouts, or infrastructure tier changes.
- p95 latency on main degrades by more than 20% vs this baseline.

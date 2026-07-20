# Runbook: RateOracleStaleness

## Overview

| Field | Value |
|---|---|
| **Alert name** | `RateOracleStaleness` |
| **Severity** | Warning |
| **Team** | Oracle |
| **SLO impact** | Partial — new payments use incorrect exchange rates |

## Trigger Condition

```promql
rate_oracle_staleness_seconds > 120
```

The FX rate oracle has not published a fresh exchange rate for a corridor in more than **120 seconds** (2 minutes). The oracle is expected to refresh rates every 5 minutes; 120 s gives a buffer before rates become dangerously stale.

---

## Immediate Triage Steps

### 1. Identify which corridors are stale
```promql
rate_oracle_staleness_seconds > 60
```
Check the Grafana "FX Rate Oracle Staleness" panel or query Prometheus directly.

### 2. Check oracle service health
```bash
kubectl get pods -l app=afropay-oracle
kubectl logs -l app=afropay-oracle --since=5m
```

### 3. Check upstream rate feed sources
The oracle aggregates from multiple sources (Coinbase, Binance, local FX APIs). Check each:
```bash
# Example: test connectivity to a rate feed
curl https://api.coinbase.com/v2/exchange-rates?currency=USD
```

### 4. Verify oracle is publishing to the API
```bash
curl https://api.afropay.io/api/v1/rates
# Look at the `updated_at` timestamps per corridor
```

### 5. Force a manual rate refresh (if oracle is running but stale)
```bash
curl -X POST https://oracle.afropay.io/v1/refresh-rates \
  -H "Authorization: Bearer $ORACLE_ADMIN_KEY"
```

---

## Possible Root Causes

| Symptom | Likely Cause | Action |
|---|---|---|
| Oracle pod not running | Crash / OOM kill | Restart pod, check memory limits |
| Oracle running but not publishing | Rate feed API returning errors | Check upstream APIs, implement fallback source |
| Only one corridor stale | That corridor's primary feed is down | Switch to backup feed source for that corridor |
| All corridors stale at the same time | Network issue or shared rate feed outage | Check network connectivity from oracle pod |
| Rates present but not updating | Clock skew between oracle and API | Sync NTP on oracle host |

---

## Rate Staleness Thresholds

| Staleness | Risk | Action |
|---|---|---|
| 0–60 s | None — within normal refresh cycle | No action |
| 60–120 s | Low — approaching alert threshold | Monitor |
| 120–300 s | Medium — alert firing | Triage immediately |
| 300–600 s | High — reject new payments on affected corridor | Pause corridor in API config |
| > 600 s | Critical — escalate immediately | Page oracle team lead |

---

## Disabling a Stale Corridor

If rates are dangerously stale and you cannot restore the oracle quickly:
```bash
# Update the API configuration to disable the corridor temporarily
# (Edit the CORRIDOR_ENABLED environment variable and redeploy, or use the admin API)
curl -X PATCH https://api.afropay.io/admin/corridors/USD_NGN \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"enabled": false}'
```

---

## Escalation Path

1. **< 5 min**: On-call engineer restarts oracle service and checks upstream feeds.
2. **5–15 min**: If not resolved, page the oracle team.
3. **> 15 min with staleness > 300 s**: Disable affected corridor(s) to prevent incorrect rate applications; page the oracle team lead.

---

## Recovery Verification

Alert auto-resolves when `rate_oracle_staleness_seconds` drops below 120 for the affected corridor. Confirm via the Grafana "FX Rate Oracle Staleness" panel.

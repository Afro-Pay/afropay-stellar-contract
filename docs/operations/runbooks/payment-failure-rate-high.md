# Runbook: PaymentFailureRateHigh

## Overview

| Field | Value |
|---|---|
| **Alert name** | `PaymentFailureRateHigh` |
| **Severity** | Critical |
| **Team** | Payments |
| **SLO impact** | Yes — directly impacts user-facing payment success rate |

## Trigger Condition

```
(
  sum(rate(payment_submissions_total{status="failure"}[5m]))
  /
  (sum(rate(payment_submissions_total[5m])) > 0)
) > 0.05
```

More than **5 % of payment submissions** have a `failure` status in the last 5 minutes, sustained for 5 minutes.

---

## Immediate Triage Steps

### 1. Quantify scope
```promql
# Which corridors are failing?
sum by (corridor) (rate(payment_submissions_total{status="failure"}[5m]))
  /
sum by (corridor) (rate(payment_submissions_total[5m]))
```

### 2. Check Horizon connectivity
```bash
curl https://horizon-testnet.stellar.org  # or mainnet
# Also check the /health endpoint:
curl https://api.afropay.io/health
```
If `horizon.connected` is `false`, the root cause is Horizon unavailability — see escalation below.

### 3. Check oracle staleness
If `rate_oracle_staleness_seconds` > 120 for the failing corridor, payments are failing due to stale FX rates. See [rate-oracle-staleness.md](./rate-oracle-staleness.md).

### 4. Check API error logs
```bash
kubectl logs -l app=afropay-api --since=10m | grep '"status":"failure"'
```
Look for recurring error patterns: contract rejection codes, Horizon submission errors, KYC failures.

### 5. Check escrow contract state
If the Soroban contract is returning `InvalidState` or `Unauthorized` errors, the issue may be in the contract deployment or oracle registration — escalate to the blockchain team.

---

## Possible Root Causes

| Symptom | Likely Cause | Action |
|---|---|---|
| All corridors failing | Horizon unavailable or degraded | Check Horizon status page, implement exponential backoff |
| Single corridor failing | Oracle down for that corridor | Restart oracle service, check oracle key rotation |
| Spike after deployment | Code regression in payment flow | Roll back to previous release |
| Gradual rise | DB connection pool exhaustion | Scale database, increase pool size |
| SEP-10 JWT errors | Key rotation without cache invalidation | Clear TOML cache, redeploy API |

---

## Escalation Path

1. **< 5 min**: On-call engineer investigates using steps above.
2. **5–15 min**: If not resolved, page the payments team lead.
3. **15–30 min**: If Horizon is the root cause, engage Stellar Development Foundation status channels.
4. **> 30 min**: Invoke incident response procedure; consider halting new payment submissions via the admin pause endpoint.

### Admin pause command (last resort)
```bash
# Pause the escrow contract to prevent further fund lockup
stellar contract invoke \
  --id $CONTRACT_ID \
  --source-account $ADMIN_KEY \
  -- pause
```

---

## Recovery Verification

Alert should auto-resolve when:
```promql
(sum(rate(payment_submissions_total{status="failure"}[5m])) / sum(rate(payment_submissions_total[5m]))) < 0.05
```

Confirm via the Grafana "Payment Failure Rate (5m)" panel returning to green.

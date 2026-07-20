# Runbook: EscrowStuckInFunded

## Overview

| Field | Value |
|---|---|
| **Alert name** | `EscrowStuckInFunded` |
| **Severity** | Critical |
| **Team** | Payments |
| **SLO impact** | Yes — user funds are locked; timeout refund may not fire |

## Trigger Condition

```promql
histogram_quantile(
  0.99,
  rate(escrow_state_duration_seconds_bucket{state="Funded"}[10m])
) > 1800
```

The **99th percentile time** an escrow spends in the `Funded` state exceeds **30 minutes**.

The Soroban contract timeout is typically 2 hours. At 30 minutes we have time to investigate before automatic refund becomes the only option.

---

## Immediate Triage Steps

### 1. Identify stuck escrows
```bash
# Query the API store for escrows in Funded state older than 30 min
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://api.afropay.io/api/v1/escrow?state=Funded
```

### 2. Check oracle delivery submissions
The most common cause is the oracle failing to submit an attestation. Check oracle logs:
```bash
kubectl logs -l app=afropay-oracle --since=60m | grep -E "error|attestation|submit"
```

### 3. Verify oracle is registered on-chain
```bash
stellar contract invoke \
  --id $CONTRACT_ID \
  --source-account $ADMIN_KEY \
  -- get_oracle
```
If the oracle address has changed (key rotation without on-chain update), re-register:
```bash
stellar contract invoke \
  --id $CONTRACT_ID \
  --source-account $ADMIN_KEY \
  -- register_oracle --oracle $NEW_ORACLE_ADDRESS
```

### 4. Check off-ramp partner status
If the off-ramp partner (M-Pesa, Flutterwave, etc.) is experiencing an outage, the oracle cannot confirm delivery. Check their status pages and the `external_transaction_id` on affected transactions.

### 5. Manual release (with oracle confirmation)
If the oracle is operational but the automatic submission failed, trigger a manual attestation:
```bash
curl -X POST https://oracle.afropay.io/v1/attest \
  -H "Authorization: Bearer $ORACLE_KEY" \
  -d '{"escrow_id": "<id>", "delivery_success": true, "proof_ref": "<ref>"}'
```

---

## Possible Root Causes

| Symptom | Likely Cause | Action |
|---|---|---|
| Oracle logs show HTTP 503 from off-ramp | Off-ramp partner outage | Wait for recovery, contact partner |
| Oracle key mismatch on-chain | Oracle key rotated without contract update | Re-register oracle key |
| Oracle not running | Service crash/OOM | Restart oracle pod |
| Horizon submission rejected | Network congestion, sequence number mismatch | Retry with fresh sequence number |
| Escrow timeout already elapsed | Refund window reached | Trigger claim_refund on behalf of sender |

---

## Timeout Refund Procedure

If the escrow timeout has passed and the oracle has not confirmed, initiate the refund:
```bash
stellar contract invoke \
  --id $CONTRACT_ID \
  --source-account $SENDER_KEY \
  -- claim_refund --escrow_id $ESCROW_ID
```

After triggering refund, update the internal database status via the API and notify the sender.

---

## Escalation Path

1. **< 10 min**: On-call engineer checks oracle health and off-ramp partner status.
2. **10–30 min**: Page payments team lead; prepare manual oracle attestation if off-ramp confirmed delivery.
3. **> 30 min with no resolution**: Initiate refund procedure for affected escrows; page the payments lead and blockchain team.

---

## Recovery Verification

Alert resolves when the P99 `Funded` state duration drops below 1800 s. Verify by checking the "P99 Time Escrow Stuck in Funded" Grafana panel.

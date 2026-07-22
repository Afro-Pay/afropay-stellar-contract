# Stellar Signing Key Rotation Runbook

**Document:** `docs/operations/key-rotation.md`  
**Owner:** Platform Security  
**Reviewed:** 2026-07  
**Classification:** Internal — Operations

---

## Overview

The AfroPay relayer service holds a **Stellar Ed25519 signing key** (hot wallet) used to:

1. Sign SEP-10 challenge transactions (authenticating users against the anchor)
2. Submit Soroban escrow transactions on behalf of AfroPay
3. Act as the treasury co-signer for multi-sig operations

A compromised key can drain the relayer hot wallet and sign fraudulent escrow releases. This runbook describes how to rotate the key with **zero service interruption**, update Vault, and deprecate the old key safely.

---

## Prerequisites

| Requirement | Details |
|---|---|
| Vault access | `relayer-admin` or `root` Vault token with write access to `secret/relayer/signing-key` |
| Stellar CLI | `stellar` CLI ≥ 20.x, or use [stellar.expert](https://stellar.expert/) for key generation |
| Horizon access | Read access to Horizon API (testnet or mainnet) |
| Node.js | ≥ 18 (for the helper scripts) |
| Multi-sig quorum | At least 2 of 3 admin keyholders if the old key is a multi-sig signer |

---

## When to Rotate

Rotate the Stellar signing key **immediately** if any of the following occur:

- [ ] A team member with knowledge of the key leaves the organisation
- [ ] The Vault `secret/relayer/signing-key` path was accessed by an unexpected token (check audit log)
- [ ] The key appears in any git diff, log, or error message
- [ ] CI/CD environment was compromised
- [ ] Routine scheduled rotation (every 90 days per policy — see `docs/operations/secrets.md`)

---

## Step-by-Step Procedure

### Phase 0 — Preparation

```bash
# Set environment variables for this session
export VAULT_ADDR="https://vault.afropay.internal:8200"
export VAULT_TOKEN="<your-operator-token>"      # Must have write on secret/relayer/*
export STELLAR_NETWORK="testnet"                 # or "mainnet"
export HORIZON_URL="https://horizon-testnet.stellar.org"  # adjust for mainnet

# Confirm you can reach Vault
vault status

# Confirm Horizon is reachable
curl -sf "${HORIZON_URL}/fee_stats" | jq .last_ledger
```

### Phase 1 — Read and verify the current key

```bash
# 1a. Read the current key from Vault (never log the seed to a file)
CURRENT_PUBLIC_KEY=$(vault kv get -field=public_key secret/relayer/signing-key)
CURRENT_KEY_VERSION=$(vault kv get -field=key_version secret/relayer/signing-key)

echo "Current public key:  ${CURRENT_PUBLIC_KEY}"
echo "Current key version: ${CURRENT_KEY_VERSION}"

# 1b. Verify the public key exists and has the expected minimum balance on-chain
curl -sf "${HORIZON_URL}/accounts/${CURRENT_PUBLIC_KEY}" | \
  jq '{account_id: .id, sequence: .sequence, xlm_balance: (.balances[] | select(.asset_type=="native") | .balance)}'
```

> ⚠️ If the account does not exist on-chain, **stop here** and contact the security team — the signing key may already be compromised or the account was never funded.

### Phase 2 — Generate the new keypair

```bash
# 2a. Generate a new Ed25519 keypair offline (air-gapped workstation preferred)
#     Option A — Stellar CLI
stellar keys generate --network ${STELLAR_NETWORK} new-relayer-key
NEW_PUBLIC_KEY=$(stellar keys address new-relayer-key)
NEW_SECRET_SEED=$(stellar keys show new-relayer-key --expose-secret-key)

#     Option B — Node.js one-liner (acceptable if offline generation is not feasible)
node -e "
const { Keypair } = require('@stellar/stellar-sdk');
const kp = Keypair.random();
console.log('PUBLIC_KEY=' + kp.publicKey());
console.log('SECRET_SEED=' + kp.secret());
"

echo "New public key:  ${NEW_PUBLIC_KEY}"
# Do NOT echo the secret seed — keep it only in your secure clipboard

# 2b. Confirm the new key is NOT already funded (sanity check)
HTTP_STATUS=$(curl -so /dev/null -w "%{http_code}" "${HORIZON_URL}/accounts/${NEW_PUBLIC_KEY}")
if [ "$HTTP_STATUS" = "404" ]; then
  echo "OK — new account does not yet exist on-chain."
else
  echo "WARNING: New account already exists. Generate a different keypair."
  exit 1
fi
```

### Phase 3 — Fund the new account from the old account

The new keypair must be funded before it can transact on Stellar. The relayer's current account pays the base reserve (1 XLM).

```bash
# 3a. Fund the new account (creates it on-chain with base reserve)
#     Replace <CURRENT_SECRET_SEED> with the value from Vault (do not store in shell history)
stellar transaction send \
  --source-account "${CURRENT_PUBLIC_KEY}" \
  --network ${STELLAR_NETWORK} \
  --fee 100 \
  --create-account "${NEW_PUBLIC_KEY}" \
  --starting-balance "2"   # 1 XLM base reserve + 1 XLM operating buffer

# 3b. Verify the new account exists
curl -sf "${HORIZON_URL}/accounts/${NEW_PUBLIC_KEY}" | \
  jq '{account_id: .id, xlm_balance: (.balances[] | select(.asset_type=="native") | .balance)}'
```

> If you need to fund from treasury (multi-sig), initiate the multi-sig funding transaction and wait for quorum sign-off before continuing.

### Phase 4 — Update the TOML and API configuration in staging

Before rotating production, validate the new key in staging:

```bash
# 4a. Write the new key to Vault (staging namespace or dev Vault)
NEW_KEY_VERSION=$(( CURRENT_KEY_VERSION + 1 ))

vault kv put secret/relayer/signing-key \
  seed="${NEW_SECRET_SEED}" \
  public_key="${NEW_PUBLIC_KEY}" \
  key_version="${NEW_KEY_VERSION}" \
  rotated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  previous_public_key="${CURRENT_PUBLIC_KEY}"

# 4b. Restart the staging relayer service to pick up the new credentials
#     (exact command depends on your deployment — kubectl, docker compose, systemd)
kubectl rollout restart deployment/relayer -n afropay-staging   # Kubernetes
# OR
docker compose restart relayer                                   # Docker Compose

# 4c. Wait for the relayer to come healthy
kubectl rollout status deployment/relayer -n afropay-staging
```

```bash
# 4d. Update stellar.toml SIGNING_KEY to the new public key
#     (edit public/.well-known/stellar.toml and redeploy the static hosting)
sed -i "s/${CURRENT_PUBLIC_KEY}/${NEW_PUBLIC_KEY}/" public/.well-known/stellar.toml

# 4e. Validate SEP-10 challenge signing with the new key
curl -sf "https://staging.afropay.io/auth?account=G..." | jq .transaction | \
  node -e "
    const { Transaction, Networks } = require('@stellar/stellar-sdk');
    const tx = new Transaction(require('fs').readFileSync('/dev/stdin','utf8').trim(), Networks.TESTNET);
    console.log('Signed by:', tx.signatures.map(s => s.hint().toString('hex')));
  "
```

### Phase 5 — Production rotation

After staging validation passes (≥ 15 min of clean operation):

```bash
# 5a. Write the new key to Vault production
vault kv put secret/relayer/signing-key \
  seed="${NEW_SECRET_SEED}" \
  public_key="${NEW_PUBLIC_KEY}" \
  key_version="${NEW_KEY_VERSION}" \
  rotated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  previous_public_key="${CURRENT_PUBLIC_KEY}"

# 5b. Perform a rolling restart of the production relayer
kubectl rollout restart deployment/relayer -n afropay-production
kubectl rollout status deployment/relayer -n afropay-production --timeout=5m

# 5c. Update stellar.toml SIGNING_KEY in production
#     Redeploy public/.well-known/stellar.toml through your CDN/hosting pipeline
git commit -am "chore: rotate Stellar signing key to version ${NEW_KEY_VERSION}"
git push origin main   # triggers CDN deploy

# 5d. Monitor for 5 minutes — check SEP-10 auth success rate
kubectl logs -n afropay-production deployment/relayer --tail=100 -f | \
  grep -E '(SEP-10|challenge|signed|error)'
```

### Phase 6 — Deprecate and archive the old key

```bash
# 6a. Confirm no in-flight SEP-10 challenges are signed by the old key
#     (SEP-10 challenges expire in ~15 minutes; wait that long before deprecating)
sleep 900  # 15 minutes

# 6b. Record the old key in the audit trail
vault kv metadata put secret/relayer/signing-key \
  custom_metadata_deprecated_key="${CURRENT_PUBLIC_KEY}" \
  custom_metadata_deprecated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# 6c. Optionally merge the old account's remaining XLM back to treasury
#     (only if the old account has no active escrow obligations)
# stellar transaction send --source-account OLD_KEY --merge-account TREASURY_KEY ...

# 6d. Revoke the old key's Vault AppRole secret_id
#     (prevents any lingering service instances from re-authenticating with old creds)
vault write -f auth/approle/role/relayer-service/secret-id-accessor/destroy \
  secret_id_accessor="<old-accessor-from-vault-audit-log>"
```

---

## Rollback Procedure

If the new key causes issues (e.g., SEP-10 auth failures, transaction submission errors):

```bash
# R1. Immediately rewrite Vault with the OLD key
vault kv put secret/relayer/signing-key \
  seed="${OLD_SECRET_SEED}" \
  public_key="${CURRENT_PUBLIC_KEY}" \
  key_version="${CURRENT_KEY_VERSION}" \
  rotated_at="" \
  previous_public_key=""

# R2. Restart the relayer to reload the old credentials
kubectl rollout restart deployment/relayer -n afropay-production
kubectl rollout status deployment/relayer -n afropay-production --timeout=5m

# R3. Revert stellar.toml to the old public key
git revert HEAD
git push origin main

# R4. Investigate — check Vault audit logs for any unexpected access
vault audit list
vault read sys/audit/file
```

> **Time budget:** Rollback must complete within 10 minutes of detecting the issue to minimise disruption to active SEP-10 sessions.

---

## Verification Checklist

After rotation (or rollback), verify all of the following:

- [ ] `vault kv get secret/relayer/signing-key` returns the expected `public_key`
- [ ] `public/.well-known/stellar.toml` `SIGNING_KEY` matches the Vault `public_key`
- [ ] SEP-10 `/auth?account=<test_account>` returns a valid challenge signed by the new key
- [ ] A full test-user sign-in completes successfully end-to-end
- [ ] Relayer pod logs show no signature errors in the first 5 minutes
- [ ] Prometheus alert `relayer_signing_error_total` is 0
- [ ] Vault audit log shows `write` to `secret/relayer/signing-key` with your operator token only

---

## Scheduled Rotation Schedule

| Environment | Frequency | Last Rotated | Next Due |
|---|---|---|---|
| Production | Every 90 days | _(update after each rotation)_ | _(update after each rotation)_ |
| Staging | Every 180 days | _(update after each rotation)_ | _(update after each rotation)_ |

---

## Emergency Contacts

| Role | Contact | Channel |
|---|---|---|
| Platform Security Lead | `@security-lead` | PagerDuty P1 |
| Vault Admin | `@vault-admin` | `#vault-ops` Slack |
| On-call Engineer | See PagerDuty rotation | PagerDuty |
| Stellar Network Status | https://status.stellar.org | — |

---

## Related Documents

- [`docs/operations/secrets.md`](./secrets.md) — Full secrets inventory and rotation schedule
- [`infrastructure/vault/policies/relayer-service.hcl`](../../infrastructure/vault/policies/relayer-service.hcl) — Vault policy for relayer
- [`infrastructure/vault/init.sh`](../../infrastructure/vault/init.sh) — Vault bootstrap script
- [`docs/adr/ADR-005-sep10-relayer-auth.md`](../adr/ADR-005-sep10-relayer-auth.md) — ADR for relayer auth design

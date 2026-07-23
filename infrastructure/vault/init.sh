#!/usr/bin/env bash
# ============================================================================
# Vault Initialization & Bootstrap Script — AfroPay
# ============================================================================
# Run ONCE on a fresh Vault instance to:
#   1. Initialize Vault (generates unseal keys + root token)
#   2. Unseal Vault
#   3. Enable the KV v2 and Database secrets engines
#   4. Configure Postgres dynamic credentials
#   5. Apply all least-privilege policies
#   6. Create service tokens for each service
#
# Usage:
#   VAULT_ADDR=http://localhost:8200 \
#   POSTGRES_HOST=localhost \
#   POSTGRES_PORT=5432 \
#   POSTGRES_DB=afropay \
#   POSTGRES_ROOT_USER=postgres \
#   POSTGRES_ROOT_PASSWORD=<secret> \
#   ./infrastructure/vault/init.sh
#
# Outputs init.json (KEEP SECURE — contains unseal keys + root token).
# ============================================================================
set -euo pipefail

VAULT_ADDR="${VAULT_ADDR:-http://localhost:8200}"
export VAULT_ADDR

echo "==> Waiting for Vault to be reachable..."
for i in $(seq 1 30); do
  if curl -sf "${VAULT_ADDR}/v1/sys/health" > /dev/null 2>&1; then
    break
  fi
  sleep 2
  echo "    Attempt $i/30..."
done

# ---------------------------------------------------------------------------
# 1. Initialize
# ---------------------------------------------------------------------------
echo "==> Initializing Vault (5 key shares, threshold 3)..."
vault operator init \
  -key-shares=5 \
  -key-threshold=3 \
  -format=json > init.json

echo "    init.json written — store each unseal key in a separate secure location!"

ROOT_TOKEN=$(jq -r '.root_token' init.json)
export VAULT_TOKEN="$ROOT_TOKEN"

# ---------------------------------------------------------------------------
# 2. Unseal (using first 3 of 5 shares)
# ---------------------------------------------------------------------------
echo "==> Unsealing Vault..."
for i in 0 1 2; do
  KEY=$(jq -r ".unseal_keys_b64[$i]" init.json)
  vault operator unseal "$KEY"
done

# ---------------------------------------------------------------------------
# 3. Secrets Engines
# ---------------------------------------------------------------------------
echo "==> Enabling KV v2 secrets engine at 'secret/'..."
vault secrets enable -path=secret kv-v2 || true

echo "==> Enabling database secrets engine..."
vault secrets enable database || true

# ---------------------------------------------------------------------------
# 4. Configure Postgres dynamic credentials
# ---------------------------------------------------------------------------
PG_HOST="${POSTGRES_HOST:-localhost}"
PG_PORT="${POSTGRES_PORT:-5432}"
PG_DB="${POSTGRES_DB:-afropay}"
PG_USER="${POSTGRES_ROOT_USER:-postgres}"
PG_PASS="${POSTGRES_ROOT_PASSWORD}"

echo "==> Configuring Postgres connection for dynamic credentials..."
vault write database/config/afropay-postgres \
  plugin_name=postgresql-database-plugin \
  allowed_roles="api-role,reconciler-role" \
  connection_url="postgresql://{{username}}:{{password}}@${PG_HOST}:${PG_PORT}/${PG_DB}?sslmode=require" \
  username="${PG_USER}" \
  password="${PG_PASS}"

echo "==> Creating DB role: api-role (1h TTL, read/write)..."
vault write database/roles/api-role \
  db_name=afropay-postgres \
  creation_statements="
    CREATE ROLE \"{{name}}\" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}';
    GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO \"{{name}}\";
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO \"{{name}}\";
  " \
  revocation_statements="DROP ROLE IF EXISTS \"{{name}}\";" \
  default_ttl="1h" \
  max_ttl="24h"

echo "==> Creating DB role: reconciler-role (1h TTL, read-only)..."
vault write database/roles/reconciler-role \
  db_name=afropay-postgres \
  creation_statements="
    CREATE ROLE \"{{name}}\" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}';
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO \"{{name}}\";
  " \
  revocation_statements="DROP ROLE IF EXISTS \"{{name}}\";" \
  default_ttl="1h" \
  max_ttl="24h"

# ---------------------------------------------------------------------------
# 5. Apply policies
# ---------------------------------------------------------------------------
echo "==> Applying service policies..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POLICIES_DIR="${SCRIPT_DIR}/policies"

for policy_file in "${POLICIES_DIR}"/*.hcl; do
  policy_name=$(basename "$policy_file" .hcl)
  echo "    Applying policy: ${policy_name}"
  vault policy write "${policy_name}" "${policy_file}"
done

# ---------------------------------------------------------------------------
# 6. Enable AppRole auth for each service
# ---------------------------------------------------------------------------
echo "==> Enabling AppRole auth method..."
vault auth enable approle || true

for service in api-service relayer-service oracle-service reconciler-service; do
  echo "    Creating AppRole: ${service}"
  vault write "auth/approle/role/${service}" \
    policies="${service}" \
    token_ttl="1h" \
    token_max_ttl="24h" \
    secret_id_ttl="720h"

  ROLE_ID=$(vault read -field=role_id "auth/approle/role/${service}/role-id")
  SECRET_ID=$(vault write -f -field=secret_id "auth/approle/role/${service}/secret-id")

  echo "    ${service} RoleID:    ${ROLE_ID}"
  echo "    ${service} SecretID:  ${SECRET_ID}"
  echo "    (Store these in your secrets manager / environment)"
done

# ---------------------------------------------------------------------------
# 7. Seed static secrets (placeholders — replace values before first use)
# ---------------------------------------------------------------------------
echo "==> Writing placeholder static secrets (update with real values)..."
vault kv put secret/api/jwt-secret       value="REPLACE_ME_JWT_SECRET"
vault kv put secret/api/master-enc-key   value="REPLACE_ME_BASE64_32BYTE_KEY"
vault kv put secret/api/redis            password="REPLACE_ME_REDIS_PASSWORD"
vault kv put secret/api/flutterwave      secret_key="REPLACE_ME_FLUTTERWAVE_SECRET"
vault kv put secret/api/paystack         secret_key="REPLACE_ME_PAYSTACK_SECRET"
vault kv put secret/relayer/signing-key  seed="REPLACE_ME_STELLAR_SIGNING_SEED" \
                                         public_key="REPLACE_ME_STELLAR_PUBLIC_KEY" \
                                         key_version="1" \
                                         rotated_at=""
vault kv put secret/oracle/providers/flutterwave api_key="REPLACE_ME_FLW_API_KEY"
vault kv put secret/oracle/providers/cbn          api_key="REPLACE_ME_CBN_API_KEY"

# ---------------------------------------------------------------------------
# 8. Enable audit log
# ---------------------------------------------------------------------------
echo "==> Enabling file audit log..."
vault audit enable file file_path=/vault/logs/audit.log || true

echo ""
echo "==> Vault bootstrap complete!"
echo "    ⚠️  Distribute the 5 unseal keys to separate keyholders (see init.json)"
echo "    ⚠️  Revoke the root token after bootstrap:"
echo "        vault token revoke \$ROOT_TOKEN"
echo "    ⚠️  Replace all REPLACE_ME_* placeholder values immediately."

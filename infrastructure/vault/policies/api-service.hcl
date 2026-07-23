# ============================================================================
# Vault Policy: api-service
# ============================================================================
# Grants read-only access to secrets required by the AfroPay API service:
#   - JWT secret
#   - Master encryption key (for user wallet storage)
#   - Redis password
#   - Static provider API keys (Flutterwave, Paystack)
#   - Dynamic Postgres credentials
#
# NO access to:
#   - Stellar signing keys (relayer-only)
#   - Oracle provider secrets (oracle-only)
# ============================================================================

# KV v2 secrets — API service secrets
path "secret/data/api/*" {
  capabilities = ["read", "list"]
}

# Dynamic DB credentials — read-only
path "database/creds/api-role" {
  capabilities = ["read"]
}

# Renew own leases (for dynamic creds TTL refresh)
path "sys/leases/renew" {
  capabilities = ["update"]
}

# Lookup self-capabilities (debugging)
path "sys/capabilities-self" {
  capabilities = ["read"]
}

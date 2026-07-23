# ============================================================================
# Vault Policy: reconciler-service
# ============================================================================
# The reconciler compares on-chain escrow state with Postgres state.
# It requires read-only dynamic DB credentials.
#
# NO access to:
#   - Stellar signing keys (relayer-only)
#   - Provider API keys (oracle/api-only)
#   - Master encryption key (api-only)
#   - Redis password (api/queue-only)
# ============================================================================

# Dynamic DB credentials for reconciler (read-only Postgres role)
path "database/creds/reconciler-role" {
  capabilities = ["read"]
}

# Renew own leases (TTL refresh)
path "sys/leases/renew" {
  capabilities = ["update"]
}

# Renew own token
path "auth/token/renew-self" {
  capabilities = ["update"]
}

# Lookup self
path "sys/capabilities-self" {
  capabilities = ["read"]
}

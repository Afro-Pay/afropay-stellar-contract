# ============================================================================
# Vault Policy: oracle-service
# ============================================================================
# The oracle aggregates FX rates from Flutterwave, CBN, and Stellar DEX.
# It requires:
#   - Read access to provider API keys (rate sources)
#
# NO access to:
#   - Stellar signing keys (relayer-only)
#   - Database credentials (api/reconciler-only)
#   - Master encryption key (api-only)
#   - Redis password (api/queue-only)
# ============================================================================

# FX rate provider API keys
path "secret/data/oracle/providers/*" {
  capabilities = ["read", "list"]
}

# Renew own token
path "auth/token/renew-self" {
  capabilities = ["update"]
}

# Lookup self
path "sys/capabilities-self" {
  capabilities = ["read"]
}

# ============================================================================
# Vault Policy: relayer-service
# ============================================================================
# Grants access ONLY to the Stellar signing key (hot wallet seed).
# The relayer signs SEP-10 challenges and submits Stellar transactions.
#
# NO access to:
#   - Database credentials (api/reconciler-only)
#   - Provider API keys (api-only)
#   - Redis password (api/queue-only)
#   - Master encryption key (api-only)
# ============================================================================

# Stellar hot-wallet signing seed (current active key)
path "secret/data/relayer/signing-key" {
  capabilities = ["read"]
}

# Metadata only — allows listing without reading
path "secret/metadata/relayer/*" {
  capabilities = ["list"]
}

# Renew own token
path "auth/token/renew-self" {
  capabilities = ["update"]
}

# Renew own leases
path "sys/leases/renew" {
  capabilities = ["update"]
}

# Lookup self
path "sys/capabilities-self" {
  capabilities = ["read"]
}

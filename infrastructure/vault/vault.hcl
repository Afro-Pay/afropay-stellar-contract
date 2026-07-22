# ============================================================================
# HashiCorp Vault Server Configuration — AfroPay
# ============================================================================
# Production: replace "file" storage with "raft" (HA) or "consul".
# This config targets a single-node dev/staging Vault instance running
# in Docker alongside the AfroPay services.

ui = true

# ---------------------------------------------------------------------------
# Storage backend (single-node; switch to raft for HA)
# ---------------------------------------------------------------------------
storage "file" {
  path = "/vault/data"
}

# For HA / production Raft:
# storage "raft" {
#   path    = "/vault/data"
#   node_id = "vault-node-1"
#   retry_join {
#     leader_api_addr = "https://vault-node-2:8200"
#   }
# }

# ---------------------------------------------------------------------------
# Listener — TLS required in production; disabled here for local compose.
# Set VAULT_SKIP_VERIFY=true in services when using self-signed certs.
# ---------------------------------------------------------------------------
listener "tcp" {
  address       = "0.0.0.0:8200"
  tls_disable   = "true"   # CHANGE TO FALSE IN PRODUCTION — supply tls_cert_file / tls_key_file
  # tls_cert_file = "/vault/tls/vault.crt"
  # tls_key_file  = "/vault/tls/vault.key"
}

# ---------------------------------------------------------------------------
# API address (used by Vault for self-referential redirects)
# ---------------------------------------------------------------------------
api_addr     = "http://0.0.0.0:8200"
cluster_addr = "http://0.0.0.0:8201"

# ---------------------------------------------------------------------------
# Telemetry (Prometheus scrape)
# ---------------------------------------------------------------------------
telemetry {
  prometheus_retention_time = "30s"
  disable_hostname          = true
}

# ---------------------------------------------------------------------------
# Audit log — REQUIRED in production for compliance / SOC-2
# ---------------------------------------------------------------------------
# Enable after init:
#   vault audit enable file file_path=/vault/logs/audit.log

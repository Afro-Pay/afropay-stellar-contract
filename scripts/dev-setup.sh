#!/usr/bin/env bash
# ============================================================
# scripts/dev-setup.sh — AfroPay one-command local dev setup
# ============================================================
# Usage:
#   bash scripts/dev-setup.sh          # core stack (api + postgres + redis)
#   bash scripts/dev-setup.sh --full   # core + listener + reconciliation + oracle
#   bash scripts/dev-setup.sh --down   # tear everything down (data preserved)
#   bash scripts/dev-setup.sh --reset  # tear down AND wipe all volumes
#
# Prerequisites: Docker >= 24.0, Docker Compose plugin >= 2.24, Git, curl
#
# On a clean machine this should complete in < 10 minutes.
# ============================================================
set -euo pipefail

# ── Colour helpers ────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${BLUE}[INFO]${RESET}  $*"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*" >&2; exit 1; }
step()    { echo -e "\n${BOLD}▶ $*${RESET}"; }
banner()  {
  echo -e "${BOLD}${GREEN}"
  echo "  ╔══════════════════════════════════════════╗"
  echo "  ║  AfroPay Local Development Environment  ║"
  echo "  ╚══════════════════════════════════════════╝"
  echo -e "${RESET}"
}

# ── Constants ─────────────────────────────────────────────────────────────────
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/docker-compose.dev.yml"
ENV_FILE="$REPO_ROOT/.env"
ENV_EXAMPLE="$REPO_ROOT/.env.example"
COMPOSE_CMD="docker compose"
SETUP_START_TIME=$(date +%s)

# Minimum versions
MIN_DOCKER_VERSION="24.0"
MIN_COMPOSE_VERSION="2.24"

# ── Parse arguments ───────────────────────────────────────────────────────────
FULL_STACK=false
TEARDOWN=false
RESET_VOLUMES=false

for arg in "$@"; do
  case "$arg" in
    --full)   FULL_STACK=true ;;
    --down)   TEARDOWN=true ;;
    --reset)  TEARDOWN=true; RESET_VOLUMES=true ;;
    --help|-h)
      echo "Usage: $0 [--full | --down | --reset]"
      echo ""
      echo "  (no flag)   Start core stack: api + postgres + redis"
      echo "  --full      Also start listener, reconciliation, oracle services"
      echo "  --down      Stop all containers (volumes preserved)"
      echo "  --reset     Stop all containers AND delete all local data volumes"
      exit 0
      ;;
    *)
      warn "Unknown argument: $arg"
      ;;
  esac
done

# ── Teardown path ─────────────────────────────────────────────────────────────
if $TEARDOWN; then
  step "Stopping AfroPay dev stack"
  cd "$REPO_ROOT"
  if $RESET_VOLUMES; then
    warn "Removing ALL volumes — database and Redis data will be lost."
    read -rp "Are you sure? [y/N] " confirm
    [[ "${confirm,,}" == "y" ]] || error "Aborted."
    $COMPOSE_CMD -f "$COMPOSE_FILE" down --volumes --remove-orphans
    success "Stack stopped and volumes removed."
  else
    $COMPOSE_CMD -f "$COMPOSE_FILE" down --remove-orphans
    success "Stack stopped. Data volumes preserved."
  fi
  exit 0
fi

# ── Prerequisites check ───────────────────────────────────────────────────────
step "Checking prerequisites"

# Docker
if ! command -v docker &>/dev/null; then
  error "Docker is not installed. Install from https://docs.docker.com/get-docker/"
fi

DOCKER_VERSION=$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo "0.0")
if ! awk -v v="$DOCKER_VERSION" -v min="$MIN_DOCKER_VERSION" \
  'BEGIN { split(v,a,"."); split(min,b,"."); for(i=1;i<=2;i++) if(a[i]+0<b[i]+0) exit 1 }'; then
  error "Docker $MIN_DOCKER_VERSION+ required (found $DOCKER_VERSION). Please upgrade."
fi
success "Docker $DOCKER_VERSION"

# Docker Compose (plugin)
if ! docker compose version &>/dev/null; then
  error "Docker Compose plugin not found. Run: docker plugin install compose"
fi
COMPOSE_VERSION=$(docker compose version --short 2>/dev/null || echo "0.0.0")
success "Docker Compose $COMPOSE_VERSION"

# git
if ! command -v git &>/dev/null; then
  error "Git is not installed."
fi
success "Git $(git --version | awk '{print $3}')"

# curl
if ! command -v curl &>/dev/null; then
  error "curl is not installed."
fi
success "curl $(curl --version | head -1 | awk '{print $2}')"

# Docker daemon running?
if ! docker info &>/dev/null; then
  error "Docker daemon is not running. Start Docker Desktop or 'sudo systemctl start docker'."
fi

banner

# ── Environment file setup ────────────────────────────────────────────────────
step "Setting up environment variables"

if [[ ! -f "$ENV_FILE" ]]; then
  if [[ -f "$ENV_EXAMPLE" ]]; then
    cp "$ENV_EXAMPLE" "$ENV_FILE"
    info "Created .env from .env.example"
  else
    info "Creating default .env for local development"
    cat > "$ENV_FILE" <<'ENVEOF'
# ============================================================
# AfroPay Local Development Environment
# ============================================================
# These are safe defaults for local development only.
# NEVER use these values in production or staging.

# Stellar testnet configuration
NETWORK_PASSPHRASE=Test SDF Network ; September 2015
HORIZON_URL=https://horizon-testnet.stellar.org

# SEP-10 signing keypair (testnet only — rotate before mainnet)
# Generate a new one: stellar keys generate --global dev-key --network testnet
SEP10_SIGNING_SEED=SBMWGFMKDMUXQFJFG7M6MLXHRGFVLGRFHCVXVRCMRGUYSNWPYONBHVFT

# JWT secret (32+ chars)
JWT_SECRET=dev-jwt-secret-replace-in-production-32chars

# Master encryption key (32 bytes, base64-encoded)
MASTER_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=

# Database
POSTGRES_PASSWORD=afropay_dev_password

# Redis
REDIS_URL=redis://localhost:6379

# Contract deployment (fill in after running: bash scripts/dev-setup.sh --full)
CONTRACT_ID=
DEPLOYER_SECRET=

# Optional: third-party API keys (leave blank to use mock providers)
FLUTTERWAVE_SECRET_KEY=
CBN_API_KEY=
ENVEOF
  fi
  warn ".env created with development defaults — review before real use."
else
  success ".env already exists"
fi

# ── Build images ──────────────────────────────────────────────────────────────
step "Building Docker images (this may take a few minutes on first run)"
cd "$REPO_ROOT"

BUILD_ARGS=""
if $FULL_STACK; then
  BUILD_ARGS="--profile services"
fi

$COMPOSE_CMD -f "$COMPOSE_FILE" $BUILD_ARGS build --parallel 2>&1 | \
  grep -v "^#[0-9]" | grep -v "^=> " | grep -v "^CACHED" || true

success "Images built"

# ── Start infrastructure services ─────────────────────────────────────────────
step "Starting infrastructure (postgres, redis)"

$COMPOSE_CMD -f "$COMPOSE_FILE" up -d postgres redis

# ── Wait for postgres to be healthy ──────────────────────────────────────────
step "Waiting for PostgreSQL to be ready"
WAIT_TIMEOUT=120
ELAPSED=0
until docker compose -f "$COMPOSE_FILE" exec -T postgres \
  pg_isready -U afropay -d afropay -q 2>/dev/null; do
  sleep 2
  ELAPSED=$((ELAPSED + 2))
  if [[ $ELAPSED -ge $WAIT_TIMEOUT ]]; then
    error "PostgreSQL did not become ready within ${WAIT_TIMEOUT}s. Run 'docker compose -f docker-compose.dev.yml logs postgres' to debug."
  fi
  echo -n "."
done
echo ""
success "PostgreSQL is ready"

# ── Wait for redis ─────────────────────────────────────────────────────────────
step "Waiting for Redis to be ready"
ELAPSED=0
until docker compose -f "$COMPOSE_FILE" exec -T redis redis-cli ping 2>/dev/null | grep -q PONG; do
  sleep 2
  ELAPSED=$((ELAPSED + 2))
  if [[ $ELAPSED -ge 60 ]]; then
    error "Redis did not become ready within 60s."
  fi
  echo -n "."
done
echo ""
success "Redis is ready"

# ── Run database migrations ────────────────────────────────────────────────────
step "Running database migrations"

# The postgres initdb.d mounts handle migrations automatically on first start.
# This step verifies tables exist and applies any new migrations not yet run.
RUN_MIGRATION() {
  local file="$1"
  local name
  name=$(basename "$file")
  info "Applying migration: $name"
  docker compose -f "$COMPOSE_FILE" exec -T postgres \
    psql -U afropay -d afropay -f "/dev/stdin" < "$file" 2>&1 | \
    grep -v "already exists" | grep -v "^$" || true
}

# Check if core migration tables exist; if not run manually (handles volumes reset case)
TABLES_EXIST=$(docker compose -f "$COMPOSE_FILE" exec -T postgres \
  psql -U afropay -d afropay -tAc \
  "SELECT COUNT(*) FROM information_schema.tables WHERE table_name='escrow_events'" \
  2>/dev/null | tr -d '[:space:]')

if [[ "$TABLES_EXIST" != "1" ]]; then
  info "Tables not found — running core migrations manually"
  for f in "$REPO_ROOT"/db/migrations/*.sql; do
    [[ -f "$f" ]] && RUN_MIGRATION "$f"
  done
  for f in "$REPO_ROOT"/api/migrations/*.sql; do
    [[ -f "$f" ]] && RUN_MIGRATION "$f"
  done
else
  success "Migrations already applied"
fi

# ── Start API service ─────────────────────────────────────────────────────────
step "Starting AfroPay API"
$COMPOSE_CMD -f "$COMPOSE_FILE" up -d api

# Wait for API health
step "Waiting for API health check to pass"
ELAPSED=0
API_WAIT=90
until curl -sf http://localhost:8000/health 2>/dev/null | grep -q '"status"'; do
  sleep 3
  ELAPSED=$((ELAPSED + 3))
  if [[ $ELAPSED -ge $API_WAIT ]]; then
    error "API did not become healthy within ${API_WAIT}s. Check logs: docker compose -f docker-compose.dev.yml logs api"
  fi
  echo -n "."
done
echo ""
API_STATUS=$(curl -sf http://localhost:8000/health 2>/dev/null | \
  grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4 || echo "unknown")
success "API is healthy (status: $API_STATUS)"

# ── Seed testnet funded account via Friendbot ──────────────────────────────────
step "Seeding test account via Stellar Friendbot"

# Extract signing public key from .env (SEP10_SIGNING_SEED)
SIGNING_SEED=$(grep '^SEP10_SIGNING_SEED=' "$ENV_FILE" 2>/dev/null | cut -d'=' -f2- | tr -d '"' || echo "")
if [[ -z "$SIGNING_SEED" ]]; then
  warn "SEP10_SIGNING_SEED not set in .env — skipping Friendbot funding"
else
  # Use node (from API container) to get the public key from the seed
  SIGNING_PUBKEY=$(docker compose -f "$COMPOSE_FILE" exec -T api \
    node -e "const {Keypair}=require('@stellar/stellar-sdk'); console.log(Keypair.fromSecret('$SIGNING_SEED').publicKey())" \
    2>/dev/null | tr -d '[:space:]' || echo "")

  if [[ -n "$SIGNING_PUBKEY" && "$SIGNING_PUBKEY" =~ ^G[A-Z0-9]{55}$ ]]; then
    FRIENDBOT_RESPONSE=$(curl -sf \
      "https://friendbot.stellar.org?addr=${SIGNING_PUBKEY}" \
      -o /dev/null -w "%{http_code}" 2>/dev/null || echo "000")

    if [[ "$FRIENDBOT_RESPONSE" == "200" ]]; then
      success "Funded test account $SIGNING_PUBKEY via Friendbot"
    elif [[ "$FRIENDBOT_RESPONSE" == "400" ]]; then
      # 400 usually means account already funded
      info "Account $SIGNING_PUBKEY already exists on testnet (Friendbot returned 400)"
    else
      warn "Friendbot returned HTTP $FRIENDBOT_RESPONSE — skipping (requires internet access)"
    fi
  else
    warn "Could not derive public key from SEP10_SIGNING_SEED — skipping Friendbot"
  fi
fi

# ── Start full stack (optional) ───────────────────────────────────────────────
if $FULL_STACK; then
  step "Starting services profile (listener, reconciliation, oracle)"
  $COMPOSE_CMD -f "$COMPOSE_FILE" --profile services up -d

  info "Waiting for services to pass health checks..."
  sleep 10

  # Print service statuses
  $COMPOSE_CMD -f "$COMPOSE_FILE" --profile services ps
fi

# ── Print stack status ────────────────────────────────────────────────────────
step "Stack status"
$COMPOSE_CMD -f "$COMPOSE_FILE" ps

# ── Summary ───────────────────────────────────────────────────────────────────
ELAPSED=$(($(date +%s) - SETUP_START_TIME))
MINUTES=$((ELAPSED / 60))
SECONDS_REMAINING=$((ELAPSED % 60))

echo ""
echo -e "${BOLD}${GREEN}╔══════════════════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}${GREEN}║  AfroPay dev stack is running! (${MINUTES}m ${SECONDS_REMAINING}s elapsed)            ║${RESET}"
echo -e "${BOLD}${GREEN}╚══════════════════════════════════════════════════════════╝${RESET}"
echo ""
echo -e "  ${BOLD}Service endpoints:${RESET}"
echo -e "  • API             → ${BLUE}http://localhost:8000${RESET}"
echo -e "  • Health check    → ${BLUE}http://localhost:8000/health${RESET}"
echo -e "  • stellar.toml    → ${BLUE}http://localhost:8000/.well-known/stellar.toml${RESET}"
echo -e "  • SEP-10 auth     → ${BLUE}http://localhost:8000/auth${RESET}"
echo -e "  • SEP-12 KYC      → ${BLUE}http://localhost:8000/kyc${RESET}"
echo -e "  • SEP-31 payments → ${BLUE}http://localhost:8000/sep31${RESET}"
echo -e "  • Metrics         → ${BLUE}http://localhost:8000/metrics${RESET}"
echo -e "  • PostgreSQL      → ${BLUE}localhost:5432${RESET}  (user: afropay, db: afropay)"
echo -e "  • Redis           → ${BLUE}localhost:6379${RESET}"

if $FULL_STACK; then
  echo -e "  • Reconciliation  → ${BLUE}http://localhost:8001${RESET}"
  echo -e "  • Oracle          → ${BLUE}http://localhost:8002${RESET}"
fi

echo ""
echo -e "  ${BOLD}Useful commands:${RESET}"
echo -e "  • View logs:       docker compose -f docker-compose.dev.yml logs -f api"
echo -e "  • Stop stack:      bash scripts/dev-setup.sh --down"
echo -e "  • Wipe and restart: bash scripts/dev-setup.sh --reset"
echo -e "  • Build contracts: docker compose -f docker-compose.dev.yml --profile contracts run contracts"
echo -e "  • Connect to DB:   docker compose -f docker-compose.dev.yml exec postgres psql -U afropay afropay"
echo ""
echo -e "  ${YELLOW}Tip: Run 'bash scripts/dev-setup.sh --full' to also start listener, reconciliation, and oracle.${RESET}"
echo ""

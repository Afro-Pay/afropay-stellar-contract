# AfroPay — Decentralized Cross-Border Remittance Platform on Stellar

---

## 🚀 Local Development Setup

> **New here? Start here.** Get a fully running AfroPay stack in under 10 minutes.

### Prerequisites

You need only two things installed on your host machine:

| Tool | Minimum version | Install |
|------|----------------|---------|
| **Docker** (with Compose plugin) | 24.0 / Compose 2.24 | [docs.docker.com/get-docker](https://docs.docker.com/get-docker/) |
| **Git** | 2.x | [git-scm.com](https://git-scm.com) |

Everything else (Node.js 22, Rust, Soroban CLI, PostgreSQL, Redis) runs inside Docker. You do **not** need to install them on your host.

> **Linux users:** ensure your user is in the `docker` group (`sudo usermod -aG docker $USER`, then log out and back in) so you can run Docker without `sudo`.

### Quick start (≤ 10 minutes)

```bash
# 1. Clone the repository
git clone https://github.com/afropay/afropay-stellar-contract.git
cd afropay-stellar-contract

# 2. One-command setup — builds images, starts services, seeds test account
bash scripts/dev-setup.sh
```

The script will:
1. Check Docker and Git are present and meet minimum versions
2. Generate a `.env` from safe development defaults (you can edit it before running)
3. Build all Docker images in parallel
4. Start PostgreSQL and Redis, wait for health checks
5. Run all database migrations
6. Fund your test Stellar keypair via Friendbot
7. Start the Anchor API and verify the `/health` endpoint

When complete (~5–8 minutes on a fast connection), you'll see:

```
╔══════════════════════════════════════════════════════════╗
║  AfroPay dev stack is running! (6m 42s elapsed)          ║
╚══════════════════════════════════════════════════════════╝

  Service endpoints:
  • API             → http://localhost:8000
  • Health check    → http://localhost:8000/health
  • stellar.toml    → http://localhost:8000/.well-known/stellar.toml
  • SEP-10 auth     → http://localhost:8000/auth
  • SEP-12 KYC      → http://localhost:8000/kyc
  • SEP-31 payments → http://localhost:8000/sep31
  • Metrics         → http://localhost:8000/metrics
  • PostgreSQL      → localhost:5432  (user: afropay, db: afropay)
  • Redis           → localhost:6379
```

### Starting optional services

The listener, reconciliation service, and oracle run in the `services` profile:

```bash
bash scripts/dev-setup.sh --full
```

This also exposes:
- Reconciliation admin API → `http://localhost:8001`
- Oracle / FX rate feed    → `http://localhost:8002`

### Configuration (`.env`)

`dev-setup.sh` creates `.env` from defaults on first run. The key variables:

| Variable | Purpose | Default (dev only) |
|----------|---------|-------------------|
| `SEP10_SIGNING_SEED` | Stellar keypair for SEP-10 challenge signing | Dev test seed |
| `JWT_SECRET` | JWT signing secret | `dev-jwt-secret-…` |
| `MASTER_ENCRYPTION_KEY` | 32-byte AES key (base64) for wallet key encryption | All-zero dev key |
| `NETWORK_PASSPHRASE` | Stellar network | `Test SDF Network ; September 2015` |
| `HORIZON_URL` | Horizon endpoint | `https://horizon-testnet.stellar.org` |
| `CONTRACT_ID` | Deployed escrow contract address (fill after deploy) | _(empty)_ |

> **Never commit `.env`** — it is in `.gitignore`.

### Building and deploying the Soroban contract

```bash
# Build the WASM artifact
docker compose -f docker-compose.dev.yml --profile contracts \
  run --rm contracts stellar contract build \
  --manifest-path /contracts/src/escrow/Cargo.toml

# Deploy to Stellar testnet (requires DEPLOYER_SECRET in .env)
docker compose -f docker-compose.dev.yml --profile contracts \
  run --rm contracts stellar contract deploy \
  --wasm /contracts/wasm/escrow.wasm \
  --source "$DEPLOYER_SECRET" \
  --network testnet
```

The `stellar-cli` in this container is pinned to **v21.0.0**, matching the
`soroban-sdk = "21.0.0"` declared in `contracts/escrow/Cargo.toml`.

### Tearing down

```bash
# Stop containers, keep database volumes
bash scripts/dev-setup.sh --down

# Full reset — stops containers AND deletes all volumes (data lost)
bash scripts/dev-setup.sh --reset
```

### Running tests

```bash
# API tests (runs inside the api container)
docker compose -f docker-compose.dev.yml exec api npm test

# Soroban contract tests (runs cargo test with soroban testutils)
docker compose -f docker-compose.dev.yml --profile contracts \
  run --rm contracts bash -c \
  "cd /contracts/src/escrow && cargo test -- --nocapture"

# AML service tests (Rust)
cargo test -p aml
```

---

## 🛠️ Troubleshooting FAQ

**Q: `docker compose` command not found / version too old**

The Compose plugin ships with Docker Desktop 4.x+ and Docker Engine 24+. If you have an older `docker-compose` (v1, standalone binary), upgrade:
```bash
# Install Docker Compose plugin (Linux)
sudo apt-get update && sudo apt-get install docker-compose-plugin
docker compose version  # should show 2.24+
```

**Q: The API container exits immediately with `SEP10_SIGNING_SEED is required`**

Your `.env` file is missing this variable. Either:
- Run `bash scripts/dev-setup.sh` — it generates `.env` automatically, or
- Add it manually: `SEP10_SIGNING_SEED=<your-testnet-secret-seed>`.
  Generate a fresh testnet keypair: `stellar keys generate --global dev-key --network testnet`

**Q: Migrations failed / tables not created**

The postgres `initdb.d` scripts only run on the very first container start (empty volume). If you interrupted setup midway:
```bash
bash scripts/dev-setup.sh --reset   # wipe volume
bash scripts/dev-setup.sh           # fresh start
```

**Q: Friendbot returned HTTP 400**

This means the test account already exists on the testnet — not an error. You can verify with:
```bash
curl https://horizon-testnet.stellar.org/accounts/<YOUR_SIGNING_PUBLIC_KEY>
```

**Q: `MASTER_ENCRYPTION_KEY must be 32 bytes` error**

The key must be exactly 32 bytes base64-encoded. Generate a valid dev key:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```
Paste the output as `MASTER_ENCRYPTION_KEY=<value>` in your `.env`.

**Q: Port 5432 or 6379 already in use**

A local PostgreSQL or Redis is running on your host. Either stop them or map the container to different host ports by overriding in `.env`:
```bash
# .env
POSTGRES_HOST_PORT=5433
REDIS_HOST_PORT=6380
```
Then edit `docker-compose.dev.yml` ports sections accordingly.

**Q: `soroban-cli version mismatch` error when building contracts**

The `Dockerfile.contracts` pins `stellar-cli` to v21.0.0. If you change `soroban-sdk` in `contracts/escrow/Cargo.toml`, update the version in `Dockerfile.contracts` to match. The Dockerfile includes a runtime assertion that will fail fast if they diverge.

**Q: Setup took more than 10 minutes**

The first run is dominated by:
- Rust compilation of the contracts (~4–6 min on 4-core machines)
- Node.js npm install (~1–2 min)
- Docker base image pulls (~1–2 min on a fast connection)

Subsequent runs are much faster (< 60 seconds) because Docker layer caching and cargo-chef dependency caching avoid recompilation.

---

## 🌍 Vision

**AfroPay** is a trustless, decentralized remittance protocol built on Stellar that enables fast, low-cost, and secure global money transfers—with a specific focus on Africa and emerging markets.

**Tagline:** "Send money across Africa — instant, borderless, unstoppable."

---

## 📊 The Problem We Solve

Africa accounts for **~$100 billion in annual remittance inflows**, yet traditional corridors (Western Union, MoneyGram) impose significant friction:

| Metric | Traditional | AfroPay |
|--------|-------------|---------|
| **Fee** | 5–10% | < 0.5% |
| **Settlement** | 1–5 days | 5 seconds |
| **Intermediaries** | 3–5 custodians | 0 (trustless) |
| **Network Effect** | Centralized | Censorship-resistant |
| **Accessibility** | Bank account required | Smartphone + USDC |

**AfroPay's advantage:** Stellar's 5-second finality and near-zero fees make it the ideal settlement layer for remittances. Combined with cryptographic escrow, AfroPay eliminates intermediaries and enables trustless cross-border payments.

---

## 🏗️ Architecture Overview

AfroPay operates as a **three-layer system**:

```
┌─────────────────────────────────────────────────────────────┐
│  User Layer (Web & Mobile)                                  │
│  ├─ Next.js Dashboard (Sender initiates transfer)           │
│  └─ Mobile Apps (View balances, track transactions)         │
└──────────────┬──────────────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────────────┐
│  API Layer (NestJS - Orchestration & KYC)                   │
│  ├─ Authentication & JWT                                    │
│  ├─ Wallet Management (Stellar key storage)                 │
│  ├─ KYC/AML Compliance                                      │
│  ├─ Transaction Queue (Redis/BullMQ)                        │
│  ├─ Fraud Detection (Python ML service)                     │
│  └─ Off-Ramp Integration (Local banks/mobile money)        │
└──────────────┬──────────────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────────────┐
│  Blockchain Layer (Stellar + Soroban Smart Contracts)      │
│  ├─ Soroban Escrow Contract (Trustless fund lock/release)  │
│  ├─ Oracle Verification (Delivery attestation)             │
│  ├─ Multi-Signature Support (Treasury management)          │
│  ├─ Rate Feeds (XLM/USDC, USD/NGN, EUR/GHS, GBP/KES)      │
│  └─ Automated Refunds (Timeout handling)                   │
└─────────────────────────────────────────────────────────────┘
```

---

## 🔒 Core Smart Contract: Soroban Escrow

### Key Capabilities

The **Soroban Escrow Contract** (`contract.rs`) implements trustless fund management:

#### 1. **Deposit (Sender → Escrow)**
```rust
fn deposit_escrow(
    sender: Address,
    agent: Address,
    amount: i128,           // USDC stroops
    recipient_country: String,
    recipient_account_hash: Vec<u8>,  // Privacy-preserving
    fiat_amount: i128,
    fiat_currency: String,
    exchange_rate: i128,
    timeout_minutes: u32,
) -> Result<escrow_id>
```

- Sender locks USDC into contract
- Contract stores escrow metadata (immutable on-chain proof)
- Timeout set (e.g., 2 hours) — if oracle doesn't confirm, sender refunds
- **State:** `Locked`

#### 2. **Oracle Attestation (Delivery Confirmation)**
```rust
fn release_to_agent(
    escrow_id: String,
    attestation: OracleAttestation
) -> Result<()>
```

- Oracle (verified off-ramp provider) signs delivery proof
- Signature includes: `[escrow_id | delivery_success | proof_ref | timestamp | nonce]`
- If delivery succeeds: funds release to agent
- If delivery fails: escrow marked `Refundable`
- **State:** `Released` or `Refundable`

#### 3. **Refund (Sender Recovery)**
```rust
fn claim_refund(
    escrow_id: String
) -> Result<()>
```

- **Timeout scenario:** If timeout expires and oracle hasn't confirmed, sender claims full refund
- **Failure scenario:** If oracle reports delivery failed, sender refunded
- Atomic USDC transfer back to sender (no intermediary)
- **State:** `Refunded`

### State Machine

```
[Locked] ──oracle_success──> [Released] ──(end)
  ↓
  ├─ timeout OR oracle_failure ──> [Refundable]
  │                                   ↓
  │                          [Refunded] ──(end)
  │
  └─ sender_cancel ──> [Cancelled] ──(end)
```

### Immutable Audit Trail

Every transition is recorded on-chain with events:
- `DepositEvent`: Captures initial escrow parameters
- `ReleaseEvent`: Oracle + delivery proof
- `RefundEvent`: Reason & timestamp
- `OracleSubmitEvent`: Oracle submissions

---

## 🌐 Supported Corridors (MVP)

| Route | Sender Currency | Recipient Currency | Use Case |
|-------|------------------|-------------------|----------|
| **USD → NGN** | USDC | Nigerian Naira | Diaspora → Nigeria |
| **EUR → GHS** | USDC | Ghanaian Cedi | Europe → Ghana |
| **GBP → KES** | USDC | Kenyan Shilling | UK → Kenya |
| **USD → USD** | USDC | USD (on-/off-ramp) | Global settlements |

Each corridor has:
- **Oracle operator** (verified off-ramp agent)
- **Exchange rate feed** (refreshed every 5 min)
- **Local compliance** (KYC by recipient country)

---

## 🔐 Security Model

### 1. **Cryptographic Guarantees**
- **Escrow atomicity:** Funds locked until oracle attestation or timeout
- **Oracle signatures:** Ed25519 (Stellar native), replay-protected with nonce
- **Private keys:** Stored encrypted in DB (AES-256-CBC), never on-chain

### 2. **Risk Mitigation**
- **Timeouts:** Automatic refund if oracle doesn't confirm (prevents fund lockup)
- **Fraud detection:** ML-based scoring (Python service) flags high-risk txns
- **KYC/AML:** Compliance checks before and after transfer
- **Pausing mechanism:** Admin can pause contract in case of attack

### 3. **Multi-Signature (Treasury)**
- Pausing, oracle registration, rate updates require multi-sig (admin + 2 of 3 trusted parties)
- Deployed via Stellar's native multi-sig feature

---

## 🚀 Deployment Strategy

### Phase 1: Testnet (Weeks 1–4)
- Deploy Soroban contract to Testnet (`stellar-testnet`)
- Onboard 3–5 test oracles (mock off-ramp agents)
- Run 1,000+ test transactions
- Stress-test with fuzzing

### Phase 2: Early Access (Weeks 5–8)
- Deploy to Mainnet with low transaction limits
- Onboard real off-ramp partners (M-Pesa, Chipper Cash, Sendwave)
- Start with $10K/day → $100K/day
- Monitor contract state, event logs, refund rates

### Phase 3: Full Scale (Week 9+)
- Scale to full corridor capacity
- Add new routes (USD → KES, GHS → USDC, etc.)
- Integrate with more off-ramp providers
- Launch mobile app with biometric verification

---

## 📦 Repository Structure

```
afropay-stellar-contract/
├── Dockerfile.api             # Multi-stage API image (Node.js 22 Alpine, < 200 MB)
├── Dockerfile.contracts       # Rust/Soroban builder + stellar-cli 21.0.0 (pinned)
├── Dockerfile.frontend        # Next.js standalone image (ready for frontend/ directory)
├── docker-compose.dev.yml     # Full local dev stack
├── .dockerignore              # Root context exclusions
├── scripts/
│   └── dev-setup.sh          # One-command local setup script
├── api/                       # AfroPay Anchor API (Express, Node.js)
│   ├── server.ts              # Entry point
│   ├── app.ts                 # Express app factory
│   ├── config.ts              # Config loader (env + stellar.toml)
│   ├── routes/                # SEP-10, SEP-12, SEP-31, escrow routes
│   ├── middleware/            # SEP-10 auth, metrics
│   ├── migrations/            # SQL migrations run on startup
│   └── __tests__/             # Jest test suite
├── contracts/
│   └── escrow/                # Soroban escrow contract (soroban-sdk 21.0.0)
│       ├── Cargo.toml
│       └── src/
├── services/
│   ├── listener/              # Horizon SSE listener (TypeScript / pg)
│   ├── reconciliation/        # Chain-vs-DB reconciliation (TypeScript / pg)
│   ├── oracle/                # FX rate aggregator (TypeScript ESM)
│   └── aml/                   # AML rule engine (Rust)
├── db/
│   └── migrations/            # Core SQL migrations (checkpoint, escrow_events)
├── src/                       # Legacy root Soroban contract source
│   ├── contract.rs            # Soroban escrow contract (650+ lines)
│   ├── escrow.rs              # Escrow struct & state machine
│   ├── oracle.rs              # Oracle attestation validation
│   ├── errors.rs              # Error codes (26 distinct errors)
│   ├── events.rs              # Event emission (audit trail)
│   └── bin/afropay.rs         # WASM binary entry
├── public/
│   └── .well-known/
│       └── stellar.toml       # SEP-1 anchor discovery document
├── Cargo.toml                 # Rust workspace (soroban-sdk 20.5.0 root)
├── README.md                  # This file
└── docs/
    ├── contract-design.md     # Technical deep-dive
    └── oracle-integration.md  # Oracle protocol spec
```

---

## 🧪 Testing

Run the Soroban test suite:

```bash
cd afropay-stellar-contract
cargo test --lib
cargo test --test integration_test -- --nocapture
```

### Test Coverage

- ✅ Contract initialization
- ✅ Valid escrow deposits
- ✅ Invalid amount rejection (too small, too large)
- ✅ Timeout handling (auto-refund)
- ✅ Oracle attestation (success/failure)
- ✅ State machine transitions
- ✅ Event emission
- ✅ Unauthorized access (non-sender, non-oracle)
- ✅ Signature verification
- ✅ Concurrency (multiple escrows)

---

## 📡 Integration with Backend

The NestJS API (`apps/api`) orchestrates contract interactions:

### Key Endpoints

```
POST   /wallet/create
       Create Stellar wallet for user

POST   /transaction/initiate-transfer
       ├─ Validate sender/recipient (KYC)
       ├─ Check fraud score (Python service)
       ├─ Invoke deposit_escrow() on Soroban
       └─ Return escrow_id to frontend

GET    /transaction/:escrow_id
       Get escrow state (Locked, Released, Refundable, Refunded)

POST   /oracle/submit-attestation
       (Oracle only) Submit delivery proof & signature
       ├─ Verify oracle is registered
       ├─ Invoke release_to_agent() on Soroban
       └─ Emit ReleaseEvent

POST   /transaction/:escrow_id/claim-refund
       Sender claims refund after timeout
       ├─ Verify timeout elapsed
       ├─ Invoke claim_refund() on Soroban
       └─ Update DB state
```

---

## 💡 Why AfroPay Strengthens Stellar

### 1. **Real-World Utility**
AfroPay demonstrates Stellar's core mission: **financial inclusion**. Unlike speculative DeFi, remittances solve a tangible problem for billions worldwide.

### 2. **Developer Attraction**
By shipping a production-grade Soroban contract, AfroPay showcases Soroban's maturity and attracts Rust developers to the ecosystem.

### 3. **Ecosystem Validator**
AfroPay validates:
- Soroban's performance (5s escrow finality)
- USDC adoption (Circle's Stellar-issued stablecoin)
- Oracle infrastructure (off-ramp verification)
- Multi-chain settlement layer

### 4. **Regulatory Precedent**
AfroPay pioneers compliant DeFi in emerging markets—valuable IP for Stellar Development Foundation's regulatory advocacy.

---

## 🛣️ Roadmap

| Milestone | Timeline | Deliverables |
|-----------|----------|--------------|
| **MVP** | Week 4 | Soroban contract (testnet), NestJS APIs, basic frontend |
| **Oracle Network** | Week 8 | 5+ verified oracle operators, delivery attestation |
| **Compliance** | Week 12 | KYC/AML, transaction reporting, audit logs |
| **Scale** | Month 6 | 10 corridors, $1M+ TVL, 10K+ active users |
| **Mobile App** | Month 8 | Native iOS/Android with biometric + push notifications |
| **DAO Governance** | Month 12 | Community governance for rate feeds, oracle onboarding |

---

## 📚 Documentation

- **Contract Design:** [contract-design.md](docs/contract-design.md)
- **Oracle Integration:** [oracle-integration.md](docs/oracle-integration.md)
- **API Reference:** [../../docs/api-reference.md](../../docs/api-reference.md)
- **Deployment Guide:** [../../docs/deployment.md](../../docs/deployment.md)

---

## 🤝 Contributing

We welcome contributions! See [../../Contributorsguide.md](../../Contributorsguide.md) for guidelines.

### Key Areas:
- Smart contract audits & optimizations
- Additional corridor support
- Fraud detection models
- Mobile app development
- Oracle operator onboarding

---

## ⚖️ License

AfroPay is licensed under the Apache 2.0 License. See [LICENSE](LICENSE) for details.

---

## 🙏 Acknowledgments

- **Stellar Development Foundation** – For Soroban and network infrastructure
- **Circle** – For USDC on Stellar
- **SDF Community** – For guidance and feedback

---

## 📞 Support

- **Discord:** [Join AfroPay Community](https://discord.gg/afropay)
- **Twitter:** [@AfroPay](https://twitter.com/afropay)
- **Email:** dev@afropay.io

---

**Built with ❤️ for financial inclusion in Africa.**

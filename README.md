# AfroPay — Decentralized Cross-Border Remittance Platform on Stellar

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
├── src/
│   ├── lib.rs                 # Main entry point
│   ├── contract.rs            # Soroban escrow contract (650+ lines)
│   ├── escrow.rs              # Escrow struct & state machine
│   ├── oracle.rs              # Oracle attestation validation
│   ├── errors.rs              # Error codes (26 distinct errors)
│   ├── events.rs              # Event emission (audit trail)
│   └── bin/afropay.rs         # WASM binary entry
├── tests/
│   └── integration_test.rs    # Unit + integration tests
├── Cargo.toml                 # Rust dependencies (Soroban SDK)
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

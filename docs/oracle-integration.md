# AfroPay Oracle Integration Protocol

## 1. Overview

Oracles are **off-ramp agents** (Chipper Cash, M-Pesa agents, etc.) that:

1. Verify the sender's USDC deposit on Stellar
2. Deliver equivalent fiat to the recipient (e.g., NGN to bank account)
3. Cryptographically sign delivery proof to unlock escrow on-chain

This document specifies the Oracle Protocol for secure, trustless delivery confirmation.

---

## 2. Oracle Registration

### 2.1 Admin Registers Oracle

**Call:**
```rust
RemittanceContract::register_oracle(env, oracle_address)
```

**Effect:**
- Oracle's address added to `oracle_operators` map
- Oracle can now submit delivery attestations

**Example:**
```rust
// Admin registers Chipper Cash's Stellar account
register_oracle(
    env,
    Address::from_string("GCHIPPER1234567890..."),
)?;
```

---

### 2.2 Oracle Key Management

**Oracle setup (off-chain):**
1. Generate Ed25519 keypair locally
2. Derive Stellar address from public key
3. Fund with small XLM balance (for contract fees)
4. Register with AfroPay admin via `register_oracle()`
5. Store private key in secure hardware wallet or environment

**Private key safeguards:**
- ✅ Never transmitted to AfroPay API
- ✅ Stored in Oracle operator's HSM (Hardware Security Module)
- ✅ Rotated every 90 days
- ✅ Audited by compliance team

---

## 3. Delivery Attestation Flow

### 3.1 Sequence Diagram

```
Sender                API              Contract           Oracle
  │                    │                   │                │
  ├─ Send USDC ───────>│                   │                │
  │                    ├─ Deposit ────────>│                │
  │                    │ Escrow            │                │
  │                    │ (state=Locked)    │                │
  │                    │                   │                │
  │  [Off-chain: Fiat Delivery]            │                │
  │                    │                   │                │
  │                    │                   │  Oracle        │
  │                    │                   │  confirms      │
  │                    │                   │  delivery      │
  │                    │<────────────────  │                │
  │                    │ Release with      │                │
  │                    │ Signature         │                │
  │                    │                   │                │
  │                    │     Release ─────>│                │
  │                    │     Escrow        │                │
  │                    │ (state=Released)  │                │
  │  [Recipient receives NGN]              │                │
```

### 3.2 Oracle Attestation Structure

```rust
pub struct OracleAttestation {
    pub escrow_id: SorobanString,         // "escrow_12345"
    pub oracle: Address,                  // Oracle's Stellar address
    pub delivery_success: bool,           // true or false
    pub delivery_proof: SorobanString,    // Bank txn ID or receipt
    pub attestation_timestamp: u64,       // Unix seconds
    pub signature: Bytes,                 // Ed25519(message)
    pub nonce: u64,                       // Replay protection
}
```

---

## 4. Signature Generation

### 4.1 Message Format

```
AFROPAY_ATTESTATION|escrow_id|success|proof|timestamp|nonce
```

**Example:**
```
AFROPAY_ATTESTATION|escrow_12345|true|BANK_TXN_98765|1704067200|1
```

**Components:**
- `AFROPAY_ATTESTATION` — Protocol identifier
- `escrow_id` — From contract (immutable)
- `success` — `true` or `false` (lowercase)
- `proof` — Delivery reference (max 256 chars)
- `timestamp` — Unix seconds (current UTC)
- `nonce` — Incremented per submission (prevents replay)

### 4.2 Signing Process (Oracle Side)

**Pseudocode (Python):**
```python
import ed25519
import time

# Load oracle's private key
oracle_private_key = ed25519.SigningKey(private_key_bytes)

# Construct message
escrow_id = "escrow_12345"
delivery_success = True
delivery_proof = "BANK_TXN_98765"
timestamp = int(time.time())
nonce = 1

message = f"AFROPAY_ATTESTATION|{escrow_id}|{str(delivery_success).lower()}|{delivery_proof}|{timestamp}|{nonce}"
message_bytes = message.encode('utf-8')

# Sign with Ed25519
signature = oracle_private_key.sign(message_bytes)

# Create attestation
attestation = {
    "escrow_id": escrow_id,
    "oracle": oracle_public_key,
    "delivery_success": delivery_success,
    "delivery_proof": delivery_proof,
    "attestation_timestamp": timestamp,
    "signature": signature.hex(),
    "nonce": nonce,
}

return attestation
```

### 4.3 Signature Verification (Contract Side)

**Soroban contract:**
```rust
fn verify_signature(attestation: &OracleAttestation, env: &Env) -> bool {
    // Reconstruct message
    let message = format_attestation_message(
        &attestation.escrow_id,
        attestation.delivery_success,
        &attestation.delivery_proof,
        attestation.attestation_timestamp,
        attestation.nonce,
    );

    // Verify Ed25519 signature
    soroban_sdk::crypto::Ed25519::verify(
        &attestation.oracle,
        &message.as_bytes(),
        &attestation.signature,
    )
}
```

---

## 5. API Endpoints (Oracle Submission)

### 5.1 POST `/oracle/submit-attestation`

**Request:**
```json
{
  "escrow_id": "escrow_12345",
  "oracle": "GCHIPPER1234567890...",
  "delivery_success": true,
  "delivery_proof": "BANK_TXN_98765",
  "attestation_timestamp": 1704067200,
  "signature": "abc123def456...",
  "nonce": 1
}
```

**Validation (NestJS API):**
1. Verify Oracle is registered in contract
2. Validate timestamp (within ±5 min of current time)
3. Verify signature format (hex, 128 chars)
4. Check escrow exists and is in `Locked` state
5. Verify nonce hasn't been used (replay check)

**Call contract:**
```rust
RemittanceContract::release_to_agent(
    env,
    escrow_id,
    attestation,
)?;
```

**Response:**
```json
{
  "success": true,
  "escrow_id": "escrow_12345",
  "new_state": "Released",
  "agent_address": "GAGENT123...",
  "amount": "100000000",
  "transaction_hash": "abc123def456..."
}
```

**Errors:**
- `401 Unauthorized` — Oracle not registered
- `400 Bad Request` — Invalid signature or timestamp
- `409 Conflict` — Escrow not in Locked state
- `429 Too Many Requests` — Rate limited

---

## 6. Delivery Proof Types

### 6.1 Bank Transfers (Nigeria, Kenya, Ghana)

**Proof format:**
```
BANK_TXN_<transaction_id>_<recipient_bank>_<amount>_<currency>
```

**Example:**
```
BANK_TXN_202401011430_GTB_100000_NGN
```

**Components:**
- `transaction_id` — SWIFT, FIX, or bank's internal TXN ID
- `recipient_bank` — Bank code (GTB = Guaranty Trust Bank)
- `amount` — Fiat amount sent
- `currency` — NGN, GHS, KES, etc.

**Verification (Oracle's backend):**
- Query bank API to confirm receipt
- Verify recipient account hash matches
- Cross-check timestamp and amount

### 6.2 Mobile Money (M-Pesa, MTN, Airtel)

**Proof format:**
```
MOBILE_TXN_<provider>_<reference_id>_<phone_number_hash>_<amount>
```

**Example:**
```
MOBILE_TXN_MPESA_SK211401010001234_sha256(254712345678)_10000
```

**Components:**
- `provider` — MPESA, MTN, AIRTEL, etc.
- `reference_id` — Mobile money transaction ID
- `phone_number_hash` — SHA-256(phone) for privacy
- `amount` — KES, NGN, GHS sent

**Verification (Oracle's backend):**
- Query mobile money provider's API
- Verify USSD/SIM delivery notification
- Cross-check amount and phone number

### 6.3 Crypto Wallet (Future)

**Proof format:**
```
CRYPTO_TXN_<blockchain>_<tx_hash>_<recipient_wallet>
```

**Example:**
```
CRYPTO_TXN_POLYGON_0xabc123_0x123wallet_0.5
```

---

## 7. Failure Scenarios

### 7.1 Oracle Submits Failure

**Situation:** Recipient bank account is invalid or closed.

**Oracle submission:**
```json
{
  "escrow_id": "escrow_12345",
  "delivery_success": false,
  "delivery_proof": "ERROR_INVALID_ACCOUNT_NG_GTB",
  "signature": "...",
  "nonce": 1
}
```

**Contract action:**
- Escrow state → `Refundable`
- Sender can claim refund via `claim_refund()`
- Funds returned to sender's Stellar wallet (USDC)

### 7.2 Oracle Timeout

**Situation:** Oracle doesn't submit attestation within timeout window (default: 2 hours).

**Contract behavior:**
- Escrow enters `Refundable` state automatically
- Sender calls `claim_refund()` after timeout ledger
- Funds returned to sender

**Example:**
```
Time 0:00   → Escrow locked (timeout = 2 hours)
Time 1:45   → Oracle delayed, hasn't submitted
Time 2:00   → Timeout ledger reached, escrow auto-refundable
Time 2:05   → Sender claims refund, receives full USDC
```

### 7.3 Oracle Misbehavior

**Detection:** Oracle submits multiple conflicting attestations.

**Contract protection:**
- Each escrow can only have ONE attestation (idempotent)
- Second submission with different proof → Rejected with error
- Admin can revoke oracle license

---

## 8. Oracle Incentives & Disputes

### 8.1 Agent Commission

**Economics:**
```
Sender USDC → Contract Escrow
    ↓
Oracle delivers NGN to recipient
    ↓
Contract releases (USDC - 0.5% fee) → Oracle
    ↓
Oracle keeps NGN spread or earns commission
```

**Typical margin:**
- Sender pays: 100 USDC
- Oracle receives: 99.5 USDC (0.5% fee to AfroPay treasury)
- Oracle's arbitrage: 99.5 USDC × exchange_rate = 39,800 NGN
- Oracle sells NGN for USD, retains spread (~0.2–0.5%)

### 8.2 Dispute Resolution

**If recipient claims non-delivery:**

1. **Recipient reports via AfroPay app** (with proof of non-receipt)
2. **API freezes escrow** (state remains `Released`, but flagged)
3. **Manual review:**
   - Check recipient's bank statement
   - Verify Oracle's proof (bank confirmation)
   - Decide: Oracle refund to sender or sender receives refund + compensation
4. **Enforcement:**
   - Oracle can be delisted if > 0.5% dispute rate
   - Sender receives USDC + bounty (from AfroPay reserve)

---

## 9. Multi-Oracle Setup (Future)

**For higher security, AfroPay can require M-of-N oracle quorum:**

```rust
fn release_to_agent_quorum(
    env: Env,
    escrow_id: String,
    attestations: Vec<OracleAttestation>,  // Requires 2 of 3 oracles
) -> Result<()>
```

**Advantages:**
- Collusion resistance (2 independent oracles must agree)
- Failover (if 1 oracle offline, 2 others can proceed)
- Higher confidence in delivery proof

---

## 10. Compliance & Audit

### 10.1 Oracle Audit Trail

**Stored in database:**
- Every attestation logged (timestamp, escrow_id, oracle, result)
- Immutable (append-only)
- Used for regulatory reporting

**Example query:**
```sql
SELECT * FROM oracle_attestations
WHERE oracle_address = 'GCHIPPER...'
AND created_at > '2024-01-01'
ORDER BY created_at DESC;
```

### 10.2 Regulatory Reporting

**Monthly report to regulators:**
- Total attestations per corridor (NGN, GHS, KES, etc.)
- Success rate per oracle
- Average delivery time
- Dispute incidents

**Example (Nigeria):** CBN (Central Bank of Nigeria) reporting
```
Month: January 2024
Corridor: USD → NGN
Total Transfers: 5,234
Total Value: $523,400
Success Rate: 99.8%
Disputes: 8 (0.15%)
Average Time-to-Delivery: 4.2 minutes
```

---

## 11. Testing Oracle Integration

### Unit Tests

```rust
#[test]
fn test_valid_oracle_signature() {
    // Generate test Ed25519 keypair
    let (oracle_pubkey, oracle_privkey) = ed25519_generate();
    
    // Create test escrow
    let escrow_id = "escrow_test_123";
    let message = format_message(escrow_id, true, "PROOF_123", 1000, 1);
    
    // Sign message
    let signature = ed25519_sign(&oracle_privkey, &message);
    
    // Create attestation
    let attestation = OracleAttestation {
        escrow_id: escrow_id.into(),
        oracle: oracle_pubkey.into(),
        delivery_success: true,
        delivery_proof: "PROOF_123".into(),
        attestation_timestamp: 1000,
        signature: signature.into(),
        nonce: 1,
    };
    
    // Verify
    assert!(verify_signature(&attestation));
}

#[test]
fn test_invalid_oracle_not_registered() {
    // Try to submit attestation from unregistered oracle
    // Should fail with NotOracleOperator
}

#[test]
fn test_replay_attack_prevention() {
    // Submit same nonce twice
    // Second submission should fail (nonce already used)
}
```

---

## 12. Oracle Operator Checklist

Before becoming an AfroPay Oracle:

- [ ] Register Stellar address
- [ ] Generate Ed25519 keypair (secure HSM)
- [ ] Fund Stellar account with 5 XLM (for fees)
- [ ] Integrate with local bank APIs (for proof verification)
- [ ] Set up monitoring for failed deliveries
- [ ] Implement dispute resolution process
- [ ] Pass KYC/AML screening
- [ ] Sign Oracle Service Agreement (MSA)
- [ ] Complete technical onboarding

---

**Document Version:** 1.0  
**Last Updated:** 2024  
**Status:** ✅ Complete

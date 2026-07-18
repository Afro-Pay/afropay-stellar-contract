# ADR-001: Stellar/Soroban as the Settlement Layer

**Date:** 2024-01-15  
**Status:** Accepted  
**Deciders:** AfroPay core team

---

## Context and Problem Statement

AfroPay needs a programmable blockchain settlement layer that can execute trustless escrow logic, hold USDC on behalf of senders, and release or refund funds within a user-acceptable latency window. The platform targets remittance corridors to Africa, where network fees and settlement speed directly affect product viability.

We evaluated three candidate platforms: Stellar with Soroban smart contracts, Ethereum Layer 2 networks (Arbitrum, Optimism, Base), and Solana. The choice of settlement layer is the single most consequential architectural decision in the stack — it determines token availability, gas economics, developer toolchain, ecosystem fit, and long-term protocol alignment.

---

## Decision Drivers

- **Settlement latency:** Remittances must settle within seconds to feel instant to the recipient. Anything above 10 seconds degrades the user experience.
- **Transaction fees:** Target corridor users are price-sensitive. Even $0.10 fees are non-trivial at sub-$100 transfer sizes.
- **USDC availability:** USDC is the preferred stable value transfer token. Native issuance is preferred over bridged.
- **Soroban maturity:** The smart contract language must be expressive enough for escrow and oracle attestation logic.
- **Regulatory alignment:** Stellar Development Foundation (SDF) has established relationships with regulators in key markets.
- **Ecosystem support:** Existing tooling, documentation, and developer community for long-term maintainability.

---

## Considered Options

1. **Stellar + Soroban** — Stellar L1 with Soroban smart contracts, native USDC from Circle
2. **EVM Layer 2 (Arbitrum/Optimism/Base)** — Solidity or Vyper contracts on an EVM-compatible L2
3. **Solana** — Rust-based smart contracts (Anchor framework) on Solana

---

## Decision Outcome

**Chosen option:** Stellar + Soroban

**Rationale:** Stellar provides 5-second finality, sub-cent transaction fees, native Circle USDC issuance, and built-in primitives (SEP-10, SEP-24, anchors) purpose-built for cross-border payments. Soroban's Rust-based SDK allows the same type-safe escrow logic we need, and the contract execution environment is optimised for financial applications rather than general-purpose DeFi.

---

## Pros and Cons of Each Option

### Option 1 — Stellar + Soroban

**Pros:**
- 5-second finality, ~3–5 second median confirmation
- Sub-cent fees (< $0.0001 per operation)
- Native USDC issued by Circle on Stellar — no bridge risk
- SEP-10, SEP-24, and the Anchor ecosystem built specifically for remittances
- SDF's active regulatory engagement in Africa (Nigeria, Kenya, Ghana corridors)
- Soroban written in Rust — strong type safety, predictable instruction budget
- WASM-based execution — deterministic and auditable

**Cons:**
- Soroban is newer than Solidity; smaller total developer pool
- Fewer DeFi money legos to compose with (acceptable for AfroPay's use case)
- Some tooling still maturing (e.g., Soroban debugger)

**Reason chosen:** Best fit for AfroPay's specific remittance use case. The cons are acceptable given the mission.

---

### Option 2 — EVM Layer 2 (Arbitrum/Optimism/Base)

**Pros:**
- Large Solidity developer pool
- Rich DeFi composability
- Native USDC available on Base (Circle's CCTP)

**Cons:**
- L2 fees still 10–100x higher than Stellar for simple transfers
- USDC on most L2s is bridged (CCTP adds latency and complexity)
- EVM L2 settlement finality depends on L1 challenge periods (7 days for optimistic rollups)
- No equivalent to Stellar's Anchor / SEP ecosystem for on/off-ramp integration
- Solidity's type system makes escrow logic more error-prone

**Reason rejected:** Higher fees, bridge risk, and absence of remittance-native primitives make EVM L2 a worse fit.

---

### Option 3 — Solana

**Pros:**
- Very high throughput (65,000+ TPS claimed)
- Low fees
- Rust-based smart contracts (similar developer profile to Soroban)

**Cons:**
- Multiple high-profile network outages undermine reliability for financial applications
- USDC on Solana is available but the ecosystem is primarily DeFi-oriented
- No remittance-specific primitives (no equivalent to SEP-10/SEP-24)
- Less regulatory engagement in African markets
- Account model complexity (rent, program-derived addresses) adds audit surface

**Reason rejected:** Reliability concerns and absence of remittance infrastructure.

---

## Consequences

### Positive

- Near-zero fees enable sub-$5 transfers to be economically viable.
- 5-second settlement meets the "instant" expectation for remittances.
- Native USDC removes bridge risk and Circle custodial complexity.
- Soroban's instruction-budget model makes contract costs predictable.

### Negative

- AfroPay is dependent on Stellar network health and SDF governance decisions.
- Soroban's smaller developer pool may slow hiring and auditor availability.
- Migrating to another chain in the future would require significant contract rewrites.

### Neutral

- The Soroban SDK version (currently 20.5.0 for the remittance contract and 21.0.0 for the escrow sub-contract) will need to be kept up-to-date as the SDK matures.

---

## References

- [Stellar Developers — Soroban Overview](https://developers.stellar.org/docs/smart-contracts)
- [Circle — USDC on Stellar](https://www.circle.com/en/usdc-multichain/stellar)
- [SEP-10 — Stellar Web Authentication](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md)
- [SEP-24 — Interactive Anchor/Wallet Asset Transfer](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0024.md)

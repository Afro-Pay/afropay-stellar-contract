# ADR-005: SEP-10 for Relayer Authentication

**Date:** 2024-02-12  
**Status:** Accepted  
**Deciders:** AfroPay core team

---

## Context and Problem Statement

The AfroPay API layer (NestJS) acts as a relayer between user wallets, oracle operators, and the Soroban contract. The relayer must authenticate callers before invoking contract operations on their behalf. Specifically:

1. **Sender authentication** — Verify the sender before invoking `deposit_escrow()`.
2. **Oracle authentication** — Verify the oracle before accepting a delivery attestation.
3. **Admin authentication** — Verify the admin before `register_oracle()` or `set_paused()`.

Two authentication mechanisms were evaluated: Stellar's SEP-10 (Web Authentication) standard and a custom JWT + Ed25519 signature scheme.

---

## Decision Drivers

- **Wallet compatibility:** Users interact via Stellar wallets (Freighter, Lobstr, hardware wallets). The auth mechanism must work with standard Stellar key pairs without custom plugins.
- **Replay protection:** Auth tokens must not be reusable across sessions or contracts.
- **Ecosystem alignment:** Using a standard reduces custom security code and benefits from community audit.
- **Implementation cost:** Custom auth is expensive to implement correctly and maintain.
- **Oracle-specific requirements:** Oracles sign delivery attestations with their Stellar key pairs — the same keys used for SEP-10 authentication.

---

## Considered Options

1. **SEP-10** — Stellar Ecosystem Proposal 10: Web Authentication using Stellar key pairs and challenge/response
2. **Custom JWT + Ed25519** — Custom authentication server issuing JWTs signed with Ed25519 keys linked to Stellar addresses
3. **Soroban native `require_auth()`** — Rely entirely on Soroban's built-in authorisation without an API-level auth layer

---

## Decision Outcome

**Chosen option:** SEP-10 for API-level relayer authentication

**Rationale:** SEP-10 is the Stellar ecosystem standard for authenticating Stellar key pairs to off-chain services. It is implemented by all major Stellar wallets, audited by the Stellar Development Foundation, and already used by Anchors in the same corridors AfroPay targets (M-Pesa, Chipper Cash). Using SEP-10 means AfroPay can onboard users and oracle operators without custom wallet integrations.

Note: On-chain authorisation for contract calls still uses Soroban's native `require_auth()`. SEP-10 operates at the API layer only.

---

## Pros and Cons of Each Option

### Option 1 — SEP-10

**Pros:**
- Supported natively by Freighter, Lobstr, and hardware wallets — zero custom wallet integration
- Challenge/response design provides nonce-based replay protection out of the box
- Audited and maintained by SDF
- Already used by off-ramp Anchors in AfroPay's target corridors — reuses existing operator tooling
- JWT issued after SEP-10 challenge is compatible with standard API gateway middleware

**Cons:**
- Requires running a SEP-10 server endpoint (challenge issuance + JWT minting)
- Challenge expiry window adds ~2 round-trips to the auth flow
- SEP-10 v3 adds complexity for multi-sig accounts (acceptable trade-off)

**Reason chosen:** Ecosystem alignment, wallet compatibility, and the absence of custom cryptography code outweigh the operational overhead.

---

### Option 2 — Custom JWT + Ed25519

**Pros:**
- Full control over token format and expiry
- No dependency on SDF specifications

**Cons:**
- Custom cryptographic code is a high-risk audit target
- No existing wallet support — requires custom signing UI in AfroPay's frontend
- Replay protection must be implemented from scratch (nonce store, token revocation)
- Does not reuse oracle operators' existing Stellar key infrastructure

**Reason rejected:** The custom cryptography risk and lack of wallet support are not justified given that SEP-10 already exists and is well-maintained.

---

### Option 3 — Soroban `require_auth()` Only

**Pros:**
- No API-layer auth code required
- Users sign transactions directly — fully self-custodied

**Cons:**
- Requires users to sign every API call as a Soroban transaction — poor UX for browsing, status checks, and KYC flows
- Does not solve oracle authentication for off-chain delivery reporting
- Incompatible with the NestJS API layer's JWT-based session model

**Reason rejected:** `require_auth()` solves on-chain auth but not the API-layer session management needed for KYC, fraud detection, and oracle operator workflows.

---

## Consequences

### Positive

- Wallets that support SEP-10 (Freighter, Lobstr, hardware wallets) work with AfroPay without modification.
- Oracle operators reuse their existing Stellar key pairs for both on-chain attestation and API authentication.
- SEP-10's challenge nonces provide out-of-the-box replay protection.
- AfroPay aligns with the Anchor ecosystem, simplifying future SEP-24 integration.

### Negative

- The API layer must implement a SEP-10 server (challenge issuance, signature verification, JWT minting) — non-trivial development effort.
- Multi-sig account support (SEP-10 v3) is deferred until needed.

### Neutral

- On-chain operations still require `require_auth()` at the Soroban level. SEP-10 JWT is only for the NestJS API; it does not bypass on-chain auth.

---

## References

- [SEP-10 Specification](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md)
- [Stellar — Web Authentication Guide](https://developers.stellar.org/docs/learn/encyclopedia/security/sep-10)
- [Soroban `require_auth()` documentation](https://developers.stellar.org/docs/smart-contracts/guides/authorisation)
- Related issue: #39

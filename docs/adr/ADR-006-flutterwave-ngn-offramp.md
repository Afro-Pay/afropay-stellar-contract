# ADR-006: Flutterwave as Primary NGN Off-Ramp

**Date:** 2024-02-20  
**Status:** Accepted  
**Deciders:** AfroPay core team

---

## Context and Problem Statement

AfroPay's most important corridor is USD/USDC → NGN (Nigerian Naira), which accounts for the largest remittance corridor in Sub-Saharan Africa. To disburse NGN to recipients, AfroPay needs a Nigerian fiat off-ramp provider that can receive a programmatic trigger from the oracle layer and push funds to the recipient's bank account or mobile wallet.

Three candidates were evaluated: Flutterwave, Paystack, and Mono. The choice affects recipient coverage, API reliability, regulatory standing, and long-term partnership feasibility.

---

## Decision Drivers

- **Bank and mobile money coverage:** Must reach the major Nigerian banks and mobile wallets used by remittance recipients.
- **API programmability:** Must support a webhook-based delivery confirmation that can trigger oracle attestation.
- **Reliability and uptime:** Delivery failures directly translate to user refunds and trust loss.
- **Regulatory standing:** Must be licensed by the Central Bank of Nigeria (CBN) and compliant with FINTRAC-equivalent requirements.
- **International payment support:** Must be able to receive USDC or USD from an international sender as the funding source.
- **Settlement speed:** Same-day NGN settlement to Nigerian bank accounts.
- **Commercial viability:** Pricing, contract terms, and partnership willingness.

---

## Considered Options

1. **Flutterwave** — Pan-African payments company with direct CBN licensing and international corridor support
2. **Paystack** (Stripe subsidiary) — Primarily Nigerian merchant payments, recently expanded to remittances
3. **Mono** — Nigerian open banking and account verification platform

---

## Decision Outcome

**Chosen option:** Flutterwave

**Rationale:** Flutterwave is the only evaluated provider with both (a) direct CBN licensing for remittance operations and (b) a programmable international-to-local corridor API that supports the oracle's webhook trigger pattern. Paystack is stronger for merchant payments but limited for inbound remittances. Mono does not offer disbursement APIs.

---

## Pros and Cons of Each Option

### Option 1 — Flutterwave

**Pros:**
- Direct CBN licensing for international money transfer (IMT)
- Established presence in 35+ African countries — covers GHS, KES corridors for future expansion
- `Transfer` API supports programmatic bank and mobile money disbursement — oracle webhook compatible
- Webhook callback (`transfer.completed` event) can trigger oracle attestation
- Existing integrations with M-Pesa (Kenya) and MTN MoMo (Ghana) reduce future corridor work
- Well-documented API with SDK support for Node.js (NestJS layer)

**Cons:**
- Higher per-transaction fee than Paystack for domestic NGN transfers
- API rate limits require queuing for high-volume operations (acceptable for MVP)
- 2021 data breach incident — requires additional API key rotation and monitoring discipline
- Settlement to some smaller Nigerian banks can take up to 24 hours

**Reason chosen:** Broadest coverage, programmatic disbursement API, and regulatory compliance across multiple corridors.

---

### Option 2 — Paystack

**Pros:**
- Strong Nigerian bank coverage (99%+ of licensed Nigerian banks)
- Highly reliable API (Stripe-grade SLA since acquisition)
- Competitive pricing for NGN transfers
- Excellent developer documentation

**Cons:**
- Paystack's international remittance license is newer and less tested in production
- Transfer API primarily designed for NGN-to-NGN merchant payouts, not USD/USDC-to-NGN corridors
- No multi-corridor support (no GHS, KES, or East African coverage)
- Webhook delivery confirmation requires custom mapping to oracle attestation format
- Stripe acquisition has created uncertainty about Paystack's independent product roadmap

**Reason rejected:** Limited to NGN and lacks the multi-corridor API needed for AfroPay's expansion roadmap.

---

### Option 3 — Mono

**Pros:**
- Strong account verification and open banking (read access to Nigerian bank accounts)
- Good for KYC/AML recipient verification

**Cons:**
- Does not offer a disbursement API — cannot push funds to recipient accounts
- Primarily a data/verification platform, not a payments platform
- Cannot serve as the off-ramp agent in AfroPay's escrow model

**Reason rejected:** Mono does not offer fund disbursement. It remains a candidate for recipient account verification (KYC layer), but is out of scope for the off-ramp decision.

---

## Consequences

### Positive

- Flutterwave's `Transfer` webhook gives the oracle layer a reliable delivery confirmation event.
- Multi-corridor support (NG, GH, KE) means future corridor expansion reuses the same integration.
- CBN licensing reduces AfroPay's regulatory exposure in Nigeria.

### Negative

- AfroPay is dependent on Flutterwave's uptime and API stability.
- The 2021 data breach history requires AfroPay to treat Flutterwave API credentials as high-value secrets with rotation policies.
- If Flutterwave changes pricing or API terms, switching costs are non-trivial.

### Neutral

- Mono should be evaluated separately as a recipient account verification service (KYC use case) independent of this off-ramp decision.
- Paystack should be re-evaluated if Flutterwave's remittance API proves unreliable in production.

---

## References

- [Flutterwave Transfer API](https://developer.flutterwave.com/docs/collecting-payments/transfers)
- [Flutterwave CBN License](https://flutterwave.com/ng/blog/cbn-license) — International Money Transfer Operator license
- [Paystack Transfer API](https://paystack.com/docs/transfers/)
- [Mono Open Banking API](https://docs.mono.co/)
- [World Bank — Nigeria Remittance Inflows](https://remittanceprices.worldbank.org/)
- Related issue: #39

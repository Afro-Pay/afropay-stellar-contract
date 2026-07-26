# AfroPay Data Map — NDPA Compliance

**Document owner:** Compliance & Privacy Team  
**Last reviewed:** 2026-07-26  
**Review cadence:** Quarterly, or within 30 days of any material change to data collection  
**Legal framework:** Nigeria Data Protection Act 2023 (NDPA), Nigeria Data Protection Regulation 2019 (NDPR), CBN AML/CFT Regulations 2022, CBN Circular BSD/DIR/GEN/LAB/07/014  
**Data Protection Officer contact:** dpo@afropay.io  

---

## 1. Purpose of this document

This data map is a record of processing activities (ROPA) required under **NDPA s.27**. It describes every category of personal data AfroPay collects, the purpose and legal basis for processing it, where it is stored, who can access it, and how long it is kept.

The map also serves as the reference for:
- DSAR (Data Subject Access Request) responses — `POST /api/v1/privacy/dsar`
- Right-to-erasure decisions — `POST /api/v1/privacy/erasure`
- Pseudonymization scope (see `services/privacyAudit/pseudonymize.ts`)
- Privacy audit log field names (see `db/migrations/003_ndpa_privacy.sql`)

---

## 2. Data controller details

| Field | Value |
|---|---|
| Controller name | AfroPay Technologies Ltd |
| Registration | CAC/IT/12345678 (Nigeria) |
| Address | 14 Adetokunbo Ademola St, Victoria Island, Lagos |
| DPO email | dpo@afropay.io |
| NDPC registration | DP/2024/AFR/00123 |

---

## 3. PII categories and storage

### 3.1 KYC / Customer identity data

Collected during SEP-12 KYC onboarding. Stored in `api/store.ts` (`Customer.fields`) in production-backed PostgreSQL.

| Field name | Description | Example | Erasable? | Retention |
|---|---|---|---|---|
| `first_name` | Given name | Amara | ✅ Yes | Until erasure request or account closure + 30 days |
| `last_name` | Family name | Okafor | ✅ Yes | Until erasure request or account closure + 30 days |
| `email_address` | Email address | amara@example.com | ✅ Yes | Until erasure request or account closure + 30 days |
| `phone_number` | Mobile number (Nigerian or international) | +2348012345678 | ✅ Yes | Until erasure request or account closure + 30 days |
| `bvn` | Bank Verification Number (11 digits, NIBSS) | 22222222222 | ✅ Yes | Until erasure request or account closure + 30 days |
| `bank_account_number` | NUBAN bank account number | 0123456789 | ✅ Yes | Until erasure request or account closure + 30 days |
| `bank_name` | Name of recipient's bank | Access Bank | ✅ Yes | Until erasure request or account closure + 30 days |
| `date_of_birth` | Date of birth (ISO 8601) | 1990-05-14 | ✅ Yes | Until erasure request or account closure + 30 days |
| `address` | Residential address | 4 Broad St, Lagos Island | ✅ Yes | Until erasure request or account closure + 30 days |
| `id_type` | Government ID type | National ID / Int'l Passport | ✅ Yes | Until erasure request or account closure + 30 days |
| `id_number` | Government ID number | A00123456 | ✅ Yes | Until erasure request or account closure + 30 days |

**Storage location:** `api/store.ts` in-memory (development); PostgreSQL `customers` table (production)  
**Encryption at rest:** AES-256-CBC (column-level encryption via application layer)  
**Legal basis:** NDPA s.25(2)(b) — necessary for the performance of a contract (remittance service)

---

### 3.2 Stellar wallet / account identifier

| Field name | Description | Erasable? | Retention |
|---|---|---|---|
| `stellar_account` | User's Stellar G… public key | ⚠️ Pseudonymized on erasure | Transaction records bound to this key are retained per CBN 5-year rule; key itself pseudonymized after retention window |

**Storage location:** `Customer.account` field; `EscrowRecord.senderAccount`; on-chain Soroban escrow contract  
**Note:** Public keys on the Stellar ledger are immutable (blockchain property). Erasure pseudonymizes the DB reference; the on-chain key is not personally identifiable without linking to off-chain KYC data.  
**Legal basis:** NDPA s.25(2)(b) — contract performance

---

### 3.3 Payment / transaction data

Collected when a SEP-31 cross-border payment is initiated or an escrow is created.

| Field name | Description | Erasable? | Retention |
|---|---|---|---|
| `amount_in` | Transfer amount (USDC) | ❌ **No** | 5 years (CBN) |
| `amount_out` | Received amount after fees | ❌ **No** | 5 years (CBN) |
| `amount_fee` | Service fee | ❌ **No** | 5 years (CBN) |
| `started_at` | Transaction initiation timestamp | ❌ **No** | 5 years (CBN) |
| `updated_at` | Last status update timestamp | ❌ **No** | 5 years (CBN) |
| `completed_at` | Settlement timestamp | ❌ **No** | 5 years (CBN) |
| `stellar_transaction_id` | On-chain Stellar transaction hash | ❌ **No** | 5 years (CBN) |
| `external_transaction_id` | Paystack / Flutterwave payment reference | ❌ **No** | 5 years (CBN) |
| `corridor` | Currency corridor (e.g. USD_NGN) | ❌ **No** | 5 years (CBN) |
| `stellar_memo` | Per-transaction hash memo | ❌ **No** | 5 years (CBN) |
| `receiver_account_number` | Recipient's bank account (SEP-31 `fields`) | ✅ Yes (pseudonymized) | Until erasure; transaction amounts retained |
| `receiver_routing_number` | Recipient bank routing number | ✅ Yes (pseudonymized) | Until erasure |

**Storage location:** `api/store.ts` `transactions` Map (development); PostgreSQL `sep31_transactions` table (production)  
**Legal basis for retention:** NDPA s.37 — processing necessary for compliance with a legal obligation (CBN BSD/DIR/GEN/LAB/07/014)  
**Erasure carve-out:** Transaction amounts, timestamps, and identifiers cannot be erased within the 5-year CBN retention window. AfroPay pseudonymizes PII fields (receiver account numbers) but retains the financial record skeleton.

---

### 3.4 Webhook / payment provider event data

Received from Paystack (`POST /webhooks/paystack`) and Flutterwave (`POST /webhooks/flutterwave`).

| Field name | Description | Erasable? | Retention |
|---|---|---|---|
| `reference` | Provider payment reference | ❌ **No** | 5 years (CBN) — idempotency and audit evidence |
| `provider` | `paystack` or `flutterwave` | ❌ **No** | 5 years (CBN) |
| `status` | Payment outcome | ❌ **No** | 5 years (CBN) |
| `received_at` | Webhook receipt timestamp | ❌ **No** | 5 years (CBN) |
| `response_body` | Cached provider response | ❌ **No** | 5 years (CBN) |

**Storage location:** PostgreSQL `webhook_idempotency` table (`db/migrations/001_webhook_idempotency.sql`)  
**Legal basis:** NDPA s.37 — legal obligation (CBN transaction evidence); NDPA s.25(2)(b) — contract performance

---

### 3.5 Consent records

| Field name | Description | Erasable? | Retention |
|---|---|---|---|
| `account` | Stellar public key of consenting user | ⚠️ Pseudonymized on erasure | 7 years (evidence of lawful processing under NDPA s.24) |
| `notice_version` | Privacy notice version accepted | ❌ **No** | 7 years |
| `consented_at` | Timestamp of consent action | ❌ **No** | 7 years |
| `ip_address` | Client IP at consent time | ✅ Yes | Until erasure |
| `user_agent` | Browser/app user-agent at consent | ✅ Yes | Until erasure |

**Storage location:** PostgreSQL `user_consent_versions` table (`db/migrations/003_ndpa_privacy.sql`)  
**Legal basis:** NDPA s.24 — documentation of consent as required by the Act

---

### 3.6 DSAR request log

| Field name | Description | Erasable? | Retention |
|---|---|---|---|
| `account` | Account that submitted the request | ⚠️ Pseudonymized after completion | 7 years (NDPC audit evidence) |
| `request_type` | `export` or `erasure` | ❌ **No** | 7 years |
| `requested_at` | Request timestamp | ❌ **No** | 7 years |
| `completed_at` | Completion timestamp | ❌ **No** | 7 years |
| `requester_ip` | Client IP at request time | ✅ Yes | Until erasure |
| `regulatory_hold` | Whether CBN carve-out applies | ❌ **No** | 7 years |

**Storage location:** PostgreSQL `dsar_requests` table (`db/migrations/003_ndpa_privacy.sql`)  
**Legal basis:** NDPA s.37 — compliance with legal obligation (demonstrating DSAR fulfilment to NDPC)

---

### 3.7 Privacy audit log

| Field name | Description | Erasable? | Retention |
|---|---|---|---|
| `actor_id` | Admin email, service name, or Stellar key of accessor | ❌ **No** | 7 years (AML examination evidence) |
| `actor_type` | `admin` / `service` / `anchor` / `operator` | ❌ **No** | 7 years |
| `subject_account` | Stellar key of the data subject whose PII was read | ❌ **No** | 7 years |
| `fields_accessed` | Comma-separated PII field names | ❌ **No** | 7 years |
| `purpose` | Business purpose code | ❌ **No** | 7 years |
| `legal_basis` | NDPA legal basis for access | ❌ **No** | 7 years |
| `occurred_at` | Timestamp of access event | ❌ **No** | 7 years |

**Storage location:** PostgreSQL `privacy_audit_log` table (`db/migrations/003_ndpa_privacy.sql`)  
**Immutability:** Application role is REVOKED from DELETE/UPDATE on this table. Deletions require a DBA via a privileged maintenance role.  
**Legal basis:** NDPA s.27 — record of processing activities; CBN AML/CFT Regulations 2022 Reg. 11 — audit trail

---

### 3.8 AML / SAR data

| Field name | Description | Erasable? | Retention |
|---|---|---|---|
| `sender_name` | Name of transaction subject | ❌ **No** | 5 years (NFIU/CBN) |
| `sender_bvn` | BVN of transaction subject | ❌ **No** | 5 years (NFIU/CBN) |
| `alert_id` | Internal AML alert reference | ❌ **No** | 5 years |
| `narrative` | SAR narrative text | ❌ **No** | 5 years |
| `severity` | Risk severity (Low/Medium/High/Critical) | ❌ **No** | 5 years |

**Storage location:** Rust AML service (`services/aml/`); SAR exports filed with NFIU via `docs/compliance/nfiu-sar-schema.json`  
**Legal basis:** NDPA s.37 — legal obligation (NFIU Act 2004 s.6, CBN AML/CFT Regulations 2022 Reg. 8)

---

## 4. Third-party data processors

| Processor | Data shared | Purpose | Jurisdiction | DPA in place? |
|---|---|---|---|---|
| Paystack | Payment reference, amount, status | Payment processing | Nigeria | ✅ Yes |
| Flutterwave | Payment reference, amount, status | Payment processing | Nigeria / US | ✅ Yes |
| Stellar Development Foundation (Horizon) | Stellar account address, transaction hash, amount | Settlement layer | US | Data agreement in Stellar ToS |
| Smile Identity (future) | BVN, government ID, selfie hash | KYC verification | Nigeria | Pending DPA |
| AWS (infrastructure) | All data at rest (encrypted) | Cloud hosting | US/EU (eu-west-1) | AWS Data Processing Addendum |

---

## 5. Legal basis summary

| Processing activity | NDPA legal basis | Article |
|---|---|---|
| KYC identity verification | Contractual necessity | s.25(2)(b) |
| Payment execution and settlement | Contractual necessity | s.25(2)(b) |
| AML screening and SAR filing | Legal obligation (NFIU Act, CBN AML/CFT) | s.25(2)(c) |
| Transaction record retention (5 yr) | Legal obligation (CBN BSD/DIR/GEN/LAB/07/014) | s.25(2)(c) |
| Audit log retention (7 yr) | Legal obligation (CBN AML/CFT Reg. 11) | s.25(2)(c) |
| DSAR fulfilment and erasure | Compliance with data subject rights | s.35–s.37 |
| Privacy notice consent records | Documentation of lawful consent | s.24 |
| Fraud detection and investigation | Legitimate interest (preventing financial crime) | s.25(2)(f) |

---

## 6. Data subject rights under NDPA

| Right | Endpoint | SLA | Notes |
|---|---|---|---|
| Right of access (DSAR) | `POST /api/v1/privacy/dsar` | 72 hours (NDPA s.35) | Synchronous for < 1,000 records; async job otherwise |
| Right to erasure | `POST /api/v1/privacy/erasure` | 30 days (NDPA s.36) | PII pseudonymized; transaction amounts/timestamps retained per CBN rule |
| Right to rectification | `PUT /kyc/customer` | Immediate | User can update own KYC fields via SEP-12 |
| Right to object | dpo@afropay.io | 30 days | Applies to legitimate-interest processing only |
| Right to data portability | `POST /api/v1/privacy/dsar` | 72 hours | JSON export provided |
| Right to withdraw consent | `POST /api/v1/privacy/consent` with `version: null` | Immediate | Withdrawing consent stops future marketing; does not affect lawful processing |

---

## 7. Pseudonymization approach

When a right-to-erasure request is processed, AfroPay applies **keyed HMAC-SHA256 pseudonymization** (not encryption):

```
pseudonym = "erased:" + HMAC-SHA256(original_value, PSEUDONYM_KEY)
```

- **Deterministic:** the same input and key always produce the same pseudonym, allowing records to remain joinable for CBN audit purposes without exposing original PII.
- **Irreversible:** without the `PSEUDONYM_KEY` (stored in a secret manager, separate from the data), the original value cannot be recovered.
- **Key rotation:** destroying the `PSEUDONYM_KEY` after the CBN 5-year retention window completes transforms all pseudonyms into fully anonymous data (no longer personal data under NDPA s.65).

Implementation: `services/privacyAudit/pseudonymize.ts`  
Unit tests: `api/__tests__/privacy.test.ts`

---

## 8. Retention schedule

| Data category | Retention period | Authority | Action at expiry |
|---|---|---|---|
| KYC / identity fields | Account closure + 30 days (or DSAR erasure, whichever earlier) | NDPA s.36 | Pseudonymized or deleted |
| Transaction financial records | 5 years from transaction date | CBN BSD/DIR/GEN/LAB/07/014 | Archived to cold storage; PII fields pseudonymized after year 1 |
| AML alerts and SAR records | 5 years from filing date | NFIU Act 2004 s.6 | Archived to compliance cold storage |
| Privacy audit log | 7 years | CBN AML/CFT Reg. 11 | Archived; then deleted by DBA maintenance role |
| DSAR request records | 7 years from fulfilment | NDPA s.27 | Pseudonymized at 7 years |
| Consent records | 7 years from last consent action | NDPA s.24 | Pseudonymized at 7 years |
| Webhook idempotency records | 5 years | CBN — transaction evidence | Purged by automated cron |

---

## 9. Security controls

| Control | Implementation |
|---|---|
| Encryption in transit | TLS 1.3 (all API endpoints) |
| Encryption at rest | AES-256 (column-level, via `services/crypto.ts`) |
| KYC field access control | SEP-10 JWT authentication; non-owner reads logged to `privacy_audit_log` |
| BVN / ID number storage | AES-GCM encrypted at rest; decrypted only for KYC provider calls |
| Private key storage | Ed25519 keypairs encrypted with `MASTER_ENCRYPTION_KEY` (AES-256-CBC) |
| Audit log immutability | DB-level REVOKE of DELETE/UPDATE from application role |
| Pseudonymization key | Stored in AWS Secrets Manager; never in code or DB |
| DSAR export access | JWT-authenticated; exports signed and expire after 24 hours |

---

## 10. Privacy Notice versioning

AfroPay maintains a versioned privacy notice in PostgreSQL (`privacy_notices` table). Every time the notice changes materially, a new version is published and users are prompted to re-consent via `GET /api/v1/privacy/consent`.

| Notice version | Effective date | Summary of changes |
|---|---|---|
| 1 | 2026-01-01 | Initial NDPA-compliant notice; baseline data map published |

Current version endpoint: `GET /api/v1/privacy/consent` returns `current_notice_version`.

---

*This document was generated from the AfroPay codebase and compliance records. It must be reviewed by the DPO before any new data collection is introduced into the system.*

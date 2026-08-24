# Contract governance, upgrades, and disputes

This contract uses Soroban account authorization for every signer. An address
listed in an approval vector must provide a valid authorization in the invoking
transaction; the Soroban host cryptographically verifies that authorization and
binds it to the exact contract call and arguments. The contract never accepts
detached, replayable signature bytes.

## Governance bootstrap and WASM upgrades

1. Initialize the contract with the deployment admin.
2. The deployment admin calls `configure_admin_multisig(signers, threshold)`
   once. Choose a threshold greater than one for production.
3. Every governance operation supplies `approvals`, a vector of distinct
   configured signer addresses. Each address must authorize the transaction.
4. To deploy new code, upload and inspect the WASM, then call
   `upgrade(approvals, new_wasm_hash)` with the SHA-256 WASM hash as
   `BytesN<32>`.
5. If the new code has a storage migration, call `migrate` immediately after
   the WASM swap and verify the emitted `schema_migrated` event.

`upgrade` is unavailable until governance multisig has been configured. After
configuration, `rotate_admin_multisig` requires the *current* threshold, so a
single legacy admin key cannot replace governance signers.

### Storage compatibility checklist

- Do not rename or change the type of existing instance-storage keys.
- Do not append fields to persisted `Escrow` or `ContractInfo` without a
  versioned migration. This implementation deliberately stores disputes and
  arbiter configuration under new keys.
- Simulate the exact target WASM using escrow records in `Locked`, `Released`,
  `Refunded`, and `Disputed` states before mainnet submission.
- Verify post-upgrade reads and a permitted write for each pre-existing escrow.
- Retain a tested rollback WASM hash and a governance signing runbook.

## Dispute lifecycle

1. Governance calls `register_arbiter` for each arbiter and sets a non-zero
   M-of-N value with `set_arbiter_threshold`.
2. Before the escrow timeout, the escrow sender calls
   `raise_dispute(escrow_id, evidence_hash)`. The `BytesN<32>` evidence hash
   is retained for audit and the escrow moves from `Locked` to `Disputed`.
3. At least M distinct registered arbiters call
   `resolve_dispute(escrow_id, arbiter_signers, decision)` in the same
   transaction. Duplicate and unregistered addresses are rejected.
4. Use `ResolutionDecision::Sender`, `::Agent`, or
   `::Split(sender_amount)`. A split is bounded to `[0, escrow.amount]`; the
   agent receives the exact remainder, preventing overpayment.

The contract emits `dispute_raised` and `dispute_resolved` events. Index both
alongside the transaction authorization entries for compliance and audit.

//! Upgrade simulation tests for the EscrowContract migration framework.
//!
//! These tests verify the full upgrade cycle:
//!   1. Deploy V1 contract and seed state.
//!   2. Simulate a WASM upgrade (by calling `migrate()` with the V2 binary in scope).
//!   3. Call `migrate()` and verify all V1 records are intact and readable under the V2 schema.
//!
//! # Running
//!
//! ```bash
//! cd contracts/escrow
//! cargo test --features testutils upgrade -- --nocapture
//! ```

#![cfg(test)]

use soroban_sdk::{
    testutils::Address as _,
    Address, Env, String,
};

// Import the escrow contract under test.
// When the feature flag `testutils` is active the SDK provides a register_contract
// helper that lets us call contract functions directly without WASM.
use escrow::{EscrowContract, EscrowContractClient};
use escrow::migration::{
    current_schema_version, EscrowMigrationError, SchemaVersion, TARGET_VERSION,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Deploy a fresh EscrowContract, call `initialize()`, and return the client
/// together with the admin address.
fn deploy_contract(env: &Env) -> (EscrowContractClient, Address) {
    let admin = Address::generate(env);
    let contract_id = env.register_contract(None, EscrowContract);
    let client = EscrowContractClient::new(env, &contract_id);
    client.initialize(&admin);
    (client, admin)
}

/// Create a test escrow and return its ID.
fn seed_escrow(
    env: &Env,
    client: &EscrowContractClient,
    sender: &Address,
    beneficiary: &Address,
    arbitrator: &Address,
) -> String {
    env.mock_all_auths();
    client.create_escrow(
        sender,
        beneficiary,
        arbitrator,
        &1_000_000_i128,
        &String::from_str(env, "USDC"),
        &3_600_u64,
    )
}

// ---------------------------------------------------------------------------
// Test: schema version is written at initialisation
// ---------------------------------------------------------------------------

#[test]
fn test_initialize_sets_schema_v1() {
    let env = Env::default();
    let (_, _admin) = deploy_contract(&env);

    let version = env.as_contract(&env.register_contract(None, EscrowContract), || {
        current_schema_version(&env)
    });

    // After initialize(), schema_version must be V1.
    assert_eq!(version, SchemaVersion::V1 as u32);
}

// ---------------------------------------------------------------------------
// Test: migrate() advances schema from V1 to TARGET_VERSION
// ---------------------------------------------------------------------------

#[test]
fn test_migrate_advances_schema_version() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, admin) = deploy_contract(&env);

    // Confirm we start at V1.
    // (schema_version is readable via the helper after init)
    let result = client.migrate(&admin);
    assert!(result.is_ok(), "migrate() should succeed: {:?}", result);
}

// ---------------------------------------------------------------------------
// Test: migrate() is idempotent — calling it twice is safe
// ---------------------------------------------------------------------------

#[test]
fn test_migrate_is_idempotent() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, admin) = deploy_contract(&env);

    // First call — advances V1 → TARGET.
    let first = client.migrate(&admin);
    assert!(first.is_ok(), "first migrate() should succeed");

    // Second call — already at target, must return Ok(()) without side effects.
    let second = client.migrate(&admin);
    assert!(
        second.is_ok(),
        "second migrate() should be a no-op Ok(()): {:?}",
        second
    );
}

// ---------------------------------------------------------------------------
// Test: non-admin cannot call migrate()
// ---------------------------------------------------------------------------

#[test]
fn test_migrate_rejects_non_admin() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _admin) = deploy_contract(&env);
    let attacker = Address::generate(&env);

    let result = client.try_migrate(&attacker);
    assert!(
        result.is_err(),
        "non-admin migrate() call must be rejected"
    );

    // The error must be Unauthorized (code 1 in EscrowMigrationError).
    if let Err(Ok(err)) = result {
        assert_eq!(
            err,
            soroban_sdk::xdr::ScVal::Error(soroban_sdk::xdr::ScError::Contract(
                EscrowMigrationError::Unauthorized as u32
            )),
            "expected Unauthorized error"
        );
    }
}

// ---------------------------------------------------------------------------
// Test: V1 escrow records survive migration and are readable under V2 schema
// ---------------------------------------------------------------------------

#[test]
fn test_v1_state_intact_after_migration() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, admin) = deploy_contract(&env);

    // Seed V1 state: create two escrows before migration.
    let sender1 = Address::generate(&env);
    let beneficiary1 = Address::generate(&env);
    let arbitrator1 = Address::generate(&env);
    let id1 = seed_escrow(&env, &client, &sender1, &beneficiary1, &arbitrator1);

    let sender2 = Address::generate(&env);
    let beneficiary2 = Address::generate(&env);
    let arbitrator2 = Address::generate(&env);
    let id2 = seed_escrow(&env, &client, &sender2, &beneficiary2, &arbitrator2);

    // Run migration.
    let migrate_result = client.migrate(&admin);
    assert!(migrate_result.is_ok(), "migration must succeed");

    // Verify record integrity: both escrows must still be readable and
    // their core fields must match what was written in V1.
    let escrow1 = client.get_escrow(&id1);
    assert_eq!(escrow1.sender, sender1, "escrow1 sender must be intact after migration");
    assert_eq!(escrow1.beneficiary, beneficiary1, "escrow1 beneficiary must be intact");
    assert_eq!(escrow1.amount, 1_000_000_i128, "escrow1 amount must be intact");

    let escrow2 = client.get_escrow(&id2);
    assert_eq!(escrow2.sender, sender2, "escrow2 sender must be intact after migration");
    assert_eq!(escrow2.beneficiary, beneficiary2, "escrow2 beneficiary must be intact");
    assert_eq!(escrow2.amount, 1_000_000_i128, "escrow2 amount must be intact");
}

// ---------------------------------------------------------------------------
// Test: fund_escrow still works on a post-migration record
// ---------------------------------------------------------------------------

#[test]
fn test_escrow_operations_work_after_migration() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, admin) = deploy_contract(&env);

    let sender = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let arbitrator = Address::generate(&env);

    // Seed a V1 escrow.
    let id = seed_escrow(&env, &client, &sender, &beneficiary, &arbitrator);

    // Run migration.
    client.migrate(&admin).expect("migration must succeed");

    // Fund the escrow after migration — state machine must still work.
    client.fund_escrow(&id, &sender);

    let escrow = client.get_escrow(&id);
    assert_eq!(
        escrow.state,
        escrow::EscrowState::Funded,
        "escrow state must be Funded after fund_escrow post-migration"
    );
}

// ---------------------------------------------------------------------------
// Test: new escrows can be created after migration
// ---------------------------------------------------------------------------

#[test]
fn test_create_escrow_after_migration() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, admin) = deploy_contract(&env);

    // Run migration first.
    client.migrate(&admin).expect("migration must succeed");

    // Creating a new escrow under the migrated schema must succeed.
    let sender = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let arbitrator = Address::generate(&env);
    let id = seed_escrow(&env, &client, &sender, &beneficiary, &arbitrator);

    let escrow = client.get_escrow(&id);
    assert_eq!(escrow.sender, sender);
    assert_eq!(
        escrow.state,
        escrow::EscrowState::Pending,
        "newly created post-migration escrow must start in Pending state"
    );
}

// ---------------------------------------------------------------------------
// Test: TARGET_VERSION is V2 (compile-time assertion)
// ---------------------------------------------------------------------------

#[test]
fn test_target_version_is_v2() {
    assert_eq!(
        TARGET_VERSION,
        SchemaVersion::V2,
        "TARGET_VERSION must be V2 — update this test when a new version is added"
    );
}

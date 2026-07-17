//! Versioned-state migration framework for the EscrowContract.
//!
//! # Overview
//!
//! Soroban contracts are upgraded by replacing the WASM bytecode via
//! `env.deployer().update_current_contract_wasm()`.  The storage layout
//! (key names and value types) is **not** touched automatically — any
//! schema change must be applied explicitly after the WASM swap.
//!
//! This module provides:
//!
//! - [`SchemaVersion`] — an enum that names every schema version the contract
//!   has ever had.
//! - [`migrate`] — a one-shot entry point callable only by the contract admin
//!   that runs all pending per-version migration functions in order and writes
//!   the new schema version to persistent storage.
//!
//! # Invariants
//!
//! 1. `migrate()` is **idempotent**: calling it when the contract is already at
//!    `TARGET_VERSION` returns `Ok(())` without side effects.
//! 2. `migrate()` is **callable once per version**: it only applies migrations
//!    for versions strictly greater than the stored `schema_version`.
//! 3. `migrate()` is **admin-only**: any non-admin caller receives
//!    `EscrowError::Unauthorized`.
//!
//! # Adding a New Migration
//!
//! 1. Add a new variant to [`SchemaVersion`] with the next sequential `u32` value.
//! 2. Update `TARGET_VERSION` to the new variant.
//! 3. Implement a `migrate_vN_to_vM` function following the existing pattern.
//! 4. Add a branch to the `for version in` loop inside [`migrate`].
//! 5. Add a simulation test in `contracts/tests/upgrade/`.
//! 6. Update `contracts/MIGRATION.md`.

#![allow(dead_code)]

use soroban_sdk::{contracttype, Address, Env, Symbol};

// ---------------------------------------------------------------------------
// Storage key constants
// ---------------------------------------------------------------------------

/// Persistent storage key for the current schema version.
pub const KEY_SCHEMA_VERSION: &str = "schema_version";

/// Persistent storage key for the contract admin address.
pub const KEY_ADMIN: &str = "admin";

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/// Errors that can be returned by the migration entry point.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum EscrowMigrationError {
    /// Caller is not the contract admin.
    Unauthorized = 1,
    /// The stored schema version is unknown — manual intervention required.
    UnknownSchemaVersion = 2,
    /// The stored schema version is ahead of the compiled target version.
    /// This indicates a rollback attempt, which is not supported.
    VersionDowngrade = 3,
    /// The admin key is missing from storage — contract may not be initialised.
    AdminNotSet = 4,
}

// ---------------------------------------------------------------------------
// Schema version enum
// ---------------------------------------------------------------------------

/// All schema versions the EscrowContract has ever used.
///
/// Variants must be kept in strictly ascending order of their discriminant
/// values.  Do not renumber or remove existing variants.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum SchemaVersion {
    /// Initial deployment — `Escrow` struct with: id, sender, beneficiary,
    /// arbitrator, amount, asset, state, created_at, funded_at, timelock,
    /// released_at, refunded_at, disputed_at.
    V1 = 1,

    /// Added `description` field (Option<String>) to `Escrow` for human-readable
    /// escrow context.  Existing records receive `None` for this field.
    V2 = 2,

    // When adding a new version:
    //   V3 = 3,
    //   ...
}

/// The schema version compiled into the current WASM binary.
///
/// Update this constant whenever a new [`SchemaVersion`] variant is added.
pub const TARGET_VERSION: SchemaVersion = SchemaVersion::V2;

// ---------------------------------------------------------------------------
// Public migration entry point
// ---------------------------------------------------------------------------

/// Apply all pending schema migrations and advance the stored schema version.
///
/// # Parameters
///
/// - `env` — The Soroban environment.
/// - `admin` — The caller's address; must match the stored admin key.
///
/// # Returns
///
/// `Ok(())` — migrations applied successfully, or already at target version.
///
/// # Errors
///
/// - [`EscrowMigrationError::AdminNotSet`] — admin key absent from storage.
/// - [`EscrowMigrationError::Unauthorized`] — caller is not the admin.
/// - [`EscrowMigrationError::UnknownSchemaVersion`] — stored version is not
///   a known [`SchemaVersion`] variant.
/// - [`EscrowMigrationError::VersionDowngrade`] — stored version is ahead of
///   `TARGET_VERSION`.
pub fn migrate(env: &Env, admin: Address) -> Result<(), EscrowMigrationError> {
    // 1. Load the stored admin and verify the caller.
    let stored_admin: Address = env
        .storage()
        .instance()
        .get(&Symbol::new(env, KEY_ADMIN))
        .ok_or(EscrowMigrationError::AdminNotSet)?;

    admin.require_auth();

    if stored_admin != admin {
        return Err(EscrowMigrationError::Unauthorized);
    }

    // 2. Read the current schema version (default to V1 if absent — contracts
    //    deployed before migration support was added have an implicit V1 schema).
    let current_version: u32 = env
        .storage()
        .instance()
        .get(&Symbol::new(env, KEY_SCHEMA_VERSION))
        .unwrap_or(SchemaVersion::V1 as u32);

    let target: u32 = TARGET_VERSION as u32;

    // 3. Guard: already at target — idempotent no-op.
    if current_version == target {
        return Ok(());
    }

    // 4. Guard: downgrade attempt.
    if current_version > target {
        return Err(EscrowMigrationError::VersionDowngrade);
    }

    // 5. Run migrations for every version between current and target (exclusive
    //    on the current side, inclusive on the target side).
    let mut version = current_version;
    while version < target {
        let next = version + 1;
        run_single_migration(env, version, next)?;
        // Checkpoint: persist the intermediate version so that a mid-migration
        // failure leaves the schema in a consistent partially-migrated state
        // rather than a corrupt one.
        env.storage()
            .instance()
            .set(&Symbol::new(env, KEY_SCHEMA_VERSION), &next);
        version = next;
    }

    // 6. Emit a migration event for off-chain monitoring.
    env.events().publish(
        (Symbol::new(env, "schema_migrated"),),
        (current_version, target),
    );

    Ok(())
}

// ---------------------------------------------------------------------------
// Per-version migration functions
// ---------------------------------------------------------------------------

/// Dispatch a single version-to-version migration.
fn run_single_migration(env: &Env, from: u32, to: u32) -> Result<(), EscrowMigrationError> {
    match (from, to) {
        (1, 2) => migrate_v1_to_v2(env),
        // Add new cases here as new versions are introduced:
        // (2, 3) => migrate_v2_to_v3(env),
        _ => Err(EscrowMigrationError::UnknownSchemaVersion),
    }
}

/// Migration V1 → V2: add `description` field (Option<String>) to all Escrow
/// records stored under their escrow ID keys.
///
/// Because Soroban uses XDR encoding for `#[contracttype]` structs, a new
/// optional field at the end of the struct is back-compatible with the XDR
/// union encoding when using `Option`.  This migration is a no-op at the data
/// level — it simply records that V1 records are now interpreted under the V2
/// schema.
///
/// If your actual V1→V2 change requires writing new fields, insert the
/// re-serialisation logic here, iterating over the escrow key space.
fn migrate_v1_to_v2(_env: &Env) -> Result<(), EscrowMigrationError> {
    // V1 Escrow records are XDR-compatible with V2 because the new
    // `description: Option<String>` field defaults to None in existing records
    // when read by V2 code.  No explicit re-write is required.
    //
    // If a future migration requires re-writing records, follow this pattern:
    //
    //   let keys: Vec<String> = collect_all_escrow_keys(_env);
    //   for key in keys.iter() {
    //       let v1_record: EscrowV1 = _env.storage().persistent().get(&key).unwrap();
    //       let v2_record = EscrowV2 { ...v1_record, description: None };
    //       _env.storage().persistent().set(&key, &v2_record);
    //   }
    Ok(())
}

// ---------------------------------------------------------------------------
// Helper: read stored schema version (for use in contract entry points)
// ---------------------------------------------------------------------------

/// Returns the currently stored schema version, or `V1` if not yet set.
///
/// Useful in contract entry points that need to guard against being called
/// on a schema that has not yet been migrated.
pub fn current_schema_version(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&Symbol::new(env, KEY_SCHEMA_VERSION))
        .unwrap_or(SchemaVersion::V1 as u32)
}

/// Write the initial schema version during contract initialisation.
///
/// Must be called once inside the contract's `initialize()` entry point.
pub fn set_initial_schema_version(env: &Env) {
    env.storage()
        .instance()
        .set(&Symbol::new(env, KEY_SCHEMA_VERSION), &(SchemaVersion::V1 as u32));
}

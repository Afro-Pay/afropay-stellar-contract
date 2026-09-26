#![cfg(test)]
use super::*;
use soroban_sdk::{Env, Address, String};
use proptest::prelude::*;
use proptest_derive::Arbitrary;
use crate::test::{EscrowInput, PartySet, escrow_input, party_set};

#[derive(Clone, Debug, Arbitrary)]
pub struct EscrowInput {
    pub amount: i128,
    pub timelock: u64,
    pub asset_code: String,
}

#[derive(Clone, Debug, Arbitrary)]
pub struct PartySet {
    pub sender: Address,
    pub beneficiary: Address,
    pub arbitrator: Address,
    pub unauthorized: Address,
}

prop_compose! {
    fn valid_amount()(amount in 1..1000000i128) -> i128 {
        amount
    }
}

prop_compose! {
    fn valid_timelock()(timelock in 1..1000000u64) -> u64 {
        timelock
    }
}

prop_compose! {
    fn random_address()(seed in 1..1000000u64) -> Address {
        let env = Env::default();
        Address::from_string(&String::from_str(&env, &format!("G{}", seed)))
    }
}

prop_compose! {
    fn party_set()(
        sender in random_address(),
        beneficiary in random_address(),
        arbitrator in random_address(),
        unauthorized in random_address(),
    ) -> PartySet {
        PartySet {
            sender,
            beneficiary,
            arbitrator,
            unauthorized,
        }
    }
}

prop_compose! {
    fn escrow_input()(
        amount in valid_amount(),
        timelock in valid_timelock(),
        asset_code in "([A-Z]{1,12})",
    ) -> EscrowInput {
        EscrowInput {
            amount,
            timelock,
            asset_code,
        }
    }
}

// ── Example-based unit tests ──────────────────────────────────────────────

#[test]
fn test_create_escrow_basic() {
    let env = Env::default();
    let sender = Address::from_string(&String::from_str(&env, "G1"));
    let beneficiary = Address::from_string(&String::from_str(&env, "G2"));
    let arbitrator = Address::from_string(&String::from_str(&env, "G3"));

    let id = EscrowContract::create_escrow(
        env.clone(),
        sender.clone(),
        beneficiary.clone(),
        arbitrator.clone(),
        1000,
        String::from_str(&env, "USDC"),
        3600,
    );

    let escrow: Escrow = env.storage().get(&id).unwrap();
    assert_eq!(escrow.id, id);
    assert_eq!(escrow.sender, sender);
    assert_eq!(escrow.beneficiary, beneficiary);
    assert_eq!(escrow.arbitrator, arbitrator);
    assert_eq!(escrow.amount, 1000);
    assert_eq!(escrow.state, EscrowState::Pending);
}

#[test]
fn test_fund_escrow_basic() {
    let env = Env::default();
    let sender = Address::from_string(&String::from_str(&env, "G1"));
    let beneficiary = Address::from_string(&String::from_str(&env, "G2"));
    let arbitrator = Address::from_string(&String::from_str(&env, "G3"));

    let id = EscrowContract::create_escrow(
        env.clone(),
        sender.clone(),
        beneficiary.clone(),
        arbitrator.clone(),
        1000,
        String::from_str(&env, "USDC"),
        3600,
    );

    EscrowContract::fund_escrow(env.clone(), id.clone(), sender.clone());
    let escrow = EscrowContract::get_escrow(env.clone(), id.clone());
    assert_eq!(escrow.state, EscrowState::Funded);
    assert!(escrow.funded_at.is_some());
}

#[test]
fn test_release_escrow_basic() {
    let env = Env::default();
    let sender = Address::from_string(&String::from_str(&env, "G1"));
    let beneficiary = Address::from_string(&String::from_str(&env, "G2"));
    let arbitrator = Address::from_string(&String::from_str(&env, "G3"));

    let id = EscrowContract::create_escrow(
        env.clone(),
        sender.clone(),
        beneficiary.clone(),
        arbitrator.clone(),
        1000,
        String::from_str(&env, "USDC"),
        3600,
    );

    EscrowContract::fund_escrow(env.clone(), id.clone(), sender.clone());
    EscrowContract::release_escrow(env.clone(), id.clone(), beneficiary.clone());
    let escrow = EscrowContract::get_escrow(env, id);
    assert_eq!(escrow.state, EscrowState::Released);
    assert!(escrow.released_at.is_some());
}

#[test]
fn test_refund_escrow_after_timelock() {
    let env = Env::default();
    let sender = Address::from_string(&String::from_str(&env, "G1"));
    let beneficiary = Address::from_string(&String::from_str(&env, "G2"));
    let arbitrator = Address::from_string(&String::from_str(&env, "G3"));

    let id = EscrowContract::create_escrow(
        env.clone(),
        sender.clone(),
        beneficiary.clone(),
        arbitrator.clone(),
        1000,
        String::from_str(&env, "USDC"),
        1, // short timelock
    );

    EscrowContract::fund_escrow(env.clone(), id.clone(), sender.clone());

    // Advance past timelock
    env.ledger().with_mut(|ledger| {
        ledger.set_timestamp(1000);
    });

    EscrowContract::refund_escrow(env.clone(), id.clone(), sender.clone());
    let escrow = EscrowContract::get_escrow(env, id);
    assert_eq!(escrow.state, EscrowState::Refunded);
    assert!(escrow.refunded_at.is_some());
}

#[test]
fn test_dispute_escrow_basic() {
    let env = Env::default();
    let sender = Address::from_string(&String::from_str(&env, "G1"));
    let beneficiary = Address::from_string(&String::from_str(&env, "G2"));
    let arbitrator = Address::from_string(&String::from_str(&env, "G3"));

    let id = EscrowContract::create_escrow(
        env.clone(),
        sender.clone(),
        beneficiary.clone(),
        arbitrator.clone(),
        1000,
        String::from_str(&env, "USDC"),
        3600,
    );

    EscrowContract::fund_escrow(env.clone(), id.clone(), sender.clone());
    EscrowContract::dispute_escrow(env.clone(), id.clone(), sender.clone());
    let escrow = EscrowContract::get_escrow(env.clone(), id.clone());
    assert_eq!(escrow.state, EscrowState::Disputed);

    EscrowContract::resolve_dispute(env.clone(), id.clone(), arbitrator.clone(), true);
    let resolved = EscrowContract::get_escrow(env, id);
    assert_eq!(resolved.state, EscrowState::Resolved);
}

#[test]
#[should_panic(expected = "Amount must be positive")]
fn test_create_escrow_zero_amount_panics() {
    let env = Env::default();
    let sender = Address::from_string(&String::from_str(&env, "G1"));
    let beneficiary = Address::from_string(&String::from_str(&env, "G2"));
    let arbitrator = Address::from_string(&String::from_str(&env, "G3"));

    EscrowContract::create_escrow(
        env,
        sender,
        beneficiary,
        arbitrator,
        0,
        String::from_str(&env, "USDC"),
        3600,
    );
}

#[test]
#[should_panic(expected = "Timelock must be positive")]
fn test_create_escrow_zero_timelock_panics() {
    let env = Env::default();
    let sender = Address::from_string(&String::from_str(&env, "G1"));
    let beneficiary = Address::from_string(&String::from_str(&env, "G2"));
    let arbitrator = Address::from_string(&String::from_str(&env, "G3"));

    EscrowContract::create_escrow(
        env,
        sender,
        beneficiary,
        arbitrator,
        1000,
        String::from_str(&env, "USDC"),
        0,
    );
}

#[test]
#[should_panic(expected = "Only sender can fund the escrow")]
fn test_fund_escrow_unauthorized_sender() {
    let env = Env::default();
    let sender = Address::from_string(&String::from_str(&env, "G1"));
    let beneficiary = Address::from_string(&String::from_str(&env, "G2"));
    let arbitrator = Address::from_string(&String::from_str(&env, "G3"));
    let unauthorized = Address::from_string(&String::from_str(&env, "G4"));

    let id = EscrowContract::create_escrow(
        env.clone(),
        sender.clone(),
        beneficiary.clone(),
        arbitrator.clone(),
        1000,
        String::from_str(&env, "USDC"),
        3600,
    );

    EscrowContract::fund_escrow(env, id, unauthorized);
}

#[test]
#[should_panic(expected = "Only beneficiary can release funds")]
fn test_release_escrow_unauthorized_beneficiary() {
    let env = Env::default();
    let sender = Address::from_string(&String::from_str(&env, "G1"));
    let beneficiary = Address::from_string(&String::from_str(&env, "G2"));
    let arbitrator = Address::from_string(&String::from_str(&env, "G3"));
    let unauthorized = Address::from_string(&String::from_str(&env, "G4"));

    let id = EscrowContract::create_escrow(
        env.clone(),
        sender.clone(),
        beneficiary.clone(),
        arbitrator.clone(),
        1000,
        String::from_str(&env, "USDC"),
        3600,
    );

    EscrowContract::fund_escrow(env.clone(), id.clone(), sender.clone());
    EscrowContract::release_escrow(env, id, unauthorized);
}

#[test]
#[should_panic(expected = "Only arbitrator can resolve dispute")]
fn test_resolve_dispute_unauthorized_arbitrator() {
    let env = Env::default();
    let sender = Address::from_string(&String::from_str(&env, "G1"));
    let beneficiary = Address::from_string(&String::from_str(&env, "G2"));
    let arbitrator = Address::from_string(&String::from_str(&env, "G3"));
    let unauthorized = Address::from_string(&String::from_str(&env, "G4"));

    let id = EscrowContract::create_escrow(
        env.clone(),
        sender.clone(),
        beneficiary.clone(),
        arbitrator.clone(),
        1000,
        String::from_str(&env, "USDC"),
        3600,
    );

    EscrowContract::fund_escrow(env.clone(), id.clone(), sender.clone());
    EscrowContract::dispute_escrow(env.clone(), id.clone(), sender.clone());
    EscrowContract::resolve_dispute(env, id, unauthorized, true);
}

#[test]
#[should_panic(expected = "Invalid state transition")]
fn test_invalid_state_transition_pending_to_released() {
    let env = Env::default();
    let sender = Address::from_string(&String::from_str(&env, "G1"));
    let beneficiary = Address::from_string(&String::from_str(&env, "G2"));
    let arbitrator = Address::from_string(&String::from_str(&env, "G3"));

    let id = EscrowContract::create_escrow(
        env.clone(),
        sender.clone(),
        beneficiary.clone(),
        arbitrator.clone(),
        1000,
        String::from_str(&env, "USDC"),
        3600,
    );

    // Try to release from Pending state (invalid)
    EscrowContract::release_escrow(env, id, beneficiary);
}

#[test]
#[should_panic(expected = "Invalid state transition")]
fn test_invalid_state_transition_pending_to_refunded() {
    let env = Env::default();
    let sender = Address::from_string(&String::from_str(&env, "G1"));
    let beneficiary = Address::from_string(&String::from_str(&env, "G2"));
    let arbitrator = Address::from_string(&String::from_str(&env, "G3"));

    let id = EscrowContract::create_escrow(
        env.clone(),
        sender.clone(),
        beneficiary.clone(),
        arbitrator.clone(),
        1000,
        String::from_str(&env, "USDC"),
        3600,
    );

    // Try to refund from Pending state (invalid)
    EscrowContract::refund_escrow(env, id, sender);
}

#[test]
fn test_full_lifecycle_pending_to_released() {
    let env = Env::default();
    let sender = Address::from_string(&String::from_str(&env, "G1"));
    let beneficiary = Address::from_string(&String::from_str(&env, "G2"));
    let arbitrator = Address::from_string(&String::from_str(&env, "G3"));

    let id = EscrowContract::create_escrow(
        env.clone(),
        sender.clone(),
        beneficiary.clone(),
        arbitrator.clone(),
        100_000,
        String::from_str(&env, "USDC"),
        3600,
    );

    // Pending → Funded
    EscrowContract::fund_escrow(env.clone(), id.clone(), sender.clone());
    let funded = EscrowContract::get_escrow(env.clone(), id.clone());
    assert_eq!(funded.state, EscrowState::Funded);

    // Funded → Released
    EscrowContract::release_escrow(env.clone(), id.clone(), beneficiary.clone());
    let released = EscrowContract::get_escrow(env.clone(), id.clone());
    assert_eq!(released.state, EscrowState::Released);
    assert_eq!(released.amount, 100_000);
}

#[test]
fn test_full_lifecycle_pending_to_refunded() {
    let env = Env::default();
    let sender = Address::from_string(&String::from_str(&env, "G1"));
    let beneficiary = Address::from_string(&String::from_str(&env, "G2"));
    let arbitrator = Address::from_string(&String::from_str(&env, "G3"));

    let id = EscrowContract::create_escrow(
        env.clone(),
        sender.clone(),
        beneficiary.clone(),
        arbitrator.clone(),
        100_000,
        String::from_str(&env, "USDC"),
        1, // short timelock
    );

    // Pending → Funded
    EscrowContract::fund_escrow(env.clone(), id.clone(), sender.clone());
    let funded = EscrowContract::get_escrow(env.clone(), id.clone());
    assert_eq!(funded.state, EscrowState::Funded);

    // Advance past timelock
    env.ledger().with_mut(|ledger| {
        ledger.set_timestamp(1000);
    });

    // Funded → Refunded
    EscrowContract::refund_escrow(env.clone(), id.clone(), sender.clone());
    let refunded = EscrowContract::get_escrow(env.clone(), id.clone());
    assert_eq!(refunded.state, EscrowState::Refunded);
    assert_eq!(refunded.amount, 100_000);
}

#[test]
fn test_full_lifecycle_pending_to_disputed_to_resolved() {
    let env = Env::default();
    let sender = Address::from_string(&String::from_str(&env, "G1"));
    let beneficiary = Address::from_string(&String::from_str(&env, "G2"));
    let arbitrator = Address::from_string(&String::from_str(&env, "G3"));

    let id = EscrowContract::create_escrow(
        env.clone(),
        sender.clone(),
        beneficiary.clone(),
        arbitrator.clone(),
        100_000,
        String::from_str(&env, "USDC"),
        3600,
    );

    // Pending → Funded
    EscrowContract::fund_escrow(env.clone(), id.clone(), sender.clone());

    // Funded → Disputed
    EscrowContract::dispute_escrow(env.clone(), id.clone(), sender.clone());
    let disputed = EscrowContract::get_escrow(env.clone(), id.clone());
    assert_eq!(disputed.state, EscrowState::Disputed);

    // Disputed → Resolved
    EscrowContract::resolve_dispute(env.clone(), id.clone(), arbitrator.clone(), true);
    let resolved = EscrowContract::get_escrow(env, id);
    assert_eq!(resolved.state, EscrowState::Resolved);
}

#[test]
fn test_create_escrow_large_amount() {
    let env = Env::default();
    let sender = Address::from_string(&String::from_str(&env, "G1"));
    let beneficiary = Address::from_string(&String::from_str(&env, "G2"));
    let arbitrator = Address::from_string(&String::from_str(&env, "G3"));

    let max_amount = i128::MAX / 2;
    let id = EscrowContract::create_escrow(
        env.clone(),
        sender.clone(),
        beneficiary.clone(),
        arbitrator.clone(),
        max_amount,
        String::from_str(&env, "USDC"),
        3600,
    );

    let escrow = EscrowContract::get_escrow(env, id);
    assert_eq!(escrow.amount, max_amount);
}

#[test]
fn test_create_escrow_minimum_amount() {
    let env = Env::default();
    let sender = Address::from_string(&String::from_str(&env, "G1"));
    let beneficiary = Address::from_string(&String::from_str(&env, "G2"));
    let arbitrator = Address::from_string(&String::from_str(&env, "G3"));

    let id = EscrowContract::create_escrow(
        env.clone(),
        sender.clone(),
        beneficiary.clone(),
        arbitrator.clone(),
        1,
        String::from_str(&env, "USDC"),
        3600,
    );

    let escrow = EscrowContract::get_escrow(env, id);
    assert_eq!(escrow.amount, 1);
}

#[test]
fn test_initialize_and_migrate() {
    let env = Env::default();
    let admin = Address::from_string(&String::from_str(&env, "GADMIN123456789012345678901234567890123456789012345678901234"));

    EscrowContract::initialize(env.clone(), admin.clone());

    // Migrate should succeed for admin
    let result = EscrowContract::migrate(env.clone(), admin.clone());
    assert!(result.is_ok());
}

#[test]
#[should_panic(expected = "Already initialised")]
fn test_double_initialize_panics() {
    let env = Env::default();
    let admin = Address::from_string(&String::from_str(&env, "GADMIN123456789012345678901234567890123456789012345678901234"));

    EscrowContract::initialize(env.clone(), admin.clone());
    EscrowContract::initialize(env, admin);
}

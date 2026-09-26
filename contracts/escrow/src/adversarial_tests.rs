#![cfg(test)]
use super::*;
use soroban_sdk::{Env, Address, String};

// ── Adversarial Scenario 1: Non-admin calling admin functions ──────────────

#[test]
fn test_adversarial_non_admin_cannot_initialize() {
    let env = Env::default();
    let admin = Address::from_string(&String::from_str(&env, "GADMIN1234567890123456789012345678901234567890123456789012345678901234"));
    let non_admin = Address::from_string(&String::from_str(&env, "GNONADMIN1234567890123456789012345678901234567890123456789012345678901234"));

    // Initialize the contract with the admin
    EscrowContract::initialize(env.clone(), admin.clone());

    // Non-admin attempting to call migrate should fail
    let result = std::panic::catch_unwind(|| {
        EscrowContract::migrate(env.clone(), non_admin.clone());
    });
    assert!(result.is_err(), "Non-admin must not be able to call migrate");
}

#[test]
fn test_adversarial_non_admin_cannot_migrate() {
    let env = Env::default();
    let admin = Address::from_string(&String::from_str(&env, "GADMIN1234567890123456789012345678901234567890123456789012345678901234"));
    let non_admin = Address::from_string(&String::from_str(&env, "GNONADMIN1234567890123456789012345678901234567890123456789012345678901234"));

    EscrowContract::initialize(env.clone(), admin.clone());

    let result = std::panic::catch_unwind(|| {
        EscrowContract::migrate(env.clone(), non_admin.clone());
    });
    assert!(result.is_err(), "Non-admin must not be able to call migrate");
}

// ── Adversarial Scenario 2: Zero-amount transfer ──────────────────────────

#[test]
fn test_adversarial_zero_amount() {
    let env = Env::default();
    let sender = Address::from_string(&String::from_str(&env, "G1"));
    let beneficiary = Address::from_string(&String::from_str(&env, "G2"));
    let arbitrator = Address::from_string(&String::from_str(&env, "G3"));

    let result = std::panic::catch_unwind(|| {
        EscrowContract::create_escrow(
            env.clone(),
            sender,
            beneficiary,
            arbitrator,
            0,
            String::from_str(&env, "USDC"),
            3600,
        );
    });
    assert!(result.is_err(), "Zero-amount escrow creation must be rejected");
}

// ── Adversarial Scenario 3: Amount = i128::MAX ────────────────────────────

#[test]
fn test_adversarial_max_amount() {
    let env = Env::default();
    let sender = Address::from_string(&String::from_str(&env, "G1"));
    let beneficiary = Address::from_string(&String::from_str(&env, "G2"));
    let arbitrator = Address::from_string(&String::from_str(&env, "G3"));

    // i128::MAX is a valid positive amount; creation should succeed
    let id = EscrowContract::create_escrow(
        env.clone(),
        sender.clone(),
        beneficiary.clone(),
        arbitrator.clone(),
        i128::MAX,
        String::from_str(&env, "USDC"),
        3600,
    );

    let escrow = EscrowContract::get_escrow(env.clone(), id.clone());
    assert_eq!(escrow.amount, i128::MAX, "Escrow should store i128::MAX amount");

    // Funding should work
    EscrowContract::fund_escrow(env.clone(), id.clone(), sender.clone());
    let funded = EscrowContract::get_escrow(env.clone(), id.clone());
    assert_eq!(funded.state, EscrowState::Funded);

    // Release should work
    EscrowContract::release_escrow(env.clone(), id.clone(), beneficiary.clone());
    let released = EscrowContract::get_escrow(env, id);
    assert_eq!(released.state, EscrowState::Released);
}

// ── Adversarial Scenario 4: Self-send (sender == beneficiary) ─────────────

#[test]
fn test_adversarial_self_send_sender_is_beneficiary() {
    let env = Env::default();
    let sender = Address::from_string(&String::from_str(&env, "G1"));
    let arbitrator = Address::from_string(&String::from_str(&env, "G3"));

    // Sender creates escrow with themselves as the beneficiary
    let id = EscrowContract::create_escrow(
        env.clone(),
        sender.clone(),
        sender.clone(), // sender == beneficiary (self-send)
        arbitrator,
        1000,
        String::from_str(&env, "USDC"),
        3600,
    );

    EscrowContract::fund_escrow(env.clone(), id.clone(), sender.clone());

    // Beneficiary (who is also the sender) can release
    EscrowContract::release_escrow(env.clone(), id.clone(), sender.clone());
    let escrow = EscrowContract::get_escrow(env, id);
    assert_eq!(escrow.state, EscrowState::Released);
}

// ── Adversarial Scenario 5: Non-beneficiary trying to release ─────────────

#[test]
fn test_adversarial_non_beneficiary_release() {
    let env = Env::default();
    let sender = Address::from_string(&String::from_str(&env, "G1"));
    let beneficiary = Address::from_string(&String::from_str(&env, "G2"));
    let arbitrator = Address::from_string(&String::from_str(&env, "G3"));
    let attacker = Address::from_string(&String::from_str(&env, "G4"));

    let id = EscrowContract::create_escrow(
        env.clone(),
        sender,
        beneficiary.clone(),
        arbitrator,
        1000,
        String::from_str(&env, "USDC"),
        3600,
    );

    EscrowContract::fund_escrow(env.clone(), id.clone(), Address::from_string(&String::from_str(&env, "G1")));

    let result = std::panic::catch_unwind(|| {
        EscrowContract::release_escrow(env.clone(), id, attacker);
    });
    assert!(result.is_err(), "Non-beneficiary must not be able to release escrow");
}

// ── Adversarial Scenario 6: Double release ────────────────────────────────

#[test]
fn test_adversarial_double_release() {
    let env = Env::default();
    let sender = Address::from_string(&String::from_str(&env, "G1"));
    let beneficiary = Address::from_string(&String::from_str(&env, "G2"));
    let arbitrator = Address::from_string(&String::from_str(&env, "G3"));

    let id = EscrowContract::create_escrow(
        env.clone(),
        sender.clone(),
        beneficiary.clone(),
        arbitrator,
        1000,
        String::from_str(&env, "USDC"),
        3600,
    );

    EscrowContract::fund_escrow(env.clone(), id.clone(), sender);
    EscrowContract::release_escrow(env.clone(), id.clone(), beneficiary.clone());

    let result = std::panic::catch_unwind(|| {
        EscrowContract::release_escrow(env.clone(), id, beneficiary);
    });
    assert!(result.is_err(), "Double release must be rejected");
}

// ── Adversarial Scenario 7: Refund before timelock expires ────────────────

#[test]
fn test_adversarial_refund_before_timelock() {
    let env = Env::default();
    let sender = Address::from_string(&String::from_str(&env, "G1"));
    let beneficiary = Address::from_string(&String::from_str(&env, "G2"));
    let arbitrator = Address::from_string(&String::from_str(&env, "G3"));

    let id = EscrowContract::create_escrow(
        env.clone(),
        sender.clone(),
        beneficiary.clone(),
        arbitrator,
        1000,
        String::from_str(&env, "USDC"),
        3600, // 1 hour timelock
    );

    EscrowContract::fund_escrow(env.clone(), id.clone(), sender.clone());

    // Attempt refund before timelock expires (current time is 0, timelock is 3600)
    let result = std::panic::catch_unwind(|| {
        EscrowContract::refund_escrow(env.clone(), id.clone(), sender.clone());
    });
    assert!(result.is_err(), "Refund before timelock expiry must be rejected");
}

// ── Adversarial Scenario 8: Unauthorized dispute ──────────────────────────

#[test]
fn test_adversarial_unauthorized_dispute() {
    let env = Env::default();
    let sender = Address::from_string(&String::from_str(&env, "G1"));
    let beneficiary = Address::from_string(&String::from_str(&env, "G2"));
    let arbitrator = Address::from_string(&String::from_str(&env, "G3"));
    let unauthorized = Address::from_string(&String::from_str(&env, "G4"));

    let id = EscrowContract::create_escrow(
        env.clone(),
        sender.clone(),
        beneficiary.clone(),
        arbitrator,
        1000,
        String::from_str(&env, "USDC"),
        3600,
    );

    EscrowContract::fund_escrow(env.clone(), id.clone(), sender.clone());

    // Only sender or beneficiary can dispute
    let result = std::panic::catch_unwind(|| {
        EscrowContract::dispute_escrow(env.clone(), id, unauthorized);
    });
    assert!(result.is_err(), "Unauthorized party must not be able to dispute escrow");
}

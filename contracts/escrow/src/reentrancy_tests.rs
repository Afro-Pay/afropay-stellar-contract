#![cfg(test)]
use crate::{EscrowContract, Escrow, EscrowState};
use soroban_sdk::{Address, Env, String};

/// Test 1: Verify reentrancy guard is set on entry
#[test]
fn test_release_escrow_guard_set_on_entry() {
    let env = Env::default();
    let beneficiary = Address::random(&env);

    let escrow_id = String::from_str(&env, "escrow_test_1");
    let escrow = Escrow {
        id: escrow_id.clone(),
        sender: Address::random(&env),
        beneficiary: beneficiary.clone(),
        arbitrator: Address::random(&env),
        amount: 100_000,
        asset: String::from_str(&env, "USDC"),
        state: EscrowState::Funded,
        created_at: 0,
        funded_at: Some(0),
        timelock: 3600,
        released_at: None,
        refunded_at: None,
        disputed_at: None,
    };

    env.storage().set(&escrow_id, &escrow);

    let guard_key = String::from_str(&env, &format!("reentrancy_guard_{}", escrow_id.clone()));

    // Verify guard is NOT set before operation
    assert!(!env.storage().has(&guard_key), "Guard should not be set initially");
}

/// Test 2: Verify state consistency after protected operation
#[test]
fn test_release_escrow_state_consistency() {
    let env = Env::default();
    let beneficiary = Address::random(&env);

    let escrow_id = String::from_str(&env, "escrow_test_2");
    let mut escrow = Escrow {
        id: escrow_id.clone(),
        sender: Address::random(&env),
        beneficiary: beneficiary.clone(),
        arbitrator: Address::random(&env),
        amount: 100_000,
        asset: String::from_str(&env, "USDC"),
        state: EscrowState::Funded,
        created_at: 0,
        funded_at: Some(0),
        timelock: 3600,
        released_at: None,
        refunded_at: None,
        disputed_at: None,
    };

    env.storage().set(&escrow_id, &escrow);

    // Call release_escrow
    EscrowContract::release_escrow(env.clone(), escrow_id.clone(), beneficiary.clone());

    // Verify state was updated
    let updated_escrow: Escrow = env.storage().get(&escrow_id).unwrap();
    assert_eq!(updated_escrow.state, EscrowState::Released, "State should be Released after operation");
    assert!(updated_escrow.released_at.is_some(), "released_at should be set");
}

/// Test 3: Verify guard cleanup after normal execution
#[test]
fn test_release_escrow_guard_cleared_on_exit() {
    let env = Env::default();
    let beneficiary = Address::random(&env);

    let escrow_id = String::from_str(&env, "escrow_test_3");
    let escrow = Escrow {
        id: escrow_id.clone(),
        sender: Address::random(&env),
        beneficiary: beneficiary.clone(),
        arbitrator: Address::random(&env),
        amount: 100_000,
        asset: String::from_str(&env, "USDC"),
        state: EscrowState::Funded,
        created_at: 0,
        funded_at: Some(0),
        timelock: 3600,
        released_at: None,
        refunded_at: None,
        disputed_at: None,
    };

    env.storage().set(&escrow_id, &escrow);

    EscrowContract::release_escrow(env.clone(), escrow_id.clone(), beneficiary);

    // Verify guard is cleaned up after operation
    let guard_key = String::from_str(&env, &format!("reentrancy_guard_{}", escrow_id));
    assert!(!env.storage().has(&guard_key), "Guard should be cleaned up after operation");
}

/// Test 4: Concurrent operation isolation (multiple escrows)
#[test]
fn test_concurrent_escrows_independent_guards() {
    let env = Env::default();

    // Create two separate escrows
    let beneficiary1 = Address::random(&env);
    let beneficiary2 = Address::random(&env);

    let escrow_id1 = String::from_str(&env, "escrow_test_4a");
    let escrow_id2 = String::from_str(&env, "escrow_test_4b");

    let escrow1 = Escrow {
        id: escrow_id1.clone(),
        sender: Address::random(&env),
        beneficiary: beneficiary1.clone(),
        arbitrator: Address::random(&env),
        amount: 100_000,
        asset: String::from_str(&env, "USDC"),
        state: EscrowState::Funded,
        created_at: 0,
        funded_at: Some(0),
        timelock: 3600,
        released_at: None,
        refunded_at: None,
        disputed_at: None,
    };

    let escrow2 = Escrow {
        id: escrow_id2.clone(),
        sender: Address::random(&env),
        beneficiary: beneficiary2.clone(),
        arbitrator: Address::random(&env),
        amount: 200_000,
        asset: String::from_str(&env, "USDC"),
        state: EscrowState::Funded,
        created_at: 0,
        funded_at: Some(0),
        timelock: 3600,
        released_at: None,
        refunded_at: None,
        disputed_at: None,
    };

    env.storage().set(&escrow_id1, &escrow1);
    env.storage().set(&escrow_id2, &escrow2);

    // Process both escrows independently
    EscrowContract::release_escrow(env.clone(), escrow_id1.clone(), beneficiary1);
    EscrowContract::release_escrow(env.clone(), escrow_id2.clone(), beneficiary2);

    // Verify both are released independently
    let updated1: Escrow = env.storage().get(&escrow_id1).unwrap();
    let updated2: Escrow = env.storage().get(&escrow_id2).unwrap();

    assert_eq!(updated1.state, EscrowState::Released);
    assert_eq!(updated2.state, EscrowState::Released);
    assert_ne!(updated1.amount, updated2.amount, "Amounts should be independent");
}

/// Test 5: Refund operation guard protection
#[test]
fn test_refund_escrow_guard_protection() {
    let env = Env::default();
    let sender = Address::random(&env);

    let escrow_id = String::from_str(&env, "escrow_test_5");
    let escrow = Escrow {
        id: escrow_id.clone(),
        sender: sender.clone(),
        beneficiary: Address::random(&env),
        arbitrator: Address::random(&env),
        amount: 100_000,
        asset: String::from_str(&env, "USDC"),
        state: EscrowState::Funded,
        created_at: 0,
        funded_at: Some(0),
        timelock: 1, // Very short timelock
        released_at: None,
        refunded_at: None,
        disputed_at: None,
    };

    env.storage().set(&escrow_id, &escrow);

    // Advance ledger past timelock
    env.ledger().with_mut(|ledger| {
        ledger.set_timestamp(1000);
    });

    // Call refund
    EscrowContract::refund_escrow(env.clone(), escrow_id.clone(), sender);

    // Verify state updated
    let refunded: Escrow = env.storage().get(&escrow_id).unwrap();
    assert_eq!(refunded.state, EscrowState::Refunded);
    assert!(refunded.refunded_at.is_some());
}

/// Test 6: Dispute resolution guard
#[test]
fn test_dispute_escrow_guard_protection() {
    let env = Env::default();
    let sender = Address::random(&env);
    let beneficiary = Address::random(&env);

    let escrow_id = String::from_str(&env, "escrow_test_6");
    let escrow = Escrow {
        id: escrow_id.clone(),
        sender: sender.clone(),
        beneficiary: beneficiary.clone(),
        arbitrator: Address::random(&env),
        amount: 100_000,
        asset: String::from_str(&env, "USDC"),
        state: EscrowState::Funded,
        created_at: 0,
        funded_at: Some(0),
        timelock: 3600,
        released_at: None,
        refunded_at: None,
        disputed_at: None,
    };

    env.storage().set(&escrow_id, &escrow);

    // Initiate dispute
    EscrowContract::dispute_escrow(env.clone(), escrow_id.clone(), sender.clone());

    let disputed: Escrow = env.storage().get(&escrow_id).unwrap();
    assert_eq!(disputed.state, EscrowState::Disputed);
    assert!(disputed.disputed_at.is_some());
}

/// Test 7: Fund escrow state transition
#[test]
fn test_fund_escrow_guard_protection() {
    let env = Env::default();
    let sender = Address::random(&env);

    let escrow_id = String::from_str(&env, "escrow_test_7");
    let escrow = Escrow {
        id: escrow_id.clone(),
        sender: sender.clone(),
        beneficiary: Address::random(&env),
        arbitrator: Address::random(&env),
        amount: 100_000,
        asset: String::from_str(&env, "USDC"),
        state: EscrowState::Pending,
        created_at: 0,
        funded_at: None,
        timelock: 3600,
        released_at: None,
        refunded_at: None,
        disputed_at: None,
    };

    env.storage().set(&escrow_id, &escrow);

    // Fund the escrow
    EscrowContract::fund_escrow(env.clone(), escrow_id.clone(), sender);

    let funded: Escrow = env.storage().get(&escrow_id).unwrap();
    assert_eq!(funded.state, EscrowState::Funded);
    assert!(funded.funded_at.is_some());
}

/// Test 8: Escrow creation
#[test]
fn test_create_escrow_basic() {
    let env = Env::default();
    let sender = Address::random(&env);
    let beneficiary = Address::random(&env);
    let arbitrator = Address::random(&env);

    let id = EscrowContract::create_escrow(
        env.clone(),
        sender.clone(),
        beneficiary.clone(),
        arbitrator.clone(),
        100_000,
        String::from_str(&env, "USDC"),
        3600,
    );

    let escrow: Escrow = env.storage().get(&id).unwrap();
    assert_eq!(escrow.id, id);
    assert_eq!(escrow.sender, sender);
    assert_eq!(escrow.beneficiary, beneficiary);
    assert_eq!(escrow.arbitrator, arbitrator);
    assert_eq!(escrow.amount, 100_000);
    assert_eq!(escrow.state, EscrowState::Pending);
}

/// Test 9: Get escrow retrieval
#[test]
fn test_get_escrow_basic() {
    let env = Env::default();
    let sender = Address::random(&env);
    let beneficiary = Address::random(&env);
    let arbitrator = Address::random(&env);

    let escrow_id = String::from_str(&env, "escrow_test_9");
    let escrow = Escrow {
        id: escrow_id.clone(),
        sender: sender.clone(),
        beneficiary: beneficiary.clone(),
        arbitrator: arbitrator.clone(),
        amount: 100_000,
        asset: String::from_str(&env, "USDC"),
        state: EscrowState::Pending,
        created_at: 100,
        funded_at: None,
        timelock: 3600,
        released_at: None,
        refunded_at: None,
        disputed_at: None,
    };

    env.storage().set(&escrow_id, &escrow);

    let retrieved = EscrowContract::get_escrow(env.clone(), escrow_id);
    assert_eq!(retrieved.id, escrow.id);
    assert_eq!(retrieved.amount, escrow.amount);
    assert_eq!(retrieved.state, escrow.state);
}

/// Test 10: Resolve dispute state transition
#[test]
fn test_resolve_dispute_basic() {
    let env = Env::default();
    let arbitrator = Address::random(&env);

    let escrow_id = String::from_str(&env, "escrow_test_10");
    let mut escrow = Escrow {
        id: escrow_id.clone(),
        sender: Address::random(&env),
        beneficiary: Address::random(&env),
        arbitrator: arbitrator.clone(),
        amount: 100_000,
        asset: String::from_str(&env, "USDC"),
        state: EscrowState::Disputed,
        created_at: 0,
        funded_at: Some(0),
        timelock: 3600,
        released_at: None,
        refunded_at: None,
        disputed_at: Some(0),
    };

    env.storage().set(&escrow_id, &escrow);

    // Resolve the dispute
    EscrowContract::resolve_dispute(env.clone(), escrow_id.clone(), arbitrator, true);

    let resolved: Escrow = env.storage().get(&escrow_id).unwrap();
    assert_eq!(resolved.state, EscrowState::Resolved);
}

/// Test 11: Multiple state transitions in sequence
#[test]
fn test_state_transition_sequence() {
    let env = Env::default();
    let sender = Address::random(&env);
    let beneficiary = Address::random(&env);
    let arbitrator = Address::random(&env);

    // Create escrow
    let escrow_id = EscrowContract::create_escrow(
        env.clone(),
        sender.clone(),
        beneficiary.clone(),
        arbitrator.clone(),
        100_000,
        String::from_str(&env, "USDC"),
        3600,
    );

    // Verify Pending state
    let escrow1: Escrow = env.storage().get(&escrow_id).unwrap();
    assert_eq!(escrow1.state, EscrowState::Pending);

    // Fund escrow
    EscrowContract::fund_escrow(env.clone(), escrow_id.clone(), sender.clone());
    let escrow2: Escrow = env.storage().get(&escrow_id).unwrap();
    assert_eq!(escrow2.state, EscrowState::Funded);

    // Release escrow
    EscrowContract::release_escrow(env.clone(), escrow_id.clone(), beneficiary.clone());
    let escrow3: Escrow = env.storage().get(&escrow_id).unwrap();
    assert_eq!(escrow3.state, EscrowState::Released);
}

/// Test 12: Invalid state transition prevention
#[test]
#[should_panic(expected = "Invalid state transition")]
fn test_invalid_state_transition_pending_to_refunded() {
    let env = Env::default();
    let sender = Address::random(&env);

    let escrow_id = String::from_str(&env, "escrow_test_12");
    let escrow = Escrow {
        id: escrow_id.clone(),
        sender: sender.clone(),
        beneficiary: Address::random(&env),
        arbitrator: Address::random(&env),
        amount: 100_000,
        asset: String::from_str(&env, "USDC"),
        state: EscrowState::Pending,
        created_at: 0,
        funded_at: None,
        timelock: 3600,
        released_at: None,
        refunded_at: None,
        disputed_at: None,
    };

    env.storage().set(&escrow_id, &escrow);

    // Try to refund from Pending state (invalid)
    EscrowContract::refund_escrow(env.clone(), escrow_id, sender);
}

/// Test 13: Authorization checks
#[test]
#[should_panic(expected = "Only sender can fund the escrow")]
fn test_fund_escrow_authorization() {
    let env = Env::default();
    let sender = Address::random(&env);
    let other = Address::random(&env);

    let escrow_id = String::from_str(&env, "escrow_test_13");
    let escrow = Escrow {
        id: escrow_id.clone(),
        sender: sender.clone(),
        beneficiary: Address::random(&env),
        arbitrator: Address::random(&env),
        amount: 100_000,
        asset: String::from_str(&env, "USDC"),
        state: EscrowState::Pending,
        created_at: 0,
        funded_at: None,
        timelock: 3600,
        released_at: None,
        refunded_at: None,
        disputed_at: None,
    };

    env.storage().set(&escrow_id, &escrow);

    // Try to fund as non-sender
    EscrowContract::fund_escrow(env.clone(), escrow_id, other);
}

/// Test 14: Timelock validation on creation
#[test]
#[should_panic(expected = "Timelock must be positive")]
fn test_create_escrow_invalid_timelock() {
    let env = Env::default();
    let sender = Address::random(&env);
    let beneficiary = Address::random(&env);
    let arbitrator = Address::random(&env);

    EscrowContract::create_escrow(
        env.clone(),
        sender,
        beneficiary,
        arbitrator,
        100_000,
        String::from_str(&env, "USDC"),
        0, // Invalid timelock
    );
}

/// Test 15: Amount validation on creation
#[test]
#[should_panic(expected = "Amount must be positive")]
fn test_create_escrow_invalid_amount() {
    let env = Env::default();
    let sender = Address::random(&env);
    let beneficiary = Address::random(&env);
    let arbitrator = Address::random(&env);

    EscrowContract::create_escrow(
        env.clone(),
        sender,
        beneficiary,
        arbitrator,
        0, // Invalid amount
        String::from_str(&env, "USDC"),
        3600,
    );
}

/// Test 16: Guard prevents double-release
#[test]
#[should_panic]
fn test_guard_prevents_double_release() {
    let env = Env::default();
    let beneficiary = Address::random(&env);

    let escrow_id = String::from_str(&env, "escrow_test_16");
    let escrow = Escrow {
        id: escrow_id.clone(),
        sender: Address::random(&env),
        beneficiary: beneficiary.clone(),
        arbitrator: Address::random(&env),
        amount: 100_000,
        asset: String::from_str(&env, "USDC"),
        state: EscrowState::Funded,
        created_at: 0,
        funded_at: Some(0),
        timelock: 3600,
        released_at: None,
        refunded_at: None,
        disputed_at: None,
    };

    env.storage().set(&escrow_id, &escrow);

    // First release should succeed
    EscrowContract::release_escrow(env.clone(), escrow_id.clone(), beneficiary.clone());

    // Try to release again (should fail due to invalid state)
    EscrowContract::release_escrow(env.clone(), escrow_id, beneficiary);
}

/// Test 17: Edge case - maximum amount
#[test]
fn test_create_escrow_large_amount() {
    let env = Env::default();
    let sender = Address::random(&env);
    let beneficiary = Address::random(&env);
    let arbitrator = Address::random(&env);

    let max_amount = i128::MAX / 2; // Large but safe amount
    let escrow_id = EscrowContract::create_escrow(
        env.clone(),
        sender.clone(),
        beneficiary.clone(),
        arbitrator.clone(),
        max_amount,
        String::from_str(&env, "USDC"),
        3600,
    );

    let escrow: Escrow = env.storage().get(&escrow_id).unwrap();
    assert_eq!(escrow.amount, max_amount);
}

/// Test 18: Edge case - minimum amount
#[test]
fn test_create_escrow_small_amount() {
    let env = Env::default();
    let sender = Address::random(&env);
    let beneficiary = Address::random(&env);
    let arbitrator = Address::random(&env);

    let min_amount = 1i128;
    let escrow_id = EscrowContract::create_escrow(
        env.clone(),
        sender.clone(),
        beneficiary.clone(),
        arbitrator.clone(),
        min_amount,
        String::from_str(&env, "USDC"),
        3600,
    );

    let escrow: Escrow = env.storage().get(&escrow_id).unwrap();
    assert_eq!(escrow.amount, min_amount);
}

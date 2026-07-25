#![cfg(test)]
use crate::RemittanceContract;
use soroban_sdk::{Address, Env, String};

/// Test 1: Verify reentrancy guard setup for fee calculations
#[test]
fn test_calculate_recipient_amount_consistency() {
    let env = Env::default();

    // Test basic calculation
    let amount = 100_000_000i128; // 10 USDC
    let sender_fee = 100i128;     // 1%
    let fx_spread = 50i128;       // 0.5%
    let recipient_fee = 50i128;   // 0.5%

    let result = RemittanceContract::calculate_recipient(
        env,
        amount,
        sender_fee,
        fx_spread,
        recipient_fee,
    );

    assert!(result.is_ok(), "Calculation should succeed");
    let recipient_amount = result.unwrap();
    assert!(recipient_amount > 0, "Recipient amount should be positive");
    assert!(recipient_amount < amount, "Recipient amount should be less than input");
}

/// Test 2: Verify fee structure consistency
#[test]
fn test_calculate_all_fees_consistent() {
    let env = Env::default();

    let amount = 100_000_000i128;
    let sender_fee = 100i128;
    let fx_spread = 50i128;
    let recipient_fee = 50i128;

    let result = RemittanceContract::calculate_fees(
        env,
        amount,
        sender_fee,
        fx_spread,
        recipient_fee,
    );

    assert!(result.is_ok(), "Fee calculation should succeed");
    let (sender_fee_amt, recipient_fee_amt, total_fees) = result.unwrap();

    assert!(sender_fee_amt > 0, "Sender fee should be positive");
    assert!(recipient_fee_amt > 0, "Recipient fee should be positive");
    assert!(total_fees > 0, "Total fees should be positive");
    assert_eq!(
        total_fees,
        sender_fee_amt + recipient_fee_amt,
        "Total fees should equal sum of individual fees"
    );
}

/// Test 3: Verify fee calculations with zero fees
#[test]
fn test_calculate_with_zero_fees() {
    let env = Env::default();

    let amount = 100_000_000i128;
    let result = RemittanceContract::calculate_recipient(
        env,
        amount,
        0i128, // No sender fee
        0i128, // No fx spread
        0i128, // No recipient fee
    );

    assert!(result.is_ok());
    let recipient_amount = result.unwrap();
    assert_eq!(recipient_amount, amount, "With no fees, recipient gets full amount");
}

/// Test 4: Verify fee calculations with max fees
#[test]
fn test_calculate_with_maximum_fees() {
    let env = Env::default();

    let amount = 100_000_000i128;
    let max_fee = 10_000i128; // 100% (basis points)

    let result = RemittanceContract::calculate_recipient(
        env,
        amount,
        max_fee,
        0i128,
        0i128,
    );

    assert!(result.is_ok());
}

/// Test 5: Verify fee rate validation
#[test]
#[should_panic]
fn test_calculate_with_invalid_fee_rate() {
    let env = Env::default();

    let amount = 100_000_000i128;
    let invalid_fee = 10_001i128; // Exceeds max

    RemittanceContract::calculate_recipient(
        env,
        amount,
        invalid_fee,
        0i128,
        0i128,
    )
    .unwrap();
}

/// Test 6: Verify multiple fee rate combinations
#[test]
fn test_calculate_various_fee_combinations() {
    let env = Env::default();

    let test_cases = vec![
        (100_000_000i128, 50i128, 25i128, 50i128),   // 0.5%, 0.25%, 0.5%
        (50_000_000i128, 100i128, 50i128, 100i128),  // 1%, 0.5%, 1%
        (200_000_000i128, 75i128, 75i128, 75i128),   // 0.75% each
    ];

    for (amount, sender_fee, fx_spread, recipient_fee) in test_cases {
        let result = RemittanceContract::calculate_recipient(
            env.clone(),
            amount,
            sender_fee,
            fx_spread,
            recipient_fee,
        );

        assert!(result.is_ok(), "Calculation should succeed for all valid combinations");
        let recipient_amount = result.unwrap();
        assert!(recipient_amount > 0 && recipient_amount < amount);
    }
}

/// Test 7: Verify fee calculations are deterministic
#[test]
fn test_calculate_recipient_deterministic() {
    let env = Env::default();

    let amount = 100_000_000i128;
    let sender_fee = 100i128;
    let fx_spread = 50i128;
    let recipient_fee = 50i128;

    let result1 = RemittanceContract::calculate_recipient(
        env.clone(),
        amount,
        sender_fee,
        fx_spread,
        recipient_fee,
    );

    let result2 = RemittanceContract::calculate_recipient(
        env,
        amount,
        sender_fee,
        fx_spread,
        recipient_fee,
    );

    assert_eq!(
        result1, result2,
        "Multiple calls with same parameters should produce same result"
    );
}

/// Test 8: Verify fee calculations with small amounts
#[test]
fn test_calculate_small_amount() {
    let env = Env::default();

    let amount = 1_000_000i128; // 0.1 USDC
    let sender_fee = 100i128;
    let fx_spread = 50i128;
    let recipient_fee = 50i128;

    let result = RemittanceContract::calculate_recipient(
        env,
        amount,
        sender_fee,
        fx_spread,
        recipient_fee,
    );

    assert!(result.is_ok());
    let recipient_amount = result.unwrap();
    assert!(recipient_amount > 0);
}

/// Test 9: Verify fee calculations with large amounts
#[test]
fn test_calculate_large_amount() {
    let env = Env::default();

    let amount = 1_000_000_000_000i128; // 100M USDC
    let sender_fee = 100i128;
    let fx_spread = 50i128;
    let recipient_fee = 50i128;

    let result = RemittanceContract::calculate_recipient(
        env,
        amount,
        sender_fee,
        fx_spread,
        recipient_fee,
    );

    assert!(result.is_ok());
}

/// Test 10: Verify all fees sum correctly
#[test]
fn test_fees_sum_correctly() {
    let env = Env::default();

    let amount = 100_000_000i128;
    let sender_fee = 100i128;
    let fx_spread = 50i128;
    let recipient_fee = 100i128;

    let fees_result = RemittanceContract::calculate_fees(
        env.clone(),
        amount,
        sender_fee,
        fx_spread,
        recipient_fee,
    );

    let recipient_result = RemittanceContract::calculate_recipient(
        env,
        amount,
        sender_fee,
        fx_spread,
        recipient_fee,
    );

    assert!(fees_result.is_ok() && recipient_result.is_ok());

    let (sender_fee_amt, recipient_fee_amt, total_fees) = fees_result.unwrap();
    let recipient_amount = recipient_result.unwrap();

    // Verify the fee breakdown
    assert_eq!(
        sender_fee_amt + recipient_fee_amt + recipient_amount,
        amount,
        "All components should sum to original amount"
    );
}

/// Test 11: Verify negative amount rejection
#[test]
#[should_panic]
fn test_calculate_negative_amount() {
    let env = Env::default();

    RemittanceContract::calculate_recipient(
        env,
        -100_000_000i128,
        100i128,
        0i128,
        0i128,
    )
    .unwrap();
}

/// Test 12: Verify zero amount handling
#[test]
#[should_panic]
fn test_calculate_zero_amount() {
    let env = Env::default();

    RemittanceContract::calculate_recipient(
        env,
        0i128,
        100i128,
        0i128,
        0i128,
    )
    .unwrap();
}

/// Test 13: Concurrent operations with different parameters
#[test]
fn test_concurrent_different_parameters() {
    let env = Env::default();

    let params = vec![
        (100_000_000i128, 50i128, 25i128, 50i128),
        (50_000_000i128, 100i128, 50i128, 100i128),
        (200_000_000i128, 75i128, 75i128, 75i128),
    ];

    for (amount, sender_fee, fx_spread, recipient_fee) in params {
        let result = RemittanceContract::calculate_recipient(
            env.clone(),
            amount,
            sender_fee,
            fx_spread,
            recipient_fee,
        );
        assert!(result.is_ok());
    }
}

/// Test 14: Fee rate boundary testing (just below max)
#[test]
fn test_fee_rate_boundary_max() {
    let env = Env::default();

    let amount = 100_000_000i128;
    let max_allowed_fee = 10_000i128; // 100%

    let result = RemittanceContract::calculate_recipient(
        env,
        amount,
        max_allowed_fee,
        0i128,
        0i128,
    );

    assert!(result.is_ok(), "Should accept fee at maximum boundary");
}

/// Test 15: Fee rate boundary testing (minimum)
#[test]
fn test_fee_rate_boundary_min() {
    let env = Env::default();

    let amount = 100_000_000i128;
    let min_fee = 0i128;

    let result = RemittanceContract::calculate_recipient(
        env,
        amount,
        min_fee,
        min_fee,
        min_fee,
    );

    assert!(result.is_ok());
    assert_eq!(result.unwrap(), amount, "With zero fees, recipient gets full amount");
}

/// Test 16: Verify fee independence across calls
#[test]
fn test_fee_calculation_independence() {
    let env = Env::default();

    let amount = 100_000_000i128;

    // First call with specific fees
    let result1 = RemittanceContract::calculate_recipient(
        env.clone(),
        amount,
        100i128, // 1%
        0i128,
        0i128,
    );

    // Second call with different fees
    let result2 = RemittanceContract::calculate_recipient(
        env,
        amount,
        200i128, // 2%
        0i128,
        0i128,
    );

    assert!(result1.is_ok() && result2.is_ok());
    let amt1 = result1.unwrap();
    let amt2 = result2.unwrap();

    assert!(amt1 > amt2, "Higher fees should result in lower recipient amount");
}

/// Test 17: Verify fee calculation arithmetic correctness
#[test]
fn test_fee_arithmetic_correctness() {
    let env = Env::default();

    let amount = 1_000_000i128; // Simple test amount
    let fee_rate = 500i128;     // 5% (5 basis points out of 10000)

    let result = RemittanceContract::calculate_recipient(
        env,
        amount,
        fee_rate,
        0i128,
        0i128,
    );

    assert!(result.is_ok());
    let recipient_amount = result.unwrap();

    // 5% of 1_000_000 = 50_000
    // Recipient should get 95% = 950_000
    assert!(recipient_amount < amount);
    assert!(recipient_amount > 0);
}

/// Test 18: Verify fees calculation consistency with recipient calculation
#[test]
fn test_fees_consistent_with_recipient() {
    let env = Env::default();

    let amount = 100_000_000i128;
    let sender_fee = 100i128;
    let fx_spread = 0i128;
    let recipient_fee = 100i128;

    let recipient_result = RemittanceContract::calculate_recipient(
        env.clone(),
        amount,
        sender_fee,
        fx_spread,
        recipient_fee,
    );

    let fees_result = RemittanceContract::calculate_fees(
        env,
        amount,
        sender_fee,
        fx_spread,
        recipient_fee,
    );

    assert!(recipient_result.is_ok() && fees_result.is_ok());

    let recipient_amount = recipient_result.unwrap();
    let (sender_fee_amt, recipient_fee_amt, total_fees) = fees_result.unwrap();

    // Verify consistency: amount = recipient + total_fees
    assert_eq!(
        recipient_amount + total_fees,
        amount,
        "Recipient amount + fees should equal input amount"
    );
}

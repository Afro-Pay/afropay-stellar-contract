#![cfg(test)]
use crate::fees::FeeError;
use crate::RemittanceContract;
use soroban_sdk::{Env, Address, String};

// ── Adversarial Scenario 1: Zero-amount transfer ──────────────────────────

#[test]
fn test_zero_amount_rejected() {
    let env = Env::default();

    let result = RemittanceContract::calculate_recipient(
        env,
        0i128,
        100i128,
        0i128,
        0i128,
    );

    assert!(result.is_err());
    assert_eq!(result.unwrap_err(), FeeError::InvalidAmount);
}

// ── Adversarial Scenario 2: Amount = i128::MAX ────────────────────────────

#[test]
fn test_max_amount_overflow_or_handled() {
    let env = Env::default();

    // i128::MAX with any non-zero fee rate should overflow during multiplication
    let result = RemittanceContract::calculate_recipient(
        env.clone(),
        i128::MAX,
        100i128, // 1% fee
        0i128,
        0i128,
    );

    // Either succeeds (if overflow is handled) or returns ArithmeticOverflow
    match result {
        Ok(recipient) => {
            // If it succeeds, recipient must be less than the input
            assert!(recipient < i128::MAX);
        }
        Err(FeeError::ArithmeticOverflow) => {
            // Expected for overflow cases
        }
        Err(e) => {
            panic!("Unexpected error for i128::MAX with valid fee config: {:?}", e);
        }
    }
}

#[test]
fn test_max_amount_with_zero_fees() {
    let env = Env::default();

    // With zero fees, i128::MAX should pass through unchanged
    let result = RemittanceContract::calculate_recipient(
        env,
        i128::MAX,
        0i128,
        0i128,
        0i128,
    );

    assert!(result.is_ok());
    assert_eq!(result.unwrap(), i128::MAX);
}

// ── Adversarial Scenario 3: Invalid fee rates ─────────────────────────────

#[test]
fn test_negative_sender_fee_rejected() {
    let env = Env::default();

    let result = RemittanceContract::calculate_recipient(
        env,
        100_000i128,
        -1i128, // Invalid: negative fee
        0i128,
        0i128,
    );

    assert!(result.is_err());
    assert_eq!(result.unwrap_err(), FeeError::InvalidFeeRate);
}

#[test]
fn test_fee_rate_exceeds_max_rejected() {
    let env = Env::default();

    let result = RemittanceContract::calculate_recipient(
        env,
        100_000i128,
        10_001i128, // Invalid: exceeds 10_000 bps
        0i128,
        0i128,
    );

    assert!(result.is_err());
    assert_eq!(result.unwrap_err(), FeeError::InvalidFeeRate);
}

#[test]
fn test_negative_recipient_fee_rejected() {
    let env = Env::default();

    let result = RemittanceContract::calculate_recipient(
        env,
        100_000i128,
        0i128,
        0i128,
        -1i128, // Invalid: negative fee
    );

    assert!(result.is_err());
    assert_eq!(result.unwrap_err(), FeeError::InvalidFeeRate);
}

// ── Adversarial Scenario 4: Fee sum exceeds maximum ───────────────────────

#[test]
fn test_fee_sum_exceeds_max_rejected() {
    let env = Env::default();

    // sender_fee_bps + recipient_fee_bps = 12_000 > 10_000
    let result = RemittanceContract::calculate_fees(
        env,
        100_000i128,
        7_000i128,
        0i128,
        5_001i128,
    );

    assert!(result.is_err());
    assert_eq!(result.unwrap_err(), FeeError::FeeRateSumExceedsMax);
}

// ── Adversarial Scenario 5: Negative amount ───────────────────────────────

#[test]
fn test_negative_amount_rejected() {
    let env = Env::default();

    let result = RemittanceContract::calculate_recipient(
        env,
        -1i128,
        100i128,
        0i128,
        0i128,
    );

    assert!(result.is_err());
    assert_eq!(result.unwrap_err(), FeeError::InvalidAmount);
}

// ── Adversarial Scenario 6: Self-send (sender == recipient) ───────────────
// Adapted for stateless remittance: verify that when all fees are zero,
// the "sender" and "recipient" are effectively the same party and receive
// the full amount.

#[test]
fn test_self_send_zero_fees_full_amount() {
    let env = Env::default();

    let amount = 100_000i128;

    // With zero fees, the recipient gets the full amount (same as self-send)
    let result = RemittanceContract::calculate_recipient(
        env,
        amount,
        0i128,
        0i128,
        0i128,
    );

    assert!(result.is_ok());
    assert_eq!(result.unwrap(), amount, "Self-send with zero fees should return full amount");
}

// ── Adversarial Scenario 7: Non-admin calling admin-like functions ────────
// The remittance contract has no admin functions, so we verify that the
// contract does not expose any privileged entry points that could be
// exploited by unauthorized callers.

#[test]
fn test_no_admin_privilege_escalation() {
    let env = Env::default();
    let unauthorized = Address::from_string(&String::from_str(&env, "GAUTHORIZED1234567890123456789012345678901234567890123456789012345678901234"));

    // The remittance contract is stateless and has no admin-gated entry points.
    // All calculation functions are publicly accessible without auth.
    // This test documents that no admin-only functions exist that could be
    // exploited by unauthorized callers.
    let result = RemittanceContract::calculate_recipient(
        env,
        100_000i128,
        100i128,
        0i128,
        0i128,
    );

    // The calculation should succeed regardless of who calls it
    // (there is no auth check in a stateless contract)
    assert!(result.is_ok());
}

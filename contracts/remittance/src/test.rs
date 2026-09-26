#![cfg(test)]
use super::*;
use soroban_sdk::{Env, Address, String};
use proptest::prelude::*;
use crate::proptests::{valid_amount, valid_fee_config};
use crate::fees::{FeeConfig, FeeError, calculate_all_fees};

// ── Property 1: Fee calculation is always ≤ amount ────────────────────────

proptest! {
    #[test]
    fn property_fee_always_less_than_or_equal_to_amount(
        amount in valid_amount(),
        config in valid_fee_config(),
    ) {
        let env = Env::default();

        let recipient = RemittanceContract::calculate_recipient(
            env,
            amount,
            config.sender_fee_bps,
            config.fx_spread_bps,
            config.recipient_fee_bps,
        );

        // Recipient amount must never exceed the input amount
        assert!(
            recipient.is_ok(),
            "Valid config and positive amount should always succeed"
        );
        let recipient_amount = recipient.unwrap();
        prop_assert!(recipient_amount <= amount, "Recipient amount {} must be ≤ input amount {}", recipient_amount, amount);
    }

    // ── Property 2: Beneficiary always receives non-negative amount ─────────

    #[test]
    fn property_recipient_amount_is_non_negative(
        amount in valid_amount(),
        config in valid_fee_config(),
    ) {
        let env = Env::default();

        let recipient = RemittanceContract::calculate_recipient(
            env,
            amount,
            config.sender_fee_bps,
            config.fx_spread_bps,
            config.recipient_fee_bps,
        );

        assert!(recipient.is_ok(), "Valid config should not error");
        let recipient_amount = recipient.unwrap();
        prop_assert!(recipient_amount >= 0, "Recipient amount {} must be non-negative", recipient_amount);
    }

    // ── Property 3: Total fees + recipient amount = input amount (no fx spread)
    //    This is the "multi-hop routing total never exceeds input" invariant,
    //    adapted for the stateless remittance contract. ──────────────────────

    #[test]
    fn property_total_fees_plus_recipient_equals_input(
        amount in valid_amount(),
        config in valid_fee_config(),
    ) {
        let env = Env::default();

        // With zero FX spread, the invariant is: sender_fee + recipient_fee + recipient_amount = amount
        let fees_result = RemittanceContract::calculate_fees(
            env.clone(),
            amount,
            config.sender_fee_bps,
            0i128, // zero FX spread for clean invariant
            config.recipient_fee_bps,
        );

        let recipient_result = RemittanceContract::calculate_recipient(
            env,
            amount,
            config.sender_fee_bps,
            0i128,
            config.recipient_fee_bps,
        );

        prop_assert!(fees_result.is_ok(), "Fee calculation should succeed");
        prop_assert!(recipient_result.is_ok(), "Recipient calculation should succeed");

        let (sender_fee, recipient_fee, total_fees) = fees_result.unwrap();
        let recipient_amount = recipient_result.unwrap();

        prop_assert_eq!(
            sender_fee + recipient_fee + recipient_amount,
            amount,
            "sender_fee({}) + recipient_fee({}) + recipient_amount({}) should equal amount({})",
            sender_fee, recipient_fee, recipient_amount, amount
        );
        prop_assert_eq!(total_fees, sender_fee + recipient_fee, "total_fees should equal sender_fee + recipient_fee");
    }

    // ── Property 4: Zero fees → recipient gets full amount ─────────────────

    #[test]
    fn property_zero_fees_full_transfer(
        amount in valid_amount(),
    ) {
        let env = Env::default();

        let recipient = RemittanceContract::calculate_recipient(
            env,
            amount,
            0i128,
            0i128,
            0i128,
        );

        prop_assert!(recipient.is_ok(), "Zero fees should always succeed");
        prop_assert_eq!(recipient.unwrap(), amount, "With zero fees, recipient gets full amount");
    }

    // ── Property 5: Higher fees → lower recipient amount ───────────────────

    #[test]
    fn property_higher_fees_lower_recipient(
        amount in valid_amount(),
    ) {
        let env = Env::default();

        let low_fee = RemittanceContract::calculate_recipient(
            env.clone(),
            amount,
            10i128,  // 0.1%
            0i128,
            0i128,
        );

        let high_fee = RemittanceContract::calculate_recipient(
            env,
            amount,
            500i128, // 5%
            0i128,
            0i128,
        );

        prop_assert!(low_fee.is_ok() && high_fee.is_ok(), "Both calculations should succeed");
        prop_assert!(
            high_fee.unwrap() <= low_fee.unwrap(),
            "Higher fees should result in lower or equal recipient amount"
        );
    }

    // ── Property 6: All fees at maximum (100%) → recipient gets zero ───────

    #[test]
    fn property_max_fees_zero_recipient(
        amount in valid_amount(),
    ) {
        let env = Env::default();

        // sender_fee_bps = 10_000 (100%), fx_spread = 0, recipient_fee_bps = 0
        let recipient = RemittanceContract::calculate_recipient(
            env,
            amount,
            10_000i128,
            0i128,
            0i128,
        );

        // With 100% sender fee, recipient gets 0
        prop_assert!(recipient.is_ok(), "100% sender fee should be valid");
        prop_assert_eq!(recipient.unwrap(), 0, "With 100% sender fee, recipient gets zero");
    }

    // ── Property 7: Boundary amount = 1 ────────────────────────────────────

    #[test]
    fn property_minimum_amount_one(
        config in valid_fee_config(),
    ) {
        let env = Env::default();

        let recipient = RemittanceContract::calculate_recipient(
            env,
            1i128,
            config.sender_fee_bps,
            config.fx_spread_bps,
            config.recipient_fee_bps,
        );

        prop_assert!(recipient.is_ok() || recipient.unwrap_err() == FeeError::Underflow,
            "Minimum amount should either succeed or underflow (not panic)");
    }

    // ── Property 8: Determinism — same inputs always produce same outputs ──

    #[test]
    fn property_fee_calculation_deterministic(
        amount in valid_amount(),
        config in valid_fee_config(),
    ) {
        let env = Env::default();

        let result1 = RemittanceContract::calculate_recipient(
            env.clone(),
            amount,
            config.sender_fee_bps,
            config.fx_spread_bps,
            config.recipient_fee_bps,
        );

        let result2 = RemittanceContract::calculate_recipient(
            env,
            amount,
            config.sender_fee_bps,
            config.fx_spread_bps,
            config.recipient_fee_bps,
        );

        prop_assert_eq!(result1, result2, "Same inputs must produce same outputs");
    }
}

// ── Property 9: Invalid fee rate always rejected ───────────────────────────

proptest! {
    #[test]
    fn property_invalid_fee_rate_always_rejected(
        amount in valid_amount(),
        invalid_bps in invalid_fee_bps(),
    ) {
        let env = Env::default();

        let result = RemittanceContract::calculate_recipient(
            env,
            amount,
            invalid_bps,
            0i128,
            0i128,
        );

        prop_assert!(result.is_err(), "Invalid fee rate {} should be rejected", invalid_bps);
        prop_assert_eq!(result.unwrap_err(), FeeError::InvalidFeeRate);
    }
}

// ── Property 10: Fee sum exceeding max always rejected ─────────────────────

proptest! {
    #[test]
    fn property_fee_sum_exceeds_max_always_rejected(
        amount in valid_amount(),
        (sender_fee_bps, _fx_spread_bps, recipient_fee_bps) in invalid_fee_config_sum(),
    ) {
        let env = Env::default();

        let result = RemittanceContract::calculate_fees(
            env,
            amount,
            sender_fee_bps,
            0i128,
            recipient_fee_bps,
        );

        prop_assert!(result.is_err(), "Fee sum exceeding max should be rejected");
        prop_assert_eq!(result.unwrap_err(), FeeError::FeeRateSumExceedsMax);
    }
}

// ── Property 11: Negative amount always rejected ───────────────────────────

proptest! {
    #[test]
    fn property_negative_amount_always_rejected(
        config in valid_fee_config(),
    ) {
        let env = Env::default();

        let result = RemittanceContract::calculate_recipient(
            env,
            -1i128,
            config.sender_fee_bps,
            config.fx_spread_bps,
            config.recipient_fee_bps,
        );

        prop_assert!(result.is_err(), "Negative amount should be rejected");
        prop_assert_eq!(result.unwrap_err(), FeeError::InvalidAmount);
    }
}

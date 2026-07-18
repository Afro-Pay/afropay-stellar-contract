#![no_main]
use libfuzzer_sys::fuzz_target;
use remittance::RemittanceContract;
use soroban_sdk::{Env, Address, String};

fuzz_target!(|data: (i128, i128, i128, i128)| {
    let (amount, sender_fee_bps, fx_spread_bps, recipient_fee_bps) = data;

    // Sanitize inputs to avoid trivial failures
    let amount = amount.abs(); // Non-negative amounts only
    let sender_fee_bps = sender_fee_bps.abs() % 10_001; // 0 to 10_000
    let fx_spread_bps = fx_spread_bps.abs() % 10_001; // 0 to 10_000
    let recipient_fee_bps = recipient_fee_bps.abs() % 10_001; // 0 to 10_000

    let env = Env::default();

    // Try to calculate recipient amount
    let result = RemittanceContract::calculate_recipient(
        env.clone(),
        amount,
        sender_fee_bps,
        fx_spread_bps,
        recipient_fee_bps,
    );

    // Verify the result is either a valid amount or an expected error
    match result {
        Ok(recipient_amount) => {
            // The recipient amount should be non-negative
            assert!(recipient_amount >= 0);
            // The recipient amount should not exceed the original amount
            assert!(recipient_amount <= amount);
        }
        Err(e) => {
            // Expected errors are: InvalidFeeRate, ArithmeticOverflow, Underflow
            // All are valid outcomes
        }
    }

    // Also test fee calculation
    let fees_result = RemittanceContract::calculate_fees(
        env,
        amount,
        sender_fee_bps,
        fx_spread_bps,
        recipient_fee_bps,
    );

    match fees_result {
        Ok((sender_fee, recipient_fee, total_fees)) => {
            assert!(sender_fee >= 0);
            assert!(recipient_fee >= 0);
            assert!(total_fees >= 0);
            assert!(sender_fee + recipient_fee == total_fees);
            assert!(total_fees <= amount);
        }
        Err(e) => {
            // Expected errors are valid
        }
    }
});

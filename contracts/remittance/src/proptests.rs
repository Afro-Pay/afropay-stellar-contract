#![cfg(test)]
use crate::fees::FeeConfig;
use proptest::prelude::*;
use proptest_derive::Arbitrary;
use soroban_sdk::{Env, Address, String};

/// Property generator for valid positive amounts.
/// Covers boundary values near zero and large values.
prop_compose! {
    fn valid_amount()(amount in 1i128..100_000_000_000i128) -> i128 {
        amount
    }
}

/// Property generator for boundary amounts including zero, one, and i128::MAX.
prop_compose! {
    fn boundary_amount()(amount in prop::sample::select(vec![
        0i128, 1, -1, i128::MAX, i128::MIN, i128::MAX / 10, i128::MAX / 1000,
    ])) -> i128 {
        amount
    }
}

/// Property generator for fee rates in the valid range 0..=10_000.
prop_compose! {
    fn valid_fee_bps()(bps in 0i128..10_000i128) -> i128 {
        bps
    }
}

/// Property generator for invalid fee rates (out of bounds).
prop_compose! {
    fn invalid_fee_bps()(bps in prop::sample::select(vec![
        -1i128, -100, 10_001, 15_000, i128::MAX,
    ])) -> i128 {
        bps
    }
}

/// Property generator for valid FeeConfig where sender_fee_bps + recipient_fee_bps <= 10_000.
prop_compose! {
    fn valid_fee_config()(
        sender_fee_bps in 0i128..10_000i128,
        fx_spread_bps in 0i128..10_000i128,
        recipient_fee_bps in 0i128..10_000i128,
    ) -> FeeConfig {
        let max_recipient = 10_000 - sender_fee_bps;
        let recipient_fee_bps = recipient_fee_bps.min(max_recipient);
        FeeConfig::new(sender_fee_bps, fx_spread_bps, recipient_fee_bps).unwrap()
    }
}

/// Property generator for FeeConfig with an invalid sum (sender + recipient > 10_000).
prop_compose! {
    fn invalid_fee_config_sum()(
        sender_fee_bps in 5_001i128..10_000i128,
        fx_spread_bps in 0i128..10_000i128,
        recipient_fee_bps in 5_001i128..10_000i128,
    ) -> (i128, i128, i128) {
        (sender_fee_bps, fx_spread_bps, recipient_fee_bps)
    }
}

/// Property generator for a pair of distinct addresses.
prop_compose! {
    fn distinct_addresses()(
        seed_a in 1u64..1_000_000u64,
        seed_b in 1u64..1_000_000u64,
    ) -> (Address, Address) {
        let env = Env::default();
        let addr_a = Address::from_string(&String::from_str(&env, &format!("G{}", seed_a)));
        let addr_b = Address::from_string(&String::from_str(&env, &format!("G{}", seed_b)));
        (addr_a, addr_b)
    }
}

/// Property generator for timelock values (positive u64).
prop_compose! {
    fn valid_timelock()(timelock in 1u64..1_000_000u64) -> u64 {
        timelock
    }
}

/// Property generator for expired timelock (current_time > created_at + timelock).
prop_compose! {
    fn expired_timelock()(
        created_at in 0u64..1_000_000u64,
        timelock in 1u64..1_000_000u64,
        offset in 1u64..1_000_000u64,
    ) -> (u64, u64, u64) {
        let current_time = created_at + timelock + offset;
        (created_at, timelock, current_time)
    }
}

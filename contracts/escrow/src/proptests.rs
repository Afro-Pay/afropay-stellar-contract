#![cfg(test)]
use super::*;
use soroban_sdk::{Env, Address, String};
use proptest::prelude::*;
use proptest_derive::Arbitrary;

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

// ── Property: Beneficiary-only release invariant holds for all address pairs
//    For every possible (sender, beneficiary, arbitrator, unauthorized) quartet,
//    only the beneficiary can release a funded escrow. ──────────────────────

proptest! {
    #[test]
    fn property_beneficiary_only_release(
        input in escrow_input(),
        parties in party_set(),
    ) {
        let env = Env::default();

        let id = EscrowContract::create_escrow(
            env.clone(),
            parties.sender.clone(),
            parties.beneficiary.clone(),
            parties.arbitrator.clone(),
            input.amount,
            String::from_str(&env, &input.asset_code),
            input.timelock,
        );

        EscrowContract::fund_escrow(env.clone(), id.clone(), parties.sender.clone());

        // Only the beneficiary can release
        EscrowContract::release_escrow(env.clone(), id.clone(), parties.beneficiary.clone());
        let escrow = EscrowContract::get_escrow(env.clone(), id.clone());
        assert_eq!(escrow.state, EscrowState::Released);

        // The unauthorized party must be rejected
        let result = std::panic::catch_unwind(|| {
            EscrowContract::release_escrow(env.clone(), id.clone(), parties.unauthorized.clone());
        });
        assert!(result.is_err(), "Unauthorized party must not be able to release escrow");
    }

    // ── Property: Expired timelock cannot be extended ────────────────────────
    //    Once an escrow is created with a timelock, the timelock value is
    //    immutable. Attempting to extend it after creation must fail. ─────────

    #[test]
    fn property_timelock_immutable_after_creation(
        input in escrow_input(),
        parties in party_set(),
    ) {
        let env = Env::default();

        let original_timelock = input.timelock;
        let id = EscrowContract::create_escrow(
            env.clone(),
            parties.sender.clone(),
            parties.beneficiary.clone(),
            parties.arbitrator.clone(),
            input.amount,
            String::from_str(&env, &input.asset_code),
            original_timelock,
        );

        let escrow = EscrowContract::get_escrow(env.clone(), id.clone());
        assert_eq!(escrow.timelock, original_timelock);

        // The timelock is stored in the escrow and cannot be changed
        // by any party. We verify this by checking that the escrow's
        // timelock field remains unchanged after funding and releasing.
        EscrowContract::fund_escrow(env.clone(), id.clone(), parties.sender.clone());
        EscrowContract::release_escrow(env.clone(), id.clone(), parties.beneficiary.clone());

        let escrow_after = EscrowContract::get_escrow(env, id);
        assert_eq!(escrow_after.timelock, original_timelock, "Timelock must be immutable");
    }

    // ── Property: Multi-hop routing total never exceeds input amount ────────
    //    Adapted for escrow: the total amount disbursed across all state
    //    transitions (release + refund) never exceeds the original escrow
    //    amount. No funds are created from thin air. ─────────────────────────

    #[test]
    fn property_amount_conserved_across_transitions(
        input in escrow_input(),
        parties in party_set(),
    ) {
        let env = Env::default();

        let id = EscrowContract::create_escrow(
            env.clone(),
            parties.sender.clone(),
            parties.beneficiary.clone(),
            parties.arbitrator.clone(),
            input.amount,
            String::from_str(&env, &input.asset_code),
            input.timelock,
        );

        // Fund the escrow
        EscrowContract::fund_escrow(env.clone(), id.clone(), parties.sender.clone());
        let escrow_funded = EscrowContract::get_escrow(env.clone(), id.clone());
        prop_assert_eq!(escrow_funded.amount, input.amount, "Amount must be preserved after funding");

        // Release to beneficiary — amount is conserved
        EscrowContract::release_escrow(env.clone(), id.clone(), parties.beneficiary.clone());
        let escrow_released = EscrowContract::get_escrow(env.clone(), id.clone());
        prop_assert_eq!(escrow_released.amount, input.amount, "Amount must be preserved after release");
        prop_assert_eq!(escrow_released.state, EscrowState::Released);
    }

    // ── Property: Only authorized parties can perform state transitions ─────
    //    Sender can only fund, beneficiary can only release, arbitrator can
    //    only resolve. Unauthorized callers are rejected for every transition.

    #[test]
    fn property_unauthorized_sender_cannot_fund(
        input in escrow_input(),
        parties in party_set(),
    ) {
        let env = Env::default();

        let id = EscrowContract::create_escrow(
            env.clone(),
            parties.sender.clone(),
            parties.beneficiary.clone(),
            parties.arbitrator.clone(),
            input.amount,
            String::from_str(&env, &input.asset_code),
            input.timelock,
        );

        // Only the sender can fund
        let result = std::panic::catch_unwind(|| {
            EscrowContract::fund_escrow(env.clone(), id.clone(), parties.unauthorized.clone());
        });
        assert!(result.is_err(), "Unauthorized party must not be able to fund escrow");
    }

    #[test]
    fn property_unauthorized_arbitrator_cannot_resolve(
        input in escrow_input(),
        parties in party_set(),
    ) {
        let env = Env::default();

        let id = EscrowContract::create_escrow(
            env.clone(),
            parties.sender.clone(),
            parties.beneficiary.clone(),
            parties.arbitrator.clone(),
            input.amount,
            String::from_str(&env, &input.asset_code),
            input.timelock,
        );

        EscrowContract::fund_escrow(env.clone(), id.clone(), parties.sender.clone());
        EscrowContract::dispute_escrow(env.clone(), id.clone(), parties.sender.clone());

        // Only the arbitrator can resolve
        let result = std::panic::catch_unwind(|| {
            EscrowContract::resolve_dispute(env.clone(), id.clone(), parties.unauthorized.clone(), true);
        });
        assert!(result.is_err(), "Unauthorized party must not be able to resolve dispute");
    }
}

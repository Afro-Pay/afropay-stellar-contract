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

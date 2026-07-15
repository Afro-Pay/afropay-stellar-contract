#![cfg(test)]
use super::*;
use soroban_sdk::{Env, Address, String};
use proptest::prelude::*;
use crate::test::{EscrowInput, PartySet, escrow_input, party_set};

proptest! {
    #[test]
    fn property_valid_transitions(
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
        let escrow = EscrowContract::get_escrow(env.clone(), id.clone());
        assert_eq!(escrow.state, EscrowState::Funded);

        EscrowContract::release_escrow(env.clone(), id.clone(), parties.beneficiary.clone());
        let escrow = EscrowContract::get_escrow(env.clone(), id.clone());
        assert_eq!(escrow.state, EscrowState::Released);
    }

    #[test]
    fn property_invalid_transitions(
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

        let result = std::panic::catch_unwind(|| {
            EscrowContract::release_escrow(env.clone(), id.clone(), parties.beneficiary.clone());
        });
        assert!(result.is_err());
    }
}

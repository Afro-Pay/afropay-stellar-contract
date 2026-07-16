#![cfg(test)]
use super::*;
use soroban_sdk::{Env, Address, String};

#[test]
fn test_adversarial_non_party_release() {
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
    assert!(result.is_err());
}

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
    assert!(result.is_err());
}

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
    assert!(result.is_err());
}

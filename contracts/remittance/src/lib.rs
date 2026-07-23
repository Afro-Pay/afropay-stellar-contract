#![no_std]
mod fees;

use soroban_sdk::{contract, contracttype, Address, Env, panic_with_error};
use fees::{FeeConfig, FeeError, calculate_recipient_amount, calculate_all_fees};

#[contracttype]
#[derive(Clone, Debug)]
pub struct RemittanceContract;

#[contractimpl]
impl RemittanceContract {
    /// Calculate the recipient amount for a remittance.
    ///
    /// # Arguments
    /// * `amount` - The amount to send
    /// * `sender_fee_bps` - Sender fee in basis points
    /// * `fx_spread_bps` - FX spread in basis points
    /// * `recipient_fee_bps` - Recipient fee in basis points
    ///
    /// # Returns
    /// * `recipient_amount` - The amount the recipient will receive
    ///
    /// # Errors
    /// * `InvalidFeeRate` - If any fee rate is out of bounds
    /// * `ArithmeticOverflow` - If an arithmetic operation overflows
    /// * `Underflow` - If the recipient amount would be negative
    pub fn calculate_recipient(
        env: Env,
        amount: i128,
        sender_fee_bps: i128,
        fx_spread_bps: i128,
        recipient_fee_bps: i128,
    ) -> Result<i128, FeeError> {
        let fee_config = FeeConfig::new(
            sender_fee_bps,
            fx_spread_bps,
            recipient_fee_bps,
        )?;

        calculate_recipient_amount(amount, &fee_config)
    }

    /// Calculate all fees for a remittance.
    ///
    /// # Returns
    /// * `(sender_fee, recipient_fee, total_fees)`
    pub fn calculate_fees(
        env: Env,
        amount: i128,
        sender_fee_bps: i128,
        fx_spread_bps: i128,
        recipient_fee_bps: i128,
    ) -> Result<(i128, i128, i128), FeeError> {
        let fee_config = FeeConfig::new(
            sender_fee_bps,
            fx_spread_bps,
            recipient_fee_bps,
        )?;

        calculate_all_fees(amount, &fee_config)
    }
}

use soroban_sdk::{Env, Address, panic_with_error};

/// Represents a fee configuration for the remittance contract.
/// All fee rates are expressed in basis points (bps), where 100 bps = 1%.
#[derive(Clone, Debug)]
pub struct FeeConfig {
    /// Sender fee in basis points (e.g., 100 = 1%)
    /// Max safe value: 10_000 (100%)
    pub sender_fee_bps: i128,
    /// FX spread in basis points (e.g., 50 = 0.5%)
    /// Max safe value: 10_000 (100%)
    pub fx_spread_bps: i128,
    /// Recipient fee in basis points (e.g., 50 = 0.5%)
    /// Max safe value: 10_000 (100%)
    pub recipient_fee_bps: i128,
}

impl FeeConfig {
    /// Creates a new FeeConfig with validation.
    ///
    /// # Invariants
    /// - All fee rates must be between 0 and 10_000 (0% to 100%)
    /// - The sum of sender_fee_bps and recipient_fee_bps must be <= 10_000
    ///
    /// # Returns
    /// - `Ok(FeeConfig)` if valid
    /// - `Err(FeeError::InvalidFeeRate)` if any rate is out of bounds
    /// - `Err(FeeError::FeeRateSumExceedsMax)` if sum exceeds 100%
    pub fn new(
        sender_fee_bps: i128,
        fx_spread_bps: i128,
        recipient_fee_bps: i128,
    ) -> Result<Self, FeeError> {
        // Validate each fee rate
        if !(0..=10_000).contains(&sender_fee_bps) {
            return Err(FeeError::InvalidFeeRate);
        }
        if !(0..=10_000).contains(&fx_spread_bps) {
            return Err(FeeError::InvalidFeeRate);
        }
        if !(0..=10_000).contains(&recipient_fee_bps) {
            return Err(FeeError::InvalidFeeRate);
        }

        // Validate sum of fees doesn't exceed 100%
        let sum = sender_fee_bps
            .checked_add(recipient_fee_bps)
            .ok_or(FeeError::ArithmeticOverflow)?;
        if sum > 10_000 {
            return Err(FeeError::FeeRateSumExceedsMax);
        }

        Ok(FeeConfig {
            sender_fee_bps,
            fx_spread_bps,
            recipient_fee_bps,
        })
    }
}

/// Errors that can occur during fee calculation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FeeError {
    InvalidFeeRate,
    FeeRateSumExceedsMax,
    ArithmeticOverflow,
    Underflow,
    InvalidAmount,
    DivisionByZero,
}

/// Calculates the sender fee based on the amount and fee rate.
///
/// # Formula
/// `fee = (amount * fee_bps) / 10_000`
///
/// # Invariants
/// - `amount` must be >= 0
/// - `fee_bps` must be between 0 and 10_000
/// - The multiplication `amount * fee_bps` must not overflow i128
/// - The division by 10_000 is safe and truncates toward zero
///
/// # Maximum Safe Inputs
/// - `amount`: up to i128::MAX / 10_000 when `fee_bps` is 10_000
/// - `fee_bps`: up to 10_000
///
/// # Returns
/// - `Ok(fee)` if calculation succeeds
/// - `Err(FeeError::InvalidAmount)` if amount is negative
/// - `Err(FeeError::ArithmeticOverflow)` if multiplication overflows
/// - `Err(FeeError::DivisionByZero)` if fee_bps is 0 (edge case)
pub fn calculate_sender_fee(
    amount: i128,
    fee_bps: i128,
) -> Result<i128, FeeError> {
    if amount < 0 {
        return Err(FeeError::InvalidAmount);
    }
    if fee_bps < 0 || fee_bps > 10_000 {
        return Err(FeeError::InvalidFeeRate);
    }
    if fee_bps == 0 {
        return Ok(0);
    }

    let fee = amount
        .checked_mul(fee_bps)
        .ok_or(FeeError::ArithmeticOverflow)?;
    
    let result = fee
        .checked_div(10_000)
        .ok_or(FeeError::DivisionByZero)?;

    Ok(result)
}

/// Calculates the recipient amount after fees and conversion.
///
/// # Formula
/// `recipient_amount = amount - sender_fee - recipient_fee + fx_spread`
///
/// # Invariants
/// - All intermediate operations must not overflow or underflow
/// - The final recipient amount must be >= 0
/// - Fee calculations must not exceed the original amount
///
/// # Maximum Safe Inputs
/// - `amount`: up to i128::MAX / 2 when all fees are applied
/// - Individual fees must be <= amount
///
/// # Returns
/// - `Ok(recipient_amount)` if calculation succeeds
/// - `Err(FeeError::Underflow)` if recipient amount would be negative
/// - `Err(FeeError::ArithmeticOverflow)` if any operation overflows
pub fn calculate_recipient_amount(
    amount: i128,
    fee_config: &FeeConfig,
) -> Result<i128, FeeError> {
    if amount < 0 {
        return Err(FeeError::InvalidAmount);
    }

    // Calculate sender fee
    let sender_fee = calculate_sender_fee(amount, fee_config.sender_fee_bps)?;
    let sender_fee = sender_fee.min(amount);

    // Calculate recipient fee
    let remaining_after_sender = amount
        .checked_sub(sender_fee)
        .ok_or(FeeError::Underflow)?;
    
    let recipient_fee = calculate_sender_fee(remaining_after_sender, fee_config.recipient_fee_bps)?;
    let recipient_fee = recipient_fee.min(remaining_after_sender);

    // Apply FX spread (can be positive or negative)
    let fx_adjustment = if fee_config.fx_spread_bps > 0 {
        let adjustment = remaining_after_sender
            .checked_sub(recipient_fee)
            .ok_or(FeeError::Underflow)?
            .checked_mul(fee_config.fx_spread_bps)
            .ok_or(FeeError::ArithmeticOverflow)?
            .checked_div(10_000)
            .ok_or(FeeError::DivisionByZero)?;
        adjustment
    } else {
        0
    };

    // Calculate final recipient amount
    let recipient_amount = remaining_after_sender
        .checked_sub(recipient_fee)
        .ok_or(FeeError::Underflow)?
        .checked_add(fx_adjustment)
        .ok_or(FeeError::ArithmeticOverflow)?;

    if recipient_amount < 0 {
        return Err(FeeError::Underflow);
    }

    Ok(recipient_amount)
}

/// Calculates the total fees charged on a transaction.
///
/// # Formula
/// `total_fees = sender_fee + recipient_fee`
///
/// # Returns
/// - `Ok((sender_fee, recipient_fee, total_fees))`
pub fn calculate_all_fees(
    amount: i128,
    fee_config: &FeeConfig,
) -> Result<(i128, i128, i128), FeeError> {
    let sender_fee = calculate_sender_fee(amount, fee_config.sender_fee_bps)?;
    let sender_fee = sender_fee.min(amount);

    let remaining = amount
        .checked_sub(sender_fee)
        .ok_or(FeeError::Underflow)?;
    
    let recipient_fee = calculate_sender_fee(remaining, fee_config.recipient_fee_bps)?;
    let recipient_fee = recipient_fee.min(remaining);

    let total_fees = sender_fee
        .checked_add(recipient_fee)
        .ok_or(FeeError::ArithmeticOverflow)?;

    Ok((sender_fee, recipient_fee, total_fees))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fee_config_creation() {
        let config = FeeConfig::new(100, 50, 50).unwrap();
        assert_eq!(config.sender_fee_bps, 100);
        assert_eq!(config.fx_spread_bps, 50);
        assert_eq!(config.recipient_fee_bps, 50);
    }

    #[test]
    fn test_fee_config_validation() {
        // Test invalid fee rates
        assert!(FeeConfig::new(100, 50, 10_001).is_err());
        assert!(FeeConfig::new(100, 50, -1).is_err());

        // Test sum exceeds 100%
        assert!(FeeConfig::new(6_000, 0, 6_000).is_err());
    }

    #[test]
    fn test_calculate_sender_fee() {
        let amount = 1_000_000_000; // 1,000,000 tokens
        let fee_bps = 100; // 1%

        let fee = calculate_sender_fee(amount, fee_bps).unwrap();
        assert_eq!(fee, 10_000_000); // 10,000 tokens
    }

    #[test]
    fn test_calculate_sender_fee_zero() {
        let fee = calculate_sender_fee(1_000, 0).unwrap();
        assert_eq!(fee, 0);
    }

    #[test]
    fn test_calculate_sender_fee_overflow() {
        let amount = i128::MAX;
        let fee_bps = 10_000;

        let result = calculate_sender_fee(amount, fee_bps);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), FeeError::ArithmeticOverflow);
    }

    #[test]
    fn test_recipient_amount_calculation() {
        let config = FeeConfig::new(100, 50, 50).unwrap();
        let amount = 1_000_000_000;

        let recipient = calculate_recipient_amount(amount, &config).unwrap();
        
        // sender_fee = 10,000,000
        // remaining = 990,000,000
        // recipient_fee = 4,950,000
        // fx_adjustment = 4,925,250
        // recipient = 990,000,000 - 4,950,000 + 4,925,250 = 989,975,250
        assert!(recipient > 0);
    }

    #[test]
    fn test_calculate_recipient_amount_underflow() {
        let config = FeeConfig::new(10_000, 10_000, 10_000).unwrap();
        let amount = 1_000;

        let result = calculate_recipient_amount(amount, &config);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), FeeError::Underflow);
    }

    #[test]
    fn test_calculate_all_fees() {
        let config = FeeConfig::new(100, 50, 50).unwrap();
        let amount = 1_000_000_000;

        let (sender_fee, recipient_fee, total_fees) = calculate_all_fees(amount, &config).unwrap();
        
        assert!(sender_fee > 0);
        assert!(recipient_fee > 0);
        assert_eq!(total_fees, sender_fee + recipient_fee);
    }

    #[test]
    fn test_fee_calculation_with_large_amounts() {
        let config = FeeConfig::new(100, 50, 50).unwrap();
        let amount = i128::MAX / 1000;

        let result = calculate_recipient_amount(amount, &config);
        assert!(result.is_ok());
        let recipient = result.unwrap();
        assert!(recipient >= 0);
    }
}

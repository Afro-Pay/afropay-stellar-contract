#![no_std]
mod fees;
mod routing;

use soroban_sdk::{contract, contracttype, Address, Env, panic_with_error};
use fees::{FeeConfig, FeeError, calculate_recipient_amount, calculate_all_fees};
use routing::{RoutingError, RoutingConfig, Asset, Path, Hop, find_best_path, estimate_gas_cost, is_within_budget};

#[cfg(test)]
mod reentrancy_tests;

#[cfg(test)]
mod test;

#[contracttype]
#[derive(Clone, Debug)]
pub struct RemittanceContract;

#[contractimpl]
impl RemittanceContract {
    /// Calculate the recipient amount for a remittance.
    ///
    /// This function is stateless and contains no external calls, therefore
    /// no reentrancy guards are required. See docs/security/reentrancy-call-graph.md
    /// for architecture details.
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

    /// Find the best routing path for a cross-asset transfer.
    ///
    /// Computes the lowest-slippage multi-hop path (up to 3 hops) using
    /// on-chain order-book depth data, with a configurable max-slippage guard
    /// that aborts the transaction if slippage exceeds the threshold.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    /// * `from_asset_code` - Source asset code (e.g., "NGN")
    /// * `from_asset_issuer` - Source asset issuer (empty for native)
    /// * `to_asset_code` - Destination asset code (e.g., "KES")
    /// * `to_asset_issuer` - Destination asset issuer (empty for native)
    /// * `amount` - Amount to route (in stroops/smallest unit)
    /// * `max_slippage_bps` - Maximum allowed slippage in basis points
    ///
    /// # Returns
    /// * `Path` - The best path with minimum slippage
    ///
    /// # Errors
    /// * `RoutingError::NoPathFound` - No valid path found
    /// * `RoutingError::SlippageExceeded` - Best path exceeds max slippage (panics)
    /// * `RoutingError::InvalidAsset` - Invalid asset configuration
    /// * `RoutingError::InvalidAmount` - Invalid amount
    /// * `RoutingError::MaxHopsExceeded` - Maximum hops exceeded
    /// * `RoutingError::ArithmeticOverflow` - Arithmetic overflow
    /// * `RoutingError::DivisionByZero` - Division by zero
    /// * `RoutingError::InvalidOrderBook` - Invalid order book data
    pub fn find_route(
        env: Env,
        from_asset_code: soroban_sdk::Symbol,
        from_asset_issuer: soroban_sdk::Symbol,
        to_asset_code: soroban_sdk::Symbol,
        to_asset_issuer: soroban_sdk::Symbol,
        amount: i128,
        max_slippage_bps: i128,
    ) -> Result<Path, RoutingError> {
        let from = Asset {
            code: from_asset_code,
            issuer: from_asset_issuer,
        };
        let to = Asset {
            code: to_asset_code,
            issuer: to_asset_issuer,
        };

        find_best_path(env, from, to, amount, max_slippage_bps)
    }

    /// Estimate the gas cost for executing a routing path.
    ///
    /// # Arguments
    /// * `path` - The routing path to estimate gas for
    ///
    /// # Returns
    /// * Estimated CPU instructions
    pub fn estimate_route_gas(path: Path) -> u64 {
        estimate_gas_cost(&path)
    }

    /// Check if a routing path is within the CPU instruction budget.
    ///
    /// Soroban limit is ~20M instructions per invocation.
    /// We target 80% = 16M instructions.
    ///
    /// # Arguments
    /// * `path` - The routing path to check
    ///
    /// # Returns
    /// * `true` if within budget, `false` otherwise
    pub fn check_route_budget(path: Path) -> bool {
        is_within_budget(&path)
    }
}

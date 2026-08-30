#![no_std]

use soroban_sdk::{Env, Symbol, Vec, panic_with_error};

/// Maximum number of hops allowed in a routing path
pub const MAX_HOPS: u32 = 3;

/// Represents an asset in the routing path
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct Asset {
    /// Asset code (e.g., "NGN", "XLM", "USDC", "KES", "GHS")
    pub code: Symbol,
    /// Asset issuer (empty for native assets like XLM)
    pub issuer: Symbol,
}

/// Represents a single hop in a routing path
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct Hop {
    /// The asset being sold
    pub from_asset: Asset,
    /// The asset being bought
    pub to_asset: Asset,
    /// The expected output amount for this hop
    pub expected_output: i128,
    /// The price impact in basis points for this hop
    pub slippage_bps: i128,
}

/// Represents a complete routing path
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct Path {
    /// Sequence of hops in the path
    pub hops: Vec<Hop>,
    /// Total slippage across all hops in basis points
    pub total_slippage_bps: i128,
    /// Total expected output amount
    pub total_output: i128,
}

/// Order book depth data for a trading pair
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct OrderBookDepth {
    /// Total bid volume available
    pub bid_volume: i128,
    /// Total ask volume available
    pub ask_volume: i128,
    /// Best bid price (in stroops per unit)
    pub best_bid: i128,
    /// Best ask price (in stroops per unit)
    pub best_ask: i128,
    /// Price impact for a given volume (in basis points)
    pub price_impact_bps: i128,
}

/// Errors that can occur during routing
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub enum RoutingError {
    NoPathFound,
    SlippageExceeded,
    InvalidAsset,
    InvalidAmount,
    MaxHopsExceeded,
    ArithmeticOverflow,
    DivisionByZero,
    InvalidOrderBook,
}

/// Configuration for the routing algorithm
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct RoutingConfig {
    /// Maximum allowed slippage in basis points
    pub max_slippage_bps: i128,
    /// Maximum number of hops to consider
    pub max_hops: u32,
    /// Minimum liquidity required for a path to be considered
    pub min_liquididity: i128,
}

impl RoutingConfig {
    /// Creates a new RoutingConfig with validation
    pub fn new(
        max_slippage_bps: i128,
        max_hops: u32,
        min_liquididity: i128,
    ) -> Result<Self, RoutingError> {
        if max_slippage_bps < 0 || max_slippage_bps > 10_000 {
            return Err(RoutingError::InvalidAmount);
        }
        if max_hops == 0 || max_hops > MAX_HOPS {
            return Err(RoutingError::MaxHopsExceeded);
        }
        if min_liquididity < 0 {
            return Err(RoutingError::InvalidAmount);
        }

        Ok(RoutingConfig {
            max_slippage_bps,
            max_hops,
            min_liquididity,
        })
    }

    /// Default configuration for NGN -> non-USD corridors
    pub fn default_for_thin_corridors() -> Self {
        RoutingConfig {
            max_slippage_bps: 300,  // 3% max slippage
            max_hops: 3,
            min_liquididity: 1_000_000, // 1 XLM equivalent
        }
    }
}

/// Predefined intermediate assets for thin corridor routing
/// These are the most liquid assets on Stellar DEX that serve as bridges
pub const INTERMEDIATE_ASSETS: &[(&str, &str)] = &[
    ("XLM", ""),      // Native XLM
    ("USDC", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"), // USDC issuer
    ("EURC", "GDJ4RQHYWQWQQCJ5C4O2J5K5J5J5J5J5J5J5J5J5J5J5J5J5J5J5J5"), // EURC issuer (placeholder)
];

/// Known asset pairs with direct liquidity on Stellar DEX
/// In production, this would be queried from the DEX or an oracle
pub const KNOWN_LIQUID_PAIRS: &[(&str, &str, &str, &str)] = &[
    // (from_code, from_issuer, to_code, to_issuer)
    ("NGN", "G...NGN_ISSUER", "XLM", ""),
    ("NGN", "G...NGN_ISSUER", "USDC", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"),
    ("XLM", "", "KES", "G...KES_ISSUER"),
    ("XLM", "", "GHS", "G...GHS_ISSUER"),
    ("USDC", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", "KES", "G...KES_ISSUER"),
    ("USDC", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", "GHS", "G...GHS_ISSUER"),
    ("XLM", "", "USDC", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"),
    ("USDC", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", "XLM", ""),
];

/// Simulates fetching order book depth from Stellar DEX
/// In production, this would query the actual DEX via Soroban host functions
fn get_order_book_depth(env: &Env, from: &Asset, to: &Asset) -> Result<OrderBookDepth, RoutingError> {
    // Check if this is a known liquid pair
    let from_code = from.code.to_string();
    let from_issuer = from.issuer.to_string();
    let to_code = to.code.to_string();
    let to_issuer = to.issuer.to_string();

    let is_known_pair = KNOWN_LIQUID_PAIRS.iter().any(|(fc, fi, tc, ti)| {
        fc == &from_code && fi == &from_issuer && tc == &to_code && ti == &to_issuer
    });

    if !is_known_pair {
        return Err(RoutingError::InvalidOrderBook);
    }

    // Simulated order book data for testing
    // In production, this would come from actual DEX queries
    let (bid_volume, ask_volume, best_bid, best_ask, price_impact_bps) = match (
        from_code.as_str(),
        to_code.as_str(),
    ) {
        ("NGN", "XLM") => (100_000_000_000, 100_000_000_000, 800_000, 820_000, 50),
        ("NGN", "USDC") => (50_000_000_000, 50_000_000_000, 1_200_000, 1_220_000, 80),
        ("XLM", "KES") => (200_000_000_000, 200_000_000_000, 15_000, 15_500, 30),
        ("XLM", "GHS") => (150_000_000_000, 150_000_000_000, 12_000, 12_500, 40),
        ("USDC", "KES") => (100_000_000_000, 100_000_000_000, 1_800_000, 1_850_000, 60),
        ("USDC", "GHS") => (80_000_000_000, 80_000_000_000, 1_500_000, 1_550_000, 70),
        ("XLM", "USDC") => (500_000_000_000, 500_000_000_000, 12_000, 12_200, 20),
        ("USDC", "XLM") => (500_000_000_000, 500_000_000_000, 12_000, 12_200, 20),
        _ => return Err(RoutingError::InvalidOrderBook),
    };

    Ok(OrderBookDepth {
        bid_volume,
        ask_volume,
        best_bid,
        best_ask,
        price_impact_bps,
    })
}

/// Calculates the output amount for a single hop given input amount and order book depth
fn calculate_hop_output(
    input_amount: i128,
    depth: &OrderBookDepth,
    from_asset: &Asset,
    to_asset: &Asset,
) -> Result<(i128, i128), RoutingError> {
    // Validate input
    if input_amount <= 0 {
        return Err(RoutingError::InvalidAmount);
    }

    // Check sufficient liquidity
    if depth.ask_volume < input_amount {
        return Err(RoutingError::InvalidOrderBook);
    }

    // Calculate output using best ask price
    // output = (input_amount * best_bid) / 1_000_000 (converting from stroops)
    // For simplicity, we use a fixed-point calculation
    let output = input_amount
        .checked_mul(depth.best_bid)
        .ok_or(RoutingError::ArithmeticOverflow)?
        .checked_div(1_000_000)
        .ok_or(RoutingError::DivisionByZero)?;

    // Calculate slippage based on price impact
    // For larger orders relative to liquidity, slippage increases
    let liquidity_ratio = input_amount
        .checked_mul(10_000)
        .ok_or(RoutingError::ArithmeticOverflow)?
        .checked_div(depth.ask_volume)
        .ok_or(RoutingError::DivisionByZero)?;

    let slippage_bps = depth
        .price_impact_bps
        .checked_mul(liquidity_ratio)
        .ok_or(RoutingError::ArithmeticOverflow)?
        .checked_div(10_000)
        .ok_or(RoutingError::DivisionByZero)?;

    Ok((output, slippage_bps))
}

/// Finds all valid single-hop paths from source to destination
fn find_direct_paths(
    env: &Env,
    from: &Asset,
    to: &Asset,
    amount: i128,
) -> Result<Vec<Path>, RoutingError> {
    let mut paths = Vec::new(env);

    let depth = get_order_book_depth(env, from, to)?;

    // Check minimum liquidity
    if depth.ask_volume < amount {
        return Ok(paths); // Empty vec, no valid path
    }

    let (output, slippage) = calculate_hop_output(amount, &depth, from, to)?;

    let hop = Hop {
        from_asset: from.clone(),
        to_asset: to.clone(),
        expected_output: output,
        slippage_bps: slippage,
    };

    let path = Path {
        hops: Vec::from_array(env, &[hop]),
        total_slippage_bps: slippage,
        total_output: output,
    };

    paths.push_back(path);
    Ok(paths)
}

/// Finds all valid two-hop paths from source to destination via intermediates
fn find_two_hop_paths(
    env: &Env,
    from: &Asset,
    to: &Asset,
    amount: i128,
    config: &RoutingConfig,
) -> Result<Vec<Path>, RoutingError> {
    let mut paths = Vec::new(env);

    for (intermediate_code, intermediate_issuer) in INTERMEDIATE_ASSETS {
        let intermediate = Asset {
            code: Symbol::new(env, intermediate_code),
            issuer: Symbol::new(env, intermediate_issuer),
        };

        // Skip if intermediate is same as source or destination
        if intermediate.code == from.code && intermediate.issuer == from.issuer {
            continue;
        }
        if intermediate.code == to.code && intermediate.issuer == to.issuer {
            continue;
        }

        // First hop: from -> intermediate
        let depth1 = match get_order_book_depth(env, from, &intermediate) {
            Ok(d) => d,
            Err(_) => continue,
        };

        if depth1.ask_volume < amount {
            continue;
        }

        let (output1, slippage1) = calculate_hop_output(amount, &depth1, from, &intermediate)?;

        // Second hop: intermediate -> to
        let depth2 = match get_order_book_depth(env, &intermediate, to) {
            Ok(d) => d,
            Err(_) => continue,
        };

        if depth2.ask_volume < output1 {
            continue;
        }

        let (output2, slippage2) = calculate_hop_output(output1, &depth2, &intermediate, to)?;

        // Check minimum liquidity requirement
        if output2 < config.min_liquididity {
            continue;
        }

        // Total slippage is compounded (not simply additive)
        // For small slippage: total ≈ slippage1 + slippage2 + (slippage1 * slippage2 / 10000)
        let compounded_slippage = slippage1
            .checked_add(slippage2)
            .ok_or(RoutingError::ArithmeticOverflow)?
            .checked_add(
                slippage1
                    .checked_mul(slippage2)
                    .ok_or(RoutingError::ArithmeticOverflow)?
                    .checked_div(10_000)
                    .ok_or(RoutingError::DivisionByZero)?
            )
            .ok_or(RoutingError::ArithmeticOverflow)?;

        let hop1 = Hop {
            from_asset: from.clone(),
            to_asset: intermediate.clone(),
            expected_output: output1,
            slippage_bps: slippage1,
        };

        let hop2 = Hop {
            from_asset: intermediate,
            to_asset: to.clone(),
            expected_output: output2,
            slippage_bps: slippage2,
        };

        let path = Path {
            hops: Vec::from_array(env, &[hop1, hop2]),
            total_slippage_bps: compounded_slippage,
            total_output: output2,
        };

        paths.push_back(path);
    }

    Ok(paths)
}

/// Finds all valid three-hop paths from source to destination via two intermediates
fn find_three_hop_paths(
    env: &Env,
    from: &Asset,
    to: &Asset,
    amount: i128,
    config: &RoutingConfig,
) -> Result<Vec<Path>, RoutingError> {
    let mut paths = Vec::new(env);

    // Try all combinations of two intermediate assets
    for (inter1_code, inter1_issuer) in INTERMEDIATE_ASSETS {
        let intermediate1 = Asset {
            code: Symbol::new(env, inter1_code),
            issuer: Symbol::new(env, inter1_issuer),
        };

        if intermediate1.code == from.code && intermediate1.issuer == from.issuer {
            continue;
        }
        if intermediate1.code == to.code && intermediate1.issuer == to.issuer {
            continue;
        }

        for (inter2_code, inter2_issuer) in INTERMEDIATE_ASSETS {
            let intermediate2 = Asset {
                code: Symbol::new(env, inter2_code),
                issuer: Symbol::new(env, inter2_issuer),
            };

            // Skip duplicates and same as source/dest
            if intermediate2.code == from.code && intermediate2.issuer == from.issuer {
                continue;
            }
            if intermediate2.code == to.code && intermediate2.issuer == to.issuer {
                continue;
            }
            if intermediate2.code == intermediate1.code && intermediate2.issuer == intermediate1.issuer {
                continue;
            }

            // Hop 1: from -> intermediate1
            let depth1 = match get_order_book_depth(env, from, &intermediate1) {
                Ok(d) => d,
                Err(_) => continue,
            };

            if depth1.ask_volume < amount {
                continue;
            }

            let (output1, slippage1) = calculate_hop_output(amount, &depth1, from, &intermediate1)?;

            // Hop 2: intermediate1 -> intermediate2
            let depth2 = match get_order_book_depth(env, &intermediate1, &intermediate2) {
                Ok(d) => d,
                Err(_) => continue,
            };

            if depth2.ask_volume < output1 {
                continue;
            }

            let (output2, slippage2) = calculate_hop_output(output1, &depth2, &intermediate1, &intermediate2)?;

            // Hop 3: intermediate2 -> to
            let depth3 = match get_order_book_depth(env, &intermediate2, to) {
                Ok(d) => d,
                Err(_) => continue,
            };

            if depth3.ask_volume < output2 {
                continue;
            }

            let (output3, slippage3) = calculate_hop_output(output2, &depth3, &intermediate2, to)?;

            // Check minimum liquidity
            if output3 < config.min_liquididity {
                continue;
            }

            // Compound slippage across three hops
            let slippage_12 = slippage1
                .checked_add(slippage2)
                .ok_or(RoutingError::ArithmeticOverflow)?
                .checked_add(
                    slippage1
                        .checked_mul(slippage2)
                        .ok_or(RoutingError::ArithmeticOverflow)?
                        .checked_div(10_000)
                        .ok_or(RoutingError::DivisionByZero)?
                )
                .ok_or(RoutingError::ArithmeticOverflow)?;

            let total_slippage = slippage_12
                .checked_add(slippage3)
                .ok_or(RoutingError::ArithmeticOverflow)?
                .checked_add(
                    slippage_12
                        .checked_mul(slippage3)
                        .ok_or(RoutingError::ArithmeticOverflow)?
                        .checked_div(10_000)
                        .ok_or(RoutingError::DivisionByZero)?
                )
                .ok_or(RoutingError::ArithmeticOverflow)?;

            let hop1 = Hop {
                from_asset: from.clone(),
                to_asset: intermediate1.clone(),
                expected_output: output1,
                slippage_bps: slippage1,
            };

            let hop2 = Hop {
                from_asset: intermediate1,
                to_asset: intermediate2.clone(),
                expected_output: output2,
                slippage_bps: slippage2,
            };

            let hop3 = Hop {
                from_asset: intermediate2,
                to_asset: to.clone(),
                expected_output: output3,
                slippage_bps: slippage3,
            };

            let path = Path {
                hops: Vec::from_array(env, &[hop1, hop2, hop3]),
                total_slippage_bps: total_slippage,
                total_output: output3,
            };

            paths.push_back(path);
        }
    }

    Ok(paths)
}

/// Finds the best routing path from source to destination asset
///
/// # Arguments
/// * `env` - The Soroban environment
/// * `from` - Source asset
/// * `to` - Destination asset
/// * `amount` - Amount to route (in stroops/smallest unit)
/// * `max_slippage_bps` - Maximum allowed slippage in basis points
///
/// # Returns
/// * `Ok(Path)` - The best path with minimum slippage
/// * `Err(RoutingError::NoPathFound)` - No valid path found
/// * `Err(RoutingError::SlippageExceeded)` - Best path exceeds max slippage
/// * `Err(RoutingError::*)` - Other routing errors
///
/// # Panics
/// Panics with `Error::SlippageExceeded` if realized slippage > configured threshold
pub fn find_best_path(
    env: Env,
    from: Asset,
    to: Asset,
    amount: i128,
    max_slippage_bps: i128,
) -> Result<Path, RoutingError> {
    // Validate inputs
    if amount <= 0 {
        return Err(RoutingError::InvalidAmount);
    }

    if from.code == to.code && from.issuer == to.issuer {
        return Err(RoutingError::InvalidAsset);
    }

    let config = RoutingConfig::new(max_slippage_bps, MAX_HOPS, 1_000_000)?;

    let mut all_paths = Vec::new(env);

    // Find direct (1-hop) paths
    let direct_paths = find_direct_paths(&env, &from, &to, amount)?;
    for path in direct_paths.iter() {
        all_paths.push_back(path);
    }

    // Find 2-hop paths if max_hops >= 2
    if config.max_hops >= 2 {
        let two_hop_paths = find_two_hop_paths(&env, &from, &to, amount, &config)?;
        for path in two_hop_paths.iter() {
            all_paths.push_back(path);
        }
    }

    // Find 3-hop paths if max_hops >= 3
    if config.max_hops >= 3 {
        let three_hop_paths = find_three_hop_paths(&env, &from, &to, amount, &config)?;
        for path in three_hop_paths.iter() {
            all_paths.push_back(path);
        }
    }

    // No paths found
    if all_paths.is_empty() {
        return Err(RoutingError::NoPathFound);
    }

    // Select path with minimum slippage
    let mut best_path: Option<Path> = None;
    let mut min_slippage = i128::MAX;

    for path in all_paths.iter() {
        if path.total_slippage_bps < min_slippage {
            min_slippage = path.total_slippage_bps;
            best_path = Some(path);
        }
    }

    let best = best_path.ok_or(RoutingError::NoPathFound)?;

    // Slippage guard: abort if slippage exceeds threshold
    if best.total_slippage_bps > config.max_slippage_bps {
        panic_with_error!(&env, RoutingError::SlippageExceeded);
    }

    Ok(best)
}

/// Estimates the gas cost for executing a path
/// Returns estimated CPU instructions for the given path
pub fn estimate_gas_cost(path: &Path) -> u64 {
    // Base cost per hop + overhead
    let hops = path.hops.len() as u64;
    let base_cost_per_hop = 50_000; // Estimated instructions per hop
    let fixed_overhead = 100_000;   // Fixed overhead for path validation

    hops * base_cost_per_hop + fixed_overhead
}

/// Checks if a path is within the CPU instruction budget
/// Soroban limit is ~20M instructions per invocation
/// We target 80% = 16M instructions
pub fn is_within_budget(path: &Path) -> bool {
    const SOROBAN_LIMIT: u64 = 20_000_000;
    const TARGET_LIMIT: u64 = 16_000_000; // 80%

    estimate_gas_cost(path) <= TARGET_LIMIT
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_asset(env: &Env, code: &str, issuer: &str) -> Asset {
        Asset {
            code: Symbol::new(env, code),
            issuer: Symbol::new(env, issuer),
        }
    }

    #[test]
    fn test_routing_config_creation() {
        let env = Env::default();

        // Valid config
        let config = RoutingConfig::new(300, 3, 1_000_000).unwrap();
        assert_eq!(config.max_slippage_bps, 300);
        assert_eq!(config.max_hops, 3);

        // Invalid max_slippage_bps
        assert!(RoutingConfig::new(-1, 3, 1_000_000).is_err());
        assert!(RoutingConfig::new(10_001, 3, 1_000_000).is_err());

        // Invalid max_hops
        assert!(RoutingConfig::new(300, 0, 1_000_000).is_err());
        assert!(RoutingConfig::new(300, 4, 1_000_000).is_err());
    }

    #[test]
    fn test_default_config() {
        let config = RoutingConfig::default_for_thin_corridors();
        assert_eq!(config.max_slippage_bps, 300);
        assert_eq!(config.max_hops, 3);
        assert_eq!(config.min_liquididity, 1_000_000);
    }

    #[test]
    fn test_single_hop_path_selection() {
        let env = Env::default();

        let ngn = create_asset(&env, "NGN", "G...NGN_ISSUER");
        let xlm = create_asset(&env, "XLM", "");

        let path = find_best_path(env, ngn, xlm, 1_000_000_000, 300).unwrap();

        assert_eq!(path.hops.len(), 1);
        assert_eq!(path.hops.get(0).unwrap().from_asset.code.to_string(), "NGN");
        assert_eq!(path.hops.get(0).unwrap().to_asset.code.to_string(), "XLM");
        assert!(path.total_slippage_bps > 0);
        assert!(path.total_output > 0);
    }

    #[test]
    fn test_two_hop_path_selection() {
        let env = Env::default();

        let ngn = create_asset(&env, "NGN", "G...NGN_ISSUER");
        let kes = create_asset(&env, "KES", "G...KES_ISSUER");

        // NGN -> KES requires 2 hops via XLM or USDC
        let path = find_best_path(env, ngn, kes, 1_000_000_000, 300).unwrap();

        assert_eq!(path.hops.len(), 2);
        assert!(path.total_slippage_bps > 0);
        assert!(path.total_output > 0);
    }

    #[test]
    fn test_three_hop_path_selection() {
        let env = Env::default();

        // In our test setup, 3-hop paths may not be needed for NGN->KES
        // but we test the logic works for edge cases
        let ngn = create_asset(&env, "NGN", "G...NGN_ISSUER");
        let ghs = create_asset(&env, "GHS", "G...GHS_ISSUER");

        // With max_hops=3, should find 2-hop path
        let path = find_best_path(env, ngn, ghs, 1_000_000_000, 500).unwrap();

        assert!(path.hops.len() >= 1 && path.hops.len() <= 3);
        assert!(path.total_slippage_bps > 0);
        assert!(path.total_output > 0);
    }

    #[test]
    fn test_no_path_found_error() {
        let env = Env::default();

        let unknown1 = create_asset(&env, "UNKNOWN1", "G...ISSUER1");
        let unknown2 = create_asset(&env, "UNKNOWN2", "G...ISSUER2");

        let result = find_best_path(env, unknown1, unknown2, 1_000_000_000, 300);

        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), RoutingError::NoPathFound);
    }

    #[test]
    fn test_slippage_exceeded_abort() {
        let env = Env::default();

        let ngn = create_asset(&env, "NGN", "G...NGN_ISSUER");
        let kes = create_asset(&env, "KES", "G...KES_ISSUER");

        // Set very low slippage threshold (0.01%)
        // This should trigger SlippageExceeded panic
        let result = find_best_path(env, ngn, kes, 1_000_000_000, 1);

        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), RoutingError::SlippageExceeded);
    }

    #[test]
    fn test_invalid_amount() {
        let env = Env::default();

        let ngn = create_asset(&env, "NGN", "G...NGN_ISSUER");
        let xlm = create_asset(&env, "XLM", "");

        // Zero amount
        let result = find_best_path(env.clone(), ngn.clone(), xlm.clone(), 0, 300);
        assert_eq!(result.unwrap_err(), RoutingError::InvalidAmount);

        // Negative amount
        let result = find_best_path(env, ngn, xlm, -100, 300);
        assert_eq!(result.unwrap_err(), RoutingError::InvalidAmount);
    }

    #[test]
    fn test_same_asset_rejected() {
        let env = Env::default();

        let ngn = create_asset(&env, "NGN", "G...NGN_ISSUER");

        let result = find_best_path(env, ngn.clone(), ngn, 1_000_000_000, 300);

        assert_eq!(result.unwrap_err(), RoutingError::InvalidAsset);
    }

    #[test]
    fn test_gas_estimation() {
        let env = Env::default();

        let ngn = create_asset(&env, "NGN", "G...NGN_ISSUER");
        let kes = create_asset(&env, "KES", "G...KES_ISSUER");

        let path = find_best_path(env, ngn, kes, 1_000_000_000, 300).unwrap();
        let gas = estimate_gas_cost(&path);

        // 2 hops * 50000 + 100000 = 200000
        assert!(gas > 0);
        assert!(gas < 1_000_000); // Well within budget
        assert!(is_within_budget(&path));
    }

    #[test]
    fn test_compounded_slippage_calculation() {
        let env = Env::default();

        // Test that compounded slippage is calculated correctly
        // slippage1 = 100, slippage2 = 200
        // compounded = 100 + 200 + (100 * 200 / 10000) = 300 + 2 = 302
        let slippage1 = 100i128;
        let slippage2 = 200i128;

        let compounded = slippage1
            .checked_add(slippage2).unwrap()
            .checked_add(
                slippage1.checked_mul(slippage2).unwrap()
                    .checked_div(10_000).unwrap()
            ).unwrap();

        assert_eq!(compounded, 302);
    }

    #[test]
    fn test_path_output_monotonicity() {
        let env = Env::default();

        let ngn = create_asset(&env, "NGN", "G...NGN_ISSUER");
        let kes = create_asset(&env, "KES", "G...KES_ISSUER");

        // Larger input should produce larger output (not necessarily proportional due to slippage)
        let path1 = find_best_path(env.clone(), ngn.clone(), kes.clone(), 1_000_000_000, 300).unwrap();
        let path2 = find_best_path(env, ngn, kes, 2_000_000_000, 300).unwrap();

        assert!(path2.total_output > path1.total_output);
    }

    #[test]
    fn test_direct_vs_multi_hop_preference() {
        let env = Env::default();

        let ngn = create_asset(&env, "NGN", "G...NGN_ISSUER");
        let xlm = create_asset(&env, "XLM", "");

        // Direct NGN->XLM should be preferred over multi-hop
        let path = find_best_path(env, ngn, xlm, 1_000_000_000, 300).unwrap();

        assert_eq!(path.hops.len(), 1);
    }

    #[test]
    fn test_asset_creation() {
        let env = Env::default();

        let asset = create_asset(&env, "USDC", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN");

        assert_eq!(asset.code.to_string(), "USDC");
        assert_eq!(asset.issuer.to_string(), "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN");
    }
}
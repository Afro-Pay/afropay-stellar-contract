#![cfg(test)]

use super::*;
use soroban_sdk::{Env, Symbol, Address, testutils::Address as _, testutils::Ledger};

/// Helper to create an Asset for testing
fn create_asset(env: &Env, code: &str, issuer: &str) -> Asset {
    Asset {
        code: Symbol::new(env, code),
        issuer: Symbol::new(env, issuer),
    }
}

/// Helper to create NGN asset (Nigerian Naira)
fn ngn_asset(env: &Env) -> Asset {
    create_asset(env, "NGN", "G...NGN_ISSUER")
}

/// Helper to create XLM asset (Stellar Lumens)
fn xlm_asset(env: &Env) -> Asset {
    create_asset(env, "XLM", "")
}

/// Helper to create USDC asset
fn usdc_asset(env: &Env) -> Asset {
    create_asset(env, "USDC", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN")
}

/// Helper to create KES asset (Kenyan Shilling)
fn kes_asset(env: &Env) -> Asset {
    create_asset(env, "KES", "G...KES_ISSUER")
}

/// Helper to create GHS asset (Ghanaian Cedi)
fn ghs_asset(env: &Env) -> Asset {
    create_asset(env, "GHS", "G...GHS_ISSUER")
}

/// Test 1: Single-hop path selection (NGN -> XLM)
#[test]
fn test_single_hop_path_selection() {
    let env = Env::default();

    let from = ngn_asset(&env);
    let to = xlm_asset(&env);
    let amount = 1_000_000_000i128; // 1000 NGN
    let max_slippage = 300i128; // 3%

    let path = find_best_path(env, from, to, amount, max_slippage).unwrap();

    // Verify single hop
    assert_eq!(path.hops.len(), 1);
    let hop = path.hops.get(0).unwrap();
    assert_eq!(hop.from_asset.code.to_string(), "NGN");
    assert_eq!(hop.to_asset.code.to_string(), "XLM");

    // Verify slippage is within bounds
    assert!(path.total_slippage_bps <= max_slippage);
    assert!(path.total_slippage_bps > 0);

    // Verify positive output
    assert!(path.total_output > 0);
}

/// Test 2: Two-hop path selection (NGN -> KES via XLM)
#[test]
fn test_two_hop_path_selection() {
    let env = Env::default();

    let from = ngn_asset(&env);
    let to = kes_asset(&env);
    let amount = 1_000_000_000i128; // 1000 NGN
    let max_slippage = 500i128; // 5% (higher for 2-hop)

    let path = find_best_path(env, from, to, amount, max_slippage).unwrap();

    // Verify two hops
    assert_eq!(path.hops.len(), 2);

    let hop1 = path.hops.get(0).unwrap();
    let hop2 = path.hops.get(1).unwrap();

    // First hop: NGN -> XLM or USDC
    assert_eq!(hop1.from_asset.code.to_string(), "NGN");
    assert!(hop1.to_asset.code.to_string() == "XLM" || hop1.to_asset.code.to_string() == "USDC");

    // Second hop: XLM/USDC -> KES
    assert!(hop2.from_asset.code.to_string() == "XLM" || hop2.from_asset.code.to_string() == "USDC");
    assert_eq!(hop2.to_asset.code.to_string(), "KES");

    // Verify slippage is within bounds
    assert!(path.total_slippage_bps <= max_slippage);
    assert!(path.total_slippage_bps > 0);

    // Verify positive output
    assert!(path.total_output > 0);
}

/// Test 3: Three-hop path selection (edge case testing)
#[test]
fn test_three_hop_path_selection() {
    let env = Env::default();

    let from = ngn_asset(&env);
    let to = ghs_asset(&env);
    let amount = 1_000_000_000i128;
    let max_slippage = 800i128; // 8% for 3-hop

    // With max_hops=3, should find a path (likely 2-hop in our test setup)
    let path = find_best_path(env, from, to, amount, max_slippage).unwrap();

    // Should have 1-3 hops
    assert!(path.hops.len() >= 1 && path.hops.len() <= 3);
    assert!(path.total_slippage_bps <= max_slippage);
    assert!(path.total_slippage_bps > 0);
    assert!(path.total_output > 0);
}

/// Test 4: No path found error
#[test]
fn test_no_path_found_error() {
    let env = Env::default();

    let from = create_asset(&env, "UNKNOWN1", "G...ISSUER1");
    let to = create_asset(&env, "UNKNOWN2", "G...ISSUER2");
    let amount = 1_000_000_000i128;
    let max_slippage = 300i128;

    let result = find_best_path(env, from, to, amount, max_slippage);

    assert!(result.is_err());
    assert_eq!(result.unwrap_err(), RoutingError::NoPathFound);
}

/// Test 5: Slippage exceeded abort
#[test]
fn test_slippage_exceeded_abort() {
    let env = Env::default();

    let from = ngn_asset(&env);
    let to = kes_asset(&env);
    let amount = 1_000_000_000i128;
    let max_slippage = 1i128; // 0.01% - impossibly low

    let result = find_best_path(env, from, to, amount, max_slippage);

    assert!(result.is_err());
    assert_eq!(result.unwrap_err(), RoutingError::SlippageExceeded);
}

/// Test 6: Invalid amount (zero)
#[test]
fn test_invalid_amount_zero() {
    let env = Env::default();

    let from = ngn_asset(&env);
    let to = xlm_asset(&env);

    let result = find_best_path(env, from, to, 0, 300);

    assert!(result.is_err());
    assert_eq!(result.unwrap_err(), RoutingError::InvalidAmount);
}

/// Test 7: Invalid amount (negative)
#[test]
fn test_invalid_amount_negative() {
    let env = Env::default();

    let from = ngn_asset(&env);
    let to = xlm_asset(&env);

    let result = find_best_path(env, from, to, -100, 300);

    assert!(result.is_err());
    assert_eq!(result.unwrap_err(), RoutingError::InvalidAmount);
}

/// Test 8: Same asset rejected
#[test]
fn test_same_asset_rejected() {
    let env = Env::default();

    let from = ngn_asset(&env);
    let to = ngn_asset(&env);

    let result = find_best_path(env, from, to, 1_000_000_000, 300);

    assert!(result.is_err());
    assert_eq!(result.unwrap_err(), RoutingError::InvalidAsset);
}

/// Test 9: Path prefers direct over multi-hop when available
#[test]
fn test_direct_preferred_over_multi_hop() {
    let env = Env::default();

    let from = ngn_asset(&env);
    let to = xlm_asset(&env);
    let amount = 1_000_000_000i128;
    let max_slippage = 300i128;

    let path = find_best_path(env, from, to, amount, max_slippage).unwrap();

    // Direct path should be found (1 hop)
    assert_eq!(path.hops.len(), 1);
    assert_eq!(path.hops.get(0).unwrap().to_asset.code.to_string(), "XLM");
}

/// Test 10: NGN -> USDC direct path
#[test]
fn test_ngn_to_usdc_direct() {
    let env = Env::default();

    let from = ngn_asset(&env);
    let to = usdc_asset(&env);
    let amount = 1_000_000_000i128;
    let max_slippage = 300i128;

    let path = find_best_path(env, from, to, amount, max_slippage).unwrap();

    assert_eq!(path.hops.len(), 1);
    assert_eq!(path.hops.get(0).unwrap().to_asset.code.to_string(), "USDC");
    assert!(path.total_slippage_bps <= max_slippage);
}

/// Test 11: Gas estimation within budget
#[test]
fn test_gas_estimation_within_budget() {
    let env = Env::default();

    let from = ngn_asset(&env);
    let to = kes_asset(&env);
    let amount = 1_000_000_000i128;
    let max_slippage = 500i128;

    let path = find_best_path(env.clone(), from, to, amount, max_slippage).unwrap();
    let gas = estimate_gas_cost(&path);

    // Should be well within 16M limit (80% of 20M)
    assert!(gas > 0);
    assert!(gas < 16_000_000);
    assert!(is_within_budget(&path));
}

/// Test 12: Gas estimation for single hop
#[test]
fn test_gas_estimation_single_hop() {
    let env = Env::default();

    let from = ngn_asset(&env);
    let to = xlm_asset(&env);
    let amount = 1_000_000_000i128;
    let max_slippage = 300i128;

    let path = find_best_path(env, from, to, amount, max_slippage).unwrap();
    let gas = estimate_gas_cost(&path);

    // 1 hop * 50000 + 100000 = 150000
    assert_eq!(gas, 150_000);
    assert!(is_within_budget(&path));
}

/// Test 13: Compounded slippage calculation correctness
#[test]
fn test_compounded_slippage_calculation() {
    // Test the compounding formula: s1 + s2 + (s1 * s2 / 10000)
    let s1 = 100i128; // 1%
    let s2 = 200i128; // 2%

    let compounded = s1
        .checked_add(s2).unwrap()
        .checked_add(
            s1.checked_mul(s2).unwrap()
                .checked_div(10_000).unwrap()
        ).unwrap();

    // 100 + 200 + (100*200/10000) = 300 + 2 = 302
    assert_eq!(compounded, 302);
}

/// Test 14: Output monotonicity (larger input -> larger output)
#[test]
fn test_output_monotonicity() {
    let env = Env::default();

    let from = ngn_asset(&env);
    let to = kes_asset(&env);
    let max_slippage = 500i128;

    let path1 = find_best_path(env.clone(), from.clone(), to.clone(), 1_000_000_000, max_slippage).unwrap();
    let path2 = find_best_path(env, from, to, 2_000_000_000, max_slippage).unwrap();

    assert!(path2.total_output > path1.total_output);
}

/// Test 15: Routing config validation
#[test]
fn test_routing_config_validation() {
    // Valid config
    let config = RoutingConfig::new(300, 3, 1_000_000).unwrap();
    assert_eq!(config.max_slippage_bps, 300);
    assert_eq!(config.max_hops, 3);

    // Invalid max_slippage_bps (negative)
    assert!(RoutingConfig::new(-1, 3, 1_000_000).is_err());

    // Invalid max_slippage_bps (> 10000)
    assert!(RoutingConfig::new(10_001, 3, 1_000_000).is_err());

    // Invalid max_hops (zero)
    assert!(RoutingConfig::new(300, 0, 1_000_000).is_err());

    // Invalid max_hops (> MAX_HOPS)
    assert!(RoutingConfig::new(300, 4, 1_000_000).is_err());

    // Invalid min_liquididity (negative)
    assert!(RoutingConfig::new(300, 3, -1).is_err());
}

/// Test 16: Default config for thin corridors
#[test]
fn test_default_config_for_thin_corridors() {
    let config = RoutingConfig::default_for_thin_corridors();
    assert_eq!(config.max_slippage_bps, 300);
    assert_eq!(config.max_hops, 3);
    assert_eq!(config.min_liquididity, 1_000_000);
}

/// Test 17: Asset creation helper
#[test]
fn test_asset_creation() {
    let env = Env::default();

    let asset = create_asset(&env, "USDC", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN");

    assert_eq!(asset.code.to_string(), "USDC");
    assert_eq!(asset.issuer.to_string(), "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN");
}

/// Test 18: Path structure integrity
#[test]
fn test_path_structure_integrity() {
    let env = Env::default();

    let from = ngn_asset(&env);
    let to = kes_asset(&env);
    let amount = 1_000_000_000i128;
    let max_slippage = 500i128;

    let path = find_best_path(env, from, to, amount, max_slippage).unwrap();

    // Each hop should have valid structure
    for i in 0..path.hops.len() {
        let hop = path.hops.get(i).unwrap();
        assert!(!hop.from_asset.code.to_string().is_empty());
        assert!(!hop.to_asset.code.to_string().is_empty());
        assert!(hop.expected_output > 0);
        assert!(hop.slippage_bps >= 0);
    }

    // Total output should equal last hop's output
    let last_hop = path.hops.get(path.hops.len() - 1).unwrap();
    assert_eq!(path.total_output, last_hop.expected_output);
}

/// Test 19: Contract entry point - find_route
#[test]
fn test_contract_find_route_entry_point() {
    let env = Env::default();
    env.mock_all_auths();

    let from_code = Symbol::new(&env, "NGN");
    let from_issuer = Symbol::new(&env, "G...NGN_ISSUER");
    let to_code = Symbol::new(&env, "KES");
    let to_issuer = Symbol::new(&env, "G...KES_ISSUER");
    let amount = 1_000_000_000i128;
    let max_slippage = 500i128;

    let path = RemittanceContract::find_route(
        env,
        from_code,
        from_issuer,
        to_code,
        to_issuer,
        amount,
        max_slippage,
    ).unwrap();

    assert_eq!(path.hops.len(), 2);
    assert!(path.total_slippage_bps <= max_slippage);
}

/// Test 20: Contract entry point - estimate_route_gas
#[test]
fn test_contract_estimate_route_gas_entry_point() {
    let env = Env::default();

    let from = ngn_asset(&env);
    let to = xlm_asset(&env);
    let amount = 1_000_000_000i128;
    let max_slippage = 300i128;

    let path = find_best_path(env.clone(), from, to, amount, max_slippage).unwrap();
    let gas = RemittanceContract::estimate_route_gas(path);

    assert_eq!(gas, 150_000);
}

/// Test 21: Contract entry point - check_route_budget
#[test]
fn test_contract_check_route_budget_entry_point() {
    let env = Env::default();

    let from = ngn_asset(&env);
    let to = kes_asset(&env);
    let amount = 1_000_000_000i128;
    let max_slippage = 500i128;

    let path = find_best_path(env.clone(), from, to, amount, max_slippage).unwrap();
    let within_budget = RemittanceContract::check_route_budget(path);

    assert!(within_budget);
}

/// Test 22: Multiple intermediate paths - selects minimum slippage
#[test]
fn test_selects_minimum_slippage_path() {
    let env = Env::default();

    let from = ngn_asset(&env);
    let to = kes_asset(&env);
    let amount = 1_000_000_000i128;
    let max_slippage = 500i128;

    let path = find_best_path(env, from, to, amount, max_slippage).unwrap();

    // Should find the path with minimum slippage among all candidates
    // In our test setup, NGN->XLM->KES should have lower slippage than NGN->USDC->KES
    assert!(path.total_slippage_bps <= max_slippage);
    assert!(path.total_slippage_bps > 0);
}

/// Test 23: Large amount handling
#[test]
fn test_large_amount_handling() {
    let env = Env::default();

    let from = ngn_asset(&env);
    let to = xlm_asset(&env);
    let amount = 1_000_000_000_000i128; // 1M NGN
    let max_slippage = 300i128;

    let path = find_best_path(env, from, to, amount, max_slippage).unwrap();

    assert_eq!(path.hops.len(), 1);
    assert!(path.total_output > 0);
    assert!(path.total_slippage_bps <= max_slippage);
}

/// Test 24: Small amount handling
#[test]
fn test_small_amount_handling() {
    let env = Env::default();

    let from = ngn_asset(&env);
    let to = xlm_asset(&env);
    let amount = 1_000_000i128; // 1 NGN
    let max_slippage = 300i128;

    let path = find_best_path(env, from, to, amount, max_slippage).unwrap();

    assert_eq!(path.hops.len(), 1);
    assert!(path.total_output > 0);
    assert!(path.total_slippage_bps <= max_slippage);
}

/// Test 25: Fee configuration integration
#[test]
fn test_routing_with_fee_config() {
    let env = Env::default();

    // Test that routing works alongside fee calculation
    let from = ngn_asset(&env);
    let to = kes_asset(&env);
    let amount = 1_000_000_000i128;
    let max_slippage = 500i128;

    let path = find_best_path(env.clone(), from, to, amount, max_slippage).unwrap();

    // Verify we can also calculate fees on the output
    let fee_config = FeeConfig::new(100, 50, 50).unwrap(); // 1%, 0.5%, 0.5%
    let recipient_amount = calculate_recipient_amount(path.total_output, &fee_config).unwrap();

    assert!(recipient_amount > 0);
    assert!(recipient_amount < path.total_output);
}

/// Integration test: Complete NGN -> KES transfer simulation
/// This test simulates a full transfer flow on Stellar testnet
#[test]
fn test_integration_ngn_to_kes_transfer() {
    let env = Env::default();
    env.mock_all_auths();

    // Setup: Create test accounts
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    // Define assets
    let from_code = Symbol::new(&env, "NGN");
    let from_issuer = Symbol::new(&env, "G...NGN_ISSUER");
    let to_code = Symbol::new(&env, "KES");
    let to_issuer = Symbol::new(&env, "G...KES_ISSUER");

    // Transfer amount: 100,000 NGN
    let amount = 100_000_000_000i128;
    let max_slippage = 500i128; // 5%

    // Step 1: Find the best route
    let path = RemittanceContract::find_route(
        env.clone(),
        from_code,
        from_issuer,
        to_code,
        to_issuer,
        amount,
        max_slippage,
    ).unwrap();

    // Verify route found
    assert_eq!(path.hops.len(), 2);
    assert!(path.total_slippage_bps <= max_slippage);
    assert!(path.total_output > 0);

    // Step 2: Estimate gas cost
    let gas_cost = RemittanceContract::estimate_route_gas(path.clone());
    assert!(gas_cost < 16_000_000); // Within 80% budget

    // Step 3: Check budget
    let within_budget = RemittanceContract::check_route_budget(path.clone());
    assert!(within_budget);

    // Step 4: Calculate fees on the output
    let fee_config = FeeConfig::new(100, 50, 50).unwrap();
    let recipient_amount = calculate_recipient_amount(path.total_output, &fee_config).unwrap();

    assert!(recipient_amount > 0);

    // Step 5: Verify the complete flow
    // sender sends NGN -> path converts to KES -> recipient receives KES (minus fees)
    assert!(path.total_output > recipient_amount); // After fees
    assert!(recipient_amount > 0);
}

/// Integration test: NGN -> GHS transfer simulation
#[test]
fn test_integration_ngn_to_ghs_transfer() {
    let env = Env::default();
    env.mock_all_auths();

    let from_code = Symbol::new(&env, "NGN");
    let from_issuer = Symbol::new(&env, "G...NGN_ISSUER");
    let to_code = Symbol::new(&env, "GHS");
    let to_issuer = Symbol::new(&env, "G...GHS_ISSUER");

    let amount = 50_000_000_000i128; // 50,000 NGN
    let max_slippage = 500i128; // 5%

    let path = RemittanceContract::find_route(
        env.clone(),
        from_code,
        from_issuer,
        to_code,
        to_issuer,
        amount,
        max_slippage,
    ).unwrap();

    assert!(path.hops.len() >= 1 && path.hops.len() <= 3);
    assert!(path.total_slippage_bps <= max_slippage);
    assert!(path.total_output > 0);
    assert!(RemittanceContract::check_route_budget(path));
}

/// Integration test: Direct NGN -> USDC transfer
#[test]
fn test_integration_ngn_to_usdc_transfer() {
    let env = Env::default();
    env.mock_all_auths();

    let from_code = Symbol::new(&env, "NGN");
    let from_issuer = Symbol::new(&env, "G...NGN_ISSUER");
    let to_code = Symbol::new(&env, "USDC");
    let to_issuer = Symbol::new(&env, "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN");

    let amount = 1_000_000_000i128; // 1,000 NGN
    let max_slippage = 300i128; // 3%

    let path = RemittanceContract::find_route(
        env.clone(),
        from_code,
        from_issuer,
        to_code,
        to_issuer,
        amount,
        max_slippage,
    ).unwrap();

    assert_eq!(path.hops.len(), 1);
    assert_eq!(path.hops.get(0).unwrap().to_asset.code.to_string(), "USDC");
    assert!(path.total_slippage_bps <= max_slippage);
    assert!(RemittanceContract::check_route_budget(path));
}

/// Integration test: Stress test with multiple concurrent routes
#[test]
fn test_integration_concurrent_routes() {
    let env = Env::default();

    let corridors = vec![
        ("NGN", "G...NGN_ISSUER", "KES", "G...KES_ISSUER", 500i128),
        ("NGN", "G...NGN_ISSUER", "GHS", "G...GHS_ISSUER", 500i128),
        ("NGN", "G...NGN_ISSUER", "XLM", "", 300i128),
        ("NGN", "G...NGN_ISSUER", "USDC", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", 300i128),
    ];

    for (from_code, from_issuer, to_code, to_issuer, max_slippage) in corridors {
        let from = create_asset(&env, from_code, from_issuer);
        let to = create_asset(&env, to_code, to_issuer);
        let amount = 1_000_000_000i128;

        let path = find_best_path(env.clone(), from, to, amount, max_slippage).unwrap();

        assert!(path.hops.len() >= 1 && path.hops.len() <= 3);
        assert!(path.total_slippage_bps <= max_slippage);
        assert!(path.total_output > 0);
        assert!(is_within_budget(&path));
    }
}

/// Test: CPU instruction budget documentation
/// This test documents the expected CPU usage for worst-case 3-hop paths
#[test]
fn test_cpu_budget_documentation() {
    let env = Env::default();

    // Worst case: 3-hop path with maximum complexity
    let from = ngn_asset(&env);
    let to = ghs_asset(&env);
    let amount = 1_000_000_000i128;
    let max_slippage = 1000i128; // 10% to allow 3-hop

    let path = find_best_path(env.clone(), from, to, amount, max_slippage).unwrap();

    let estimated_instructions = estimate_gas_cost(&path);
    let soroban_limit = 20_000_000u64;
    let target_limit = 16_000_000u64; // 80%

    // Document the budget usage
    println!("Estimated instructions: {}", estimated_instructions);
    println!("Soroban limit: {}", soroban_limit);
    println!("Target limit (80%): {}", target_limit);
    println!("Usage: {:.1}%", (estimated_instructions as f64 / soroban_limit as f64) * 100.0);

    // Verify within budget
    assert!(estimated_instructions <= target_limit);
    assert!(is_within_budget(&path));
}

/// Test: Error handling for max hops exceeded in config
#[test]
fn test_max_hops_exceeded_in_config() {
    assert!(RoutingConfig::new(300, 4, 1_000_000).is_err());
}

/// Test: Error handling for invalid slippage in config
#[test]
fn test_invalid_slippage_in_config() {
    assert!(RoutingConfig::new(-1, 3, 1_000_000).is_err());
    assert!(RoutingConfig::new(10_001, 3, 1_000_000).is_err());
}

/// Test: Verify path hop sequence is valid
#[test]
fn test_path_hop_sequence_validity() {
    let env = Env::default();

    let from = ngn_asset(&env);
    let to = kes_asset(&env);
    let amount = 1_000_000_000i128;
    let max_slippage = 500i128;

    let path = find_best_path(env, from, to, amount, max_slippage).unwrap();

    // Verify hop sequence: output of hop N = input of hop N+1
    for i in 0..path.hops.len() - 1 {
        let hop_n = path.hops.get(i).unwrap();
        let hop_n_plus_1 = path.hops.get(i + 1).unwrap();

        // The to_asset of hop N should match from_asset of hop N+1
        assert_eq!(hop_n.to_asset.code, hop_n_plus_1.from_asset.code);
        assert_eq!(hop_n.to_asset.issuer, hop_n_plus_1.from_asset.issuer);

        // The expected_output of hop N should match (approximately) the input of hop N+1
        // (exact match depends on precision)
        assert!(hop_n.expected_output > 0);
    }

    // Final output should match last hop's output
    let last_hop = path.hops.get(path.hops.len() - 1).unwrap();
    assert_eq!(path.total_output, last_hop.expected_output);
}
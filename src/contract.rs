use soroban_sdk::{
    contract, contractimpl, contracttype, Address, Env, Map, String as SorobanString, Symbol,
    Vec, Bytes,
};
use crate::{
    escrow::{Escrow, EscrowState},
    oracle::OracleAttestation,
    errors::RemittanceError,
    events::EventEmitter,
    migration,
};

const USDC_ISSUER: &str = "GBBD47UZQ5PBC4GHW2REORM2HJW5AU4OT4QC5TFW76ZAYDG5ZWQGURNZ"; // Testnet USDC
const USDC_CODE: &str = "USDC";
const MAX_TIMEOUT_LEDGERS: u32 = 1_000_000; // ~5 days at ~4.5s blocks
const MIN_AMOUNT: i128 = 1_000_000; // 0.1 USDC in stroops
const MAX_AMOUNT: i128 = 1_000_000_000_000; // 100M USDC

/// Contract instance metadata
#[contracttype]
pub struct ContractInfo {
    /// Admin address (can pause, upgrade, manage oracles)
    pub admin: Address,
    /// Whether contract is paused
    pub paused: bool,
    /// Total fees collected by admin
    pub fees_collected: i128,
    /// Supported oracle operators
    pub oracle_operators: Map<Address, bool>,
    /// Contract version
    pub version: u32,
}

/// Main remittance contract
#[contract]
pub struct RemittanceContract;

#[contractimpl]
impl RemittanceContract {
    /// Initialize the contract
    pub fn initialize(env: Env, admin: Address) -> Result<(), RemittanceError> {
        // Check if already initialized
        if env.storage().instance().has(&Symbol::new(&env, "info")) {
            return Err(RemittanceError::AlreadyInitialized);
        }

        let info = ContractInfo {
            admin: admin.clone(),
            paused: false,
            fees_collected: 0,
            oracle_operators: Map::new(&env),
            version: 1,
        };

        env.storage()
            .instance()
            .set(&Symbol::new(&env, "info"), &info);

        // Initialize empty escrow map
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "escrows"), &Map::<SorobanString, Escrow>::new(&env));

        // Record the initial schema version so migrate() has a baseline.
        migration::set_initial_schema_version(&env);

        Ok(())
    }

    /// Deposit funds into escrow
    /// Sender locks USDC to receive local currency
    pub fn deposit_escrow(
        env: Env,
        sender: Address,
        agent: Address,
        amount: i128,
        recipient_country: SorobanString,
        recipient_account_hash: Vec<u8>,
        fiat_amount: i128,
        fiat_currency: SorobanString,
        exchange_rate: i128,
        timeout_minutes: u32,
    ) -> Result<SorobanString, RemittanceError> {
        // Verify sender authorized
        sender.require_auth();

        // Get contract info
        let info: ContractInfo = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "info"))
            .ok_or(RemittanceError::NotInitialized)?;

        if info.paused {
            return Err(RemittanceError::OperationFailed);
        }

        // Validate inputs
        if amount < MIN_AMOUNT || amount > MAX_AMOUNT {
            return Err(RemittanceError::InvalidAmount);
        }
        if timeout_minutes == 0 || timeout_minutes > 10_080 {
            return Err(RemittanceError::InvalidTimeout); // Max 7 days
        }
        if exchange_rate <= 0 {
            return Err(RemittanceError::InvalidAmount);
        }

        // Calculate timeout ledger (approx. 4.5 seconds per ledger)
        let ledger_height = env.ledger().sequence();
        let timeout_ledgers = (timeout_minutes as u32) * 60 / 4; // ~15 ledgers per minute
        let timeout_ledger = ledger_height
            .checked_add(timeout_ledgers)
            .ok_or(RemittanceError::InvalidTimeout)?;

        if timeout_ledger > MAX_TIMEOUT_LEDGERS {
            return Err(RemittanceError::InvalidTimeout);
        }

        // Transfer USDC from sender to contract
        transfer_usdc_to_contract(&env, &sender, amount)?;

        // Generate unique escrow ID
        let escrow_id = generate_escrow_id(&env);

        // Create escrow
        let escrow = Escrow::new(
            escrow_id.clone(),
            sender.clone(),
            agent,
            amount,
            SorobanString::from_slice(&env, USDC_CODE.as_bytes()),
            Address::from_contract_id(
                &env,
                &Bytes::from_slice(&env, USDC_ISSUER.as_bytes()),
            ),
            recipient_country.clone(),
            recipient_account_hash,
            fiat_amount,
            fiat_currency,
            exchange_rate,
            timeout_ledger,
            ledger_height,
            get_current_timestamp(&env),
        );

        // Store escrow
        let mut escrows: Map<SorobanString, Escrow> = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "escrows"))
            .unwrap_or_else(|_| Map::new(&env));

        escrows.set(escrow_id.clone(), escrow.clone());
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "escrows"), &escrows);

        // Emit deposit event
        EventEmitter::emit_deposit(
            &env,
            escrow_id.clone(),
            sender,
            amount,
            SorobanString::from_slice(&env, USDC_CODE.as_bytes()),
            recipient_country,
            timeout_ledger,
        );

        Ok(escrow_id)
    }

    /// Release funds to off-ramp agent (oracle confirms delivery)
    pub fn release_to_agent(
        env: Env,
        escrow_id: SorobanString,
        attestation: OracleAttestation,
    ) -> Result<(), RemittanceError> {
        // Get contract info and verify oracle is authorized
        let info: ContractInfo = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "info"))
            .ok_or(RemittanceError::NotInitialized)?;

        let is_oracle = info
            .oracle_operators
            .get(attestation.oracle.clone())
            .unwrap_or(false);

        if !is_oracle {
            return Err(RemittanceError::NotOracleOperator);
        }

        // Get escrow
        let mut escrows: Map<SorobanString, Escrow> = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "escrows"))
            .ok_or(RemittanceError::EscrowNotFound)?;

        let mut escrow = escrows
            .get(escrow_id.clone())
            .ok_or(RemittanceError::EscrowNotFound)?;

        // Verify escrow is locked
        if escrow.state != EscrowState::Locked {
            return Err(RemittanceError::InvalidEscrowState);
        }

        // Verify attestation (signature check)
        if !attestation.verify_signature(&env) {
            return Err(RemittanceError::InvalidSignature);
        }

        // If delivery failed, mark as refundable
        if !attestation.delivery_success {
            escrow.mark_refundable(env.ledger().sequence());
            escrows.set(escrow_id, escrow);
            env.storage()
                .instance()
                .set(&Symbol::new(&env, "escrows"), &escrows);
            return Ok(());
        }

        // Transfer USDC to agent
        transfer_usdc_from_contract(&env, &escrow.agent, escrow.amount)?;

        // Update escrow state
        escrow.release(
            attestation.oracle.clone(),
            attestation.delivery_proof.clone(),
            env.ledger().sequence(),
            get_current_timestamp(&env),
        );

        escrows.set(escrow_id.clone(), escrow);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "escrows"), &escrows);

        // Emit release event
        EventEmitter::emit_release(
            &env,
            escrow_id,
            attestation.oracle,
            escrow.amount,
            attestation.delivery_proof,
        );

        Ok(())
    }

    /// Claim refund (sender, after timeout or delivery failure)
    pub fn claim_refund(env: Env, escrow_id: SorobanString) -> Result<(), RemittanceError> {
        // Get escrow
        let mut escrows: Map<SorobanString, Escrow> = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "escrows"))
            .ok_or(RemittanceError::EscrowNotFound)?;

        let mut escrow = escrows
            .get(escrow_id.clone())
            .ok_or(RemittanceError::EscrowNotFound)?;

        // Verify sender
        escrow.sender.require_auth();

        // Check if timeout elapsed or delivery failed
        let current_ledger = env.ledger().sequence();
        let is_timeout = current_ledger >= escrow.timeout_ledger;
        let is_refundable = escrow.state == EscrowState::Refundable;

        if !is_timeout && !is_refundable {
            return Err(RemittanceError::InvalidEscrowState);
        }

        // Mark as refundable if timeout
        if is_timeout && escrow.state == EscrowState::Locked {
            escrow.mark_refundable(current_ledger);
        }

        // Transfer USDC back to sender
        transfer_usdc_from_contract(&env, &escrow.sender, escrow.amount)?;

        // Update escrow state
        escrow.refund(current_ledger);
        escrows.set(escrow_id.clone(), escrow);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "escrows"), &escrows);

        // Emit refund event
        EventEmitter::emit_refund(
            &env,
            escrow_id,
            escrow.sender,
            escrow.amount,
            SorobanString::from_slice(&env, b"sender_claim"),
        );

        Ok(())
    }

    /// Get escrow details
    pub fn get_escrow(env: Env, escrow_id: SorobanString) -> Result<Escrow, RemittanceError> {
        let escrows: Map<SorobanString, Escrow> = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "escrows"))
            .ok_or(RemittanceError::EscrowNotFound)?;

        escrows
            .get(escrow_id)
            .ok_or(RemittanceError::EscrowNotFound)
    }

    /// Register an oracle operator
    pub fn register_oracle(env: Env, oracle: Address) -> Result<(), RemittanceError> {
        let mut info: ContractInfo = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "info"))
            .ok_or(RemittanceError::NotInitialized)?;

        // Only admin can register oracles
        info.admin.require_auth();

        info.oracle_operators.set(oracle, true);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "info"), &info);

        Ok(())
    }

    /// Pause/unpause contract
    pub fn set_paused(env: Env, paused: bool) -> Result<(), RemittanceError> {
        let mut info: ContractInfo = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "info"))
            .ok_or(RemittanceError::NotInitialized)?;

        info.admin.require_auth();
        info.paused = paused;
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "info"), &info);

        Ok(())
    }

    /// Apply pending schema migrations after a WASM upgrade.
    ///
    /// This entry point must be called exactly once after each WASM swap that
    /// introduces storage schema changes.  Calling it when already at the
    /// target version is a no-op and returns `Ok(())`.
    ///
    /// Only the contract admin may call this function.
    ///
    /// # Errors
    ///
    /// - [`RemittanceError::NotInitialized`] if the contract has not been initialised.
    /// - [`RemittanceError::Unauthorized`] if `admin` is not the stored admin address.
    /// - [`RemittanceError::OperationFailed`] if a downgrade or unknown version is
    ///   detected.
    pub fn migrate(env: Env, admin: Address) -> Result<(), RemittanceError> {
        migration::migrate(&env, admin)
    }
}

// Helper functions

fn transfer_usdc_to_contract(env: &Env, from: &Address, amount: i128) -> Result<(), RemittanceError> {
    // Call USDC contract's transfer function
    // This is simplified; production uses soroban_sdk::token_client
    Ok(())
}

fn transfer_usdc_from_contract(
    env: &Env,
    to: &Address,
    amount: i128,
) -> Result<(), RemittanceError> {
    // Call USDC contract's transfer function (as contract)
    Ok(())
}

fn generate_escrow_id(env: &Env) -> SorobanString {
    // Generate UUID or counter-based ID
    let counter: u64 = env
        .storage()
        .instance()
        .get(&Symbol::new(env, "escrow_counter"))
        .unwrap_or(0);

    let new_counter = counter + 1;
    env.storage()
        .instance()
        .set(&Symbol::new(env, "escrow_counter"), &new_counter);

    SorobanString::from_slice(env, format!("escrow_{}", new_counter).as_bytes())
}

fn get_current_timestamp(env: &Env) -> u64 {
    env.ledger().timestamp()
}

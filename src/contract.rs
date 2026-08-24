use crate::{
    errors::RemittanceError,
    escrow::{Escrow, EscrowState},
    events::EventEmitter,
    migration,
    oracle::OracleAttestation,
};
use soroban_sdk::{
    contract, contractimpl, contracttype, Address, Bytes, BytesN, Env, Map,
    String as SorobanString, Symbol, Vec,
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

/// The amounts approved by arbiters for a disputed escrow. `Split` is the
/// sender's amount; the agent receives the remainder.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ResolutionDecision {
    Sender,
    Agent,
    Split(i128),
}

/// Immutable metadata captured when a dispute is raised. It is stored under a
/// new key rather than appended to `Escrow`, preserving the escrow XDR layout.
#[contracttype]
#[derive(Clone)]
pub struct Dispute {
    pub evidence_hash: BytesN<32>,
    pub raised_at: u64,
}

const KEY_ARBITERS: &str = "arbiters";
const KEY_ARBITER_THRESHOLD: &str = "arbiter_threshold";
const KEY_ADMIN_SIGNERS: &str = "admin_signers";
const KEY_ADMIN_THRESHOLD: &str = "admin_threshold";
const KEY_DISPUTES: &str = "disputes";

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
        env.storage().instance().set(
            &Symbol::new(&env, "escrows"),
            &Map::<SorobanString, Escrow>::new(&env),
        );

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
            Address::from_contract_id(&env, &Bytes::from_slice(&env, USDC_ISSUER.as_bytes())),
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

    /// Configure the initial admin multisig set. The original deployment admin
    /// may do this once; subsequent rotations use `rotate_admin_multisig` and
    /// therefore require the existing threshold.
    pub fn configure_admin_multisig(
        env: Env,
        signers: Vec<Address>,
        threshold: u32,
    ) -> Result<(), RemittanceError> {
        let info = load_info(&env)?;
        if env
            .storage()
            .instance()
            .has(&Symbol::new(&env, KEY_ADMIN_SIGNERS))
        {
            return Err(RemittanceError::InvalidEscrowState);
        }
        info.admin.require_auth();
        validate_signer_set(&env, &signers, threshold)?;
        store_admin_multisig(&env, signers, threshold);
        Ok(())
    }

    /// Rotate governance signers. Existing M-of-N governance authorizations
    /// must approve the rotation, preventing a single admin key from taking
    /// over after multisig has been enabled.
    pub fn rotate_admin_multisig(
        env: Env,
        approvals: Vec<Address>,
        signers: Vec<Address>,
        threshold: u32,
    ) -> Result<(), RemittanceError> {
        let info = load_info(&env)?;
        require_admin_approval(&env, &info, &approvals)?;
        validate_signer_set(&env, &signers, threshold)?;
        store_admin_multisig(&env, signers, threshold);
        Ok(())
    }

    /// Add an authorized arbiter. Governance authorization is a Soroban
    /// account signature and is cryptographically bound to this invocation.
    pub fn register_arbiter(
        env: Env,
        approvals: Vec<Address>,
        arbiter: Address,
    ) -> Result<(), RemittanceError> {
        let info = load_info(&env)?;
        require_admin_approval(&env, &info, &approvals)?;
        let mut arbiters = load_address_set(&env, KEY_ARBITERS);
        arbiters.set(arbiter, true);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, KEY_ARBITERS), &arbiters);
        Ok(())
    }

    /// Remove an arbiter. The current threshold must remain satisfiable.
    pub fn remove_arbiter(
        env: Env,
        approvals: Vec<Address>,
        arbiter: Address,
    ) -> Result<(), RemittanceError> {
        let info = load_info(&env)?;
        require_admin_approval(&env, &info, &approvals)?;
        let mut arbiters = load_address_set(&env, KEY_ARBITERS);
        arbiters.remove(arbiter);
        let threshold: u32 = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, KEY_ARBITER_THRESHOLD))
            .unwrap_or(0);
        if threshold > arbiters.len() {
            return Err(RemittanceError::InvalidThreshold);
        }
        env.storage()
            .instance()
            .set(&Symbol::new(&env, KEY_ARBITERS), &arbiters);
        Ok(())
    }

    /// Set the M value required to resolve a dispute.
    pub fn set_arbiter_threshold(
        env: Env,
        approvals: Vec<Address>,
        threshold: u32,
    ) -> Result<(), RemittanceError> {
        let info = load_info(&env)?;
        require_admin_approval(&env, &info, &approvals)?;
        if threshold == 0 || threshold > load_address_set(&env, KEY_ARBITERS).len() {
            return Err(RemittanceError::InvalidThreshold);
        }
        env.storage()
            .instance()
            .set(&Symbol::new(&env, KEY_ARBITER_THRESHOLD), &threshold);
        Ok(())
    }

    /// Raise a dispute before expiry. `escrow.sender.require_auth()` is the
    /// sender signature: Soroban verifies it against the invocation arguments,
    /// including the evidence hash, so a detached/replayable signature is not
    /// accepted.
    pub fn raise_dispute(
        env: Env,
        escrow_id: SorobanString,
        evidence_hash: BytesN<32>,
    ) -> Result<(), RemittanceError> {
        let mut escrows = load_escrows(&env)?;
        let mut escrow = escrows
            .get(escrow_id.clone())
            .ok_or(RemittanceError::EscrowNotFound)?;
        escrow.sender.require_auth();
        if escrow.state != EscrowState::Locked || env.ledger().sequence() >= escrow.timeout_ledger {
            return Err(RemittanceError::InvalidEscrowState);
        }

        escrow.dispute(env.ledger().sequence());
        escrows.set(escrow_id.clone(), escrow.clone());
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "escrows"), &escrows);
        let mut disputes: Map<SorobanString, Dispute> = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, KEY_DISPUTES))
            .unwrap_or_else(|| Map::new(&env));
        disputes.set(
            escrow_id.clone(),
            Dispute {
                evidence_hash: evidence_hash.clone(),
                raised_at: get_current_timestamp(&env),
            },
        );
        env.storage()
            .instance()
            .set(&Symbol::new(&env, KEY_DISPUTES), &disputes);
        EventEmitter::emit_dispute_raised(&env, escrow_id, escrow.sender, evidence_hash);
        Ok(())
    }

    /// Resolve a disputed escrow after M distinct registered arbiters have
    /// supplied Soroban account authorizations. The execution transaction's
    /// signatures are verified by the host; no unauthenticated signature bytes
    /// are ever trusted by contract code.
    pub fn resolve_dispute(
        env: Env,
        escrow_id: SorobanString,
        arbiter_signers: Vec<Address>,
        decision: ResolutionDecision,
    ) -> Result<(), RemittanceError> {
        let threshold: u32 = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, KEY_ARBITER_THRESHOLD))
            .ok_or(RemittanceError::InvalidThreshold)?;
        require_registered_approvals(&env, &arbiter_signers, KEY_ARBITERS, threshold, false)?;
        let mut escrows = load_escrows(&env)?;
        let mut escrow = escrows
            .get(escrow_id.clone())
            .ok_or(RemittanceError::EscrowNotFound)?;
        if escrow.state != EscrowState::Disputed {
            return Err(RemittanceError::InvalidEscrowState);
        }
        let (sender_amount, agent_amount) = resolution_amounts(&escrow, decision)?;
        if sender_amount > 0 {
            transfer_usdc_from_contract(&env, &escrow.sender, sender_amount)?;
        }
        if agent_amount > 0 {
            transfer_usdc_from_contract(&env, &escrow.agent, agent_amount)?;
        }
        escrow.state = if sender_amount == escrow.amount {
            EscrowState::Refunded
        } else {
            EscrowState::Released
        };
        escrow.last_modified_ledger = env.ledger().sequence();
        escrow.released_at = Some(get_current_timestamp(&env));
        escrows.set(escrow_id.clone(), escrow);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "escrows"), &escrows);
        EventEmitter::emit_dispute_resolved(
            &env,
            escrow_id,
            sender_amount,
            agent_amount,
            arbiter_signers.len(),
        );
        Ok(())
    }

    /// Swap the contract WASM after the configured admin M-of-N authorizes it.
    /// Existing instance storage is retained by Soroban; new storage must use
    /// compatible keys/types or be introduced through `migrate`.
    pub fn upgrade(
        env: Env,
        approvals: Vec<Address>,
        new_wasm_hash: BytesN<32>,
    ) -> Result<(), RemittanceError> {
        let info = load_info(&env)?;
        require_admin_approval(&env, &info, &approvals)?;
        env.deployer().update_current_contract_wasm(new_wasm_hash);
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

fn load_info(env: &Env) -> Result<ContractInfo, RemittanceError> {
    env.storage()
        .instance()
        .get(&Symbol::new(env, "info"))
        .ok_or(RemittanceError::NotInitialized)
}

fn load_escrows(env: &Env) -> Result<Map<SorobanString, Escrow>, RemittanceError> {
    env.storage()
        .instance()
        .get(&Symbol::new(env, "escrows"))
        .ok_or(RemittanceError::EscrowNotFound)
}

fn load_address_set(env: &Env, key: &str) -> Map<Address, bool> {
    env.storage()
        .instance()
        .get(&Symbol::new(env, key))
        .unwrap_or_else(|| Map::new(env))
}

fn validate_signer_set(
    env: &Env,
    signers: &Vec<Address>,
    threshold: u32,
) -> Result<(), RemittanceError> {
    if threshold == 0 || signers.len() < threshold {
        return Err(RemittanceError::InvalidThreshold);
    }
    let mut unique = Map::<Address, bool>::new(env);
    for signer in signers.iter() {
        if unique.get(signer.clone()).unwrap_or(false) {
            return Err(RemittanceError::DuplicateSigner);
        }
        unique.set(signer, true);
    }
    Ok(())
}

fn store_admin_multisig(env: &Env, signers: Vec<Address>, threshold: u32) {
    let mut administrators = Map::<Address, bool>::new(env);
    for signer in signers.iter() {
        administrators.set(signer, true);
    }
    env.storage()
        .instance()
        .set(&Symbol::new(env, KEY_ADMIN_SIGNERS), &administrators);
    env.storage()
        .instance()
        .set(&Symbol::new(env, KEY_ADMIN_THRESHOLD), &threshold);
}

fn require_admin_approval(
    env: &Env,
    info: &ContractInfo,
    approvals: &Vec<Address>,
) -> Result<(), RemittanceError> {
    if !env
        .storage()
        .instance()
        .has(&Symbol::new(env, KEY_ADMIN_SIGNERS))
    {
        // Governance must be explicitly configured before sensitive operations
        // (including upgrades) are available.
        return Err(RemittanceError::AdminThresholdNotMet);
    }
    let threshold: u32 = env
        .storage()
        .instance()
        .get(&Symbol::new(env, KEY_ADMIN_THRESHOLD))
        .ok_or(RemittanceError::AdminThresholdNotMet)?;
    let _ = info; // Retain the initialized-contract check at every call site.
    require_registered_approvals(env, approvals, KEY_ADMIN_SIGNERS, threshold, true)
}

fn require_registered_approvals(
    env: &Env,
    approvals: &Vec<Address>,
    registry_key: &str,
    threshold: u32,
    admin: bool,
) -> Result<(), RemittanceError> {
    if threshold == 0 || approvals.len() < threshold {
        return Err(if admin {
            RemittanceError::AdminThresholdNotMet
        } else {
            RemittanceError::ArbiterThresholdNotMet
        });
    }
    let registered = load_address_set(env, registry_key);
    let mut unique = Map::<Address, bool>::new(env);
    for signer in approvals.iter() {
        if unique.get(signer.clone()).unwrap_or(false) {
            return Err(RemittanceError::DuplicateSigner);
        }
        if !registered.get(signer.clone()).unwrap_or(false) {
            return Err(RemittanceError::InvalidArbiter);
        }
        // The host verifies the account's cryptographic authorization and binds
        // it to this contract invocation (including ID and decision arguments).
        signer.require_auth();
        unique.set(signer, true);
    }
    Ok(())
}

fn resolution_amounts(
    escrow: &Escrow,
    decision: ResolutionDecision,
) -> Result<(i128, i128), RemittanceError> {
    let sender_amount = match decision {
        ResolutionDecision::Sender => escrow.amount,
        ResolutionDecision::Agent => 0,
        ResolutionDecision::Split(amount) => amount,
    };
    if sender_amount < 0 || sender_amount > escrow.amount {
        return Err(RemittanceError::InvalidResolution);
    }
    let agent_amount = escrow
        .amount
        .checked_sub(sender_amount)
        .ok_or(RemittanceError::InvalidResolution)?;
    Ok((sender_amount, agent_amount))
}

fn transfer_usdc_to_contract(
    env: &Env,
    from: &Address,
    amount: i128,
) -> Result<(), RemittanceError> {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn disputed_escrow(env: &Env, amount: i128) -> Escrow {
        let mut escrow = Escrow::new(
            SorobanString::from_slice(env, b"escrow_test"),
            Address::generate(env),
            Address::generate(env),
            amount,
            SorobanString::from_slice(env, b"USDC"),
            Address::generate(env),
            SorobanString::from_slice(env, b"NG"),
            Vec::new(env),
            amount,
            SorobanString::from_slice(env, b"NGN"),
            1,
            100,
            1,
            0,
        );
        escrow.dispute(2);
        escrow
    }

    #[test]
    fn split_resolution_preserves_escrow_amount() {
        let env = Env::default();
        let escrow = disputed_escrow(&env, 100);
        assert_eq!(
            resolution_amounts(&escrow, ResolutionDecision::Split(40)),
            Ok((40, 60))
        );
    }

    #[test]
    fn resolution_rejects_oversized_split() {
        let env = Env::default();
        let escrow = disputed_escrow(&env, 100);
        assert_eq!(
            resolution_amounts(&escrow, ResolutionDecision::Split(101)),
            Err(RemittanceError::InvalidResolution)
        );
    }
}

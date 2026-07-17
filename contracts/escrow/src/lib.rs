#![no_std]
use soroban_sdk::{contract, contracttype, Address, Env, Map, Vec, String, panic};

pub mod migration;
use migration::{EscrowMigrationError, migrate as run_migrate};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EscrowState {
    Pending,
    Funded,
    Released,
    Refunded,
    Disputed,
    Resolved,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Escrow {
    pub id: String,
    pub sender: Address,
    pub beneficiary: Address,
    pub arbitrator: Address,
    pub amount: i128,
    pub asset: String,
    pub state: EscrowState,
    pub created_at: u64,
    pub funded_at: Option<u64>,
    pub timelock: u64,
    pub released_at: Option<u64>,
    pub refunded_at: Option<u64>,
    pub disputed_at: Option<u64>,
}

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    /// Create a new escrow
    pub fn create_escrow(
        env: Env,
        sender: Address,
        beneficiary: Address,
        arbitrator: Address,
        amount: i128,
        asset: String,
        timelock: u64,
    ) -> String {
        if amount <= 0 {
            panic!("Amount must be positive");
        }
        if timelock == 0 {
            panic!("Timelock must be positive");
        }

        let id = String::from_str(&env, &env.crypto().random().unwrap().to_string());
        
        let escrow = Escrow {
            id: id.clone(),
            sender: sender.clone(),
            beneficiary: beneficiary.clone(),
            arbitrator: arbitrator.clone(),
            amount,
            asset: asset.clone(),
            state: EscrowState::Pending,
            created_at: env.ledger().timestamp(),
            funded_at: None,
            timelock,
            released_at: None,
            refunded_at: None,
            disputed_at: None,
        };

        env.storage().set(&id, &escrow);
        id
    }

    /// Fund the escrow (Pending -> Funded)
    pub fn fund_escrow(env: Env, id: String, sender: Address) {
        let mut escrow = Self::get_escrow(env.clone(), id.clone());
        Self::validate_transition(&escrow.state, EscrowState::Funded);
        if escrow.sender != sender {
            panic!("Only sender can fund the escrow");
        }
        escrow.state = EscrowState::Funded;
        escrow.funded_at = Some(env.ledger().timestamp());
        env.storage().set(&id, &escrow);
    }

    /// Release funds to beneficiary (Funded -> Released)
    pub fn release_escrow(env: Env, id: String, beneficiary: Address) {
        let mut escrow = Self::get_escrow(env.clone(), id.clone());
        Self::validate_transition(&escrow.state, EscrowState::Released);
        if escrow.beneficiary != beneficiary {
            panic!("Only beneficiary can release funds");
        }
        escrow.state = EscrowState::Released;
        escrow.released_at = Some(env.ledger().timestamp());
        env.storage().set(&id, &escrow);
    }

    /// Refund funds to sender (Funded -> Refunded)
    pub fn refund_escrow(env: Env, id: String, sender: Address) {
        let mut escrow = Self::get_escrow(env.clone(), id.clone());
        Self::validate_transition(&escrow.state, EscrowState::Refunded);
        if escrow.sender != sender {
            panic!("Only sender can refund");
        }
        let current_time = env.ledger().timestamp();
        let timelock_time = escrow.created_at + escrow.timelock;
        if current_time < timelock_time {
            panic!("Timelock not expired");
        }
        escrow.state = EscrowState::Refunded;
        escrow.refunded_at = Some(env.ledger().timestamp());
        env.storage().set(&id, &escrow);
    }

    /// Dispute the escrow (Funded -> Disputed)
    pub fn dispute_escrow(env: Env, id: String, caller: Address) {
        let mut escrow = Self::get_escrow(env.clone(), id.clone());
        Self::validate_transition(&escrow.state, EscrowState::Disputed);
        if escrow.sender != caller && escrow.beneficiary != caller {
            panic!("Only sender or beneficiary can dispute");
        }
        escrow.state = EscrowState::Disputed;
        escrow.disputed_at = Some(env.ledger().timestamp());
        env.storage().set(&id, &escrow);
    }

    /// Resolve dispute (Disputed -> Resolved)
    pub fn resolve_dispute(env: Env, id: String, arbitrator: Address, _release_to_beneficiary: bool) {
        let mut escrow = Self::get_escrow(env.clone(), id.clone());
        Self::validate_transition(&escrow.state, EscrowState::Resolved);
        if escrow.arbitrator != arbitrator {
            panic!("Only arbitrator can resolve dispute");
        }
        escrow.state = EscrowState::Resolved;
        escrow.released_at = Some(env.ledger().timestamp());
        env.storage().set(&id, &escrow);
    }

    /// Get escrow data
    pub fn get_escrow(env: Env, id: String) -> Escrow {
        env.storage()
            .get(&id)
            .unwrap_or_else(|| panic!("Escrow not found"))
    }

    /// Initialise the contract and set the admin address.
    ///
    /// Must be called once after deployment before any other entry point.
    /// Sets the initial schema version so that `migrate()` has a baseline.
    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&soroban_sdk::Symbol::new(&env, migration::KEY_ADMIN)) {
            panic!("Already initialised");
        }
        env.storage()
            .instance()
            .set(&soroban_sdk::Symbol::new(&env, migration::KEY_ADMIN), &admin);
        migration::set_initial_schema_version(&env);
    }

    /// Apply pending schema migrations after a WASM upgrade.
    ///
    /// Callable only by the contract admin.  Idempotent — calling it when
    /// already at the target version returns without side effects.
    ///
    /// # Errors
    ///
    /// - [`EscrowMigrationError::AdminNotSet`] if `initialize()` has not been called.
    /// - [`EscrowMigrationError::Unauthorized`] if `admin` is not the stored admin.
    /// - [`EscrowMigrationError::VersionDowngrade`] if stored version > target.
    /// - [`EscrowMigrationError::UnknownSchemaVersion`] for unrecognised transitions.
    pub fn migrate(env: Env, admin: Address) -> Result<(), EscrowMigrationError> {
        run_migrate(&env, admin)
    }

    /// Validate state transition
    fn validate_transition(current_state: &EscrowState, next_state: EscrowState) {
        match (current_state, next_state) {
            (EscrowState::Pending, EscrowState::Funded) => (),
            (EscrowState::Funded, EscrowState::Released) => (),
            (EscrowState::Funded, EscrowState::Refunded) => (),
            (EscrowState::Funded, EscrowState::Disputed) => (),
            (EscrowState::Disputed, EscrowState::Resolved) => (),
            _ => panic!("Invalid state transition: {:?} -> {:?}", current_state, next_state),
        }
    }
}

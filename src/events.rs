use soroban_sdk::{contracttype, Address, BytesN, Env, String as SorobanString, Symbol, Vec};

/// Event emitted when funds are locked into escrow
#[contracttype]
#[derive(Clone, Debug)]
pub struct DepositEvent {
    pub escrow_id: SorobanString,
    pub sender: Address,
    pub amount: i128,
    pub asset: SorobanString,
    pub recipient_country: SorobanString,
    pub timeout_ledger: u32,
}

/// Event emitted when funds are released to off-ramp agent
#[contracttype]
#[derive(Clone, Debug)]
pub struct ReleaseEvent {
    pub escrow_id: SorobanString,
    pub agent: Address,
    pub amount: i128,
    pub delivery_proof: SorobanString,
}

/// Event emitted when sender claims a refund
#[contracttype]
#[derive(Clone, Debug)]
pub struct RefundEvent {
    pub escrow_id: SorobanString,
    pub sender: Address,
    pub amount: i128,
    pub reason: SorobanString,
}

/// Event emitted when oracle submits delivery attestation
#[contracttype]
#[derive(Clone, Debug)]
pub struct OracleSubmitEvent {
    pub escrow_id: SorobanString,
    pub oracle: Address,
    pub delivery_status: bool,
    pub timestamp: u64,
}

/// Audit record for a sender-initiated delivery dispute.
#[contracttype]
#[derive(Clone, Debug)]
pub struct DisputeRaisedEvent {
    pub escrow_id: SorobanString,
    pub sender: Address,
    pub evidence_hash: BytesN<32>,
}

/// Audit record for an arbiter-threshold resolution.
#[contracttype]
#[derive(Clone, Debug)]
pub struct DisputeResolvedEvent {
    pub escrow_id: SorobanString,
    pub sender_amount: i128,
    pub agent_amount: i128,
    pub signer_count: u32,
}

pub struct EventEmitter;

impl EventEmitter {
    pub fn emit_deposit(
        env: &Env,
        escrow_id: SorobanString,
        sender: Address,
        amount: i128,
        asset: SorobanString,
        recipient_country: SorobanString,
        timeout_ledger: u32,
    ) {
        let event = DepositEvent {
            escrow_id,
            sender,
            amount,
            asset,
            recipient_country,
            timeout_ledger,
        };
        env.events().publish((Symbol::new(env, "deposit"),), event);
    }

    pub fn emit_release(
        env: &Env,
        escrow_id: SorobanString,
        agent: Address,
        amount: i128,
        delivery_proof: SorobanString,
    ) {
        let event = ReleaseEvent {
            escrow_id,
            agent,
            amount,
            delivery_proof,
        };
        env.events().publish((Symbol::new(env, "release"),), event);
    }

    pub fn emit_refund(
        env: &Env,
        escrow_id: SorobanString,
        sender: Address,
        amount: i128,
        reason: SorobanString,
    ) {
        let event = RefundEvent {
            escrow_id,
            sender,
            amount,
            reason,
        };
        env.events().publish((Symbol::new(env, "refund"),), event);
    }

    pub fn emit_oracle_submit(
        env: &Env,
        escrow_id: SorobanString,
        oracle: Address,
        delivery_status: bool,
        timestamp: u64,
    ) {
        let event = OracleSubmitEvent {
            escrow_id,
            oracle,
            delivery_status,
            timestamp,
        };
        env.events()
            .publish((Symbol::new(env, "oracle_submit"),), event);
    }

    pub fn emit_dispute_raised(
        env: &Env,
        escrow_id: SorobanString,
        sender: Address,
        evidence_hash: BytesN<32>,
    ) {
        env.events().publish(
            (Symbol::new(env, "dispute_raised"),),
            DisputeRaisedEvent {
                escrow_id,
                sender,
                evidence_hash,
            },
        );
    }

    pub fn emit_dispute_resolved(
        env: &Env,
        escrow_id: SorobanString,
        sender_amount: i128,
        agent_amount: i128,
        signer_count: u32,
    ) {
        env.events().publish(
            (Symbol::new(env, "dispute_resolved"),),
            DisputeResolvedEvent {
                escrow_id,
                sender_amount,
                agent_amount,
                signer_count,
            },
        );
    }
}

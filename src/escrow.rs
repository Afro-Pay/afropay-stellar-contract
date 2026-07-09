use soroban_sdk::{Address, String as SorobanString, Vec};

/// State of an escrow agreement
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EscrowState {
    /// Funds locked, awaiting oracle confirmation
    Locked = 0,
    /// Oracle confirmed delivery, funds released to agent
    Released = 1,
    /// Delivery failed or timed out, sender can refund
    Refundable = 2,
    /// Funds refunded to sender
    Refunded = 3,
    /// Cancelled by sender before confirmation
    Cancelled = 4,
}

/// Core escrow struct holding all remittance state
#[derive(Clone)]
pub struct Escrow {
    /// Unique identifier for this escrow (UUID or sequential)
    pub id: SorobanString,
    /// Sender's Stellar address
    pub sender: Address,
    /// Off-ramp agent's address (verifies local delivery)
    pub agent: Address,
    /// Amount in stroops (1 USDC = 10^7 stroops)
    pub amount: i128,
    /// Asset code (e.g., "USDC")
    pub asset: SorobanString,
    /// Asset issuer (Circle's Stellar issuer for USDC)
    pub asset_issuer: Address,
    /// Recipient country code (e.g., "NG" for Nigeria)
    pub recipient_country: SorobanString,
    /// Recipient bank/mobile money account identifier (hashed for privacy)
    pub recipient_account_hash: Vec<u8>,
    /// Fiat amount in local currency (for reference)
    pub fiat_amount: i128,
    /// Local currency code (e.g., "NGN")
    pub fiat_currency: SorobanString,
    /// Exchange rate at lock time (for audit)
    pub exchange_rate: i128,
    /// Current escrow state
    pub state: EscrowState,
    /// Ledger height when escrow expires (if oracle doesn't confirm)
    pub timeout_ledger: u32,
    /// Oracle that verified delivery
    pub oracle: Option<Address>,
    /// Delivery proof (e.g., bank txn reference or mobile money receipt)
    pub delivery_proof: Option<SorobanString>,
    /// Ledger where transition occurred
    pub last_modified_ledger: u32,
    /// Unix timestamp of creation
    pub created_at: u64,
    /// Unix timestamp of release (if released)
    pub released_at: Option<u64>,
}

impl Escrow {
    /// Create a new escrow in Locked state
    pub fn new(
        id: SorobanString,
        sender: Address,
        agent: Address,
        amount: i128,
        asset: SorobanString,
        asset_issuer: Address,
        recipient_country: SorobanString,
        recipient_account_hash: Vec<u8>,
        fiat_amount: i128,
        fiat_currency: SorobanString,
        exchange_rate: i128,
        timeout_ledger: u32,
        last_modified_ledger: u32,
        created_at: u64,
    ) -> Self {
        Escrow {
            id,
            sender,
            agent,
            amount,
            asset,
            asset_issuer,
            recipient_country,
            recipient_account_hash,
            fiat_amount,
            fiat_currency,
            exchange_rate,
            state: EscrowState::Locked,
            timeout_ledger,
            oracle: None,
            delivery_proof: None,
            last_modified_ledger,
            created_at,
            released_at: None,
        }
    }

    /// Transition to Released state
    pub fn release(
        &mut self,
        oracle: Address,
        delivery_proof: SorobanString,
        last_modified_ledger: u32,
        released_at: u64,
    ) {
        self.state = EscrowState::Released;
        self.oracle = Some(oracle);
        self.delivery_proof = Some(delivery_proof);
        self.last_modified_ledger = last_modified_ledger;
        self.released_at = Some(released_at);
    }

    /// Transition to Refundable state (timeout)
    pub fn mark_refundable(&mut self, last_modified_ledger: u32) {
        self.state = EscrowState::Refundable;
        self.last_modified_ledger = last_modified_ledger;
    }

    /// Transition to Refunded state
    pub fn refund(&mut self, last_modified_ledger: u32) {
        self.state = EscrowState::Refunded;
        self.last_modified_ledger = last_modified_ledger;
    }

    /// Transition to Cancelled state
    pub fn cancel(&mut self, last_modified_ledger: u32) {
        self.state = EscrowState::Cancelled;
        self.last_modified_ledger = last_modified_ledger;
    }
}

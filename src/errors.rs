use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub enum RemittanceError {
    // Contract State Errors
    NotInitialized = 1,
    AlreadyInitialized = 2,

    // Permission Errors
    Unauthorized = 3,
    NotOracleOperator = 4,
    NotSender = 5,
    NotRecipient = 6,

    // Escrow Errors
    EscrowNotFound = 7,
    EscrowAlreadyExists = 8,
    InvalidEscrowState = 9,
    EscrowExpired = 10,
    EscrowNotExpired = 11,

    // Validation Errors
    InvalidAmount = 12,
    InvalidRecipient = 13,
    InvalidOracleKey = 14,
    InvalidSignature = 15,
    InvalidDeliveryProof = 16,
    InvalidTimeout = 17,

    // Fund Transfer Errors
    InsufficientBalance = 18,
    TransferFailed = 19,
    RefundFailed = 20,

    // Oracle Errors
    OracleNotVerified = 21,
    InvalidAttestation = 22,
    WrongChain = 23,

    // Rate & Slippage Errors
    ExchangeRateStale = 24,
    SlippageExceeded = 25,

    // Generic Errors
    OperationFailed = 26,

    // Dispute and governance errors
    InvalidArbiter = 27,
    ArbiterThresholdNotMet = 28,
    DuplicateSigner = 29,
    InvalidResolution = 30,
    InvalidEvidenceHash = 31,
    AdminThresholdNotMet = 32,
    InvalidThreshold = 33,
}

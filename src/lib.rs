#![no_std]

pub mod contract;
pub mod escrow;
pub mod oracle;
pub mod errors;
pub mod events;

pub use contract::RemittanceContract;
pub use escrow::{Escrow, EscrowState};
pub use oracle::OracleAttestation;
pub use errors::RemittanceError;
pub use events::{
    DepositEvent, ReleaseEvent, RefundEvent, OracleSubmitEvent, EventEmitter,
};

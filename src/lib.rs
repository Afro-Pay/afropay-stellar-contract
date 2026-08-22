#![no_std]

pub mod contract;
pub mod errors;
pub mod escrow;
pub mod events;
pub mod migration;
pub mod oracle;

pub use contract::RemittanceContract;
pub use errors::RemittanceError;
pub use escrow::{Escrow, EscrowState};
pub use events::{
    DepositEvent, DisputeRaisedEvent, DisputeResolvedEvent, EventEmitter, OracleSubmitEvent,
    RefundEvent, ReleaseEvent,
};
pub use migration::{current_schema_version, migrate, set_initial_schema_version, SchemaVersion};
pub use oracle::OracleAttestation;

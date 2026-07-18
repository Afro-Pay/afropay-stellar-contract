use serde::{Deserialize, Serialize};

pub type UnixTimestamp = i64;

/// Converts a whole-Naira amount into kobo (minor units), the unit used throughout this crate.
pub const fn naira(amount: i128) -> i128 {
    amount * 100
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Transaction {
    pub id: String,
    pub sender_id: String,
    pub sender_name: String,
    pub sender_bvn: Option<String>,
    pub recipient_id: String,
    pub recipient_name: String,
    pub recipient_bvn: Option<String>,
    pub amount_kobo: i128,
    pub completed_at: UnixTimestamp,
}

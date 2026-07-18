use crate::rule_engine::{AlertDraft, Severity};
use crate::transaction::UnixTimestamp;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum ReviewAction {
    Escalate,
    Dismiss,
}

/// A single append-only entry in the `aml_alerts` log. Mirrors the insert-only event-log
/// pattern used for `escrow_events`: nothing is ever mutated or deleted, so the full audit
/// trail (raise + every review action) is always reconstructable.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AlertRecord {
    Raised {
        record_id: u64,
        alert_id: String,
        rule_name: String,
        severity: Severity,
        reason: String,
        related_transaction_ids: Vec<String>,
        sender_id: String,
        raised_at: UnixTimestamp,
    },
    Reviewed {
        record_id: u64,
        alert_id: String,
        action: ReviewAction,
        reviewer: String,
        note: String,
        reviewed_at: UnixTimestamp,
    },
}

#[derive(Debug)]
pub enum AlertError {
    UnknownAlert(String),
}

#[derive(Default)]
pub struct AlertStore {
    records: Vec<AlertRecord>,
}

impl AlertStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn raise(
        &mut self,
        alert_id: impl Into<String>,
        draft: &AlertDraft,
        sender_id: impl Into<String>,
        raised_at: UnixTimestamp,
    ) {
        let record_id = self.records.len() as u64;
        self.records.push(AlertRecord::Raised {
            record_id,
            alert_id: alert_id.into(),
            rule_name: draft.rule_name.to_string(),
            severity: draft.severity,
            reason: draft.reason.clone(),
            related_transaction_ids: draft.related_transaction_ids.clone(),
            sender_id: sender_id.into(),
            raised_at,
        });
    }

    pub fn review(
        &mut self,
        alert_id: &str,
        action: ReviewAction,
        reviewer: impl Into<String>,
        note: impl Into<String>,
        reviewed_at: UnixTimestamp,
    ) -> Result<(), AlertError> {
        let exists = self.records.iter().any(
            |r| matches!(r, AlertRecord::Raised { alert_id: id, .. } if id == alert_id),
        );
        if !exists {
            return Err(AlertError::UnknownAlert(alert_id.to_string()));
        }

        let record_id = self.records.len() as u64;
        self.records.push(AlertRecord::Reviewed {
            record_id,
            alert_id: alert_id.to_string(),
            action,
            reviewer: reviewer.into(),
            note: note.into(),
            reviewed_at,
        });
        Ok(())
    }

    pub fn records(&self) -> &[AlertRecord] {
        &self.records
    }
}

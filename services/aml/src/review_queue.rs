use crate::alerts::{AlertRecord, AlertStore, ReviewAction};
use crate::rule_engine::Severity;
use crate::transaction::UnixTimestamp;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AlertStatus {
    Open,
    Escalated,
    Dismissed,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AlertView {
    pub alert_id: String,
    pub rule_name: String,
    pub severity: Severity,
    pub reason: String,
    pub related_transaction_ids: Vec<String>,
    pub sender_id: String,
    pub raised_at: UnixTimestamp,
    pub status: AlertStatus,
}

/// The Rust-level equivalent of an admin review queue endpoint: folds the append-only
/// `AlertStore` log into current-state views, since no HTTP API layer exists in this repo yet.
pub fn build_alert_views(store: &AlertStore) -> Vec<AlertView> {
    let mut views: Vec<AlertView> = Vec::new();

    for record in store.records() {
        match record {
            AlertRecord::Raised {
                alert_id,
                rule_name,
                severity,
                reason,
                related_transaction_ids,
                sender_id,
                raised_at,
                ..
            } => {
                views.push(AlertView {
                    alert_id: alert_id.clone(),
                    rule_name: rule_name.clone(),
                    severity: *severity,
                    reason: reason.clone(),
                    related_transaction_ids: related_transaction_ids.clone(),
                    sender_id: sender_id.clone(),
                    raised_at: *raised_at,
                    status: AlertStatus::Open,
                });
            }
            AlertRecord::Reviewed {
                alert_id, action, ..
            } => {
                if let Some(view) = views.iter_mut().find(|v| &v.alert_id == alert_id) {
                    view.status = match action {
                        ReviewAction::Escalate => AlertStatus::Escalated,
                        ReviewAction::Dismiss => AlertStatus::Dismissed,
                    };
                }
            }
        }
    }

    views
}

pub fn pending_review(store: &AlertStore) -> Vec<AlertView> {
    build_alert_views(store)
        .into_iter()
        .filter(|v| v.status == AlertStatus::Open)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rule_engine::AlertDraft;

    fn draft(rule_name: &'static str, tx_id: &str) -> AlertDraft {
        AlertDraft {
            rule_name,
            severity: Severity::High,
            reason: "test".to_string(),
            related_transaction_ids: vec![tx_id.to_string()],
        }
    }

    #[test]
    fn newly_raised_alert_is_pending() {
        let mut store = AlertStore::new();
        store.raise("a1", &draft("structuring", "t1"), "alice", 1_000);

        let pending = pending_review(&store);
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].alert_id, "a1");
        assert_eq!(pending[0].status, AlertStatus::Open);
    }

    #[test]
    fn dismissed_alert_is_not_pending() {
        let mut store = AlertStore::new();
        store.raise("a1", &draft("structuring", "t1"), "alice", 1_000);
        store
            .review("a1", ReviewAction::Dismiss, "officer1", "false positive", 2_000)
            .unwrap();

        assert!(pending_review(&store).is_empty());
        let views = build_alert_views(&store);
        assert_eq!(views[0].status, AlertStatus::Dismissed);
    }

    #[test]
    fn escalated_alert_is_not_pending_but_is_tracked() {
        let mut store = AlertStore::new();
        store.raise("a1", &draft("sanctions_screening", "t1"), "alice", 1_000);
        store
            .review("a1", ReviewAction::Escalate, "officer1", "confirmed match", 2_000)
            .unwrap();

        assert!(pending_review(&store).is_empty());
        let views = build_alert_views(&store);
        assert_eq!(views[0].status, AlertStatus::Escalated);
    }

    #[test]
    fn reviewing_unknown_alert_errors() {
        let mut store = AlertStore::new();
        let result = store.review("missing", ReviewAction::Dismiss, "officer1", "n/a", 1_000);
        assert!(result.is_err());
    }

    #[test]
    fn review_history_is_preserved_not_overwritten() {
        let mut store = AlertStore::new();
        store.raise("a1", &draft("structuring", "t1"), "alice", 1_000);
        store
            .review("a1", ReviewAction::Escalate, "officer1", "first pass", 2_000)
            .unwrap();

        // Insert-only: a second review appends rather than mutating the first record.
        assert_eq!(store.records().len(), 2);
    }
}

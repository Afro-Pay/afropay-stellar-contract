use crate::rule_engine::{AlertDraft, EvaluationContext, Rule, Severity};

/// Flags a transaction over `amount_threshold_kobo` from an account with no prior activity in
/// the preceding `dormancy_window_seconds` (including accounts with no history at all).
pub struct DormantAccountRule {
    pub amount_threshold_kobo: i128,
    pub dormancy_window_seconds: i64,
}

impl Rule for DormantAccountRule {
    fn name(&self) -> &'static str {
        "dormant_account"
    }

    fn evaluate(&self, ctx: &EvaluationContext) -> Vec<AlertDraft> {
        let tx = ctx.transaction;
        if tx.amount_kobo <= self.amount_threshold_kobo {
            return vec![];
        }

        let cutoff = tx.completed_at - self.dormancy_window_seconds;
        let has_recent_activity = ctx.sender_history.iter().any(|t| {
            t.sender_id == tx.sender_id && t.completed_at > cutoff && t.completed_at < tx.completed_at
        });

        if has_recent_activity {
            return vec![];
        }

        vec![AlertDraft {
            rule_name: self.name(),
            severity: Severity::Medium,
            reason: format!(
                "₦{} transaction from sender {} with no activity in the prior {}s",
                tx.amount_kobo / 100,
                tx.sender_id,
                self.dormancy_window_seconds
            ),
            related_transaction_ids: vec![tx.id.clone()],
        }]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sanctions_list::SanctionsList;
    use crate::transaction::{naira, Transaction};

    const NINETY_DAYS: i64 = 90 * 86_400;

    fn rule() -> DormantAccountRule {
        DormantAccountRule {
            amount_threshold_kobo: naira(500_000),
            dormancy_window_seconds: NINETY_DAYS,
        }
    }

    fn tx(id: &str, sender: &str, amount_kobo: i128, completed_at: i64) -> Transaction {
        Transaction {
            id: id.to_string(),
            sender_id: sender.to_string(),
            sender_name: "Sender".to_string(),
            sender_bvn: None,
            recipient_id: "recipient".to_string(),
            recipient_name: "Recipient".to_string(),
            recipient_bvn: None,
            amount_kobo,
            completed_at,
        }
    }

    fn evaluate(rule: &DormantAccountRule, current: &Transaction, history: &[Transaction]) -> Vec<AlertDraft> {
        let sanctions = SanctionsList::default();
        let ctx = EvaluationContext {
            transaction: current,
            sender_history: history,
            sanctions_list: &sanctions,
        };
        rule.evaluate(&ctx)
    }

    #[test]
    fn flags_large_first_transaction_with_no_history() {
        let rule = rule();
        let current = tx("t1", "alice", naira(600_000), 1_000_000);
        assert_eq!(evaluate(&rule, &current, &[]).len(), 1);
    }

    #[test]
    fn amount_exactly_at_threshold_does_not_flag() {
        let rule = rule();
        let current = tx("t1", "alice", naira(500_000), 1_000_000);
        assert!(evaluate(&rule, &current, &[]).is_empty());
    }

    #[test]
    fn amount_one_kobo_above_threshold_flags() {
        let rule = rule();
        let current = tx("t1", "alice", naira(500_000) + 1, 1_000_000);
        assert_eq!(evaluate(&rule, &current, &[]).len(), 1);
    }

    #[test]
    fn prior_activity_within_window_suppresses_alert() {
        let rule = rule();
        let history = vec![tx("h1", "alice", naira(1_000), 1_000_000 - NINETY_DAYS + 1)];
        let current = tx("t1", "alice", naira(600_000), 1_000_000);
        assert!(evaluate(&rule, &current, &history).is_empty());
    }

    #[test]
    fn prior_activity_exactly_at_cutoff_boundary_does_not_count_as_recent() {
        let rule = rule();
        // completed_at == cutoff is not `> cutoff`, so this is treated as outside the window.
        let history = vec![tx("h1", "alice", naira(1_000), 1_000_000 - NINETY_DAYS)];
        let current = tx("t1", "alice", naira(600_000), 1_000_000);
        assert_eq!(evaluate(&rule, &current, &history).len(), 1);
    }

    #[test]
    fn prior_activity_older_than_window_still_flags() {
        let rule = rule();
        let history = vec![tx("h1", "alice", naira(1_000), 1_000_000 - NINETY_DAYS - 1)];
        let current = tx("t1", "alice", naira(600_000), 1_000_000);
        assert_eq!(evaluate(&rule, &current, &history).len(), 1);
    }

    #[test]
    fn other_senders_activity_does_not_count() {
        let rule = rule();
        let history = vec![tx("h1", "bob", naira(1_000), 999_999)];
        let current = tx("t1", "alice", naira(600_000), 1_000_000);
        assert_eq!(evaluate(&rule, &current, &history).len(), 1);
    }
}

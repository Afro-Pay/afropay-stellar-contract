use crate::rule_engine::{AlertDraft, EvaluationContext, Rule, Severity};

/// Flags a sender who repeatedly transacts just under a reporting threshold within a window,
/// a classic structuring ("smurfing") pattern.
pub struct StructuringRule {
    pub reporting_threshold_kobo: i128,
    /// Amounts in `[reporting_threshold_kobo * near_threshold_ratio, reporting_threshold_kobo)`
    /// count as "near" the threshold. Must be in `(0.0, 1.0)`.
    pub near_threshold_ratio: f64,
    /// Minimum number of near-threshold transactions (including the current one) within the
    /// window before an alert is raised.
    pub min_occurrences: usize,
    pub window_seconds: i64,
}

impl StructuringRule {
    fn is_near_threshold(&self, amount_kobo: i128) -> bool {
        if amount_kobo >= self.reporting_threshold_kobo {
            return false;
        }
        let lower_bound = (self.reporting_threshold_kobo as f64 * self.near_threshold_ratio) as i128;
        amount_kobo >= lower_bound
    }
}

impl Rule for StructuringRule {
    fn name(&self) -> &'static str {
        "structuring"
    }

    fn evaluate(&self, ctx: &EvaluationContext) -> Vec<AlertDraft> {
        let tx = ctx.transaction;
        if !self.is_near_threshold(tx.amount_kobo) {
            return vec![];
        }

        let window_start = tx.completed_at - self.window_seconds;
        let mut matching_ids: Vec<String> = ctx
            .sender_history
            .iter()
            .filter(|t| {
                t.sender_id == tx.sender_id
                    && t.completed_at > window_start
                    && t.completed_at <= tx.completed_at
                    && self.is_near_threshold(t.amount_kobo)
            })
            .map(|t| t.id.clone())
            .collect();
        matching_ids.push(tx.id.clone());

        if matching_ids.len() < self.min_occurrences {
            return vec![];
        }

        vec![AlertDraft {
            rule_name: self.name(),
            severity: Severity::High,
            reason: format!(
                "{} transactions near the ₦{} reporting threshold from sender {} within {}s",
                matching_ids.len(),
                self.reporting_threshold_kobo / 100,
                tx.sender_id,
                self.window_seconds
            ),
            related_transaction_ids: matching_ids,
        }]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sanctions_list::SanctionsList;
    use crate::transaction::{naira, Transaction};

    fn rule() -> StructuringRule {
        StructuringRule {
            reporting_threshold_kobo: naira(5_000_000),
            near_threshold_ratio: 0.8,
            min_occurrences: 2,
            window_seconds: 86_400,
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

    fn evaluate(rule: &StructuringRule, current: &Transaction, history: &[Transaction]) -> Vec<AlertDraft> {
        let sanctions = SanctionsList::default();
        let ctx = EvaluationContext {
            transaction: current,
            sender_history: history,
            sanctions_list: &sanctions,
        };
        rule.evaluate(&ctx)
    }

    #[test]
    fn flags_two_near_threshold_transactions_within_window() {
        let rule = rule();
        let history = vec![tx("t1", "alice", naira(4_800_000), 1_000)];
        let current = tx("t2", "alice", naira(4_900_000), 2_000);

        let alerts = evaluate(&rule, &current, &history);
        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0].related_transaction_ids, vec!["t1", "t2"]);
    }

    #[test]
    fn does_not_flag_single_near_threshold_transaction() {
        let rule = rule();
        let current = tx("t1", "alice", naira(4_900_000), 1_000);
        assert!(evaluate(&rule, &current, &[]).is_empty());
    }

    #[test]
    fn amount_exactly_at_threshold_is_not_near_threshold() {
        let rule = rule();
        let history = vec![tx("t1", "alice", naira(4_900_000), 1_000)];
        let current = tx("t2", "alice", naira(5_000_000), 2_000);
        assert!(evaluate(&rule, &current, &history).is_empty());
    }

    #[test]
    fn amount_one_below_lower_bound_does_not_count() {
        let rule = rule();
        // lower bound = 4_000_000 naira; one naira below should not count.
        let history = vec![tx("t1", "alice", naira(3_999_999), 1_000)];
        let current = tx("t2", "alice", naira(4_900_000), 2_000);
        assert!(evaluate(&rule, &current, &history).is_empty());
    }

    #[test]
    fn amount_exactly_at_lower_bound_counts() {
        let rule = rule();
        let history = vec![tx("t1", "alice", naira(4_000_000), 1_000)];
        let current = tx("t2", "alice", naira(4_900_000), 2_000);
        assert_eq!(evaluate(&rule, &current, &history).len(), 1);
    }

    #[test]
    fn transaction_outside_window_is_excluded() {
        let rule = rule();
        let history = vec![tx("t1", "alice", naira(4_900_000), 1_000)];
        let current = tx("t2", "alice", naira(4_900_000), 1_000 + 86_400 + 1);
        assert!(evaluate(&rule, &current, &history).is_empty());
    }

    #[test]
    fn different_sender_does_not_count_toward_pattern() {
        let rule = rule();
        let history = vec![tx("t1", "bob", naira(4_900_000), 1_000)];
        let current = tx("t2", "alice", naira(4_900_000), 2_000);
        assert!(evaluate(&rule, &current, &history).is_empty());
    }
}

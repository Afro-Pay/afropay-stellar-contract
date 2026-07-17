use crate::rule_engine::{AlertDraft, EvaluationContext, Rule, Severity};

/// Flags a sender who exceeds `max_transactions` completed transactions within `window_seconds`.
pub struct HighVelocityRule {
    pub max_transactions: usize,
    pub window_seconds: i64,
}

impl Rule for HighVelocityRule {
    fn name(&self) -> &'static str {
        "high_velocity"
    }

    fn evaluate(&self, ctx: &EvaluationContext) -> Vec<AlertDraft> {
        let tx = ctx.transaction;
        let window_start = tx.completed_at - self.window_seconds;

        let mut matching_ids: Vec<String> = ctx
            .sender_history
            .iter()
            .filter(|t| {
                t.sender_id == tx.sender_id
                    && t.completed_at > window_start
                    && t.completed_at <= tx.completed_at
            })
            .map(|t| t.id.clone())
            .collect();
        matching_ids.push(tx.id.clone());

        if matching_ids.len() <= self.max_transactions {
            return vec![];
        }

        vec![AlertDraft {
            rule_name: self.name(),
            severity: Severity::Medium,
            reason: format!(
                "{} transactions from sender {} within {}s exceeds the limit of {}",
                matching_ids.len(),
                tx.sender_id,
                self.window_seconds,
                self.max_transactions
            ),
            related_transaction_ids: matching_ids,
        }]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sanctions_list::SanctionsList;
    use crate::transaction::Transaction;

    fn rule() -> HighVelocityRule {
        HighVelocityRule {
            max_transactions: 10,
            window_seconds: 3_600,
        }
    }

    fn tx(id: &str, sender: &str, completed_at: i64) -> Transaction {
        Transaction {
            id: id.to_string(),
            sender_id: sender.to_string(),
            sender_name: "Sender".to_string(),
            sender_bvn: None,
            recipient_id: "recipient".to_string(),
            recipient_name: "Recipient".to_string(),
            recipient_bvn: None,
            amount_kobo: 100_000,
            completed_at,
        }
    }

    fn evaluate(rule: &HighVelocityRule, current: &Transaction, history: &[Transaction]) -> Vec<AlertDraft> {
        let sanctions = SanctionsList::default();
        let ctx = EvaluationContext {
            transaction: current,
            sender_history: history,
            sanctions_list: &sanctions,
        };
        rule.evaluate(&ctx)
    }

    fn history_of(sender: &str, count: usize, start: i64) -> Vec<Transaction> {
        (0..count)
            .map(|i| tx(&format!("h{i}"), sender, start + i as i64))
            .collect()
    }

    #[test]
    fn exactly_ten_transactions_in_window_does_not_flag() {
        let rule = rule();
        // 9 prior + current = 10 total, at the limit (not exceeding it).
        let history = history_of("alice", 9, 1_000);
        let current = tx("current", "alice", 1_009);
        assert!(evaluate(&rule, &current, &history).is_empty());
    }

    #[test]
    fn eleventh_transaction_in_window_flags() {
        let rule = rule();
        let history = history_of("alice", 10, 1_000);
        let current = tx("current", "alice", 1_010);
        let alerts = evaluate(&rule, &current, &history);
        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0].related_transaction_ids.len(), 11);
    }

    #[test]
    fn transaction_just_outside_window_is_excluded() {
        let rule = rule();
        let mut history = history_of("alice", 10, 1_000 - 3_600 - 1);
        // Push all 10 prior transactions to exactly (or before) the window boundary so none count.
        for (i, t) in history.iter_mut().enumerate() {
            t.completed_at = 1_000 - 3_600 - 1 - i as i64;
        }
        let current = tx("current", "alice", 1_000);
        assert!(evaluate(&rule, &current, &history).is_empty());
    }

    #[test]
    fn different_sender_does_not_count() {
        let rule = rule();
        let history = history_of("bob", 15, 1_000);
        let current = tx("current", "alice", 1_010);
        assert!(evaluate(&rule, &current, &history).is_empty());
    }
}

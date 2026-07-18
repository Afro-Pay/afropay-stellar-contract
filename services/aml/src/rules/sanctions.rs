use crate::rule_engine::{AlertDraft, EvaluationContext, Rule, Severity};

/// Screens both parties of a transaction against the configured OFAC/UN/CBN sanctions list.
pub struct SanctionsScreeningRule;

impl Rule for SanctionsScreeningRule {
    fn name(&self) -> &'static str {
        "sanctions_screening"
    }

    fn evaluate(&self, ctx: &EvaluationContext) -> Vec<AlertDraft> {
        let tx = ctx.transaction;
        let mut hits = Vec::new();

        if let Some(entry) = ctx
            .sanctions_list
            .match_entity(&tx.sender_name, tx.sender_bvn.as_deref())
        {
            hits.push(format!(
                "sender '{}' matches sanctions entry '{}' ({})",
                tx.sender_name, entry.name, entry.source
            ));
        }
        if let Some(entry) = ctx
            .sanctions_list
            .match_entity(&tx.recipient_name, tx.recipient_bvn.as_deref())
        {
            hits.push(format!(
                "recipient '{}' matches sanctions entry '{}' ({})",
                tx.recipient_name, entry.name, entry.source
            ));
        }

        if hits.is_empty() {
            return vec![];
        }

        vec![AlertDraft {
            rule_name: self.name(),
            severity: Severity::Critical,
            reason: hits.join("; "),
            related_transaction_ids: vec![tx.id.clone()],
        }]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sanctions_list::{SanctionedEntity, SanctionsList};
    use crate::transaction::Transaction;

    fn sanctioned_list() -> SanctionsList {
        SanctionsList::from_entities(vec![SanctionedEntity {
            name: "John Doe".to_string(),
            bvn: Some("12345678901".to_string()),
            source: "OFAC".to_string(),
        }])
    }

    fn tx(sender_name: &str, sender_bvn: Option<&str>, recipient_name: &str) -> Transaction {
        Transaction {
            id: "t1".to_string(),
            sender_id: "sender".to_string(),
            sender_name: sender_name.to_string(),
            sender_bvn: sender_bvn.map(str::to_string),
            recipient_id: "recipient".to_string(),
            recipient_name: recipient_name.to_string(),
            recipient_bvn: None,
            amount_kobo: 100_000,
            completed_at: 1_000,
        }
    }

    fn evaluate(list: &SanctionsList, transaction: &Transaction) -> Vec<AlertDraft> {
        let ctx = EvaluationContext {
            transaction,
            sender_history: &[],
            sanctions_list: list,
        };
        SanctionsScreeningRule.evaluate(&ctx)
    }

    #[test]
    fn flags_sender_matched_by_bvn() {
        let list = sanctioned_list();
        let t = tx("J. D.", Some("12345678901"), "Someone Else");
        assert_eq!(evaluate(&list, &t).len(), 1);
    }

    #[test]
    fn flags_sender_matched_by_normalized_name() {
        let list = sanctioned_list();
        let t = tx("  john doe ", None, "Someone Else");
        assert_eq!(evaluate(&list, &t).len(), 1);
    }

    #[test]
    fn flags_recipient_match() {
        let list = sanctioned_list();
        let t = tx("Someone Else", None, "John Doe");
        assert_eq!(evaluate(&list, &t).len(), 1);
    }

    #[test]
    fn no_match_does_not_flag() {
        let list = sanctioned_list();
        let t = tx("Alice", None, "Bob");
        assert!(evaluate(&list, &t).is_empty());
    }

    #[test]
    fn empty_sanctions_list_never_flags() {
        let list = SanctionsList::default();
        let t = tx("John Doe", Some("12345678901"), "Bob");
        assert!(evaluate(&list, &t).is_empty());
    }
}

use aml::{
    default_rule_engine, naira, pending_review, AlertStore, EvaluationContext, ReviewAction,
    RuleConfig, SanctionsList, SuspiciousActivityReport, Transaction,
};

fn tx(id: &str, sender: &str, amount_kobo: i128, completed_at: i64) -> Transaction {
    Transaction {
        id: id.to_string(),
        sender_id: sender.to_string(),
        sender_name: "Jane Doe".to_string(),
        sender_bvn: Some("22222222222".to_string()),
        recipient_id: "recipient".to_string(),
        recipient_name: "Recipient".to_string(),
        recipient_bvn: None,
        amount_kobo,
        completed_at,
    }
}

#[test]
fn structuring_pattern_flows_through_review_and_sar_export() {
    let engine = default_rule_engine(RuleConfig::default());
    let sanctions = SanctionsList::default();
    let mut store = AlertStore::new();

    let history = vec![tx("t1", "sender-1", naira(4_800_000), 1_000)];
    let current = tx("t2", "sender-1", naira(4_900_000), 2_000);

    let ctx = EvaluationContext {
        transaction: &current,
        sender_history: &history,
        sanctions_list: &sanctions,
    };
    let drafts = engine.evaluate(&ctx);
    assert_eq!(drafts.len(), 1);
    assert_eq!(drafts[0].rule_name, "structuring");

    store.raise("alert-1", &drafts[0], current.sender_id.clone(), current.completed_at);

    let pending = pending_review(&store);
    assert_eq!(pending.len(), 1);

    store
        .review("alert-1", ReviewAction::Escalate, "compliance-officer-1", "confirmed structuring", 3_000)
        .unwrap();
    assert!(pending_review(&store).is_empty());

    let views = aml::build_alert_views(&store);
    let all_transactions = vec![history[0].clone(), current.clone()];
    let report = SuspiciousActivityReport::from_alert(
        &views[0],
        &all_transactions,
        "AfroPay",
        "compliance-officer-1",
        3_100,
    );

    let json = report.to_json().unwrap();
    assert!(json.contains("\"rule_triggered\": \"structuring\""));

    let csv = aml::export_csv(&[report]);
    assert!(csv.starts_with("report_id,alert_id"));
    assert_eq!(csv.lines().count(), 2);
}

use crate::review_queue::AlertView;
use crate::rule_engine::Severity;
use crate::transaction::{Transaction, UnixTimestamp};
use chrono::{TimeZone, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SuspiciousActivityReport {
    pub report_id: String,
    pub alert_id: String,
    pub filing_institution: String,
    pub reporting_officer: String,
    pub rule_triggered: String,
    pub severity: Severity,
    pub subject_name: String,
    pub subject_bvn: Option<String>,
    pub related_transaction_ids: Vec<String>,
    pub total_amount_kobo: i128,
    pub currency: String,
    pub narrative: String,
    pub date_of_activity: String,
    pub date_reported: String,
}

fn to_rfc3339(ts: UnixTimestamp) -> String {
    Utc.timestamp_opt(ts, 0).single().expect("valid unix timestamp").to_rfc3339()
}

impl SuspiciousActivityReport {
    pub fn from_alert(
        alert: &AlertView,
        transactions: &[Transaction],
        filing_institution: &str,
        reporting_officer: &str,
        reported_at: UnixTimestamp,
    ) -> Self {
        let subject = transactions
            .iter()
            .find(|t| t.sender_id == alert.sender_id);
        let subject_name = subject.map(|t| t.sender_name.clone()).unwrap_or_default();
        let subject_bvn = subject.and_then(|t| t.sender_bvn.clone());

        let total_amount_kobo: i128 = alert
            .related_transaction_ids
            .iter()
            .filter_map(|id| transactions.iter().find(|t| &t.id == id))
            .map(|t| t.amount_kobo)
            .sum();

        SuspiciousActivityReport {
            report_id: format!("SAR-{}", alert.alert_id),
            alert_id: alert.alert_id.clone(),
            filing_institution: filing_institution.to_string(),
            reporting_officer: reporting_officer.to_string(),
            rule_triggered: alert.rule_name.clone(),
            severity: alert.severity,
            subject_name,
            subject_bvn,
            related_transaction_ids: alert.related_transaction_ids.clone(),
            total_amount_kobo,
            currency: "NGN".to_string(),
            narrative: alert.reason.clone(),
            date_of_activity: to_rfc3339(alert.raised_at),
            date_reported: to_rfc3339(reported_at),
        }
    }

    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string_pretty(self)
    }
}

fn csv_escape(field: &str) -> String {
    if field.contains(',') || field.contains('"') || field.contains('\n') {
        format!("\"{}\"", field.replace('"', "\"\""))
    } else {
        field.to_string()
    }
}

const CSV_HEADER: &str = "report_id,alert_id,filing_institution,reporting_officer,rule_triggered,severity,subject_name,subject_bvn,related_transaction_ids,total_amount_kobo,currency,narrative,date_of_activity,date_reported";

pub fn export_csv(reports: &[SuspiciousActivityReport]) -> String {
    let mut out = String::from(CSV_HEADER);
    out.push('\n');
    for r in reports {
        let severity = format!("{:?}", r.severity);
        let fields = [
            r.report_id.clone(),
            r.alert_id.clone(),
            r.filing_institution.clone(),
            r.reporting_officer.clone(),
            r.rule_triggered.clone(),
            severity,
            r.subject_name.clone(),
            r.subject_bvn.clone().unwrap_or_default(),
            r.related_transaction_ids.join("|"),
            r.total_amount_kobo.to_string(),
            r.currency.clone(),
            r.narrative.clone(),
            r.date_of_activity.clone(),
            r.date_reported.clone(),
        ];
        let row: Vec<String> = fields.iter().map(|f| csv_escape(f)).collect();
        out.push_str(&row.join(","));
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::review_queue::AlertStatus;
    use jsonschema::JSONSchema;
    use std::fs;

    fn sample_alert() -> AlertView {
        AlertView {
            alert_id: "a1".to_string(),
            rule_name: "structuring".to_string(),
            severity: Severity::High,
            reason: "2 transactions near the ₦5,000,000 reporting threshold".to_string(),
            related_transaction_ids: vec!["t1".to_string(), "t2".to_string()],
            sender_id: "sender-1".to_string(),
            raised_at: 1_700_000_000,
            status: AlertStatus::Open,
        }
    }

    fn sample_transactions() -> Vec<Transaction> {
        vec![
            Transaction {
                id: "t1".to_string(),
                sender_id: "sender-1".to_string(),
                sender_name: "Jane Doe".to_string(),
                sender_bvn: Some("22222222222".to_string()),
                recipient_id: "r1".to_string(),
                recipient_name: "Recipient One".to_string(),
                recipient_bvn: None,
                amount_kobo: 480_000_000,
                completed_at: 1_699_999_000,
            },
            Transaction {
                id: "t2".to_string(),
                sender_id: "sender-1".to_string(),
                sender_name: "Jane Doe".to_string(),
                sender_bvn: Some("22222222222".to_string()),
                recipient_id: "r2".to_string(),
                recipient_name: "Recipient Two".to_string(),
                recipient_bvn: None,
                amount_kobo: 490_000_000,
                completed_at: 1_700_000_000,
            },
        ]
    }

    #[test]
    fn sar_json_export_validates_against_nfiu_schema() {
        let alert = sample_alert();
        let transactions = sample_transactions();
        let report = SuspiciousActivityReport::from_alert(
            &alert,
            &transactions,
            "AfroPay",
            "compliance-officer-1",
            1_700_100_000,
        );

        let json = report.to_json().expect("serializes to JSON");
        let instance: serde_json::Value = serde_json::from_str(&json).unwrap();

        let schema_str = fs::read_to_string(
            concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/compliance/nfiu-sar-schema.json"),
        )
        .expect("schema file exists");
        let schema_value: serde_json::Value = serde_json::from_str(&schema_str).unwrap();
        let compiled = JSONSchema::compile(&schema_value).expect("valid schema");

        let result = compiled.validate(&instance);
        if let Err(errors) = result {
            let messages: Vec<String> = errors.map(|e| e.to_string()).collect();
            panic!("SAR JSON failed schema validation: {messages:?}");
        }
    }

    #[test]
    fn sar_total_amount_sums_related_transactions() {
        let alert = sample_alert();
        let transactions = sample_transactions();
        let report = SuspiciousActivityReport::from_alert(
            &alert,
            &transactions,
            "AfroPay",
            "compliance-officer-1",
            1_700_100_000,
        );
        assert_eq!(report.total_amount_kobo, 480_000_000 + 490_000_000);
    }

    #[test]
    fn csv_export_escapes_commas_in_narrative() {
        let mut alert = sample_alert();
        alert.reason = "flag, with a comma".to_string();
        let transactions = sample_transactions();
        let report = SuspiciousActivityReport::from_alert(
            &alert,
            &transactions,
            "AfroPay",
            "compliance-officer-1",
            1_700_100_000,
        );
        let csv = export_csv(&[report]);
        assert!(csv.contains("\"flag, with a comma\""));
    }
}

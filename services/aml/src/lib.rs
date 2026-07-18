pub mod alerts;
pub mod review_queue;
pub mod rule_engine;
pub mod rules;
pub mod sanctions_list;
pub mod sar;
pub mod transaction;

pub use alerts::{AlertError, AlertRecord, AlertStore, ReviewAction};
pub use review_queue::{build_alert_views, pending_review, AlertStatus, AlertView};
pub use rule_engine::{AlertDraft, EvaluationContext, Rule, RuleEngine, Severity};
pub use rules::{DormantAccountRule, HighVelocityRule, SanctionsScreeningRule, StructuringRule};
pub use sanctions_list::{
    CachedSanctionsList, FileSanctionsListSource, S3SanctionsListSource, SanctionedEntity,
    SanctionsList, SanctionsListSource,
};
pub use sar::{export_csv, SuspiciousActivityReport};
pub use transaction::{naira, Transaction, UnixTimestamp};

use std::time::{SystemTime, UNIX_EPOCH};

/// Assembles a `RuleEngine` with the four rules required by CBN AML/CFT monitoring, using
/// thresholds configurable per deployment (defaults below are illustrative starting points,
/// not legal advice).
pub struct RuleConfig {
    pub structuring_threshold_kobo: i128,
    pub structuring_near_threshold_ratio: f64,
    pub structuring_min_occurrences: usize,
    pub structuring_window_seconds: i64,
    pub high_velocity_max_transactions: usize,
    pub high_velocity_window_seconds: i64,
    pub dormant_amount_threshold_kobo: i128,
    pub dormant_window_seconds: i64,
}

impl Default for RuleConfig {
    fn default() -> Self {
        Self {
            structuring_threshold_kobo: naira(5_000_000),
            structuring_near_threshold_ratio: 0.8,
            structuring_min_occurrences: 2,
            structuring_window_seconds: 86_400,
            high_velocity_max_transactions: 10,
            high_velocity_window_seconds: 3_600,
            dormant_amount_threshold_kobo: naira(500_000),
            dormant_window_seconds: 90 * 86_400,
        }
    }
}

pub fn default_rule_engine(config: RuleConfig) -> RuleEngine {
    let mut engine = RuleEngine::new();
    engine
        .register(Box::new(StructuringRule {
            reporting_threshold_kobo: config.structuring_threshold_kobo,
            near_threshold_ratio: config.structuring_near_threshold_ratio,
            min_occurrences: config.structuring_min_occurrences,
            window_seconds: config.structuring_window_seconds,
        }))
        .register(Box::new(HighVelocityRule {
            max_transactions: config.high_velocity_max_transactions,
            window_seconds: config.high_velocity_window_seconds,
        }))
        .register(Box::new(DormantAccountRule {
            amount_threshold_kobo: config.dormant_amount_threshold_kobo,
            dormancy_window_seconds: config.dormant_window_seconds,
        }))
        .register(Box::new(SanctionsScreeningRule));
    engine
}

pub fn now_unix() -> UnixTimestamp {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before unix epoch")
        .as_secs() as i64
}

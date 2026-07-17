use crate::sanctions_list::SanctionsList;
use crate::transaction::Transaction;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
pub enum Severity {
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlertDraft {
    pub rule_name: &'static str,
    pub severity: Severity,
    pub reason: String,
    pub related_transaction_ids: Vec<String>,
}

/// Everything a `Rule` needs to evaluate a single completed transaction.
pub struct EvaluationContext<'a> {
    pub transaction: &'a Transaction,
    /// The sender's prior completed transactions, not including `transaction`. Order is not
    /// required; rules filter by timestamp/sender themselves.
    pub sender_history: &'a [Transaction],
    pub sanctions_list: &'a SanctionsList,
}

pub trait Rule: Send + Sync {
    fn name(&self) -> &'static str;
    fn evaluate(&self, ctx: &EvaluationContext) -> Vec<AlertDraft>;
}

#[derive(Default)]
pub struct RuleEngine {
    rules: Vec<Box<dyn Rule>>,
}

impl RuleEngine {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, rule: Box<dyn Rule>) -> &mut Self {
        self.rules.push(rule);
        self
    }

    pub fn rules(&self) -> &[Box<dyn Rule>] {
        &self.rules
    }

    pub fn evaluate(&self, ctx: &EvaluationContext) -> Vec<AlertDraft> {
        self.rules.iter().flat_map(|rule| rule.evaluate(ctx)).collect()
    }
}

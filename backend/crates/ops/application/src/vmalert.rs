// SPDX-License-Identifier: LicenseRef-Proprietary
use std::collections::BTreeMap;

use serde::Deserialize;
use time::OffsetDateTime;

use crate::SourceFuture;

pub trait Vmalert: Send + Sync {
    fn read(&self) -> SourceFuture<'_, VmalertSnapshot>;
}

#[derive(Debug)]
pub struct VmalertSnapshot {
    pub groups: Vec<RuleGroup>,
    pub alerts: Vec<RuleAlert>,
}

#[derive(Debug, Deserialize)]
pub struct RuleGroup {
    pub id: String,
    pub name: String,
    pub file: String,
    pub rules: Vec<Rule>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    pub id: String,
    pub name: String,
    pub query: String,
    #[serde(rename = "type")]
    pub kind: RuleKind,
    pub state: RuleState,
    pub health: RuleHealth,
    pub last_error: String,
    #[serde(with = "time::serde::rfc3339")]
    pub last_evaluation: OffsetDateTime,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuleKind {
    Alerting,
    Recording,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuleState {
    #[serde(rename = "")]
    NotReported,
    Inactive,
    Pending,
    Firing,
    Unhealthy,
    Nomatch,
    Ok,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuleHealth {
    Ok,
    Err,
    Unknown,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleAlert {
    pub labels: BTreeMap<String, String>,
    pub annotations: Option<BTreeMap<String, String>>,
    pub state: RuleAlertState,
    #[serde(with = "time::serde::rfc3339")]
    pub active_at: OffsetDateTime,
    pub value: String,
    #[serde(rename = "rule_id")]
    pub rule_id: String,
    #[serde(rename = "group_id")]
    pub group_id: String,
    pub expression: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuleAlertState {
    Pending,
    Firing,
}

// SPDX-License-Identifier: LicenseRef-Proprietary
use std::{collections::BTreeMap, future::Future, pin::Pin};

use serde::Deserialize;
use time::OffsetDateTime;

pub type SourceFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, SourceError>> + Send + 'a>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum SourceError {
    #[error("source down")]
    Down,
    #[error("invalid source response")]
    Invalid,
    #[error("invalid source configuration")]
    Configuration,
}

pub trait Alertmanager: Send + Sync {
    fn read(&self) -> SourceFuture<'_, AlertmanagerSnapshot>;
}

#[derive(Debug)]
pub struct AlertmanagerSnapshot {
    pub alerts: Vec<Alert>,
    pub silences: Vec<Silence>,
    pub status: AlertmanagerStatus,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Alert {
    pub fingerprint: String,
    pub labels: BTreeMap<String, String>,
    pub annotations: BTreeMap<String, String>,
    #[serde(with = "time::serde::rfc3339")]
    pub starts_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub ends_at: OffsetDateTime,
    pub status: AlertStatus,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlertStatus {
    pub state: AlertState,
    pub silenced_by: Vec<String>,
    pub inhibited_by: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AlertState {
    Active,
    Suppressed,
    Unprocessed,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Silence {
    pub id: String,
    pub matchers: Vec<Matcher>,
    #[serde(with = "time::serde::rfc3339")]
    pub starts_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub ends_at: OffsetDateTime,
    pub created_by: String,
    pub comment: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Matcher {
    pub name: String,
    pub value: String,
    pub is_regex: bool,
    #[serde(default = "equal_matcher")]
    pub is_equal: bool,
}

fn equal_matcher() -> bool {
    true
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlertmanagerStatus {
    pub version_info: VersionInfo,
    #[serde(with = "time::serde::rfc3339")]
    pub uptime: OffsetDateTime,
}

#[derive(Debug, Deserialize)]
pub struct VersionInfo {
    pub version: String,
}

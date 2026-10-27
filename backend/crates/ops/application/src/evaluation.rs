// SPDX-License-Identifier: LicenseRef-Proprietary
use std::{
    collections::{BTreeMap, BTreeSet},
    num::NonZeroU64,
};

use console_ops_domain::{
    Observed,
    ladders::{AlertState, Severity},
};
use time::OffsetDateTime;

use crate::{Alert, AlertState as SourceAlertState, Alertmanager, AlertmanagerSnapshot};

pub struct AlertGroup {
    pub key: String,
    pub alertname: String,
    pub members_n: Observed<usize>,
    pub component: Observed<String>,
    pub severity: Observed<Severity>,
    pub state: Observed<AlertState>,
    pub summary: Observed<String>,
    pub impact: Observed<String>,
    pub first_action: Observed<String>,
}

pub struct AlertEvaluation {
    pub groups: Vec<AlertGroup>,
    /// Number of groups, independent of the number of member alerts.
    pub count: Observed<usize>,
    pub alert_count: Observed<usize>,
    pub source: Observed<String>,
}

pub struct AlertmanagerEvaluator<'a> {
    port: &'a dyn Alertmanager,
    producer: String,
    interval_s: NonZeroU64,
    attempted_at: Option<OffsetDateTime>,
    current: Option<AlertmanagerSnapshot>,
    identities: BTreeSet<(String, String)>,
    reason: String,
}

impl<'a> AlertmanagerEvaluator<'a> {
    pub fn new(port: &'a dyn Alertmanager, producer: String, interval_s: NonZeroU64) -> Self {
        Self {
            port,
            producer,
            interval_s,
            attempted_at: None,
            current: None,
            identities: BTreeSet::new(),
            reason: "not yet read".into(),
        }
    }

    pub async fn tick(&mut self, now: OffsetDateTime) -> bool {
        if self.attempted_at.is_some_and(|at| {
            now >= at
                && (now - at).whole_nanoseconds()
                    < i128::from(self.interval_s.get()) * 1_000_000_000
        }) {
            return false;
        }
        self.attempted_at = Some(now);
        self.current = None;
        self.reason = "read incomplete".into();
        match self.port.read().await {
            Ok(snapshot) => {
                self.identities = snapshot.alerts.iter().map(identity).collect();
                self.current = Some(snapshot);
            }
            Err(error) => {
                self.reason = error.to_string();
            }
        }
        true
    }

    fn observe<T>(&self, value: Option<T>, now: OffsetDateTime) -> Observed<T> {
        match (self.current.as_ref(), self.attempted_at, value) {
            (Some(_), Some(at), Some(value)) => {
                Observed::current(value, None, self.producer.clone(), at, now, self.interval_s)
            }
            (Some(_), _, None) => {
                Observed::unknown(self.producer.clone(), "not instrumented".into())
            }
            _ => Observed::unknown(self.producer.clone(), self.reason.clone()),
        }
    }

    pub fn evaluate(&self, now: OffsetDateTime) -> AlertEvaluation {
        let mut grouped: BTreeMap<_, Vec<_>> = BTreeMap::new();
        for alert in self.current.iter().flat_map(|snapshot| &snapshot.alerts) {
            grouped.entry(identity(alert)).or_default().push(alert);
        }
        let groups = self
            .identities
            .iter()
            .map(|key| {
                let members = grouped.get(key).map(Vec::as_slice).unwrap_or_default();
                let field = |name: &str, annotation: bool| {
                    let values: BTreeSet<_> = members
                        .iter()
                        .map(|alert| {
                            (if annotation {
                                &alert.annotations
                            } else {
                                &alert.labels
                            })
                            .get(name)
                            .filter(|value| !value.is_empty())
                            .cloned()
                        })
                        .collect();
                    if values.len() > 1 {
                        Observed::unknown(self.producer.clone(), "members disagree".into())
                    } else {
                        self.observe(values.into_iter().next().flatten(), now)
                    }
                };
                let severity = field("severity", false);
                let severity = match severity.value().map(String::as_str) {
                    Some("page") => self.observe(Some(Severity::Page), now),
                    Some("ticket") => self.observe(Some(Severity::Ticket), now),
                    Some(value) => Observed::unknown(
                        self.producer.clone(),
                        format!("severity {value} not on the ladder"),
                    ),
                    None => Observed::unknown(
                        self.producer.clone(),
                        severity.reason().unwrap_or("not instrumented").into(),
                    ),
                };
                let state = if members
                    .iter()
                    .any(|alert| matches!(alert.status.state, SourceAlertState::Active))
                {
                    Some(AlertState::Firing)
                } else if members
                    .iter()
                    .any(|alert| matches!(alert.status.state, SourceAlertState::Unprocessed))
                {
                    None
                } else if members
                    .iter()
                    .any(|alert| !alert.status.silenced_by.is_empty())
                {
                    Some(AlertState::Silenced)
                } else if members
                    .iter()
                    .any(|alert| !alert.status.inhibited_by.is_empty())
                {
                    Some(AlertState::Inhibited)
                } else {
                    None
                };
                AlertGroup {
                    key: format!(
                        "{}×{}",
                        key.0.replace('%', "%25").replace('×', "%C3%97"),
                        key.1.replace('%', "%25").replace('×', "%C3%97")
                    ),
                    alertname: key.0.clone(),
                    members_n: self.observe(Some(members.len()), now),
                    component: field("component", false),
                    severity,
                    state: self.observe(state, now),
                    summary: field("summary", true),
                    impact: field("impact", true),
                    first_action: field("first_action", true),
                }
            })
            .collect();
        AlertEvaluation {
            count: self.observe(self.current.as_ref().map(|_| self.identities.len()), now),
            alert_count: self.observe(self.current.as_ref().map(|s| s.alerts.len()), now),
            source: self.observe(
                self.current
                    .as_ref()
                    .map(|snapshot| snapshot.status.version_info.version.clone()),
                now,
            ),
            groups,
        }
    }
}

fn identity(alert: &Alert) -> (String, String) {
    let label = |name: &str| alert.labels.get(name).filter(|value| !value.is_empty());
    (
        label("alertname").cloned().unwrap_or_default(),
        label("component")
            .or_else(|| label("job"))
            .cloned()
            .unwrap_or_default(),
    )
}

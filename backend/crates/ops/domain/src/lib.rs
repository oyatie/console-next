// SPDX-License-Identifier: LicenseRef-Proprietary
use std::num::NonZeroU64;

use serde::{Deserialize, Serialize};
use time::{OffsetDateTime, UtcOffset, format_description::well_known::Rfc3339};

pub mod alert_actions;
pub mod bundle;
mod bundle_oncall;
mod bundle_settings;
pub mod changes;
pub mod incident;
mod incident_types;
pub mod ladders;
pub mod obligation;
pub mod recovery;
pub mod runbook;
pub mod status;
pub use ladders::{EvidenceState, Health, WorkKind};

pub const COMPONENTS_SCHEMA: &str = include_str!("../schemas/components.schema.json");
pub const OPERATORS_SCHEMA: &str = include_str!("../schemas/operators.schema.json");
pub const SETTINGS_SCHEMA: &str = include_str!("../schemas/ops-settings.schema.json");
pub const ONCALL_SCHEMA: &str = include_str!("../schemas/oncall.schema.json");
pub const OBLIGATION_RECORD_SCHEMA: &str = include_str!("../schemas/obligation-record.schema.json");

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct UtcTimestamp(pub OffsetDateTime);

impl UtcTimestamp {
    pub fn new(ts: OffsetDateTime) -> Self {
        Self(ts.to_offset(UtcOffset::UTC))
    }

    pub fn into_inner(self) -> OffsetDateTime {
        self.0
    }
}

impl From<OffsetDateTime> for UtcTimestamp {
    fn from(ts: OffsetDateTime) -> Self {
        Self::new(ts)
    }
}

impl From<UtcTimestamp> for OffsetDateTime {
    fn from(ts: UtcTimestamp) -> Self {
        ts.0
    }
}

impl std::ops::Deref for UtcTimestamp {
    type Target = OffsetDateTime;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl Serialize for UtcTimestamp {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let utc = self.0.to_offset(UtcOffset::UTC);
        time::serde::rfc3339::serialize(&utc, serializer)
    }
}

impl<'de> Deserialize<'de> for UtcTimestamp {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        if !raw.ends_with('Z') {
            return Err(serde::de::Error::custom("timestamp must end with UTC 'Z'"));
        }
        let parsed = OffsetDateTime::parse(&raw, &Rfc3339).map_err(serde::de::Error::custom)?;
        Ok(Self::new(parsed))
    }
}

pub type ObservedTimestamp = Observed<UtcTimestamp>;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Observed<T> {
    state: EvidenceState,
    value: Option<T>,
    unit: Option<String>,
    source: String,
    #[serde(with = "time::serde::rfc3339::option")]
    observed_at: Option<OffsetDateTime>,
    age_s: u64,
    reason: Option<String>,
}

impl<T> Observed<T> {
    pub fn state(&self) -> EvidenceState {
        self.state
    }

    pub fn value(&self) -> Option<&T> {
        self.value.as_ref()
    }

    pub fn reason(&self) -> Option<&str> {
        self.reason.as_deref()
    }

    pub fn unit(&self) -> Option<&str> {
        self.unit.as_deref()
    }

    pub fn source(&self) -> &str {
        &self.source
    }

    pub fn observed_at(&self) -> Option<OffsetDateTime> {
        self.observed_at
    }

    pub fn age_s(&self) -> u64 {
        self.age_s
    }

    pub fn map<U>(self, f: impl FnOnce(T) -> U) -> Observed<U> {
        Observed {
            state: self.state,
            value: self.value.map(f),
            unit: self.unit,
            source: self.source,
            observed_at: self.observed_at,
            age_s: self.age_s,
            reason: self.reason,
        }
    }

    pub fn unknown(source: String, reason: String) -> Self {
        Self {
            state: EvidenceState::Unknown,
            value: None,
            unit: None,
            source,
            observed_at: None,
            age_s: 0,
            reason: Some(reason),
        }
    }

    pub fn current(
        value: T,
        unit: Option<String>,
        source: String,
        observed_at: OffsetDateTime,
        now: OffsetDateTime,
        interval_s: NonZeroU64,
    ) -> Self {
        let age = now - observed_at;
        let age_s = u64::try_from(age.whole_seconds()).unwrap_or_default();
        let reason = if age.is_negative() {
            Some("observation in future".to_owned())
        } else if age.whole_nanoseconds() > 2 * i128::from(interval_s.get()) * 1_000_000_000 {
            Some(format!("stale {}", duration_text(age_s)))
        } else {
            None
        };
        Self {
            state: if reason.is_some() {
                EvidenceState::Unknown
            } else {
                EvidenceState::Verified
            },
            value: reason.is_none().then_some(value),
            unit,
            source,
            observed_at: Some(observed_at.to_offset(UtcOffset::UTC)),
            age_s,
            reason,
        }
    }
}

pub fn duration_text(seconds: u64) -> String {
    match (seconds / 3600, seconds / 60 % 60) {
        (0, 0) => format!("{seconds}s"),
        (0, minutes) => format!("{minutes}m"),
        (hours, 0) => format!("{hours}h"),
        (hours, minutes) => format!("{hours}h {minutes}m"),
    }
}

pub fn roll_up(children: impl IntoIterator<Item = Health>) -> Health {
    children.into_iter().max().unwrap_or(Health::Unknown)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Verdict {
    pub text: String,
    pub worst: Health,
}

pub fn verdict(
    health: Health,
    work: &[WorkKind],
    evidence: &[(EvidenceState, Option<&str>)],
) -> Verdict {
    let unverified = evidence
        .iter()
        .filter(|(state, _)| *state != EvidenceState::Verified)
        .count();
    let unknown = unverified > 0 || evidence.is_empty();
    let worst = if unknown { Health::Unknown } else { health };
    let quiet = worst == Health::Healthy && work.iter().all(|kind| *kind == WorkKind::Ticket);
    let evidence_text = if evidence.is_empty() {
        "Unknown: no sources checked".to_owned()
    } else if unknown {
        let reason = evidence.iter().find_map(|(state, reason)| {
            (*state != EvidenceState::Verified)
                .then_some(*reason)
                .flatten()
        });
        match reason {
            Some(reason) => {
                format!(
                    "{} not verified · Unknown: {reason}",
                    count_text(unverified, "source")
                )
            }
            None => format!("Unknown: {} not verified", count_text(unverified, "source")),
        }
    } else {
        "evidence fresh".to_owned()
    };
    let mut counts = Vec::new();
    for (kind, noun) in [
        (WorkKind::Page, "page"),
        (WorkKind::Overdue, "overdue"),
        (WorkKind::Due, "due"),
        (WorkKind::Ticket, "ticket"),
        (WorkKind::Obligation, "obligation"),
    ] {
        let count = work.iter().filter(|value| **value == kind).count();
        if count > 0 || kind == WorkKind::Page {
            counts.push(if matches!(kind, WorkKind::Due | WorkKind::Overdue) {
                format!("{count} {noun}")
            } else {
                count_text(count, noun)
            });
        }
    }
    Verdict {
        text: format!(
            "{} · {} · {evidence_text}",
            if quiet {
                "All quiet"
            } else {
                "Needs a human now"
            },
            counts.join(" · ")
        ),
        worst,
    }
}

fn count_text(count: usize, noun: &str) -> String {
    format!("{count} {noun}{}", if count == 1 { "" } else { "s" })
}

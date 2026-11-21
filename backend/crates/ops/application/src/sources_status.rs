// SPDX-License-Identifier: LicenseRef-Proprietary
use std::num::NonZeroU64;

use console_ops_domain::Observed;
use console_ops_domain::ladders::EvidenceState;
use time::{OffsetDateTime, UtcOffset};

use crate::snapshot::{EvidenceCountsView, SourceKind, SourceView};

#[derive(Debug, Clone)]
pub struct SourceSlot<T> {
    pub name: String,
    pub kind: SourceKind,
    pub producer: String,
    pub interval_s: NonZeroU64,
    pub attempted_at: Option<OffsetDateTime>,
    pub current: Option<T>,
    pub reason: String,
}

impl<T> SourceSlot<T> {
    pub fn new(
        name: impl Into<String>,
        kind: SourceKind,
        producer: String,
        interval_s: NonZeroU64,
    ) -> Self {
        Self {
            name: name.into(),
            kind,
            producer,
            interval_s,
            attempted_at: None,
            current: None,
            reason: "not yet read".to_owned(),
        }
    }

    pub fn due(&self, now: OffsetDateTime) -> bool {
        !self.attempted_at.is_some_and(|at| {
            now >= at
                && (now - at).whole_nanoseconds()
                    < i128::from(self.interval_s.get()) * 1_000_000_000
        })
    }

    pub fn begin_read(&mut self, now: OffsetDateTime) {
        self.attempted_at = Some(now);
        self.current = None;
        self.reason = "read incomplete".to_owned();
    }

    pub fn finish_ok(&mut self, value: T) {
        self.current = Some(value);
    }

    pub fn finish_err(&mut self, reason: impl Into<String>) {
        self.current = None;
        self.reason = reason.into();
    }

    pub fn observe<V>(
        &self,
        value: Option<V>,
        unit: Option<String>,
        now: OffsetDateTime,
    ) -> Observed<V> {
        match (self.current.as_ref(), self.attempted_at, value) {
            (Some(_), Some(at), Some(val)) => {
                Observed::current(val, unit, self.producer.clone(), at, now, self.interval_s)
            }
            (Some(_), _, None) => {
                Observed::unknown(self.producer.clone(), "not instrumented".to_owned())
            }
            _ => Observed::unknown(self.producer.clone(), self.reason.clone()),
        }
    }

    pub fn observe_at<V>(
        &self,
        value: Option<V>,
        unit: Option<String>,
        observed_at: Option<OffsetDateTime>,
        now: OffsetDateTime,
        interval_s: NonZeroU64,
    ) -> Observed<V> {
        match (self.current.as_ref(), observed_at, value) {
            (Some(_), Some(at), Some(val)) => {
                Observed::current(val, unit, self.producer.clone(), at, now, interval_s)
            }
            (Some(_), _, _) => {
                Observed::unknown(self.producer.clone(), "not instrumented".to_owned())
            }
            (None, _, _) => Observed::unknown(self.producer.clone(), self.reason.clone()),
        }
    }

    pub fn source_view(&self, now: OffsetDateTime) -> SourceView {
        match (self.current.as_ref(), self.attempted_at) {
            (Some(_), Some(at)) => {
                let probe =
                    Observed::current((), None, self.producer.clone(), at, now, self.interval_s);
                SourceView {
                    name: self.name.clone(),
                    kind: self.kind,
                    producer: self.producer.clone(),
                    interval: self.interval_s.get(),
                    observed_at: Some(at.to_offset(UtcOffset::UTC)),
                    age: probe.age_s(),
                    state: probe.state(),
                    reason: probe.reason().map(str::to_owned),
                }
            }
            _ => SourceView {
                name: self.name.clone(),
                kind: self.kind,
                producer: self.producer.clone(),
                interval: self.interval_s.get(),
                observed_at: None,
                age: 0,
                state: EvidenceState::Unknown,
                reason: Some(self.reason.clone()),
            },
        }
    }
}

#[derive(Debug, Clone)]
pub struct ExternalSourceStatus {
    pub name: String,
    pub kind: SourceKind,
    pub producer: String,
    pub interval_s: NonZeroU64,
    pub observed_at: Option<OffsetDateTime>,
    pub error: Option<String>,
}

impl ExternalSourceStatus {
    pub fn into_view(&self, now: OffsetDateTime) -> SourceView {
        if let Some(reason) = &self.error {
            return SourceView {
                name: self.name.clone(),
                kind: self.kind,
                producer: self.producer.clone(),
                interval: self.interval_s.get(),
                observed_at: None,
                age: 0,
                state: EvidenceState::Unknown,
                reason: Some(reason.clone()),
            };
        }
        match self.observed_at {
            Some(at) => {
                let probe =
                    Observed::current((), None, self.producer.clone(), at, now, self.interval_s);
                SourceView {
                    name: self.name.clone(),
                    kind: self.kind,
                    producer: self.producer.clone(),
                    interval: self.interval_s.get(),
                    observed_at: Some(at.to_offset(UtcOffset::UTC)),
                    age: probe.age_s(),
                    state: probe.state(),
                    reason: probe.reason().map(str::to_owned),
                }
            }
            None => SourceView {
                name: self.name.clone(),
                kind: self.kind,
                producer: self.producer.clone(),
                interval: self.interval_s.get(),
                observed_at: None,
                age: 0,
                state: EvidenceState::Unknown,
                reason: Some("not yet read".to_owned()),
            },
        }
    }
}

pub fn sanitize_text(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || matches!(trimmed, "No data" | "N/A" | "—") {
        None
    } else {
        Some(raw.to_owned())
    }
}

pub fn count_evidence(sources: &[SourceView]) -> EvidenceCountsView {
    let mut counts = EvidenceCountsView {
        verified: 0,
        monitoring: 0,
        stale: 0,
        unknown: 0,
    };
    for s in sources {
        match s.state {
            EvidenceState::Verified => counts.verified += 1,
            EvidenceState::Monitoring => counts.monitoring += 1,
            EvidenceState::Stale => counts.stale += 1,
            EvidenceState::Unknown => counts.unknown += 1,
        }
    }
    counts
}

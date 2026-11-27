// SPDX-License-Identifier: LicenseRef-Proprietary
use serde::{Deserialize, Serialize};
use time::{Date, OffsetDateTime, UtcOffset};

use crate::{Health, Verdict};

time::serde::format_description!(iso_date, Date, "[year]-[month]-[day]");

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    ProfessionalReview,
    CredentialRotation,
    Escrow,
    Drill,
    LaunchGate,
    OwnerDecision,
    RegulatoryWatch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReviewerRole {
    LaborAttorney,
    Lawyer,
    TaxAccountant,
    Owner,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum State {
    Open,
    InReview,
    Done,
    Waived,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "event",
    content = "fields",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum Event {
    Opened {
        kind: Kind,
        reviewer_role: ReviewerRole,
        title: String,
        #[serde(default, with = "iso_date::option")]
        due: Option<Date>,
        evidence_ref: Option<String>,
    },
    InReview {
        note: Option<String>,
    },
    Redated {
        #[serde(default, with = "iso_date::option")]
        due: Option<Date>,
        reason: Option<String>,
    },
    Done {
        evidence_ref: Option<String>,
        signer: Option<String>,
        #[serde(default)]
        co_signer: Option<String>,
        #[serde(default)]
        counsel_url: Option<String>,
        #[serde(default, with = "iso_date::option")]
        signed_on: Option<Date>,
    },
    Waived {
        reason: Option<String>,
        signer: Option<String>,
        #[serde(default)]
        co_signer: Option<String>,
        #[serde(default)]
        counsel_url: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    Invalid,
    Incomplete,
    Final,
    NotFound,
}

impl Refusal {
    pub fn code(self) -> &'static str {
        match self {
            Self::Invalid => "OPS_OBLIGATION_INVALID",
            Self::Incomplete => "OPS_OBLIGATION_INCOMPLETE",
            Self::Final => "OPS_OBLIGATION_FINAL",
            Self::NotFound => "OPS_OBLIGATION_NOT_FOUND",
        }
    }
}

// State is reconstructed only through validated events, never deserialized from a snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Obligation {
    kind: Kind,
    reviewer_role: ReviewerRole,
    title: String,
    #[serde(with = "iso_date::option")]
    due: Option<Date>,
    state: State,
    evidence_ref: Option<String>,
    signer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    co_signer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    counsel_url: Option<String>,
    #[serde(with = "iso_date::option")]
    signed_on: Option<Date>,
}

fn present(value: &Option<String>) -> bool {
    value.as_ref().is_some_and(|value| !value.trim().is_empty())
}

pub fn is_structured_counsel_url(raw: &str) -> bool {
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed.chars().any(|c| c.is_whitespace() || c.is_control())
        || trimmed.contains("..")
    {
        return false;
    }
    if let Some(rest) = trimmed.strip_prefix("https://") {
        let Some((host, path)) = rest.split_once('/') else {
            return false;
        };
        return !host.is_empty()
            && (host.contains('.') || host.starts_with("localhost"))
            && !path.is_empty();
    }
    if let Some(rest) = trimmed
        .strip_prefix("docs/")
        .or_else(|| trimmed.strip_prefix("ops/"))
    {
        return !rest.is_empty() && !rest.starts_with('/');
    }
    false
}

fn distinct_signers(primary: &Option<String>, secondary: &Option<String>) -> bool {
    match (primary.as_deref(), secondary.as_deref()) {
        (Some(a), Some(b)) => !a.trim().eq_ignore_ascii_case(b.trim()),
        _ => true,
    }
}

impl Obligation {
    /// Replay under the spool's append lock; a refusal leaves the previous state intact.
    pub fn evolve(current: Option<&Self>, event: &Event) -> Result<Self, Refusal> {
        if current.is_some_and(|item| !item.is_open()) {
            return Err(Refusal::Final);
        }
        if let Event::Opened {
            kind,
            reviewer_role,
            title,
            due,
            evidence_ref,
        } = event
        {
            if current.is_some() || title.trim().is_empty() {
                return Err(Refusal::Invalid);
            }
            return Ok(Self {
                kind: *kind,
                reviewer_role: *reviewer_role,
                title: title.clone(),
                due: *due,
                state: State::Open,
                evidence_ref: evidence_ref.clone(),
                signer: None,
                co_signer: None,
                counsel_url: None,
                signed_on: None,
            });
        }
        let mut item = current.ok_or(Refusal::NotFound)?.clone();
        match event {
            Event::InReview { .. } if item.state == State::Open => item.state = State::InReview,
            Event::Redated {
                due: Some(due),
                reason,
            } if present(reason) => item.due = Some(*due),
            Event::Done {
                evidence_ref,
                signer,
                co_signer,
                counsel_url,
                signed_on: Some(signed_on),
            } if present(evidence_ref) && present(signer) => {
                if item.kind == Kind::LaunchGate {
                    if !present(co_signer) {
                        return Err(Refusal::Incomplete);
                    }
                    let structured_ok = if present(counsel_url) {
                        counsel_url
                            .as_deref()
                            .is_some_and(is_structured_counsel_url)
                    } else {
                        evidence_ref
                            .as_deref()
                            .is_some_and(is_structured_counsel_url)
                    };
                    if !distinct_signers(signer, co_signer) || !structured_ok {
                        return Err(Refusal::Invalid);
                    }
                } else {
                    if present(co_signer) && !distinct_signers(signer, co_signer) {
                        return Err(Refusal::Invalid);
                    }
                    if present(counsel_url)
                        && !counsel_url
                            .as_deref()
                            .is_some_and(is_structured_counsel_url)
                    {
                        return Err(Refusal::Invalid);
                    }
                }
                item.state = State::Done;
                item.evidence_ref = evidence_ref.clone();
                item.signer = signer.clone();
                item.co_signer = co_signer.as_ref().filter(|s| !s.trim().is_empty()).cloned();
                item.counsel_url = counsel_url
                    .as_ref()
                    .filter(|s| !s.trim().is_empty())
                    .cloned();
                item.signed_on = Some(*signed_on);
            }
            Event::Waived {
                reason,
                signer,
                co_signer,
                counsel_url,
            } if present(reason) && present(signer) => {
                if item.kind == Kind::LaunchGate {
                    if !present(co_signer) || !present(counsel_url) {
                        return Err(Refusal::Incomplete);
                    }
                    if !distinct_signers(signer, co_signer)
                        || !counsel_url
                            .as_deref()
                            .is_some_and(is_structured_counsel_url)
                    {
                        return Err(Refusal::Invalid);
                    }
                } else {
                    if present(co_signer) && !distinct_signers(signer, co_signer) {
                        return Err(Refusal::Invalid);
                    }
                    if present(counsel_url)
                        && !counsel_url
                            .as_deref()
                            .is_some_and(is_structured_counsel_url)
                    {
                        return Err(Refusal::Invalid);
                    }
                }
                item.state = State::Waived;
                item.signer = signer.clone();
                item.co_signer = co_signer.as_ref().filter(|s| !s.trim().is_empty()).cloned();
                item.counsel_url = counsel_url
                    .as_ref()
                    .filter(|s| !s.trim().is_empty())
                    .cloned();
            }
            Event::Opened { .. } | Event::InReview { .. } => return Err(Refusal::Invalid),
            _ => return Err(Refusal::Incomplete),
        }
        Ok(item)
    }

    pub fn kind(&self) -> Kind {
        self.kind
    }

    pub fn reviewer_role(&self) -> ReviewerRole {
        self.reviewer_role
    }

    pub fn title(&self) -> &str {
        &self.title
    }

    pub fn due(&self) -> Option<Date> {
        self.due
    }

    pub fn state(&self) -> State {
        self.state
    }

    pub fn evidence_ref(&self) -> Option<&str> {
        self.evidence_ref.as_deref()
    }

    pub fn signer(&self) -> Option<&str> {
        self.signer.as_deref()
    }

    pub fn co_signer(&self) -> Option<&str> {
        self.co_signer.as_deref()
    }

    pub fn counsel_url(&self) -> Option<&str> {
        self.counsel_url.as_deref()
    }

    pub fn signed_on(&self) -> Option<Date> {
        self.signed_on
    }

    pub fn is_open(&self) -> bool {
        matches!(self.state, State::Open | State::InReview)
    }

    pub fn days_remaining(&self, now: OffsetDateTime) -> Option<i64> {
        self.due
            .map(|due| (due - now.to_offset(UtcOffset::UTC).date()).whole_days())
    }

    pub fn worklist_key(
        &self,
        now: OffsetDateTime,
        due_soon_days: u32,
    ) -> Option<(u8, Option<Date>)> {
        if !self.is_open() {
            return None;
        }
        let days = self.days_remaining(now);
        let include =
            self.kind == Kind::LaunchGate || days.is_none_or(|d| d <= i64::from(due_soon_days));
        if !include {
            return None;
        }
        let priority = match days {
            Some(d) if d < 0 && self.kind == Kind::OwnerDecision => 0,
            Some(d) if d < 0 => 1,
            Some(d) if d <= i64::from(due_soon_days) => 2,
            Some(_) => 3,
            None => 4,
        };
        Some((priority, self.due))
    }

    pub fn deadline(&self, now: OffsetDateTime) -> String {
        match self.days_remaining(now) {
            None => "Unknown: no due date".into(),
            Some(0) => "D-day".into(),
            Some(days) if days > 0 => format!("D-{days}"),
            Some(days) => format!("D+{}", -days),
        }
    }
}

/// Call only after obligation.read is allowed, passing the verified source or its failure reason.
pub fn launch_readiness(source: Result<&[Obligation], &str>) -> Verdict {
    let items = match source {
        Ok(items) => items,
        Err(reason) => {
            return Verdict {
                text: format!("Unknown: {reason}"),
                worst: Health::Unknown,
            };
        }
    };
    let gates: Vec<_> = items
        .iter()
        .filter(|item| item.kind == Kind::LaunchGate)
        .collect();
    let open = gates.iter().filter(|item| item.is_open()).count();
    if gates.is_empty() {
        Verdict {
            text: "Unknown: no launch gates recorded".into(),
            worst: Health::Unknown,
        }
    } else if open > 0 {
        Verdict {
            text: format!("Blocked: {} open", crate::count_text(open, "launch gate")),
            worst: Health::Degraded,
        }
    } else {
        Verdict {
            text: format!(
                "Ready: all {} done or waived (signed)",
                crate::count_text(gates.len(), "launch gate")
            ),
            worst: Health::Healthy,
        }
    }
}

/// Input must be chain-verified and Cedar-authorized before computing any worklist or count.
pub fn worklist(items: &[Obligation], now: OffsetDateTime, due_soon_days: u32) -> Vec<&Obligation> {
    let mut keyed: Vec<_> = items
        .iter()
        .filter_map(|item| item.worklist_key(now, due_soon_days).map(|key| (key, item)))
        .collect();
    keyed.sort_by_key(|(key, _)| *key);
    keyed.into_iter().map(|(_, item)| item).collect()
}

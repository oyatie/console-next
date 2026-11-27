// SPDX-License-Identifier: LicenseRef-Proprietary
use serde::{Deserialize, Serialize};
use time::{Date, OffsetDateTime, UtcOffset};

pub use crate::obligation_guards::{is_structured_counsel_url, launch_readiness, worklist};
use crate::obligation_guards::{present, validate_done, validate_waived};

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
                validate_done(item.kind, evidence_ref, signer, co_signer, counsel_url)?;
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
                validate_waived(item.kind, signer, co_signer, counsel_url)?;
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

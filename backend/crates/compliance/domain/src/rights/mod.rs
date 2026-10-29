// SPDX-License-Identifier: LicenseRef-Proprietary
//! Privacy-rights clocks and append-only decisions; authorization belongs to Cedar.
#[cfg(test)]
mod tests;
use crate::statutory::{StatutoryRegister, StatutoryRule, StatutoryUnit, codes, filing};
use console_kernel_core::KernelError;
use serde::Serialize;
use std::collections::BTreeMap;
use time::{Date, OffsetDateTime};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Kind {
    Access,
    Correction,
    Deletion,
    Suspension,
    Withdrawal,
    AutomatedDecision,
    Transmission,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Controller {
    Tenant,
    Operator,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Channel {
    InApp,
    Phone,
    Letter,
    Email,
    InPerson,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AgentKind {
    Subject,
    LegalRepresentative,
    Authorized,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum IdentityMethod {
    SignedIn,
    IdDocumentSeen,
    KnownContact,
    AgentMandate,
}
#[derive(Debug, Clone, Serialize)]
pub struct Receipt {
    pub id: Uuid,
    pub controller: Controller,
    pub channel: Channel,
    pub agent: AgentKind,
    /// Required for both legal representatives and authorized agents (영 §45②).
    pub mandate_received: bool,
    pub identity_method: IdentityMethod,
    pub identity_at: OffsetDateTime,
    /// Controller's receipt date in KST, including off-app receipt.
    pub received_on: Date,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Outcome {
    Granted,
    Partial,
    Refused,
    Postponed,
}
#[derive(Debug, Clone, Serialize)]
pub struct Decision {
    pub outcome: Outcome,
    pub reason: Option<String>,
    pub note: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
pub struct RecordedDecision {
    pub on: Date,
    pub decision: Decision,
}
#[derive(Debug, Clone, Serialize)]
pub struct Due {
    pub on: Option<Date>,
    pub without_delay: bool,
    /// The exact register row, including its HOLD/review disposition.
    pub rule: Option<StatutoryRule>,
}
#[derive(Debug, Clone, Serialize)]
pub struct KindState {
    /// None means 기한 확인 불가; intake remains recorded.
    pub due: Option<Due>,
    pub decisions: Vec<RecordedDecision>,
}
impl KindState {
    fn is_final(&self) -> bool {
        self.decisions
            .last()
            .is_some_and(|d| d.decision.outcome != Outcome::Postponed)
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Status {
    Received,
    Decided,
}
#[derive(Debug, Clone, Serialize)]
pub struct RightsRequest {
    receipt: Receipt,
    kinds: BTreeMap<Kind, KindState>,
    objection_of: Option<Uuid>,
}
impl RightsRequest {
    pub fn receive(
        receipt: Receipt,
        kinds: impl IntoIterator<Item = Kind>,
        register: &StatutoryRegister,
        today: Date,
        original: Option<(&Self, u16)>,
    ) -> Result<Self, KernelError> {
        if receipt.received_on > today {
            return Err(KernelError::validation("received_on_invalid"));
        }
        if receipt.agent != AgentKind::Subject && !receipt.mandate_received {
            return Err(KernelError::validation("mandate_required"));
        }
        let kinds = kinds
            .into_iter()
            .map(|kind| {
                let due = if let Some((original, review_days)) = original {
                    if !original
                        .kinds
                        .get(&kind)
                        .is_some_and(|s| !s.decisions.is_empty())
                    {
                        return Err(KernelError::validation("objection_before_result"));
                    }
                    // review_days is resolved from privacy.rights.objection_review_days.
                    Some(clock(receipt.received_on, Some(review_days), None)?)
                } else {
                    due(kind, receipt.received_on, register)?
                };
                Ok((
                    kind,
                    KindState {
                        due,
                        decisions: vec![],
                    },
                ))
            })
            .collect::<Result<BTreeMap<_, _>, KernelError>>()?;
        if kinds.is_empty() {
            return Err(KernelError::validation("request_kind_required"));
        }
        Ok(Self {
            receipt,
            kinds,
            objection_of: original.map(|(r, _)| r.receipt.id),
        })
    }
    pub fn receipt(&self) -> &Receipt {
        &self.receipt
    }
    pub fn kinds(&self) -> &BTreeMap<Kind, KindState> {
        &self.kinds
    }
    pub fn objection_of(&self) -> Option<Uuid> {
        self.objection_of
    }
    pub fn status(&self) -> Status {
        if self.kinds.values().all(KindState::is_final) {
            Status::Decided
        } else {
            Status::Received
        }
    }
    pub fn decide(
        &mut self,
        kind: Kind,
        decision: Decision,
        on: Date,
        today: Date,
        reason_codes: &BTreeMap<String, Vec<String>>,
    ) -> Result<(), KernelError> {
        let state = self
            .kinds
            .get_mut(&kind)
            .ok_or_else(|| KernelError::validation("request_kind_unavailable"))?;
        if state.is_final() {
            return Err(KernelError::validation("request_already_decided"));
        }
        if on > today
            || on < self.receipt.received_on
            || state.decisions.last().is_some_and(|d| on < d.on)
        {
            return Err(KernelError::validation("decision_date_invalid"));
        }
        let reason_allowed = kind
            .reason_domain(decision.outcome)
            .and_then(|domain| reason_codes.get(domain))
            .is_some_and(|codes| {
                decision
                    .reason
                    .as_ref()
                    .is_some_and(|code| codes.contains(code))
            });
        let allowed = match decision.outcome {
            Outcome::Granted => decision.reason.is_none(),
            Outcome::Postponed => {
                reason_allowed
                    && state.decisions.is_empty()
                    && state
                        .due
                        .as_ref()
                        .and_then(|d| d.on)
                        .is_some_and(|due| on <= due)
            }
            Outcome::Partial | Outcome::Refused => reason_allowed,
        };
        if !allowed {
            return Err(KernelError::validation(
                if decision.outcome == Outcome::Postponed {
                    "postpone_not_allowed"
                } else {
                    "reason_code_invalid"
                },
            ));
        }
        if decision.outcome != Outcome::Granted
            && decision.note.as_deref().is_none_or(|n| n.trim().is_empty())
        {
            return Err(KernelError::validation("reason_note_required"));
        }
        state.decisions.push(RecordedDecision { on, decision });
        Ok(())
    }
}
fn due(kind: Kind, on: Date, register: &StatutoryRegister) -> Result<Option<Due>, KernelError> {
    let code = match kind {
        Kind::Access => Some(codes::PIPA_ACCESS_RESPONSE_DAYS),
        Kind::Correction | Kind::Deletion => Some(codes::PIPA_CORRECTION_RESPONSE_DAYS),
        Kind::Suspension => Some(codes::PIPA_SUSPENSION_RESPONSE_DAYS),
        Kind::Withdrawal => None,
        Kind::AutomatedDecision | Kind::Transmission => return Ok(None),
    };
    let rule = if let Some(code) = code {
        let Ok(rule) = register.rule(code, on) else {
            return Ok(None);
        };
        Some(rule.clone())
    } else {
        None
    };
    let value = rule
        .as_ref()
        .map(|r| {
            u16::try_from(r.whole(StatutoryUnit::Days)?)
                .map_err(|_| KernelError::validation("invalid rights clock"))
        })
        .transpose()?;
    Ok(Some(clock(on, value, rule)?))
}
fn clock(on: Date, value: Option<u16>, rule: Option<StatutoryRule>) -> Result<Due, KernelError> {
    use filing::{Calculation, FilingAnchor, FilingAnchors, FilingRuleKind, FirstDay, HolidayRoll};
    let without_delay = value.is_none();
    let calculation = Calculation {
        anchor: FilingAnchor::RequestDate,
        kind: if without_delay {
            FilingRuleKind::WithoutDelay
        } else {
            FilingRuleKind::Days
        },
        value,
        first_day: FirstDay::Excluded,
    };
    let on = filing::calculation_date(
        &calculation,
        &FilingAnchors {
            request_date: Some(on),
            ..Default::default()
        },
        HolidayRoll::Unverified,
        &[],
    )?;
    Ok(Due {
        on,
        without_delay,
        rule,
    })
}

impl Kind {
    /// Wire domains are identifiers; the settings code_lists roster owns their codes.
    pub fn reason_domain(self, outcome: Outcome) -> Option<&'static str> {
        match (self, outcome) {
            (Self::Access, Outcome::Postponed) => Some("privacy_postpone_access"),
            (_, Outcome::Granted | Outcome::Postponed) => None,
            (Self::Access, _) => Some("privacy_refusal_access"),
            (Self::Deletion, _) => Some("privacy_refusal_deletion"),
            (Self::Suspension | Self::Withdrawal, _) => Some("privacy_refusal_suspension"),
            _ => None,
        }
    }
}

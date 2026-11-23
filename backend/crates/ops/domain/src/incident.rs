// SPDX-License-Identifier: LicenseRef-Proprietary
use serde::Serialize;
use time::{Duration, OffsetDateTime};

use crate::UtcTimestamp;
use crate::ladders::{Incident, IncidentSeverity};

pub use crate::incident_types::{
    IncidentEvent, IncidentRefusal, IncidentTimelineEntry, LegalClock, PersonalDataImpact,
    PublicDraftStage, PublicUpdateDraft,
};

pub const LEGAL_CLOCK_PIPC_KISA_HOURS: i64 = 72;
pub const LEGAL_CLOCK_INTRUSION_HOURS: i64 = 24;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct IncidentState {
    pub id: String,
    pub title: String,
    pub sev: IncidentSeverity,
    pub status: Incident,
    pub lead: Option<String>,
    pub affected_components: Vec<String>,
    pub personal_data_impact: PersonalDataImpact,
    pub intrusion: bool,
    pub opened_at: UtcTimestamp,
    pub discovered_at: UtcTimestamp,
    pub next_public_update_at: Option<UtcTimestamp>,
    pub public_incident_id: Option<String>,
    pub postmortem_ref: Option<String>,
    pub mitigations: Vec<String>,
    pub timeline: Vec<IncidentTimelineEntry>,
    pub head_seq: u64,
    pub head_hash: String,
}

pub type IncidentRecord = IncidentState;

fn non_empty(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty() && !trimmed.chars().any(char::is_control)
}

fn is_valid_public_id(id: &str) -> bool {
    let Some(digits) = id.strip_prefix("ST-") else {
        return false;
    };
    digits.len() >= 4 && digits.bytes().all(|b| b.is_ascii_digit())
}

impl IncidentState {
    pub fn is_open(&self) -> bool {
        self.status != Incident::Resolved
    }

    pub fn legal_clocks(&self, now: OffsetDateTime) -> Vec<LegalClock> {
        let mut clocks = Vec::new();
        if matches!(
            self.personal_data_impact,
            PersonalDataImpact::Yes | PersonalDataImpact::Unknown
        ) {
            let deadline = UtcTimestamp::new(
                *self.discovered_at + Duration::hours(LEGAL_CLOCK_PIPC_KISA_HOURS),
            );
            let remaining_s = (*deadline - now).whole_seconds();
            clocks.push(LegalClock {
                kind: "pipc_kisa_72h",
                deadline,
                remaining_s,
                overdue: remaining_s < 0,
            });
        }
        if self.intrusion {
            let deadline = UtcTimestamp::new(
                *self.discovered_at + Duration::hours(LEGAL_CLOCK_INTRUSION_HOURS),
            );
            let remaining_s = (*deadline - now).whole_seconds();
            clocks.push(LegalClock {
                kind: "intrusion_24h",
                deadline,
                remaining_s,
                overdue: remaining_s < 0,
            });
        }
        clocks
    }

    #[allow(clippy::too_many_arguments)]
    pub fn evolve(
        current: Option<&Self>,
        id: &str,
        event: &IncidentEvent,
        seq: u64,
        hash: &str,
        at: OffsetDateTime,
        actor: &str,
        expected_seq: Option<u64>,
    ) -> Result<Self, IncidentRefusal> {
        let at_utc = UtcTimestamp::new(at);
        if let IncidentEvent::Declared {
            title,
            sev,
            lead,
            affected_components,
            personal_data_impact,
            intrusion,
            discovered_at,
            next_public_update_at,
            public_incident_id,
        } = event
        {
            if current.is_some()
                || expected_seq.is_some_and(|s| s != 0)
                || !non_empty(id)
                || !non_empty(title)
                || !non_empty(actor)
                || **discovered_at > *at_utc
                || lead.as_deref().is_some_and(|l| !non_empty(l))
                || affected_components.iter().any(|c| !non_empty(c))
                || public_incident_id
                    .as_deref()
                    .is_some_and(|pid| !is_valid_public_id(pid))
            {
                return Err(IncidentRefusal::Invalid);
            }
            return Ok(Self {
                id: id.to_owned(),
                title: title.trim().to_owned(),
                sev: *sev,
                status: Incident::Investigating,
                lead: lead.as_deref().map(|l| l.trim().to_owned()),
                affected_components: affected_components
                    .iter()
                    .map(|c| c.trim().to_owned())
                    .collect(),
                personal_data_impact: *personal_data_impact,
                intrusion: *intrusion,
                opened_at: at_utc,
                discovered_at: *discovered_at,
                next_public_update_at: *next_public_update_at,
                public_incident_id: public_incident_id.clone(),
                postmortem_ref: None,
                mitigations: Vec::new(),
                timeline: vec![IncidentTimelineEntry {
                    seq,
                    at: at_utc,
                    actor: actor.to_owned(),
                    kind: "declared".to_owned(),
                    summary: title.trim().to_owned(),
                }],
                head_seq: seq,
                head_hash: hash.to_owned(),
            });
        }

        let mut next = current.ok_or(IncidentRefusal::NotFound)?.clone();
        if let Some(exp) = expected_seq
            && next.head_seq != exp
        {
            return Err(IncidentRefusal::Conflict);
        }
        if !next.is_open() {
            return Err(IncidentRefusal::Final);
        }
        let requires_postmortem =
            matches!(next.sev, IncidentSeverity::Sev1 | IncidentSeverity::Sev2)
                && next.postmortem_ref.as_deref().is_none_or(str::is_empty);

        let (kind, summary) = apply_mutation(&mut next, event, requires_postmortem)?;
        next.timeline.push(IncidentTimelineEntry {
            seq,
            at: at_utc,
            actor: actor.to_owned(),
            kind: kind.to_owned(),
            summary,
        });
        next.head_seq = seq;
        next.head_hash = hash.to_owned();
        Ok(next)
    }
}

fn apply_mutation(
    next: &mut IncidentState,
    event: &IncidentEvent,
    requires_postmortem: bool,
) -> Result<(&'static str, String), IncidentRefusal> {
    match event {
        IncidentEvent::Declared { .. } => Err(IncidentRefusal::Invalid),
        IncidentEvent::LeadAssigned { lead } => {
            if !non_empty(lead) {
                return Err(IncidentRefusal::Invalid);
            }
            next.lead = Some(lead.trim().to_owned());
            Ok(("lead_assigned", lead.trim().to_owned()))
        }
        IncidentEvent::NoteAdded { note } => {
            if !non_empty(note) {
                return Err(IncidentRefusal::Invalid);
            }
            Ok(("note_added", note.trim().to_owned()))
        }
        IncidentEvent::SeverityChanged { sev, reason } => {
            next.sev = *sev;
            Ok((
                "severity_changed",
                reason.clone().unwrap_or_else(|| format!("{sev:?}")),
            ))
        }
        IncidentEvent::StatusChanged {
            status,
            next_public_update_at,
            reason,
        } => {
            if *status == Incident::Resolved && requires_postmortem {
                return Err(IncidentRefusal::PostmortemRequired);
            }
            next.status = *status;
            if next_public_update_at.is_some() {
                next.next_public_update_at = *next_public_update_at;
            }
            Ok((
                "status_changed",
                reason.clone().unwrap_or_else(|| format!("{status:?}")),
            ))
        }
        IncidentEvent::PostmortemLinked { postmortem_ref } => {
            if !non_empty(postmortem_ref) {
                return Err(IncidentRefusal::Invalid);
            }
            next.postmortem_ref = Some(postmortem_ref.trim().to_owned());
            Ok(("postmortem_linked", postmortem_ref.trim().to_owned()))
        }
        IncidentEvent::PublicAttached { public_incident_id } => {
            if !is_valid_public_id(public_incident_id) {
                return Err(IncidentRefusal::Invalid);
            }
            next.public_incident_id = Some(public_incident_id.clone());
            Ok(("public_attached", public_incident_id.clone()))
        }
        IncidentEvent::MitigationAdded { action_id, summary } => {
            if !non_empty(action_id) || !non_empty(summary) {
                return Err(IncidentRefusal::Invalid);
            }
            next.mitigations.push(action_id.trim().to_owned());
            Ok((
                "mitigation_added",
                format!("{}: {}", action_id.trim(), summary.trim()),
            ))
        }
        IncidentEvent::PublicDrafted { draft, action_id } => {
            if !non_empty(action_id)
                || !non_empty(&draft.message_ko)
                || !non_empty(&draft.message_en)
                || draft.components.is_empty()
                || draft.components.iter().any(|c| !non_empty(c))
                || draft.rev == 0
            {
                return Err(IncidentRefusal::Invalid);
            }
            Ok((
                "public_drafted",
                format!("rev {} ({})", draft.rev, action_id.trim()),
            ))
        }
        IncidentEvent::NoticeSent {
            channel,
            summary,
            next_public_update_at,
        } => {
            if !non_empty(channel) {
                return Err(IncidentRefusal::Invalid);
            }
            if next_public_update_at.is_some() {
                next.next_public_update_at = *next_public_update_at;
            }
            Ok((
                "notice_sent",
                summary
                    .as_deref()
                    .filter(|s| non_empty(s))
                    .map_or_else(|| channel.trim().to_owned(), str::to_owned),
            ))
        }
        IncidentEvent::Resolved { summary } => {
            if requires_postmortem {
                return Err(IncidentRefusal::PostmortemRequired);
            }
            next.status = Incident::Resolved;
            Ok((
                "resolved",
                summary
                    .as_deref()
                    .filter(|s| non_empty(s))
                    .map_or_else(|| "Resolved".to_owned(), str::to_owned),
            ))
        }
    }
}

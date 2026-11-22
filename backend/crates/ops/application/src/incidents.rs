// SPDX-License-Identifier: LicenseRef-Proprietary
use console_ops_domain::UtcTimestamp;
use console_ops_domain::changes::CmdHandOff;
use console_ops_domain::incident::{
    IncidentEvent, IncidentRefusal, IncidentState, LegalClock, PublicUpdateDraft,
};
use console_ops_domain::status::StatusIncident;
use serde::Serialize;
use time::OffsetDateTime;

use crate::actions::{ActionStore, CmdHandOffInput};
use crate::obligations::{Context, Error as SpoolError};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct IncidentSummaryView {
    pub id: String,
    pub title: String,
    pub sev: console_ops_domain::ladders::IncidentSeverity,
    pub status: console_ops_domain::ladders::Incident,
    pub lead: Option<String>,
    pub head_seq: u64,
    pub next_public_update_at: Option<UtcTimestamp>,
    pub legal_clocks: Vec<LegalClock>,
}

impl IncidentSummaryView {
    pub fn from_state(state: &IncidentState, now: OffsetDateTime) -> Self {
        Self {
            id: state.id.clone(),
            title: state.title.clone(),
            sev: state.sev,
            status: state.status,
            lead: state.lead.clone(),
            head_seq: state.head_seq,
            next_public_update_at: state.next_public_update_at,
            legal_clocks: state.legal_clocks(now),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct IncidentDetailView {
    #[serde(flatten)]
    pub state: IncidentState,
    pub legal_clocks: Vec<LegalClock>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub public_card: Option<StatusIncident>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IncidentError {
    Domain(IncidentRefusal),
    Spool(SpoolError),
}

impl IncidentError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Domain(r) => r.code(),
            Self::Spool(e) => e.code(),
        }
    }
}

impl From<IncidentRefusal> for IncidentError {
    fn from(value: IncidentRefusal) -> Self {
        Self::Domain(value)
    }
}

impl From<SpoolError> for IncidentError {
    fn from(value: SpoolError) -> Self {
        Self::Spool(value)
    }
}

pub trait IncidentStore: Send + Sync {
    fn list(&self) -> Result<Vec<IncidentState>, IncidentError>;
    fn get(&self, id: &str) -> Result<IncidentState, IncidentError>;
    fn declare(
        &self,
        event: IncidentEvent,
        context: &Context,
    ) -> Result<IncidentState, IncidentError>;
    fn mutate(
        &self,
        id: &str,
        expected_seq: u64,
        event: IncidentEvent,
        context: &Context,
    ) -> Result<IncidentState, IncidentError>;
}

pub struct IncidentsService<'a> {
    pub incidents: &'a dyn IncidentStore,
    pub actions: &'a dyn ActionStore,
}

impl<'a> IncidentsService<'a> {
    pub fn list(&self) -> Result<Vec<IncidentState>, IncidentError> {
        self.incidents.list()
    }

    pub fn detail(
        &self,
        id: &str,
        public_incidents: &[StatusIncident],
        now: OffsetDateTime,
    ) -> Result<IncidentDetailView, IncidentError> {
        let state = self.incidents.get(id)?;
        let public_card = state
            .public_incident_id
            .as_deref()
            .and_then(|pid| public_incidents.iter().find(|inc| inc.id == pid).cloned());
        let legal_clocks = state.legal_clocks(now);
        Ok(IncidentDetailView {
            state,
            legal_clocks,
            public_card,
        })
    }

    pub fn declare(
        &self,
        event: IncidentEvent,
        context: &Context,
    ) -> Result<IncidentState, IncidentError> {
        self.incidents.declare(event, context)
    }

    pub fn mutate(
        &self,
        id: &str,
        expected_seq: u64,
        event: IncidentEvent,
        context: &Context,
    ) -> Result<IncidentState, IncidentError> {
        self.incidents.mutate(id, expected_seq, event, context)
    }

    pub fn attach_public(
        &self,
        id: &str,
        expected_seq: u64,
        public_incident_id: String,
        context: &Context,
    ) -> Result<IncidentState, IncidentError> {
        self.incidents.mutate(
            id,
            expected_seq,
            IncidentEvent::PublicAttached { public_incident_id },
            context,
        )
    }

    pub fn draft_public_update(
        &self,
        id: &str,
        expected_seq: u64,
        draft: PublicUpdateDraft,
        context: &Context,
    ) -> Result<(IncidentState, CmdHandOff), IncidentError> {
        let current = self.incidents.get(id)?;
        if current.head_seq != expected_seq {
            return Err(IncidentError::Domain(IncidentRefusal::Conflict));
        }
        if !current.is_open() {
            return Err(IncidentError::Domain(IncidentRefusal::Final));
        }
        let stage_str = match draft.stage {
            console_ops_domain::incident::PublicDraftStage::Status(s) => serde_json::to_value(s)
                .ok()
                .and_then(|v| v.as_str().map(str::to_lowercase))
                .unwrap_or_else(|| "investigating".to_owned()),
            console_ops_domain::incident::PublicDraftStage::Component(c) => serde_json::to_value(c)
                .ok()
                .and_then(|v| v.as_str().map(str::to_owned))
                .unwrap_or_else(|| "Degraded performance".to_owned()),
        };
        let comps = draft.components.join(",");
        let cmd = format!(
            "scripts/tb status publish --incident {id} --stage {stage_str} --components {comps} --rev {}",
            draft.rev
        );
        let action = self.actions.record_handoff(
            &CmdHandOffInput {
                kind: "status-publish",
                command: &cmd,
                target: id,
                consequence: "Publishes bilingual status update to status.cosskorea.com",
                expected_result: "status.json rev increments and public card shows update",
                verify_step: "Verify status.cosskorea.com/status.json rev and stage",
            },
            context,
        )?;
        let updated = self.incidents.mutate(
            id,
            expected_seq,
            IncidentEvent::PublicDrafted {
                draft,
                action_id: action.handoff.action_id.clone(),
            },
            context,
        )?;
        Ok((updated, action.handoff))
    }
}

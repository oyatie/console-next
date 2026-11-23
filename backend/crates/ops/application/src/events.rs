// SPDX-License-Identifier: LicenseRef-Proprietary
use std::collections::VecDeque;

use console_ops_domain::changes::CmdHandOff;
use serde::Serialize;
use time::OffsetDateTime;

use crate::events_diff;
use crate::incidents::IncidentSummaryView;
use crate::obligations::ObligationItemView;
use crate::snapshot::{
    AlertGroupDetailView, ComponentView, EvaluatedSnapshot, HomeSnapshotView, JobView, SourceView,
};

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum OpsEvent {
    #[serde(rename = "home.changed")]
    HomeChanged {
        id: u64,
        #[serde(with = "time::serde::rfc3339")]
        evaluated_at: OffsetDateTime,
        home: HomeSnapshotView,
    },
    #[serde(rename = "alert.group.changed")]
    AlertGroupChanged {
        id: u64,
        #[serde(with = "time::serde::rfc3339")]
        evaluated_at: OffsetDateTime,
        group: AlertGroupDetailView,
    },
    #[serde(rename = "alert.group.resolved")]
    AlertGroupResolved {
        id: u64,
        #[serde(with = "time::serde::rfc3339")]
        evaluated_at: OffsetDateTime,
        group: AlertGroupDetailView,
    },
    #[serde(rename = "component.changed")]
    ComponentChanged {
        id: u64,
        #[serde(with = "time::serde::rfc3339")]
        evaluated_at: OffsetDateTime,
        component: ComponentView,
    },
    #[serde(rename = "job.changed")]
    JobChanged {
        id: u64,
        #[serde(with = "time::serde::rfc3339")]
        evaluated_at: OffsetDateTime,
        job: JobView,
    },
    #[serde(rename = "source.changed")]
    SourceChanged {
        id: u64,
        #[serde(with = "time::serde::rfc3339")]
        evaluated_at: OffsetDateTime,
        source: SourceView,
    },
    #[serde(rename = "obligation.changed")]
    ObligationChanged {
        id: u64,
        #[serde(with = "time::serde::rfc3339")]
        evaluated_at: OffsetDateTime,
        item: ObligationItemView,
    },
    #[serde(rename = "incident.changed")]
    IncidentChanged {
        id: u64,
        #[serde(with = "time::serde::rfc3339")]
        evaluated_at: OffsetDateTime,
        incident: IncidentSummaryView,
    },
    #[serde(rename = "action.changed")]
    ActionChanged {
        id: u64,
        #[serde(with = "time::serde::rfc3339")]
        evaluated_at: OffsetDateTime,
        action: CmdHandOff,
    },
    #[serde(rename = "silence.changed")]
    SilenceChanged {
        id: u64,
        #[serde(with = "time::serde::rfc3339")]
        evaluated_at: OffsetDateTime,
        silence_id: String,
        active: bool,
    },
    #[serde(rename = "promotion.changed")]
    PromotionChanged {
        id: u64,
        #[serde(with = "time::serde::rfc3339")]
        evaluated_at: OffsetDateTime,
        digest: String,
    },
    #[serde(rename = "heartbeat")]
    Heartbeat {
        id: u64,
        #[serde(with = "time::serde::rfc3339")]
        evaluated_at: OffsetDateTime,
    },
    #[serde(rename = "resync")]
    Resync {
        id: u64,
        #[serde(with = "time::serde::rfc3339")]
        evaluated_at: OffsetDateTime,
    },
}

impl OpsEvent {
    pub fn id(&self) -> u64 {
        match self {
            Self::HomeChanged { id, .. }
            | Self::AlertGroupChanged { id, .. }
            | Self::AlertGroupResolved { id, .. }
            | Self::ComponentChanged { id, .. }
            | Self::JobChanged { id, .. }
            | Self::SourceChanged { id, .. }
            | Self::ObligationChanged { id, .. }
            | Self::IncidentChanged { id, .. }
            | Self::ActionChanged { id, .. }
            | Self::SilenceChanged { id, .. }
            | Self::PromotionChanged { id, .. }
            | Self::Heartbeat { id, .. }
            | Self::Resync { id, .. } => *id,
        }
    }

    pub fn event_type(&self) -> &'static str {
        match self {
            Self::HomeChanged { .. } => "home.changed",
            Self::AlertGroupChanged { .. } => "alert.group.changed",
            Self::AlertGroupResolved { .. } => "alert.group.resolved",
            Self::ComponentChanged { .. } => "component.changed",
            Self::JobChanged { .. } => "job.changed",
            Self::SourceChanged { .. } => "source.changed",
            Self::ObligationChanged { .. } => "obligation.changed",
            Self::IncidentChanged { .. } => "incident.changed",
            Self::ActionChanged { .. } => "action.changed",
            Self::SilenceChanged { .. } => "silence.changed",
            Self::PromotionChanged { .. } => "promotion.changed",
            Self::Heartbeat { .. } => "heartbeat",
            Self::Resync { .. } => "resync",
        }
    }

    pub fn required_action(&self) -> &'static str {
        match self {
            Self::HomeChanged { .. }
            | Self::IncidentChanged { .. }
            | Self::Heartbeat { .. }
            | Self::Resync { .. } => "read.home",
            Self::AlertGroupChanged { .. }
            | Self::AlertGroupResolved { .. }
            | Self::SilenceChanged { .. } => "read.alerts",
            Self::ComponentChanged { .. }
            | Self::JobChanged { .. }
            | Self::ActionChanged { .. }
            | Self::PromotionChanged { .. } => "read.running",
            Self::SourceChanged { .. } => "read.sources",
            Self::ObligationChanged { .. } => "obligation.read",
        }
    }

    fn set_id(&mut self, new_id: u64) {
        match self {
            Self::HomeChanged { id, .. }
            | Self::AlertGroupChanged { id, .. }
            | Self::AlertGroupResolved { id, .. }
            | Self::ComponentChanged { id, .. }
            | Self::JobChanged { id, .. }
            | Self::SourceChanged { id, .. }
            | Self::ObligationChanged { id, .. }
            | Self::IncidentChanged { id, .. }
            | Self::ActionChanged { id, .. }
            | Self::SilenceChanged { id, .. }
            | Self::PromotionChanged { id, .. }
            | Self::Heartbeat { id, .. }
            | Self::Resync { id, .. } => *id = new_id,
        }
    }
}

#[derive(Debug, Clone)]
pub enum ReplayOutcome {
    Current,
    Events(Vec<OpsEvent>),
    Resync,
}

#[derive(Debug)]
pub struct DeltaRingBuffer {
    capacity: usize,
    next_id: u64,
    evicted_through: u64,
    buffer: VecDeque<OpsEvent>,
}

impl DeltaRingBuffer {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            next_id: 1,
            evicted_through: 0,
            buffer: VecDeque::new(),
        }
    }

    pub fn next_id(&self) -> u64 {
        self.next_id
    }

    pub fn alloc_ephemeral_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    pub fn push(&mut self, mut event: OpsEvent) -> OpsEvent {
        let id = self.next_id;
        self.next_id += 1;
        event.set_id(id);
        if self.buffer.len() == self.capacity
            && let Some(old) = self.buffer.pop_front()
        {
            self.evicted_through = old.id();
        }
        self.buffer.push_back(event.clone());
        event
    }

    pub fn replay_since(&self, last_event_id: Option<u64>) -> ReplayOutcome {
        let Some(last_id) = last_event_id else {
            return ReplayOutcome::Current;
        };
        if last_id < self.evicted_through || last_id >= self.next_id {
            return ReplayOutcome::Resync;
        }
        let events: Vec<OpsEvent> = self
            .buffer
            .iter()
            .filter(|ev| ev.id() > last_id)
            .cloned()
            .collect();
        ReplayOutcome::Events(events)
    }

    pub fn diff_and_push(
        &mut self,
        prev: &EvaluatedSnapshot,
        next: &EvaluatedSnapshot,
    ) -> Vec<OpsEvent> {
        events_diff::diff_and_push(self, prev, next)
    }
}

// SPDX-License-Identifier: LicenseRef-Proprietary
use std::num::NonZeroU64;
use std::sync::Arc;

use axum::http::HeaderMap;
use console_ops_application::VictoriaMetrics;
use console_ops_application::actions::ActionStore;
use console_ops_application::alert_actions::{
    AlertAckStore, AlertmanagerWriter, SilenceAuditStore,
};
use console_ops_application::changes::{HostStateStore, ReleasesStore};
use console_ops_application::events::{DeltaRingBuffer, OpsEvent};
use console_ops_application::health::StatusFeed;
use console_ops_application::home::CockpitEvaluator;
use console_ops_application::incidents::IncidentStore;
use console_ops_application::obligations::ObligationStore;
use console_ops_application::promote::{FeedbackStore, PromotionStore};
use console_ops_application::runbooks::RunbookStore;
use console_ops_application::snapshot::{EvaluatedSnapshot, SourceKind};
use console_ops_application::sources_status::SourceSlot;
use console_ops_application::victoriametrics::VictoriaMetricsSnapshot;
use console_ops_domain::bundle::{OncallConfig, OpsSettings};
use time::OffsetDateTime;
use tokio::sync::{Mutex, RwLock, broadcast, watch};
use uuid::Uuid;

use crate::access_jwt::AccessJwtVerifier;
use crate::error::OpsApiError;
use crate::operators::{Grant, OperatorRegistry, Refusal};

pub type SupportRefFn = Arc<dyn Fn() -> String + Send + Sync>;
pub type ClockFn = Arc<dyn Fn() -> OffsetDateTime + Send + Sync>;

pub struct AuthorizedOperator {
    pub person: Uuid,
    pub display_email: String,
    pub grants: Vec<Grant>,
}

impl std::fmt::Debug for AuthorizedOperator {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuthorizedOperator")
            .field("person", &self.person)
            .field("grants", &self.grants.len())
            .finish()
    }
}

pub struct SnapshotStore {
    pub snapshot: EvaluatedSnapshot,
    pub ring: DeltaRingBuffer,
}

#[derive(Clone)]
pub struct OpsRestState {
    pub registry: Arc<OperatorRegistry>,
    pub jwt: Arc<AccessJwtVerifier>,
    pub snapshots: Arc<RwLock<SnapshotStore>>,
    pub tx: broadcast::Sender<OpsEvent>,
    pub origin: Arc<str>,
    pub support_ref: SupportRefFn,
    pub clock: ClockFn,
    pub shutdown: watch::Receiver<bool>,
    pub settings: Option<OpsSettings>,
    pub due_soon_days: u32,
    pub obligations: Option<Arc<dyn ObligationStore>>,
    pub ack_store: Option<Arc<dyn AlertAckStore>>,
    pub silence_store: Option<Arc<dyn SilenceAuditStore>>,
    pub am_writer: Option<Arc<dyn AlertmanagerWriter>>,
    pub incidents: Option<Arc<dyn IncidentStore>>,
    pub actions: Option<Arc<dyn ActionStore>>,
    pub promotions: Option<Arc<dyn PromotionStore>>,
    pub feedback: Option<Arc<dyn FeedbackStore>>,
    pub releases: Option<Arc<dyn ReleasesStore>>,
    pub runbooks: Option<Arc<dyn RunbookStore>>,
    pub host_state: Option<Arc<dyn HostStateStore>>,
    pub status_feed: Option<Arc<dyn StatusFeed>>,
    pub oncall: Option<OncallConfig>,
    pub bundle_sha: Option<String>,
    pub vm_source: Option<Arc<dyn VictoriaMetrics>>,
    pub vm_slot: Arc<RwLock<SourceSlot<VictoriaMetricsSnapshot>>>,
}

impl OpsRestState {
    pub fn new(
        registry: Arc<OperatorRegistry>,
        jwt: Arc<AccessJwtVerifier>,
        initial_snapshot: EvaluatedSnapshot,
        origin: impl Into<Arc<str>>,
        shutdown: watch::Receiver<bool>,
    ) -> Self {
        let (tx, _) = broadcast::channel(512);
        let default_interval = NonZeroU64::new(15).unwrap_or(NonZeroU64::MIN);
        Self {
            registry,
            jwt,
            snapshots: Arc::new(RwLock::new(SnapshotStore {
                snapshot: initial_snapshot,
                ring: DeltaRingBuffer::new(512),
            })),
            tx,
            origin: origin.into(),
            support_ref: Arc::new(|| Uuid::new_v4().simple().to_string()),
            clock: Arc::new(OffsetDateTime::now_utc),
            shutdown,
            settings: None,
            due_soon_days: 7,
            obligations: None,
            ack_store: None,
            silence_store: None,
            am_writer: None,
            incidents: None,
            actions: None,
            promotions: None,
            feedback: None,
            releases: None,
            runbooks: None,
            host_state: None,
            status_feed: None,
            oncall: None,
            bundle_sha: None,
            vm_source: None,
            vm_slot: Arc::new(RwLock::new(SourceSlot::new(
                "victoriametrics",
                SourceKind::VictoriaMetrics,
                "victoriametrics".to_owned(),
                default_interval,
            ))),
        }
    }

    pub fn with_support_ref(mut self, support_ref: SupportRefFn) -> Self {
        self.support_ref = support_ref;
        self
    }

    pub fn with_clock(mut self, clock: ClockFn) -> Self {
        self.clock = clock;
        self
    }

    pub fn authorize(
        &self,
        headers: &HeaderMap,
        action: &'static str,
        route: &'static str,
    ) -> Result<AuthorizedOperator, OpsApiError> {
        let support_ref = (self.support_ref)();
        let identity = self.jwt.verify_headers(headers).map_err(|err| {
            record_authz(action, "deny");
            OpsApiError::from_jwt(err, support_ref.clone(), route)
        })?;
        let now = (self.clock)();
        match self.registry.authorize(&identity.email, action, now) {
            Ok(op) => {
                record_authz(action, "allow");
                Ok(AuthorizedOperator {
                    person: op.person,
                    display_email: identity.email,
                    grants: op.grants.clone(),
                })
            }
            Err(refusal) => {
                record_authz(action, "deny");
                Err(OpsApiError::from_refusal(refusal, support_ref, route, None))
            }
        }
    }

    pub fn authenticate_operator(
        &self,
        headers: &HeaderMap,
        route: &'static str,
    ) -> Result<AuthorizedOperator, OpsApiError> {
        let support_ref = (self.support_ref)();
        let identity = self
            .jwt
            .verify_headers(headers)
            .map_err(|err| OpsApiError::from_jwt(err, support_ref.clone(), route))?;
        let now = (self.clock)();
        match self.registry.authorize(&identity.email, "read.me", now) {
            Ok(op) => Ok(AuthorizedOperator {
                person: op.person,
                display_email: identity.email,
                grants: op.grants.clone(),
            }),
            Err(Refusal::ActionDenied) => {
                let op = self
                    .registry
                    .authorize(&identity.email, "read.home", now)
                    .ok();
                if let Some(op) = op {
                    return Ok(AuthorizedOperator {
                        person: op.person,
                        display_email: identity.email,
                        grants: op.grants.clone(),
                    });
                }
                // Operator has at least one live grant (otherwise GrantNotLive).
                Ok(AuthorizedOperator {
                    person: Uuid::nil(),
                    display_email: identity.email,
                    grants: Vec::new(),
                })
            }
            Err(refusal) => Err(OpsApiError::from_refusal(refusal, support_ref, route, None)),
        }
    }

    pub fn authorize_operator(
        &self,
        op: &AuthorizedOperator,
        action: &'static str,
        route: &'static str,
    ) -> Result<AuthorizedOperator, OpsApiError> {
        let support_ref = (self.support_ref)();
        let now = (self.clock)();
        match self.registry.authorize(&op.display_email, action, now) {
            Ok(matched) => {
                record_authz(action, "allow");
                Ok(AuthorizedOperator {
                    person: matched.person,
                    display_email: op.display_email.clone(),
                    grants: matched.grants.clone(),
                })
            }
            Err(refusal) => {
                record_authz(action, "deny");
                Err(OpsApiError::from_refusal(refusal, support_ref, route, None))
            }
        }
    }

    pub fn is_action_allowed(&self, email: &str, action: &str, now: OffsetDateTime) -> bool {
        self.registry.authorize(email, action, now).is_ok()
    }

    pub async fn apply_evaluation(&self, evaluator: &Arc<Mutex<CockpitEvaluator>>) {
        let now = (self.clock)();
        let next = {
            let mut guard = evaluator.lock().await;
            let (obs_at, err) = self.jwt.status();
            guard.set_access_jwks_status(obs_at, err);
            let reports = guard.tick(now).await;
            for r in reports {
                let outcome = if r.ok { "success" } else { "error" };
                metrics::counter!(
                    "ops_cockpit_source_reads_total",
                    "source" => r.source,
                    "outcome" => outcome
                )
                .increment(1);
            }
            guard.evaluate(now)
        };
        self.refresh_vm_slot(now).await;
        let jwks_age = self.jwt.jwks_age_seconds(now);
        metrics::gauge!("ops_cockpit_access_jwks_age_seconds").set(jwks_age as f64);
        for src in &next.sources.sources {
            if matches!(
                src.kind,
                SourceKind::Alertmanager
                    | SourceKind::Vmalert
                    | SourceKind::VictoriaMetrics
                    | SourceKind::AccessJwks
            ) {
                metrics::gauge!("ops_cockpit_source_age_seconds", "source" => src.name.clone())
                    .set(src.age as f64);
            }
        }
        let events = {
            let mut guard = self.snapshots.write().await;
            let store = &mut *guard;
            let emitted = store.ring.diff_and_push(&store.snapshot, &next);
            store.snapshot = next;
            emitted
        };
        for ev in events {
            let _ = self.tx.send(ev);
        }
        metrics::counter!("ops_cockpit_evaluator_runs_total", "outcome" => "success").increment(1);
        metrics::gauge!("ops_cockpit_evaluator_last_success_timestamp_seconds")
            .set(now.unix_timestamp() as f64);
    }
}

fn record_authz(action: &'static str, decision: &'static str) {
    metrics::counter!(
        "ops_cockpit_authz_decisions_total",
        "action" => action,
        "decision" => decision
    )
    .increment(1);
}

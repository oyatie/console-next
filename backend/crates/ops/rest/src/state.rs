// SPDX-License-Identifier: LicenseRef-Proprietary
use std::sync::Arc;

use axum::http::HeaderMap;
use console_ops_application::events::DeltaRingBuffer;
use console_ops_application::events::OpsEvent;
use console_ops_application::home::CockpitEvaluator;
use console_ops_application::snapshot::EvaluatedSnapshot;
use time::OffsetDateTime;
use tokio::sync::{Mutex, RwLock, broadcast, watch};
use uuid::Uuid;

use crate::access_jwt::AccessJwtVerifier;
use crate::error::OpsApiError;
use crate::operators::{Grant, OperatorRegistry};

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
            metrics::counter!(
                "ops_cockpit_authz_decisions_total",
                "action" => action,
                "decision" => "deny"
            )
            .increment(1);
            OpsApiError::from_jwt(err, support_ref.clone(), route)
        })?;

        let now = (self.clock)();
        match self.registry.authorize(&identity.email, action, now) {
            Ok(op) => {
                metrics::counter!(
                    "ops_cockpit_authz_decisions_total",
                    "action" => action,
                    "decision" => "allow"
                )
                .increment(1);
                Ok(AuthorizedOperator {
                    person: op.person,
                    display_email: identity.email,
                    grants: op.grants.clone(),
                })
            }
            Err(refusal) => {
                metrics::counter!(
                    "ops_cockpit_authz_decisions_total",
                    "action" => action,
                    "decision" => "deny"
                )
                .increment(1);
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
        let jwks_age = self.jwt.jwks_age_seconds(now);
        metrics::gauge!("ops_cockpit_access_jwks_age_seconds").set(jwks_age as f64);
        for src in &next.sources.sources {
            if matches!(
                src.kind,
                console_ops_application::snapshot::SourceKind::Alertmanager
                    | console_ops_application::snapshot::SourceKind::Vmalert
                    | console_ops_application::snapshot::SourceKind::VictoriaMetrics
                    | console_ops_application::snapshot::SourceKind::AccessJwks
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

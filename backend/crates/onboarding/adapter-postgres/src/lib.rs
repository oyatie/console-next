//! Postgres adapter for the tenant setup phase (entity-depth design §5).
//!
//! 운영 시작 runs in one audited transaction: lock the phase row `FOR UPDATE`
//! (setup writes hold it `FOR SHARE`, so none interleaves), compute the facts,
//! rebuild the preview and compare its digest, then require BOTH the Rust
//! backstop and the Cedar `tenant_go_live` bundle to allow. On success the
//! phase flips (the tenant_phase trigger makes it one-way), identities lock, a phase
//! event and an audit event are written and every SUPER_ADMIN / EXECUTIVE is
//! notified — all or nothing.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

mod access_facts;
mod choices;
mod facts;
mod go_live;
mod people_facts;
mod refusal_audit;
mod tenant_facts;
mod terms;
pub use terms::TermsDocument;
mod viewer;

use console_kernel_core::{
    AuditAction, AuditClassification, AuditEvent, ErrorKind, KernelError, OrgId, TenantPhase,
    TraceContext, UserId,
};
use console_onboarding_domain::{Checklist, Preview, backstop, checklist, preview};
use console_platform_authz::cedar_pbac::actions::tenant_go_live;
use console_platform_db::{DbError, with_audits, with_org_conn, with_phase_audits};
use serde::Serialize;
use serde_json::json;
use sqlx::{PgPool, Postgres, Transaction};

#[derive(Debug, thiserror::Error)]
pub enum PgOnboardingError {
    /// A refusal: stable code, the failing facts, and the fix to offer.
    #[error("refused: {code}")]
    Refused {
        kind: ErrorKind,
        code: &'static str,
        fields: Vec<&'static str>,
        remedy: Option<&'static str>,
        details: Option<Box<serde_json::Value>>,
    },
    #[error(transparent)]
    Db(#[from] DbError),
}

impl From<sqlx::Error> for PgOnboardingError {
    fn from(value: sqlx::Error) -> Self {
        Self::Db(DbError::from(value))
    }
}

impl From<KernelError> for PgOnboardingError {
    fn from(value: KernelError) -> Self {
        Self::Refused {
            kind: value.kind,
            code: value.code.unwrap_or("invalid"),
            fields: Vec::new(),
            remedy: None,
            details: None,
        }
    }
}

/// The go-live notice: 결재 only when the tenant routes org changes (decisions #26).
const fn go_live_notice(org_change_routed: bool) -> &'static str {
    if org_change_routed {
        "운영이 시작되었습니다. 이제 조직 변경은 결재를 거쳐 시행됩니다."
    } else {
        "운영이 시작되었습니다. 이제 조직 변경은 시행일과 사유를 남기고 반영됩니다."
    }
}

fn refused(kind: ErrorKind, code: &'static str, remedy: Option<&'static str>) -> PgOnboardingError {
    PgOnboardingError::Refused {
        kind,
        code,
        fields: Vec::new(),
        remedy,
        details: None,
    }
}

/// Who is acting (from the verified token) and with which roles.
#[derive(Debug, Clone)]
pub struct OnboardingActor {
    pub org: OrgId,
    pub user: UserId,
    pub roles: Vec<String>,
    pub trace: TraceContext,
}

#[derive(Debug, Clone, Serialize)]
pub struct GoLiveDone {
    pub phase: &'static str,
    #[serde(with = "time::serde::rfc3339")]
    pub go_live_at: time::OffsetDateTime,
    pub notified: i64,
}

#[derive(Clone)]
pub struct PgOnboardingStore {
    pool: PgPool,
}

impl std::fmt::Debug for PgOnboardingStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PgOnboardingStore")
    }
}

async fn phase(tx: &mut Transaction<'_, Postgres>, lock: bool) -> Result<TenantPhase, sqlx::Error> {
    let sql: &'static str = if lock {
        "SELECT phase FROM tenant_phase WHERE org_id = NULLIF(current_setting('app.current_org', true), '')::uuid FOR UPDATE"
    } else {
        "SELECT phase FROM tenant_phase WHERE org_id = NULLIF(current_setting('app.current_org', true), '')::uuid"
    };
    let raw: Option<String> = sqlx::query_scalar(sql).fetch_optional(tx.as_mut()).await?;
    Ok(TenantPhase::from_db(raw.as_deref()))
}

fn event(
    actor: &OnboardingActor,
    action: &str,
    after: serde_json::Value,
    setup: bool,
) -> Result<AuditEvent, PgOnboardingError> {
    Ok(AuditEvent::new(
        Some(actor.user),
        AuditAction::new(action)?,
        "tenant",
        actor.org.as_uuid().to_string(),
        actor.trace.clone(),
        time::OffsetDateTime::now_utc(),
    )
    .with_org(actor.org)
    .with_snapshots(None, Some(after))
    .with_classification(AuditClassification {
        badges: setup.then(|| vec!["setup".to_owned()]),
        anomaly: None,
        reason: None,
    }))
}

impl PgOnboardingStore {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    #[must_use]
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    /// The setup rail.
    ///
    /// # Errors
    /// Database faults.
    pub async fn checklist(&self, actor: &OnboardingActor) -> Result<Checklist, PgOnboardingError> {
        let refusal_actor = actor.clone();
        let actor = actor.clone();
        let (user, org) = (*actor.user.as_uuid(), actor.org);
        let result = with_org_conn(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                let p = phase(tx, false).await?;
                let (f, _, _) =
                    facts::setup_facts(tx, (org, user), p == TenantPhase::Setup).await?;
                let mut c = checklist(&f);
                viewer::checklist_permissions(tx, &actor, &mut c).await?;
                let at: Option<time::OffsetDateTime> =
                    sqlx::query_scalar("SELECT go_live_at FROM tenant_phase WHERE org_id = $1")
                        .bind(org.as_uuid())
                        .fetch_optional(tx.as_mut())
                        .await?
                        .flatten();
                c.go_live_at = at
                    .map(|at| at.format(&time::format_description::well_known::Rfc3339))
                    .transpose()
                    .map_err(|_| refused(ErrorKind::Internal, "internal", None))?;
                Ok(c)
            })
        })
        .await;
        self.audit_refusal(&refusal_actor, result).await
    }

    /// The 운영 시작 preview (blockers, warnings, becomes-governed, digest).
    ///
    /// # Errors
    /// Database faults.
    pub async fn preview(&self, actor: &OnboardingActor) -> Result<Preview, PgOnboardingError> {
        let refusal_actor = actor.clone();
        let actor = actor.clone();
        let (user, org) = (*actor.user.as_uuid(), actor.org);
        let result = with_org_conn(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                viewer::require_ops(tx, &actor).await?;
                let p = phase(tx, false).await?;
                let (f, records, details) =
                    facts::setup_facts(tx, (org, user), p == TenantPhase::Setup).await?;
                let preview = preview(&f, &records).with_details(details);
                tracing::info!(
                    event = "tenant_go_live_previewed",
                    blocker_codes = ?preview.blockers.iter().map(|item| item.code).collect::<Vec<_>>(),
                    "tenant go-live previewed"
                );
                Ok(preview)
            })
        })
        .await;
        self.audit_refusal(&refusal_actor, result).await
    }
}

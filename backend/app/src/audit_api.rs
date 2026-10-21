//! App-level audit log and audit-chain attestation endpoints.

mod context;

use crate::error::AppError;
use crate::http::error::ApiError;
use crate::state::AppState;
use crate::state::DatabaseDependency;
use crate::telemetry::current_trace_context;
use axum::Json;
use axum::extract::{Extension, Query, State};
use console_kernel_core::{AuditAction, AuditEvent, BranchId, BranchScope};
use console_platform_audit_chain::{ChainReport, SealConfig, verify_org_chain};
use console_platform_authz::{
    Action, Feature, Principal, authorize_capability, authorize_org_wide,
};
use console_platform_db::with_audit;
use serde::{Deserialize, Serialize};
use sqlx::{Postgres, QueryBuilder};
use tracing::Instrument;

const DEFAULT_AUDIT_LIMIT: i64 = 50;
const MAX_AUDIT_LIMIT: i64 = 200;

pub const AUDIT_ROUTE_PATH: &str = "/api/audit";
pub const AUDIT_ATTESTATION_ROUTE_PATH: &str = "/api/v1/audit/attestation";
pub const AUDIT_ROUTE_PATHS: &[&str] = &[AUDIT_ROUTE_PATH, AUDIT_ATTESTATION_ROUTE_PATH];

#[derive(Debug, Deserialize, Clone)]
pub(crate) struct AuditQuery {
    limit: Option<i64>,
    offset: Option<i64>,
    target_type: Option<String>,
    target_id: Option<String>,
    actor: Option<uuid::Uuid>,
    trace_id: Option<String>,
}

#[derive(Debug, Clone)]
struct NormalizedAuditQuery {
    limit: i64,
    offset: i64,
    target_type: Option<String>,
    target_id: Option<String>,
    actor: Option<uuid::Uuid>,
    trace_id: Option<String>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
struct AuditRecord {
    id: uuid::Uuid,
    actor: Option<uuid::Uuid>,
    action: String,
    target_type: String,
    target_id: String,
    branch_id: Option<uuid::Uuid>,
    before_snap: Option<serde_json::Value>,
    after_snap: Option<serde_json::Value>,
    #[serde(flatten)]
    #[sqlx(flatten)]
    context: context::AuditRecordContext,
    occurred_at: time::OffsetDateTime,
}

#[derive(Debug, Serialize)]
pub(crate) struct AuditPage {
    items: Vec<AuditRecord>,
    limit: i64,
    offset: i64,
}

pub(crate) async fn audit_log(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<AuditQuery>,
) -> Result<Json<AuditPage>, ApiError> {
    let pool = match &state.database {
        DatabaseDependency::Postgres(pool) => pool,
        DatabaseDependency::NotConfigured => {
            return Err(ApiError::service_unavailable(
                "database is not configured for audit access",
            ));
        }
    };
    authorize_audit_read(&principal)?;
    let query = normalize_audit_query(query)?;
    let audit_event = audit_read_event(&principal)?;
    let branch_scope = principal.branch_scope.clone();
    let limit = query.limit;
    let offset = query.offset;

    let items = with_audit::<_, Vec<AuditRecord>, AppError>(pool, audit_event, |tx| {
        Box::pin(async move {
            fetch_audit_records(tx.as_mut(), branch_scope, query)
                .await
                .map_err(AppError::Database)
        })
    })
    .await
    .map_err(ApiError::from_app)?;

    Ok(Json(AuditPage {
        items,
        limit,
        offset,
    }))
}

/// L20 audit-chain PR-2: read-only attestation for the caller's tenant.
/// Recomputes and compares the org's sealed hash chain (`verify_org_chain`,
/// charter §5.3) and returns the verdict — never mutates. Unlike `/api/audit`,
/// which can safely branch-filter rows for a branch-scoped ADMIN, this endpoint
/// verifies the whole tenant chain. Require org-wide `AuditLogRead` so the
/// attestation surface cannot widen branch-scoped audit visibility. For
/// `AuditLogRead` today, built-in org-wide authority is SUPER_ADMIN; a
/// branch-scoped or branch-omitted ADMIN token must not pass this gate.
///
/// Cost note: `verify_org_chain` re-derives every seal's batch from its full
/// `audit_events` range — a FULL-CHAIN re-verify, not an incremental one, so
/// wall time scales with the org's total sealed audit history. Bounded today
/// by (a) org-wide built-in callers (SUPER_ADMIN for `AuditLogRead`), so
/// callers are trusted and infrequent, (b) the app-wide request timeout, and
/// (c) console_rt's 30s `statement_timeout` (migration 0112) capping any single DB
/// pass. A head-N-seals or cached-verdict endpoint variant for orgs with a long
/// history is a PR-3 item (charter F1 anchor), not built here.
pub(crate) async fn audit_attestation(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> Result<Json<ChainReport>, ApiError> {
    let pool = match &state.database {
        DatabaseDependency::Postgres(pool) => pool,
        DatabaseDependency::NotConfigured => {
            return Err(ApiError::service_unavailable(
                "database is not configured for audit access",
            ));
        }
    };
    authorize_audit_attestation(&principal)?;

    // Shared throwaway signer is correct here: `verify` reconstructs the
    // public key from each seal's OWN stored `key_ref`; this object is not the
    // trust root, just the implementation that performs verification. The
    // context-selected external signer/key-custody adapter will verify the same
    // way (key material keyed off the stored `key_ref`).
    let signer = state.audit_attestation_signer.clone();

    let report = verify_org_chain(
        pool,
        principal.org_id,
        &signer,
        time::OffsetDateTime::now_utc(),
        &SealConfig::default(),
    )
    .await
    .map_err(|err| {
        tracing::error!(error = %err, "audit-chain attestation verify failed");
        ApiError::internal("attestation verification failed")
    })?;

    Ok(Json(report))
}

/// `GET /api/audit` is a QUERY over the caller's whole branch scope, not a read of
/// one branch's row — `fetch_audit_records` is already handed `branch_scope` and
/// confines the rows. There is no single resource branch to authorize against, so
/// this is a capability check. (Its sibling `authorize_audit_attestation` is
/// deliberately org-wide; see its doc comment.)
fn authorize_audit_read(principal: &Principal) -> Result<(), ApiError> {
    authorize_capability(principal, Action::new(Feature::AuditLogRead))
        .map_err(ApiError::from_kernel)
}

fn authorize_audit_attestation(principal: &Principal) -> Result<(), ApiError> {
    // Whole-tenant attestation is intentionally stricter than branch-filtered
    // `/api/audit`: built-in ADMIN is operational/branch authority, not an
    // org-wide evidentiary attestation authority. `authorize_org_wide` first
    // requires all-branch scope, then applies the feature matrix; for
    // `AuditLogRead` that means built-in SUPER_ADMIN today, while still
    // preserving the custom-grant path for future policy-managed org-wide
    // AuditLogRead.
    authorize_org_wide(principal, Action::new(Feature::AuditLogRead)).map_err(ApiError::from_kernel)
}

fn normalize_audit_query(query: AuditQuery) -> Result<NormalizedAuditQuery, ApiError> {
    let limit = query.limit.unwrap_or(DEFAULT_AUDIT_LIMIT);
    if !(1..=MAX_AUDIT_LIMIT).contains(&limit) {
        return Err(ApiError::validation(format!(
            "limit must be between 1 and {MAX_AUDIT_LIMIT}"
        )));
    }
    let offset = query.offset.unwrap_or(0);
    if offset < 0 {
        return Err(ApiError::validation("offset must be non-negative"));
    }
    let target_type = query
        .target_type
        .map(|target_type| target_type.trim().to_owned())
        .filter(|target_type| !target_type.is_empty());
    let target_id = query
        .target_id
        .map(|target_id| target_id.trim().to_owned())
        .filter(|target_id| !target_id.is_empty());
    let trace_id = query
        .trace_id
        .map(|trace_id| trace_id.trim().to_owned())
        .filter(|trace_id| !trace_id.is_empty());

    Ok(NormalizedAuditQuery {
        limit,
        offset,
        target_type,
        target_id,
        actor: query.actor,
        trace_id,
    })
}

fn audit_read_event(principal: &Principal) -> Result<AuditEvent, ApiError> {
    let event = AuditEvent::new(
        Some(principal.user_id),
        AuditAction::new("audit.read").map_err(ApiError::from_kernel)?,
        "audit_log",
        "query",
        current_trace_context(),
        time::OffsetDateTime::now_utc(),
    )
    // Arm `app.current_org` for the FORCE-RLS read: `with_audit` binds the GUC
    // from `event.org_id`, so without this the `audit_events` SELECT runs with
    // an unset GUC and RLS fails closed (zero rows) as the `console_rt` role. Also
    // stamps the `audit.read` row with the caller's org instead of NULL.
    .with_org(principal.org_id);
    Ok(match audit_event_branch(&principal.branch_scope) {
        Some(branch_id) => event.with_branch(branch_id),
        None => event,
    })
}

fn audit_event_branch(scope: &BranchScope) -> Option<BranchId> {
    match scope {
        BranchScope::All => None,
        // fabricated-branch: ok stamps the ACTOR's branch on an audit row; never reaches authorize
        BranchScope::Branches(branches) => branches.iter().next().copied(),
    }
}

async fn fetch_audit_records(
    conn: &mut sqlx::PgConnection,
    branch_scope: BranchScope,
    query: NormalizedAuditQuery,
) -> Result<Vec<AuditRecord>, sqlx::Error> {
    let mut builder = QueryBuilder::<Postgres>::new(
        r#"
        SELECT
            id, actor, action, target_type, target_id, branch_id,
            before_snap, after_snap,
            ip, user_agent, auth_method, device,
            classification_badges, anomaly, reason,
            source, change_mode, reason_code, decision_snapshot, command_id,
            scope_ids, actor_kind, principal_type, session_id,
            outcome, actor_display, actor_employer, row_hash_version,
            trace_id::text AS trace_id,
            span_id::text AS span_id, occurred_at
        FROM audit_events
        WHERE
        "#,
    );

    match branch_scope {
        BranchScope::All => {
            builder.push("TRUE");
        }
        BranchScope::Branches(branches) if branches.is_empty() => {
            builder.push("FALSE");
        }
        BranchScope::Branches(branches) => {
            let branch_ids: Vec<uuid::Uuid> = branches
                .into_iter()
                .map(|branch_id| *branch_id.as_uuid())
                .collect();
            builder
                .push("branch_id = ANY(")
                .push_bind(branch_ids)
                .push(")");
        }
    }

    if let Some(target_type) = query.target_type {
        builder.push(" AND target_type = ").push_bind(target_type);
    }
    if let Some(target_id) = query.target_id {
        builder.push(" AND target_id = ").push_bind(target_id);
    }
    if let Some(actor) = query.actor {
        builder.push(" AND actor = ").push_bind(actor);
    }
    // `trace_id` is CHAR(32); cast to text so the bound String compares as
    // text=text (matching the SELECT projection) rather than bpchar padding.
    if let Some(trace_id) = query.trace_id {
        builder.push(" AND trace_id::text = ").push_bind(trace_id);
    }
    builder
        .push(" ORDER BY occurred_at DESC, id DESC LIMIT ")
        .push_bind(query.limit)
        .push(" OFFSET ")
        .push_bind(query.offset);

    builder
        .build_query_as::<AuditRecord>()
        .fetch_all(conn)
        .instrument(tracing::info_span!(
            "db.query",
            db_system = "postgresql",
            db_operation = "SELECT",
            db_statement = "SELECT audit_events",
        ))
        .await
}

#[cfg(test)]
#[cfg(not(feature = "test-postgres"))]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod audit_attestation_auth_tests {
    use std::collections::BTreeSet;

    use console_kernel_core::{BranchId, BranchScope, OrgId, UserId};
    use console_platform_authz::{Principal, Role};

    use super::authorize_audit_attestation;

    fn principal(role: Role, branch_scope: BranchScope) -> Principal {
        Principal::new(
            UserId::new(),
            OrgId::one(),
            BTreeSet::from([role]),
            branch_scope,
        )
    }

    #[test]
    fn audit_attestation_builtin_gate_allows_only_super_admin_for_audit_read() {
        assert!(
            authorize_audit_attestation(&principal(Role::Admin, BranchScope::All)).is_err(),
            "built-in ADMIN is not org-wide attestation authority even with all-branch scope"
        );
        assert!(
            authorize_audit_attestation(&principal(
                Role::Admin,
                BranchScope::single(BranchId::new())
            ))
            .is_err(),
            "branch-scoped ADMIN must not access a whole-tenant attestation"
        );
        assert!(
            authorize_audit_attestation(&principal(Role::SuperAdmin, BranchScope::All)).is_ok()
        );
        assert!(
            authorize_audit_attestation(&principal(Role::Executive, BranchScope::All)).is_err(),
            "EXECUTIVE has org-wide scope semantics, but not AuditLogRead matrix permission"
        );
    }
}

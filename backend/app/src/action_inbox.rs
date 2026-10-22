//! Unified my-action-inbox read model (`GET /api/v1/me/action-inbox`).
//!
//! Source adapters own visibility; `console-action-inbox-application` owns merge and pagination.

use axum::extract::{Query, State};
use axum::routing::get;
use axum::{Extension, Json, Router};
use console_action_inbox_application::{
    ActionInboxSource, ActionInboxSourceFuture, ActionInboxSourcePage, ActionInboxSourcePort,
    ActionInboxSourceQuery, InboxFilter, ListActionInboxQuery,
    list_filtered_action_inbox as run_action_inbox,
};
use console_kernel_core::KernelError;
use console_platform_auth::JwtVerifier;
use console_platform_authz::Principal;
use serde::Deserialize;
use sqlx::PgPool;
use time::OffsetDateTime;

mod error;
use error::InboxError;

#[cfg(any(
    feature = "workspace",
    feature = "dispatch",
    feature = "support",
    feature = "workorder",
    feature = "payroll",
    feature = "governance"
))]
mod legacy;
mod sources;
#[cfg(feature = "workspace")]
mod workbench;
#[cfg(feature = "workspace")]
mod workflow;
#[cfg(feature = "workspace")]
pub(crate) use workbench::read_workbench_action_inbox;

pub const ME_ACTION_INBOX_PATH: &str = "/api/v1/me/action-inbox";
#[derive(Clone)]
pub struct ActionInboxState {
    pool: PgPool,
    jwt_verifier: Option<JwtVerifier>,
}

impl ActionInboxState {
    #[must_use]
    pub fn new(pool: PgPool, jwt_verifier: Option<JwtVerifier>) -> Self {
        Self { pool, jwt_verifier }
    }
}

pub fn router(state: ActionInboxState) -> Router {
    let verifier = state.jwt_verifier.clone();
    let pool = state.pool.clone();
    let router = Router::new()
        .route(ME_ACTION_INBOX_PATH, get(list_action_inbox))
        .with_state(state);
    console_platform_request_context::with_request_context(router, verifier, pool)
}

#[derive(Debug, Default, Deserialize)]
struct ActionInboxQuery {
    limit: Option<usize>,
    cursor: Option<String>,
    #[serde(default)]
    filter: InboxFilter,
}

async fn list_action_inbox(
    State(state): State<ActionInboxState>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<ActionInboxQuery>,
) -> Result<Json<serde_json::Value>, InboxError> {
    // The snapshot instant comes from the database clock, the same clock that
    // stamps `created_at` on every source row. An app-host clock lagging the DB
    // would hide rows created in the lag window (`created_at <= as_of`).
    let now: OffsetDateTime = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&state.pool)
        .await
        .map_err(|error| source_failure("clock", error))?;
    let org = principal.org_id;
    let created_at = console_platform_db::with_org_conn::<_, _, console_platform_db::DbError>(
        &state.pool,
        org,
        move |tx| {
            Box::pin(async move {
                Ok(sqlx::query_scalar::<_, OffsetDateTime>(
                    "SELECT created_at FROM organizations WHERE id = $1",
                )
                .bind(org.as_uuid())
                .fetch_one(tx.as_mut())
                .await?)
            })
        },
    )
    .await
    .map_err(|e| source_failure("tenant", e))?;
    let sources = PgActionInboxSources {
        pool: state.pool,
        principal,
        setup: tokio::sync::OnceCell::new(),
        setup_created_at: created_at,
    };
    let page = run_action_inbox(
        &sources,
        ListActionInboxQuery {
            limit: query.limit,
            cursor: query.cursor.clone(),
        },
        query.filter,
        now,
    )
    .await?;
    let mut response = serde_json::to_value(page).map_err(|e| source_failure("projection", e))?;
    if matches!(query.filter, InboxFilter::All | InboxFilter::Turn)
        && query.cursor.is_none()
        && let Some(Some(setup)) = sources.setup.get()
    {
        response["setup"] = setup.clone();
    }
    Ok(Json(response))
}

/// Temporary composition-root adapter. This intentionally proves the inward
/// dependency seam only; it does not claim the source adapters have been split
/// into a dedicated infrastructure crate.
struct PgActionInboxSources {
    pool: PgPool,
    principal: Principal,
    setup: tokio::sync::OnceCell<Option<serde_json::Value>>,
    setup_created_at: OffsetDateTime,
}

impl ActionInboxSourcePort for PgActionInboxSources {
    fn list_source_page(
        &self,
        source: ActionInboxSource,
        query: ActionInboxSourceQuery,
    ) -> ActionInboxSourceFuture<'_> {
        Box::pin(async move {
            let page = match source {
                #[cfg(feature = "workspace")]
                ActionInboxSource::Workflow => self.workflow_page(query).await,
                #[cfg(feature = "dispatch")]
                ActionInboxSource::Dispatch => self.dispatch_page(query).await,
                #[cfg(feature = "support")]
                ActionInboxSource::Support => self.support_page(query).await,
                #[cfg(feature = "workorder")]
                ActionInboxSource::WorkOrder => self.work_order_page(query).await,
                #[cfg(feature = "payroll")]
                ActionInboxSource::Payroll => self.payroll_page(query).await,
                #[cfg(feature = "governance")]
                ActionInboxSource::Governance => self.governance_page(query).await,
                ActionInboxSource::HrIdentity
                | ActionInboxSource::HrBranch
                | ActionInboxSource::HrContract => {
                    sources::hr_followups::page(&self.pool, &self.principal, source, query).await
                }
                ActionInboxSource::PeriodUnlock => {
                    crate::lifecycle::inbox::page(&self.pool, &self.principal, query).await
                }
                ActionInboxSource::Setup => {
                    let setup = self
                        .setup
                        .get_or_try_init(|| sources::setup::load(&self.pool, &self.principal))
                        .await?;
                    Ok(sources::setup::page(
                        setup.as_ref(),
                        *self.principal.org_id.as_uuid(),
                        self.setup_created_at,
                        query,
                    ))
                }
                ActionInboxSource::GrantNotice => {
                    sources::grants::page(&self.pool, &self.principal, query).await
                }
                ActionInboxSource::OrgChange => {
                    sources::org_change::page(&self.pool, &self.principal, query).await
                }
                ActionInboxSource::HrExit => {
                    sources::hr_exit::page(&self.pool, &self.principal, query).await
                }
                ActionInboxSource::HrLifecycle => {
                    sources::hr_lifecycle::page(&self.pool, &self.principal, query).await
                }
                ActionInboxSource::HrRegister => {
                    sources::hr_register::page(&self.pool, &self.principal, query).await
                }
                ActionInboxSource::HrRequests => {
                    sources::hr_requests::page(&self.pool, &self.principal, query).await
                }
                ActionInboxSource::HrInsurance => {
                    sources::hr_insurance::page(&self.pool, &self.principal, query).await
                }
                #[allow(unreachable_patterns)]
                _ => Ok(empty_source_page()),
            }?;
            if matches!(
                source,
                ActionInboxSource::HrIdentity
                    | ActionInboxSource::HrBranch
                    | ActionInboxSource::HrContract
                    | ActionInboxSource::HrRegister
                    | ActionInboxSource::HrLifecycle
                    | ActionInboxSource::HrExit
                    | ActionInboxSource::HrRequests
            ) {
                sources::audit_personnel::record(&self.pool, &self.principal, &page).await?;
            }
            Ok(page)
        })
    }
}

pub(crate) fn empty_source_page() -> ActionInboxSourcePage {
    ActionInboxSourcePage {
        items: Vec::new(),
        total: 0,
        total_is_exact: true,
        has_more: false,
    }
}

fn source_failure(source: &'static str, error: impl std::fmt::Display) -> KernelError {
    tracing::error!(source, error = %error, "action-inbox source read failed");
    KernelError::internal("failed to load action inbox")
}

#[cfg(test)]
#[cfg(not(feature = "test-postgres"))]
mod tests {
    use console_action_inbox_application::canonical_action_link_kind;

    #[test]
    fn normalizes_the_legacy_workflow_run_alias() {
        assert_eq!(canonical_action_link_kind("workflow_run"), "approval_run");
        assert_eq!(canonical_action_link_kind("approval_run"), "approval_run");
        assert_eq!(canonical_action_link_kind("work_order"), "work_order");
    }
}

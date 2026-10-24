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
mod response;
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
    pub(crate) read_permits: std::sync::Arc<tokio::sync::Semaphore>,
}

impl ActionInboxState {
    #[must_use]
    pub fn new(pool: PgPool, jwt_verifier: Option<JwtVerifier>, source_concurrency: u32) -> Self {
        // Budget for each active read plus its asynchronously returning SQLx lease.
        let pool_budget = pool.options().get_max_connections().saturating_sub(1) / 2;
        let capacity = source_concurrency.min(pool_budget).max(1);
        Self {
            pool,
            jwt_verifier,
            read_permits: std::sync::Arc::new(tokio::sync::Semaphore::new(capacity as usize)),
        }
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
        read_permits: state.read_permits,
        support_reference: crate::telemetry::current_trace_context()
            .trace_id()
            .to_owned(),
        setup: tokio::sync::OnceCell::new(),
        support_can_approve: tokio::sync::OnceCell::new(),
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
    response::project(&sources, page, query.filter, query.cursor.is_none(), now)
}

/// Temporary composition-root adapter. This intentionally proves the inward
/// dependency seam only; it does not claim the source adapters have been split
/// into a dedicated infrastructure crate.
struct PgActionInboxSources {
    pool: PgPool,
    principal: Principal,
    setup: tokio::sync::OnceCell<Option<serde_json::Value>>,
    support_can_approve: tokio::sync::OnceCell<bool>,
    setup_created_at: OffsetDateTime,
    read_permits: std::sync::Arc<tokio::sync::Semaphore>,
    support_reference: String,
}

impl ActionInboxSourcePort for PgActionInboxSources {
    fn list_source_page(
        &self,
        source: ActionInboxSource,
        query: ActionInboxSourceQuery,
    ) -> ActionInboxSourceFuture<'_> {
        Box::pin(async move {
            let _permit = self
                .read_permits
                .acquire()
                .await
                .map_err(|_| KernelError::internal("inbox reader closed"))?;
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
                        .await;
                    setup.map(|setup| sources::setup::page(
                        setup.as_ref(),
                        *self.principal.org_id.as_uuid(),
                        self.setup_created_at,
                        query,
                    ))
                }
                ActionInboxSource::GrantNotice => {
                    sources::grants::page(&self.pool, &self.principal, query).await
                }
                ActionInboxSource::SupportAccess => {
                    sources::support_access::page(&self.pool, &self.principal, query, &self.support_can_approve).await
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
            }.map_err(|error| {
                tracing::error!(source = ?source, support_reference = %self.support_reference, error = %error, "inbox source unavailable");
                error
            })?;
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
                sources::audit_personnel::record(&self.pool, &self.principal, &page).await.map_err(|error| {
                    tracing::error!(source = ?source, support_reference = %self.support_reference, error = %error, "inbox source audit unavailable"); error
                })?;
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

    #[tokio::test]
    async fn source_read_budget_reserves_returning_leases() {
        for (connections, configured, expected) in [(8, 4, 3), (64, 4, 4), (8, 1, 1), (1, 4, 1)] {
            let pool = sqlx::postgres::PgPoolOptions::new()
                .max_connections(connections)
                .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
                .unwrap();
            let state = super::ActionInboxState::new(pool, None, configured);
            assert_eq!(state.read_permits.available_permits(), expected);
        }
    }

    #[test]
    fn normalizes_the_legacy_workflow_run_alias() {
        assert_eq!(canonical_action_link_kind("workflow_run"), "approval_run");
        assert_eq!(canonical_action_link_kind("approval_run"), "approval_run");
        assert_eq!(canonical_action_link_kind("work_order"), "work_order");
    }
}

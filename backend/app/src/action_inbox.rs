//! Unified my-action-inbox read model (`GET /api/v1/me/action-inbox`).
//!
//! Source adapters own visibility; `console-action-inbox-application` owns merge and pagination.

use axum::extract::{Query, State};
use axum::routing::get;
use axum::{Extension, Json, Router};
use console_action_inbox_application::{
    ActionInboxSource, ActionInboxSourceFuture, ActionInboxSourcePage, ActionInboxSourcePort,
    ActionInboxSourceQuery, Attention, InboxFilter, ListActionInboxQuery, SnoozeMode, SnoozedPort,
    Snoozes, list_filtered_action_inbox as run_action_inbox,
};
use console_kernel_core::KernelError;
use console_platform_auth::JwtVerifier;
use console_platform_authz::Principal;
use serde::Deserialize;
use sqlx::PgPool;
use time::OffsetDateTime;
use tracing::Instrument;

mod activity;
use console_platform_request_context::Authorization;
#[cfg(all(test, feature = "test-postgres"))]
#[path = "../tests/action_inbox/authorization.rs"]
mod authorization_tests;
mod decisions;
mod done;
pub(crate) mod error;
mod policy;
mod raw;
mod reference;
mod request_register;
mod response;
mod snooze;
pub(crate) mod tabs;
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
    let router = tabs::routes(Router::new().route(ME_ACTION_INBOX_PATH, get(list_action_inbox)))
        .with_state(state);
    console_platform_request_context::with_request_context(router, verifier, pool)
}

#[derive(Debug, Default, Deserialize)]
struct ActionInboxQuery {
    limit: Option<usize>,
    cursor: Option<String>,
    #[serde(default)]
    filter: InboxFilter,
    attention: Option<Attention>,
    snoozed: Option<Snoozed>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Snoozed {
    Only,
}

async fn list_action_inbox(
    State(state): State<ActionInboxState>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<ActionInboxQuery>,
) -> Result<Json<serde_json::Value>, InboxError> {
    let mode = match query.snoozed {
        None => SnoozeMode::Exclude,
        Some(Snoozed::Only) if query.attention.is_none() && query.filter == InboxFilter::All => {
            SnoozeMode::Only
        }
        Some(Snoozed::Only) => {
            return Err(KernelError::validation("the snoozed view takes no other filter").into());
        }
    };
    read(state, principal, query, mode).await
}

/// The list read. Only this module chooses the mode: no query string reaches `Include`.
async fn read(
    state: ActionInboxState,
    principal: Principal,
    query: ActionInboxQuery,
    mode: SnoozeMode,
) -> Result<Json<serde_json::Value>, InboxError> {
    if query.attention.is_some() && !matches!(query.filter, InboxFilter::All | InboxFilter::Turn) {
        return Err(
            KernelError::validation("attention cannot be combined with a saved filter").into(),
        );
    }
    let filter = match query.attention {
        Some(Attention::All) | None => query.filter,
        Some(attention) => attention.filter(),
    };
    // The snapshot instant comes from the database clock, the same clock that
    // stamps `created_at` on every source row. An app-host clock lagging the DB
    // would hide rows created in the lag window (`created_at <= as_of`).
    let now: OffsetDateTime = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&state.pool)
        .await
        .map_err(|error| source_failure("clock", error))?;
    let (org, account) = (principal.org_id, principal.user_id);
    let (created_at, deadline_due_soon_days, policies, snooze_days, snoozed) =
        console_platform_db::with_org_conn::<
            _,
            _,
            console_settings_adapter_postgres::PgSettingsError,
        >(&state.pool, org, move |tx| {
            Box::pin(async move {
                let (window, policies, snooze_days) = policy::load(tx.as_mut(), org, now).await?;
                // The account's snoozes are read once here, before any source runs.
                let snoozed = snooze::load(tx.as_mut(), org, account)
                    .await
                    .map_err(console_platform_db::DbError::from)?;
                let created = sqlx::query_scalar::<_, OffsetDateTime>(
                    "SELECT created_at FROM organizations WHERE id = $1",
                )
                .bind(org.as_uuid())
                .fetch_one(tx.as_mut())
                .await
                .map_err(console_platform_db::DbError::from)?;
                Ok((created, window, policies, snooze_days, snoozed))
            })
        })
        .await
        .map_err(|e| source_failure("tenant", format!("{e:?}")))?;
    let sources = PgActionInboxSources {
        authorization: Authorization::default(),
        pool: state.pool,
        principal,
        read_permits: state.read_permits,
        support_reference: crate::telemetry::current_trace_context()
            .trace_id()
            .to_owned(),
        setup: tokio::sync::OnceCell::new(),
        support_can_approve: tokio::sync::OnceCell::new(),
        privacy_can_handle: tokio::sync::OnceCell::new(),
        statutory_register: request_register::Register::default(),
        setup_created_at: created_at,
        deadline_due_soon_days,
        policies,
        snoozes: Snoozes::new(snoozed, mode, now),
    };
    let mut page = run_action_inbox(
        &sources,
        ListActionInboxQuery {
            limit: query.limit,
            cursor: query.cursor.clone(),
        },
        filter,
        now,
    )
    .await?;
    if query.filter == InboxFilter::Turn
        && let Some(turn) = page.counts.get("turn")
        && let Some(all) = page
            .attention_filters
            .iter_mut()
            .find(|count| count.key == Attention::All)
    {
        all.total = turn.total;
        all.total_is_exact = turn.total_is_exact;
    }
    sources.snoozes.annotate(&mut page);
    response::project(
        &sources,
        page,
        filter,
        query.cursor.is_none(),
        now,
        snooze_days,
    )
    .await
}

/// Temporary composition-root adapter. This intentionally proves the inward
/// dependency seam only; it does not claim the source adapters have been split
/// into a dedicated infrastructure crate.
struct PgActionInboxSources {
    authorization: Authorization,
    pool: PgPool,
    principal: Principal,
    setup: tokio::sync::OnceCell<Option<serde_json::Value>>,
    support_can_approve: tokio::sync::OnceCell<bool>,
    privacy_can_handle: tokio::sync::OnceCell<bool>,
    statutory_register: request_register::Register,
    setup_created_at: OffsetDateTime,
    deadline_due_soon_days: i64,
    policies: policy::Policies,
    read_permits: std::sync::Arc<tokio::sync::Semaphore>,
    support_reference: String,
    snoozes: Snoozes,
}

impl ActionInboxSourcePort for PgActionInboxSources {
    fn deadline_due_soon_days(&self) -> Result<i64, KernelError> {
        Ok(self.deadline_due_soon_days)
    }

    fn list_source_page(
        &self,
        source: ActionInboxSource,
        query: ActionInboxSourceQuery,
    ) -> ActionInboxSourceFuture<'_> {
        Box::pin(async move {
            let span = tracing::debug_span!("action_inbox.source", source = ?source,
                permit_wait_seconds = tracing::field::Empty, work_seconds = tracing::field::Empty);
            let waiting = std::time::Instant::now();
            let permit = self.read_permits.acquire().await;
            let permit_wait_seconds = waiting.elapsed().as_secs_f64();
            let label = format!("{source:?}");
            metrics::histogram!("action_inbox_source_seconds", "source" => label.clone(), "phase" => "permit_wait")
                .record(permit_wait_seconds);
            span.record("permit_wait_seconds", permit_wait_seconds);
            let _permit = permit.map_err(|_| KernelError::internal("inbox reader closed"))?;
            let started = std::time::Instant::now();
            let result = async {
            // Snoozed rows leave the page before the access log is written, so only revealed rows are logged.
            let mut page = SnoozedPort { port: &raw::Raw(self), snoozes: &self.snoozes }
                .list_source_page(source, query).await.map_err(|error| {
                tracing::error!(source = ?source, support_reference = %self.support_reference, error = %error, "inbox source unavailable");
                error
            })?;
            if matches!(
                source,
                ActionInboxSource::HrIdentity
                    | ActionInboxSource::HrUnplaced
                    | ActionInboxSource::HrContract
                    | ActionInboxSource::HrRegister
                    | ActionInboxSource::HrLifecycle
                    | ActionInboxSource::HrExit
                    | ActionInboxSource::HrRequests
            ) {
                sources::audit_personnel::record(&self.pool, &self.principal, &mut page).await.map_err(|error| {
                    tracing::error!(source = ?source, support_reference = %self.support_reference, error = %error, "inbox source audit unavailable"); error
                })?;
            }
            Ok(page)
            }.instrument(span.clone()).await;
            let work_seconds = started.elapsed().as_secs_f64();
            metrics::histogram!("action_inbox_source_seconds", "source" => label, "phase" => "work")
                .record(work_seconds);
            span.record("work_seconds", work_seconds);
            tracing::debug!(parent: &span, permit_wait_seconds, work_seconds, "inbox source measured");
            result
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

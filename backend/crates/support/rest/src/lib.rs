//! Support-ticket REST API.
//!
//! Two channels:
//!   * Authenticated, authz-gated, branch-scoped staff endpoints under
//!     `/api/v1/support/tickets`.
//!   * One unauthenticated customer intake endpoint `/api/v1/support/intake`,
//!     rate-limited with the same DB-backed fixed-window scheme the auth
//!     endpoints use (the shared `auth_rate_limit` table, a new endpoint key).
//!
//! Notifications reuse `platform/push`: on assign / status change / non-internal
//! comment we resolve staff push tokens and fan out FCM messages behind the
//! `PushNotifier` port, degrading gracefully (no-op) when FCM is unconfigured.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

mod openapi;
pub use openapi::OPENAPI_FRAGMENT;

use std::collections::BTreeMap;
use std::sync::Arc;

use axum::extract::{Extension, Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use console_kernel_core::{
    BranchId, BranchScope, CustomerId, ErrorKind, KernelError, OrgId, SiteId, SupportTicketId,
    TraceContext, UserId, WorkOrderId,
};
use console_platform_auth::JwtVerifier;
use console_platform_authz::{Action, Feature, Principal, authorize, authorize_capability};
use console_platform_push::{FcmPushMessage, PushNotifier};
use console_platform_request_context::{TrustedClientIp, rate_limit};
use console_support_adapter_postgres::{
    MAX_BODY_CHARS, MAX_REQUESTER_CONTACT_CHARS, MAX_REQUESTER_NAME_CHARS, MAX_TITLE_CHARS,
    PgSupportError, PgSupportStore,
};
use console_support_application::{
    AddCommentCommand, AssignTicketCommand, CommentAudience, CreateCustomerIntakeCommand,
    CreateInternalTicketCommand, LinkTicketCommand, ListFieldSitesQuery, ListTicketsQuery,
    RecordAcceptanceCommand, TicketNotification, TransitionTicketCommand,
};
use console_support_domain::{
    AcceptanceChannel, AcceptanceKind, FieldSlaState, TicketCategory, TicketOrigin, TicketPriority,
    TicketStatus,
};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use time::OffsetDateTime;

// ---------------------------------------------------------------------------
// Route paths (exported for the openapi_drift test)
// ---------------------------------------------------------------------------

pub const SUPPORT_TICKETS_PATH: &str = "/api/v1/support/tickets";
pub const SUPPORT_TICKET_PATH_TEMPLATE: &str = "/api/v1/support/tickets/{id}";
pub const SUPPORT_TICKET_ASSIGN_PATH_TEMPLATE: &str = "/api/v1/support/tickets/{id}/assign";
pub const SUPPORT_TICKET_TRANSITION_PATH_TEMPLATE: &str = "/api/v1/support/tickets/{id}/transition";
pub const SUPPORT_TICKET_COMMENTS_PATH_TEMPLATE: &str = "/api/v1/support/tickets/{id}/comments";
pub const SUPPORT_INTAKE_PATH: &str = "/api/v1/support/intake";
pub const SUPPORT_TICKET_LINK_PATH_TEMPLATE: &str = "/api/v1/support/tickets/{id}/link";
pub const SUPPORT_TICKET_ACCEPTANCE_PATH_TEMPLATE: &str = "/api/v1/support/tickets/{id}/acceptance";
pub const FIELD_SITES_PATH: &str = "/api/v1/field/sites";
pub const FIELD_SITE_PATH_TEMPLATE: &str = "/api/v1/field/sites/{id}";
pub const SUPPORT_ROUTE_PATHS: &[&str] = &[
    SUPPORT_TICKETS_PATH,
    SUPPORT_TICKET_PATH_TEMPLATE,
    SUPPORT_TICKET_ASSIGN_PATH_TEMPLATE,
    SUPPORT_TICKET_TRANSITION_PATH_TEMPLATE,
    SUPPORT_TICKET_COMMENTS_PATH_TEMPLATE,
    SUPPORT_INTAKE_PATH,
    SUPPORT_TICKET_LINK_PATH_TEMPLATE,
    SUPPORT_TICKET_ACCEPTANCE_PATH_TEMPLATE,
    FIELD_SITES_PATH,
    FIELD_SITE_PATH_TEMPLATE,
];

// ---------------------------------------------------------------------------
// Rate-limit constants for the unauthenticated intake endpoint.
//
// Same DB-backed fixed-window scheme as the auth endpoints (`auth_rate_limit`
// table), with an intake-specific endpoint key so the buckets are isolated.
// ---------------------------------------------------------------------------
const RATE_LIMIT_PER_IP: i64 = 5;
const RATE_LIMIT_PER_DEVICE: i64 = 5;
const RATE_LIMIT_GLOBAL: i64 = 60;
const RATE_LIMIT_ENDPOINT: &str = "support_intake";

#[derive(Clone)]
pub struct SupportRestState {
    store: PgSupportStore,
    jwt_verifier: Option<JwtVerifier>,
    push_notifier: Option<Arc<dyn PushNotifier>>,
    /// Tenant that owns unauthenticated public support intake. It defaults to
    /// tenant #1 for legacy/local deployments, but the app composition root overrides
    /// it from the public storefront config (`STOREFRONT_ORG_ID`) when set. The
    /// router captures this configured value instead of hardcoding tenant #1, because
    /// reminted storefront/support tenants would be hidden from same-org staff by
    /// RLS.
    public_intake_org: OrgId,
}

impl SupportRestState {
    /// Construct with a legacy tenant #1 public-intake org. Prefer
    /// [`SupportRestState::with_storefront_org`] from the app composition root
    /// so configured public storefront/support tenants are used.
    #[must_use]
    pub fn new(
        store: PgSupportStore,
        jwt_verifier: Option<JwtVerifier>,
        push_notifier: Option<Arc<dyn PushNotifier>>,
    ) -> Self {
        Self {
            store,
            jwt_verifier,
            push_notifier,
            public_intake_org: OrgId::one(),
        }
    }

    /// Set the public storefront/CX tenant used by unauthenticated support
    /// intake (`STOREFRONT_ORG_ID`), mirroring sales REST storefront scoping.
    #[must_use]
    pub fn with_storefront_org(mut self, org: OrgId) -> Self {
        self.public_intake_org = org;
        self
    }

    fn pool(&self) -> &PgPool {
        self.store.pool()
    }
}

pub fn router(state: SupportRestState) -> Router {
    let verifier = state.jwt_verifier.clone();
    let pool = state.pool().clone();
    // Authenticated routes — every handler here requires a resolved Principal.
    let authed = Router::new()
        .route(
            SUPPORT_TICKETS_PATH,
            get(list_tickets).post(create_internal_ticket),
        )
        .route(SUPPORT_TICKET_PATH_TEMPLATE, get(get_ticket))
        .route(SUPPORT_TICKET_ASSIGN_PATH_TEMPLATE, post(assign_ticket))
        .route(
            SUPPORT_TICKET_TRANSITION_PATH_TEMPLATE,
            post(transition_ticket),
        )
        .route(SUPPORT_TICKET_COMMENTS_PATH_TEMPLATE, post(add_comment))
        .route(SUPPORT_TICKET_LINK_PATH_TEMPLATE, post(link_ticket))
        .route(
            SUPPORT_TICKET_ACCEPTANCE_PATH_TEMPLATE,
            post(record_acceptance),
        )
        .route(FIELD_SITES_PATH, get(list_field_sites))
        .route(FIELD_SITE_PATH_TEMPLATE, get(get_field_site))
        .with_state(state.clone());
    let authed = console_platform_request_context::with_request_context(authed, verifier, pool);
    // Unauthenticated intake route — no JWT required, but still needs a tenant
    // context for the store. The public intake org is configured by app boot
    // from `STOREFRONT_ORG_ID`, matching the public storefront tenant instead
    // of hardcoding tenant #1 in this router.
    let public_intake_org = state.public_intake_org;
    let intake = Router::new()
        .route(SUPPORT_INTAKE_PATH, post(customer_intake))
        .with_state(state)
        .layer(axum::middleware::from_fn(
            move |req: axum::extract::Request, next: axum::middleware::Next| async move {
                console_platform_request_context::scope_org(public_intake_org, next.run(req)).await
            },
        ));
    authed.merge(intake)
}

// ---------------------------------------------------------------------------
// Request / response DTOs
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct CreateInternalTicketRequest {
    branch_id: BranchId,
    category: TicketCategory,
    priority: TicketPriority,
    title: String,
    body: String,
}

#[derive(Debug, Deserialize)]
struct CustomerIntakeRequest {
    category: TicketCategory,
    priority: TicketPriority,
    title: String,
    body: String,
    requester_name: String,
    requester_contact: String,
}

#[derive(Debug, Deserialize)]
struct AssignTicketRequest {
    assignee_user_id: UserId,
    branch_id: Option<BranchId>,
}

#[derive(Debug, Deserialize)]
struct TransitionTicketRequest {
    to_status: TicketStatus,
}

#[derive(Debug, Deserialize)]
struct AddCommentRequest {
    body: String,
    #[serde(default)]
    is_internal_note: bool,
}

#[derive(Debug, Deserialize)]
struct ListTicketsRequest {
    status: Option<TicketStatus>,
    priority: Option<TicketPriority>,
    category: Option<TicketCategory>,
    origin: Option<TicketOrigin>,
    assignee_user_id: Option<UserId>,
    /// Restrict to tickets linked to one customer site (field-console queue).
    site_id: Option<SiteId>,
    #[serde(default)]
    include_untriaged: bool,
    /// Page size; the adapter always clamps to `1..=100` and defaults a missing
    /// value, so existing clients that omit it still get a bounded page.
    limit: Option<i64>,
    /// Keyset cursor: the id of the last ticket from the previous page.
    cursor: Option<SupportTicketId>,
}

#[derive(Debug, Deserialize)]
struct ListFieldSitesRequest {
    /// Substring match on site name or customer name.
    q: Option<String>,
    customer_id: Option<CustomerId>,
    /// Filter on the derived per-site SLA state.
    sla: Option<FieldSlaState>,
    /// Page size; the adapter clamps to `1..=100`.
    limit: Option<i64>,
    /// Keyset cursor: the id of the last site from the previous page.
    cursor: Option<SiteId>,
}

/// Bind a ticket to the field object chain. Each field distinguishes absent
/// (leave untouched) from explicit JSON `null` (clear the link); at least one
/// must be present (422, enforced by the store).
#[derive(Debug, Deserialize)]
struct LinkTicketRequest {
    #[serde(default, deserialize_with = "double_option")]
    site_id: Option<Option<SiteId>>,
    #[serde(default, deserialize_with = "double_option")]
    work_order_id: Option<Option<WorkOrderId>>,
}

/// Distinguish an absent JSON field (`None`) from an explicit `null`
/// (`Some(None)`), so PATCH-style link clearing is expressible.
fn double_option<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    Deserialize::deserialize(deserializer).map(Some)
}

#[derive(Debug, Deserialize)]
struct RecordAcceptanceRequest {
    kind: AcceptanceKind,
    channel: AcceptanceChannel,
    /// Customer-side acknowledger name (1..=200 chars, store-enforced).
    accepted_by: String,
    /// Optional note (<=2000 chars); required by the store on a decline.
    note: Option<String>,
}

/// Intake acknowledgement. Deliberately minimal — no internal identifiers, no
/// echo of the PII contact.
#[derive(Debug, Serialize)]
struct IntakeAck {
    status: &'static str,
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    error: ErrorPayload,
}

#[derive(Debug, Serialize)]
struct ErrorPayload {
    code: &'static str,
    message: String,
}

// ---------------------------------------------------------------------------
// Authenticated handlers
// ---------------------------------------------------------------------------

async fn create_internal_ticket(
    State(state): State<SupportRestState>,
    headers: HeaderMap,
    Json(body): Json<CreateInternalTicketRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    authorize(&principal, Action::new(Feature::Login), body.branch_id)
        .map_err(RestError::from_kernel)?;
    let summary = state
        .store
        .create_internal_ticket(CreateInternalTicketCommand {
            actor: principal.user_id,
            branch_id: body.branch_id,
            category: body.category,
            priority: body.priority,
            title: body.title,
            body: body.body,
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok((StatusCode::CREATED, Json(summary)))
}

async fn list_tickets(
    State(state): State<SupportRestState>,
    headers: HeaderMap,
    Query(query): Query<ListTicketsRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    // LIST gate: `list_tickets` returns rows across the caller's whole
    // `branch_scope` (the store filters on it below), so there is no single
    // resource branch. NOT `authorize_org_wide` — `Feature::Login` is
    // `[A,A,A,A,A,A]` and org-wide routing would deny every branch-scoped user,
    // i.e. the entire staff surface. The per-row gate `authorize_on_ticket`
    // loads the ticket's real branch and is unchanged.
    authorize_capability(&principal, Action::new(Feature::Login))
        .map_err(RestError::from_kernel)?;
    // Only cross-branch principals (SUPER_ADMIN/EXECUTIVE) may pull the
    // untriaged customer-intake queue; branch-scoped staff cannot.
    let cross_branch = matches!(principal.branch_scope, BranchScope::All);
    let tickets = state
        .store
        .list_tickets(ListTicketsQuery {
            branch_scope: principal.branch_scope,
            status: query.status,
            priority: query.priority,
            category: query.category,
            origin: query.origin,
            assignee_user_id: query.assignee_user_id,
            site_id: query.site_id,
            include_untriaged: query.include_untriaged && cross_branch,
            limit: query.limit,
            cursor: query.cursor,
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(tickets))
}

async fn get_ticket(
    State(state): State<SupportRestState>,
    headers: HeaderMap,
    Path(id): Path<uuid::Uuid>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    let ticket_id = SupportTicketId::from_uuid(id);
    // Staff path: internal notes are visible.
    let detail = state
        .store
        .get_ticket(
            ticket_id,
            &principal.branch_scope,
            CommentAudience::Internal,
        )
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(detail))
}

async fn assign_ticket(
    State(state): State<SupportRestState>,
    headers: HeaderMap,
    Path(id): Path<uuid::Uuid>,
    Json(body): Json<AssignTicketRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    let ticket_id = SupportTicketId::from_uuid(id);
    authorize_on_ticket(&state, &principal, ticket_id, Feature::AssigneeManage).await?;
    let (summary, notifications) = state
        .store
        .assign_ticket(AssignTicketCommand {
            actor: principal.user_id,
            ticket_id,
            assignee_user_id: body.assignee_user_id,
            branch_id: body.branch_id,
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    deliver_notifications(&state, &notifications).await;
    Ok(Json(summary))
}

async fn transition_ticket(
    State(state): State<SupportRestState>,
    headers: HeaderMap,
    Path(id): Path<uuid::Uuid>,
    Json(body): Json<TransitionTicketRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    let ticket_id = SupportTicketId::from_uuid(id);
    authorize_on_ticket(&state, &principal, ticket_id, Feature::AssigneeManage).await?;
    let (summary, notifications) = state
        .store
        .transition_status(TransitionTicketCommand {
            actor: principal.user_id,
            ticket_id,
            to_status: body.to_status,
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    deliver_notifications(&state, &notifications).await;
    Ok(Json(summary))
}

async fn add_comment(
    State(state): State<SupportRestState>,
    headers: HeaderMap,
    Path(id): Path<uuid::Uuid>,
    Json(body): Json<AddCommentRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    let ticket_id = SupportTicketId::from_uuid(id);
    authorize_on_ticket(&state, &principal, ticket_id, Feature::WorkOrderStart).await?;
    let (view, notifications) = state
        .store
        .add_comment(AddCommentCommand {
            actor: principal.user_id,
            ticket_id,
            body: body.body,
            is_internal_note: body.is_internal_note,
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    deliver_notifications(&state, &notifications).await;
    Ok((StatusCode::CREATED, Json(view)))
}

// ---------------------------------------------------------------------------
// Field console (customer-site overview / detail / link / acceptance)
// ---------------------------------------------------------------------------

async fn list_field_sites(
    State(state): State<SupportRestState>,
    headers: HeaderMap,
    Query(query): Query<ListFieldSitesRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    // Field read gate mirrors the shell nav gate (work_order_read_all): the
    // overview carries customer PII (contact, geo), so the open-signup MEMBER
    // tier is denied server-side, not just nav-hidden.
    authorize_capability(&principal, Action::new(Feature::WorkOrderReadAll))
        .map_err(RestError::from_kernel)?;
    let page = state
        .store
        .list_field_sites(ListFieldSitesQuery {
            branch_scope: principal.branch_scope,
            q: query.q,
            customer_id: query.customer_id,
            sla: query.sla,
            limit: query.limit,
            cursor: query.cursor,
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(page))
}

async fn get_field_site(
    State(state): State<SupportRestState>,
    headers: HeaderMap,
    Path(id): Path<uuid::Uuid>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    let site_id = SiteId::from_uuid(id);
    // Scope resolution first: an out-of-scope site is a 404 (never 403) so its
    // existence does not leak; then the feature check on the resolved branch.
    let branch = state
        .store
        .site_branch_in_scope(site_id, &principal.branch_scope)
        .await
        .map_err(RestError::from_store)?;
    authorize(&principal, Action::new(Feature::WorkOrderReadAll), branch)
        .map_err(RestError::from_kernel)?;
    let detail = state
        .store
        .field_site_detail(site_id, &principal.branch_scope)
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(detail))
}

async fn link_ticket(
    State(state): State<SupportRestState>,
    headers: HeaderMap,
    Path(id): Path<uuid::Uuid>,
    Json(body): Json<LinkTicketRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    let ticket_id = SupportTicketId::from_uuid(id);
    // Same authority as assign: linking an untriaged customer ticket to a site
    // IS triage, so it carries the same cross-branch rule.
    authorize_on_ticket(&state, &principal, ticket_id, Feature::AssigneeManage).await?;
    let summary = state
        .store
        .link_ticket(LinkTicketCommand {
            actor: principal.user_id,
            ticket_id,
            branch_scope: principal.branch_scope,
            site_id: body.site_id,
            work_order_id: body.work_order_id,
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(summary))
}

async fn record_acceptance(
    State(state): State<SupportRestState>,
    headers: HeaderMap,
    Path(id): Path<uuid::Uuid>,
    Json(body): Json<RecordAcceptanceRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    let ticket_id = SupportTicketId::from_uuid(id);
    authorize_on_ticket(&state, &principal, ticket_id, Feature::AssigneeManage).await?;
    let idempotency_key = idempotency_key_header(&headers)?;
    let (view, notifications, _replayed) = state
        .store
        .record_acceptance(RecordAcceptanceCommand {
            actor: principal.user_id,
            ticket_id,
            kind: body.kind,
            channel: body.channel,
            accepted_by: body.accepted_by,
            note: body.note,
            idempotency_key,
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    // A replay carries no notifications, so the fan-out is naturally once-only.
    deliver_notifications(&state, &notifications).await;
    Ok((StatusCode::CREATED, Json(view)))
}

/// Required `Idempotency-Key` header (sibling-pilot semantics). Presence is
/// checked here; the 16..=200-char bound is enforced by the store.
fn idempotency_key_header(headers: &HeaderMap) -> Result<String, RestError> {
    headers
        .get("Idempotency-Key")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
        .ok_or_else(|| {
            RestError::from_kernel(KernelError::validation(
                "Idempotency-Key header is required",
            ))
        })
}

// ---------------------------------------------------------------------------
// Unauthenticated customer intake (rate-limited)
// ---------------------------------------------------------------------------

async fn customer_intake(
    State(state): State<SupportRestState>,
    headers: HeaderMap,
    trusted_client_ip: Option<Extension<TrustedClientIp>>,
    Json(body): Json<CustomerIntakeRequest>,
) -> Result<impl IntoResponse, RestError> {
    let now = OffsetDateTime::now_utc();
    rate_limit(
        &state.store,
        &headers,
        trusted_client_ip.map(|Extension(ip)| ip),
        now,
    )
    .await?;

    // Generic validation: never echo the PII contact, never leak which field
    // failed beyond a coarse message.
    if body.title.trim().is_empty()
        || body.body.trim().is_empty()
        || body.requester_name.trim().is_empty()
        || body.requester_contact.trim().is_empty()
    {
        return Err(RestError::bad_request("request is missing required fields"));
    }

    // Reject over-length fields at the unauthenticated edge, before any DB or
    // audit work, mirroring the store-side bounds (counts trimmed Unicode
    // scalars, as the store does). The store remains the source of truth; this
    // is defense-in-depth so the public channel fails fast and generically.
    if body.title.trim().chars().count() > MAX_TITLE_CHARS
        || body.body.trim().chars().count() > MAX_BODY_CHARS
        || body.requester_name.trim().chars().count() > MAX_REQUESTER_NAME_CHARS
        || body.requester_contact.trim().chars().count() > MAX_REQUESTER_CONTACT_CHARS
    {
        return Err(RestError::bad_request("request failed validation"));
    }

    state
        .store
        .create_customer_intake(CreateCustomerIntakeCommand {
            category: body.category,
            priority: body.priority,
            title: body.title,
            body: body.body,
            requester_name: body.requester_name,
            requester_contact: body.requester_contact,
            trace: TraceContext::generate(),
            occurred_at: now,
        })
        .await
        .map_err(|err| {
            // Intake must not surface internal details; map everything to a
            // stable generic acknowledgement-failure shape.
            match err.kind() {
                ErrorKind::Validation => RestError::bad_request("request failed validation"),
                _ => {
                    tracing::error!(error = %err, "support intake failed");
                    RestError::internal("internal server error")
                }
            }
        })?;
    Ok((StatusCode::ACCEPTED, Json(IntakeAck { status: "received" })))
}

// ---------------------------------------------------------------------------
// Notification fan-out (reuses platform/push, degrades gracefully)
// ---------------------------------------------------------------------------

async fn deliver_notifications(state: &SupportRestState, notifications: &[TicketNotification]) {
    let Some(notifier) = state.push_notifier.as_ref() else {
        return;
    };
    for notification in notifications {
        if let Err(err) = deliver_one(state, notifier.as_ref(), notification).await {
            // Notification delivery is best-effort; never fail the request on it.
            tracing::warn!(error = %err, "support notification delivery failed");
        }
    }
}

async fn deliver_one(
    state: &SupportRestState,
    notifier: &dyn PushNotifier,
    notification: &TicketNotification,
) -> Result<(), PgSupportError> {
    let tokens = state
        .store
        .active_push_tokens(notification.recipient)
        .await?;
    for token in tokens {
        let data = BTreeMap::from([
            ("type".to_owned(), notification.kind.data_kind().to_owned()),
            ("ticket_id".to_owned(), notification.ticket_id.to_string()),
        ]);
        let message = FcmPushMessage {
            token,
            title: notification.kind.title().to_owned(),
            body: notification.body.clone(),
            data,
            idempotency_key: format!(
                "support:{}:{}:{}",
                notification.ticket_id,
                notification.kind.data_kind(),
                notification.recipient
            ),
        };
        // Best-effort: a single failed send is logged, not propagated.
        if let Err(err) = notifier.send_fcm(message).await {
            tracing::warn!(error = %err, "support FCM push failed");
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Rate limiter (same DB-backed fixed-window scheme as the auth endpoints)
//
// The window/bucket logic lives here; the actual counter UPSERT is delegated to
// the adapter (`PgSupportStore::increment_rate_bucket`) so the rate-limit SQL
// stays out of this REST handler surface — mirroring how the auth crate keeps
// its identical counter off the audit-coverage gate's radar.
// ---------------------------------------------------------------------------

async fn rate_limit(
    store: &PgSupportStore,
    headers: &HeaderMap,
    trusted_client_ip: Option<TrustedClientIp>,
    now: OffsetDateTime,
) -> Result<(), RestError> {
    let caps = rate_limit::Caps {
        per_ip: RATE_LIMIT_PER_IP,
        per_device: RATE_LIMIT_PER_DEVICE,
        global: RATE_LIMIT_GLOBAL,
        // Public, anonymous writes: one /56 per bucket, like sign-up.
        ipv6_prefix: 56,
    };
    let admitted = rate_limit::admit(
        RATE_LIMIT_ENDPOINT,
        caps,
        headers,
        trusted_client_ip,
        now,
        |key, window| async move {
            store
                .increment_rate_bucket(&key, RATE_LIMIT_ENDPOINT, window)
                .await
                .map_err(RestError::from_store)
        },
    )
    .await?;
    if admitted {
        Ok(())
    } else {
        Err(RestError::too_many_requests())
    }
}

// ---------------------------------------------------------------------------
// Authz helpers
// ---------------------------------------------------------------------------

/// Resolve a ticket's branch within the principal's scope, then authorize the
/// feature on that branch. Branch-less (untriaged) tickets require a
/// cross-branch principal.
async fn authorize_on_ticket(
    state: &SupportRestState,
    principal: &Principal,
    ticket_id: SupportTicketId,
    feature: Feature,
) -> Result<(), RestError> {
    let branch = state
        .store
        .ticket_branch_in_scope(ticket_id, &principal.branch_scope)
        .await
        .map_err(RestError::from_store)?;
    match branch {
        Some(branch_id) => {
            authorize(principal, Action::new(feature), branch_id).map_err(RestError::from_kernel)
        }
        None => {
            // Untriaged customer ticket: only cross-branch principals can act.
            if matches!(principal.branch_scope, BranchScope::All) {
                Ok(())
            } else {
                Err(RestError::from_kernel(KernelError::forbidden(
                    "untriaged tickets require cross-branch authority",
                )))
            }
        }
    }
}

async fn principal_from_headers(
    state: &SupportRestState,
    headers: &HeaderMap,
) -> Result<Principal, RestError> {
    let verifier = state.jwt_verifier.as_ref().ok_or_else(|| {
        RestError::unavailable("JWT verification is not configured for support API")
    })?;
    console_platform_request_context::resolve_principal(verifier, state.pool(), headers)
        .await
        .map_err(rest_error_from_request_context)
}

fn rest_error_from_request_context(
    err: console_platform_request_context::RequestContextError,
) -> RestError {
    match err {
        console_platform_request_context::RequestContextError::VerifierUnavailable => {
            RestError::unavailable("JWT verification is not configured for support API")
        }
        console_platform_request_context::RequestContextError::WrongTokenTier => {
            RestError::from_kernel(KernelError::forbidden(
                "token tier is not valid for this route",
            ))
        }
        console_platform_request_context::RequestContextError::AccessScope(error) => {
            RestError::from_kernel(error)
        }
        console_platform_request_context::RequestContextError::BranchScope(message)
        | console_platform_request_context::RequestContextError::EffectivePolicy(message) => {
            RestError::from_kernel(KernelError::internal(message))
        }
        console_platform_request_context::RequestContextError::MissingOrg => {
            RestError::from_kernel(KernelError::internal(
                "no tenant context is bound to the current request",
            ))
        }
        console_platform_request_context::RequestContextError::MissingBearer => {
            RestError::unauthorized("missing or malformed bearer token")
        }
        console_platform_request_context::RequestContextError::InvalidToken => {
            RestError::unauthorized("invalid bearer token")
        }
        console_platform_request_context::RequestContextError::InvalidClaim(message) => {
            RestError::unauthorized(format!("token claim is invalid: {message}"))
        }
    }
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct RestError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl RestError {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }

    fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "bad_request", message)
    }

    fn unauthorized(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "unauthorized", message)
    }

    fn unavailable(message: impl Into<String>) -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, "unavailable", message)
    }

    fn internal(message: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", message)
    }

    fn too_many_requests() -> Self {
        Self::new(
            StatusCode::TOO_MANY_REQUESTS,
            "too_many_requests",
            "rate limit exceeded; retry later",
        )
    }

    fn from_kernel(error: KernelError) -> Self {
        match error.kind {
            ErrorKind::Validation => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "validation",
                error.message,
            ),
            ErrorKind::Forbidden => Self::new(StatusCode::FORBIDDEN, "forbidden", error.message),
            ErrorKind::NotFound => Self::new(StatusCode::NOT_FOUND, "not_found", error.message),
            ErrorKind::Conflict | ErrorKind::InvalidTransition => {
                Self::new(StatusCode::CONFLICT, "conflict", error.message)
            }
            ErrorKind::Unavailable => Self::unavailable(error.message),
            ErrorKind::Internal => Self::internal(error.message),
        }
    }

    fn from_store(error: PgSupportError) -> Self {
        match error {
            // Domain errors carry safe, caller-facing messages.
            PgSupportError::Domain(kernel) => Self::from_kernel(kernel),
            // Db errors must never leak raw sqlx strings / constraint names
            // (schema disclosure, OWASP A05). Log server-side; return generic.
            db_error => {
                let kind = db_error.kind();
                tracing::error!(error = %db_error, "support database error");
                match kind {
                    ErrorKind::NotFound => {
                        Self::new(StatusCode::NOT_FOUND, "not_found", "resource not found")
                    }
                    ErrorKind::Conflict | ErrorKind::InvalidTransition => {
                        Self::new(StatusCode::CONFLICT, "conflict", "resource already exists")
                    }
                    _ => Self::internal("internal server error"),
                }
            }
        }
    }
}

impl IntoResponse for RestError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ErrorBody {
                error: ErrorPayload {
                    code: self.code,
                    message: self.message,
                },
            }),
        )
            .into_response()
    }
}

#[cfg(test)]
mod tests {
    use axum::http::HeaderMap;
    use console_platform_request_context::TrustedClientIp;

    #[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
    async fn rate_limit_trips_at_cap_and_resets_after_window(pool: sqlx::PgPool) {
        use super::{RATE_LIMIT_PER_IP, rate_limit};
        use axum::http::StatusCode;
        use console_platform_request_context::rate_limit::WINDOW as RATE_LIMIT_WINDOW;
        use console_support_adapter_postgres::PgSupportStore;
        use time::OffsetDateTime;

        let store = PgSupportStore::new(pool);
        let headers = HeaderMap::new();
        let window1 = OffsetDateTime::from_unix_timestamp(1_700_000_000).unwrap();

        for attempt in 0..RATE_LIMIT_PER_IP {
            rate_limit(
                &store,
                &headers,
                Some(TrustedClientIp::new("203.0.113.50".parse().unwrap())),
                window1,
            )
            .await
            .unwrap_or_else(|_| panic!("attempt {attempt} within the cap must not trip 429"));
        }

        let tripped = rate_limit(
            &store,
            &headers,
            Some(TrustedClientIp::new("203.0.113.50".parse().unwrap())),
            window1,
        )
        .await
        .expect_err("the request past the cap in the same window must trip 429");
        assert_eq!(tripped.status, StatusCode::TOO_MANY_REQUESTS);

        // Advancing past the fixed window resets the per-IP bucket.
        let window2 = window1 + RATE_LIMIT_WINDOW;
        rate_limit(
            &store,
            &headers,
            Some(TrustedClientIp::new("203.0.113.50".parse().unwrap())),
            window2,
        )
        .await
        .expect("a new window must reset the per-IP bucket");
    }
}

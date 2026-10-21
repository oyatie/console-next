use console_platform_provisioning::{
    GroupAccountOnboarding, GroupAccountSummary, GroupMemberSummary, GroupSummary,
    OrganizationSummary, RouteAdoptionMetric, TenantHealth, TenantOnboarding,
};
use serde::Serialize;
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(Debug, Serialize)]
pub(crate) struct OrgResponse {
    id: Uuid,
    slug: String,
    domain_aliases: Vec<String>,
    pending_domain: Option<String>,
    name: String,
    status: String,
    group_id: Option<Uuid>,
    group_slug: Option<String>,
    group_name: Option<String>,
    // `time::OffsetDateTime` derives a numeric-array Serialize by default; the
    // console reads these as rfc3339 strings (`new Date(created_at)`), so emit
    // rfc3339 like every other tenant DTO (e.g. financial `created_at`).
    #[serde(with = "time::serde::rfc3339")]
    created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    updated_at: OffsetDateTime,
}

impl From<OrganizationSummary> for OrgResponse {
    fn from(o: OrganizationSummary) -> Self {
        Self {
            id: o.id,
            slug: o.slug,
            domain_aliases: o.domain_aliases,
            pending_domain: o.pending_domain,
            name: o.name,
            status: o.status,
            group_id: o.group_id,
            group_slug: o.group_slug,
            group_name: o.group_name,
            created_at: o.created_at,
            updated_at: o.updated_at,
        }
    }
}

#[derive(Debug, Serialize)]
pub(crate) struct GroupMemberResponse {
    id: Uuid,
    slug: String,
    name: String,
    status: String,
}

impl From<GroupMemberSummary> for GroupMemberResponse {
    fn from(member: GroupMemberSummary) -> Self {
        Self {
            id: member.id,
            slug: member.slug,
            name: member.name,
            status: member.status,
        }
    }
}

#[derive(Debug, Serialize)]
pub(crate) struct GroupResponse {
    id: Uuid,
    slug: String,
    name: String,
    status: String,
    member_count: i64,
    members: Vec<GroupMemberResponse>,
    #[serde(with = "time::serde::rfc3339")]
    created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    updated_at: OffsetDateTime,
}

impl From<GroupSummary> for GroupResponse {
    fn from(group: GroupSummary) -> Self {
        Self {
            id: group.id,
            slug: group.slug,
            name: group.name,
            status: group.status,
            member_count: group.member_count,
            members: group
                .members
                .into_iter()
                .map(GroupMemberResponse::from)
                .collect(),
            created_at: group.created_at,
            updated_at: group.updated_at,
        }
    }
}

#[derive(Debug, Serialize)]
pub(crate) struct GroupAccountResponse {
    user_id: Uuid,
    display_name: String,
    phone: Option<String>,
    tenant_roles: Vec<String>,
    is_active: bool,
    has_passkey: bool,
    account_status: String,
    org_id: Uuid,
    org_slug: String,
    org_name: String,
    group_roles: Vec<String>,
    #[serde(with = "time::serde::rfc3339")]
    created_at: OffsetDateTime,
}

impl From<GroupAccountSummary> for GroupAccountResponse {
    fn from(account: GroupAccountSummary) -> Self {
        Self {
            user_id: account.user_id,
            display_name: account.display_name,
            phone: account.phone,
            tenant_roles: account.tenant_roles,
            is_active: account.is_active,
            has_passkey: account.has_passkey,
            account_status: account.account_status,
            org_id: account.org_id,
            org_slug: account.org_slug,
            org_name: account.org_name,
            group_roles: account.group_roles,
            created_at: account.created_at,
        }
    }
}

#[derive(Debug, Serialize)]
pub(crate) struct CreateGroupAccountResponse {
    account: GroupAccountResponse,
    /// One-time setup code for the created tenant account. Returned once only.
    otp: String,
    #[serde(with = "time::serde::rfc3339")]
    otp_expires_at: OffsetDateTime,
}

impl From<GroupAccountOnboarding> for CreateGroupAccountResponse {
    fn from(value: GroupAccountOnboarding) -> Self {
        Self {
            account: GroupAccountResponse::from(value.account),
            otp: value.otp.as_str().to_owned(),
            otp_expires_at: value.otp_expires_at,
        }
    }
}

#[derive(Debug, Serialize)]
pub(crate) struct OnboardingResponse {
    // The console's `OnboardOrgResponse` reads `{ org, otp }`; keep those exact
    // field names so the one-time OTP and the new org actually surface in the UI.
    org: OrgResponse,
    admin_user_id: Uuid,
    /// The ONE-TIME OTP for the new tenant's first SUPER_ADMIN. Returned exactly
    /// once, to be delivered out-of-band; never logged or stored in cleartext.
    otp: String,
    #[serde(with = "time::serde::rfc3339")]
    admin_otp_expires_at: OffsetDateTime,
}

impl From<TenantOnboarding> for OnboardingResponse {
    fn from(o: TenantOnboarding) -> Self {
        Self {
            org: o.organization.into(),
            admin_user_id: o.admin_user_id,
            otp: o.admin_otp.as_str().to_owned(),
            admin_otp_expires_at: o.admin_otp_expires_at,
        }
    }
}

#[derive(Debug, Serialize)]
pub(crate) struct TenantHealthResponse {
    id: Uuid,
    slug: String,
    name: String,
    status: String,
    group_id: Option<Uuid>,
    group_slug: Option<String>,
    group_name: Option<String>,
    user_count: i64,
    active_user_count: i64,
    active_work_orders: i64,
    open_work_orders: i64,
    #[serde(with = "time::serde::rfc3339::option")]
    last_activity_at: Option<OffsetDateTime>,
    route_adoption: Vec<RouteAdoptionMetricResponse>,
    zero_legacy_release_cycles: i64,
}

#[derive(Debug, Serialize)]
pub(crate) struct RouteAdoptionMetricResponse {
    release_cycle: String,
    console_route_events: i64,
    legacy_route_events: i64,
    rum_error_events: i64,
    rum_perf_p95_ms: Option<i64>,
    #[serde(with = "time::serde::rfc3339")]
    last_event_at: OffsetDateTime,
}

impl From<RouteAdoptionMetric> for RouteAdoptionMetricResponse {
    fn from(metric: RouteAdoptionMetric) -> Self {
        Self {
            release_cycle: metric.release_cycle,
            console_route_events: metric.console_route_events,
            legacy_route_events: metric.legacy_route_events,
            rum_error_events: metric.rum_error_events,
            rum_perf_p95_ms: metric.rum_perf_p95_ms,
            last_event_at: metric.last_event_at,
        }
    }
}

impl From<TenantHealth> for TenantHealthResponse {
    fn from(h: TenantHealth) -> Self {
        Self {
            id: h.id,
            slug: h.slug,
            name: h.name,
            status: h.status,
            group_id: h.group_id,
            group_slug: h.group_slug,
            group_name: h.group_name,
            user_count: h.user_count,
            active_user_count: h.active_user_count,
            active_work_orders: h.active_work_orders,
            open_work_orders: h.open_work_orders,
            last_activity_at: h.last_activity_at,
            route_adoption: h
                .route_adoption
                .into_iter()
                .map(RouteAdoptionMetricResponse::from)
                .collect(),
            zero_legacy_release_cycles: h.zero_legacy_release_cycles,
        }
    }
}

#[derive(Debug, Serialize)]
pub(crate) struct PlatformOpsResponse {
    pub(crate) tenants: Vec<TenantHealthResponse>,
    /// Operator notices (e.g. `{env, state, expires_on, days_left}` for a juso
    /// key from D-14); empty when none.
    pub(crate) notices: Vec<serde_json::Value>,
}

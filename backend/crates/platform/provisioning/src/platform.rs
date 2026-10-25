mod tenant_erase;
mod tenant_erase_types;
pub use tenant_erase_types::*;
mod company_domain;
mod ops_recovery;
mod ops_recovery_rules;
mod ops_recovery_store;
pub(crate) use ops_recovery_store::admin_enrolled_tx;
mod ops_recovery_types;
pub use ops_recovery_rules::*;
pub use ops_recovery_types::*;
mod group_accounts;
mod groups;
mod listings;
mod removal;
mod rename;
mod rows;
mod tenants;

pub use rename::TenantRename;
pub(crate) use rows::*;

use crate::BootstrapToken;
use serde::{Deserialize, Serialize};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Platform tenant onboarding.
// ---------------------------------------------------------------------------

/// Summary of a tenant row for the platform tenant-list / status APIs.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct OrganizationSummary {
    pub id: Uuid,
    pub slug: String,
    pub domain_aliases: Vec<String>,
    pub pending_domain: Option<String>,
    pub removable: bool,
    pub removal_refusal: Option<String>,
    pub lifecycle: String,
    pub code_issued_count: i64,
    pub passkey_registered_count: i64,
    pub name: String,
    pub status: String,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
    pub group_id: Option<Uuid>,
    pub group_slug: Option<String>,
    pub group_name: Option<String>,
}

/// Organization member identity inside a platform group response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GroupMemberSummary {
    pub id: Uuid,
    pub slug: String,
    pub name: String,
    pub status: String,
}

/// Platform group identity + its subsidiary organization memberships.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GroupSummary {
    pub id: Uuid,
    pub slug: String,
    pub name: String,
    pub status: String,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
    pub member_count: i64,
    pub members: Vec<GroupMemberSummary>,
}

/// Tenant-anchored account that holds one or more group-level grants.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GroupAccountSummary {
    pub person_id: Option<Uuid>,
    pub principal_kind: String,
    pub user_id: Uuid,
    pub display_name: String,
    pub phone: Option<String>,
    pub tenant_roles: Vec<String>,
    pub is_active: bool,
    pub has_passkey: bool,
    pub account_status: String,
    pub org_id: Uuid,
    pub org_slug: String,
    pub org_name: String,
    pub group_roles: Vec<String>,
    pub created_at: OffsetDateTime,
}

/// Result of creating a group account: the account plus the one-time setup OTP.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupAccountOnboarding {
    pub account: GroupAccountSummary,
    pub otp: BootstrapToken,
    pub otp_expires_at: OffsetDateTime,
}

/// Per-tenant health/usage rollup for the platform ops dashboard.
///
/// Produced by the SECURITY DEFINER `platform_org_health()` function (the only
/// sanctioned cross-tenant aggregation path) and surfaced through an audited
/// platform read. Carries only counts + a last-activity timestamp; never any
/// row-level tenant data.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct TenantHealth {
    pub id: Uuid,
    pub slug: String,
    pub name: String,
    pub status: String,
    pub group_id: Option<Uuid>,
    pub group_slug: Option<String>,
    pub group_name: Option<String>,
    pub user_count: i64,
    pub active_user_count: i64,
    pub active_work_orders: i64,
    pub open_work_orders: i64,
    pub last_activity_at: Option<OffsetDateTime>,
    pub route_adoption: Vec<RouteAdoptionMetric>,
    pub zero_legacy_release_cycles: i64,
}

/// Per-release route-adoption/RUM rollup for one tenant.
///
/// A release cycle with `legacy_route_events = 0` and `console_route_events > 0`
/// counts toward the D5 endgame evidence. Two consecutive release cycles with no
/// legacy route traffic are enough to consider retiring the legacy lane.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct RouteAdoptionMetric {
    pub release_cycle: String,
    pub console_route_events: i64,
    pub legacy_route_events: i64,
    pub rum_error_events: i64,
    pub rum_perf_p95_ms: Option<i64>,
    pub last_event_at: OffsetDateTime,
}

/// Outcome of onboarding a new tenant: the created org plus the ONE-TIME OTP for
/// its first SUPER_ADMIN, to be delivered out-of-band.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TenantOnboarding {
    pub organization: OrganizationSummary,
    pub admin_user_id: Uuid,
    pub admin_sign_in_id: Option<String>,
    /// The one-time cold-start OTP for the new org's first SUPER_ADMIN. Returned
    /// to the platform caller exactly once; never logged or audited.
    pub admin_otp: BootstrapToken,
    pub admin_otp_expires_at: OffsetDateTime,
}

/// A replacement cold-start OTP for a tenant's first SUPER_ADMIN who never
/// enrolled a passkey. Returned exactly once; never logged or audited.
#[derive(Debug, Clone)]
pub struct TenantAdminOtpReissue {
    pub admin_user_id: Uuid,
    pub admin_sign_in_id: Option<String>,
    pub admin_otp: BootstrapToken,
    pub admin_otp_expires_at: OffsetDateTime,
}

/// Result of a guarded tenant hard-removal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TenantRemovalOutcome {
    /// The empty/test tenant + its shell were deleted; its audit trail was
    /// re-homed to the platform sentinel and preserved.
    Removed,
    /// The tenant owns real operational data and was NOT touched; the caller
    /// surfaces a 409 telling the operator to archive instead. Only the GUARDED
    /// [`PlatformProvisioner::remove_tenant`] path can return this.
    BlockedHasData,
    /// The FORCE path was refused because the tenant is not ARCHIVED; nothing was
    /// touched. The caller surfaces a 409 telling the operator to archive the
    /// tenant (reversible) before force-removing it. Only the FORCE
    /// [`PlatformProvisioner::force_remove_tenant`] path can return this.
    BlockedActive,
    /// An active legal hold preserves the tenant and its audit attribution.
    BlockedLegalHold,
    /// No such tenant (or the platform sentinel was targeted); nothing changed.
    NotFound,
}

/// Cross-tenant tenant-provisioning operations for the PLATFORM tier.
///
/// Every method here is a privileged, AUDITED, cross-tenant action. The REST
/// layer only reaches it behind the platform extractor (a tenant token is
/// rejected), so these can never be driven by a tenant admin.
#[derive(Debug, Clone, Copy)]
pub struct PlatformProvisioner {
    pub(crate) onboarding_otp_ttl: Duration,
}

impl PlatformProvisioner {
    #[must_use]
    pub const fn new(onboarding_otp_ttl: Duration) -> Self {
        Self { onboarding_otp_ttl }
    }
}

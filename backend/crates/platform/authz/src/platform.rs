use console_kernel_core::{KernelError, UserId};

// ---------------------------------------------------------------------------
// Platform tier — the SaaS-vendor identity ABOVE all tenants.
// ---------------------------------------------------------------------------
//
// The platform tier is a DISTINCT concept from the per-tenant [`Role`]s. It is
// deliberately NOT just another `Role`: a platform actor must never be treated
// as a tenant member, regardless of how many tenant roles exist. Instead a
// platform principal is its own type with its own
// small capability set, and it can NEVER hold a tenant `Role` or be authorized
// for a tenant [`Feature`] (there is no bridge from [`PlatformFeature`] to
// [`Feature`], and [`PlatformPrincipal`] carries no `BranchScope`).

/// Cross-tenant capabilities held only by the platform (SaaS-vendor) tier.
///
/// Every platform action is cross-tenant and must be explicit + audited; a
/// tenant admin can never reach these (the platform extractor rejects a tenant
/// token, and tenant middleware rejects a platform token).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlatformFeature {
    /// Create (onboard) a new tenant organization + seed its first admin.
    TenantCreate,
    /// List all tenants (cross-tenant read).
    TenantList,
    /// Suspend / reactivate a tenant (status change).
    TenantSuspend,
    /// Hard-remove (delete) an empty/test tenant org + its onboarding shell.
    /// Strictly more destructive than [`Self::TenantSuspend`]; a tenant's own
    /// admin can never reach it (the platform extractor rejects a tenant token).
    TenantRemove,
    /// Read a tenant's health/status.
    TenantHealthRead,
    /// Mint an audited tenant-admin context so a platform operator can manage a
    /// specific tenant through the ordinary tenant-scoped UI/API.
    TenantManage,
    /// Manage platform group identities and subsidiary membership.
    GroupManage,
    /// Invite, list, reissue, and revoke platform-tier operators.
    OperatorManage,
    /// Read the platform-tier audit trail.
    PlatformAuditRead,
}

impl PlatformFeature {
    pub const ALL: [Self; 9] = [
        Self::TenantCreate,
        Self::TenantList,
        Self::TenantSuspend,
        Self::TenantRemove,
        Self::TenantHealthRead,
        Self::TenantManage,
        Self::GroupManage,
        Self::OperatorManage,
        Self::PlatformAuditRead,
    ];
}

/// An authenticated PLATFORM principal — the SaaS-vendor tier above all tenants.
///
/// It holds NO tenant [`Role`] and NO [`BranchScope`]: a platform principal can
/// never create a work order or touch tenant-scoped data through the tenant
/// matrix. Existing platform sessions hold the full [`PlatformFeature`] set;
/// an explicit feature set restricts authority without entering the tenant matrix.
///
/// [`Role`]: crate::Role
/// [`BranchScope`]: console_kernel_core::BranchScope
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PlatformPrincipal {
    pub user_id: UserId,
    #[serde(default)]
    features: Option<Vec<PlatformFeature>>,
}

impl PlatformPrincipal {
    /// The current operator identity contract. Support eligibility uses the same door as authentication.
    #[must_use]
    pub fn accepts_roles(roles: &[String]) -> bool {
        roles
            .iter()
            .any(|role| role == crate::Role::SuperAdmin.as_str())
    }
    #[must_use]
    pub const fn new(user_id: UserId) -> Self {
        Self {
            user_id,
            features: None,
        }
    }

    /// Whether an explicit subset (or full platform session) includes `feature`.
    #[must_use]
    pub fn has_feature(&self, feature: PlatformFeature) -> bool {
        self.features
            .as_ref()
            .is_none_or(|features| features.contains(&feature))
    }

    /// An explicit subset is authoritative; an omitted set preserves existing platform sessions.
    pub fn authorize(&self, feature: PlatformFeature) -> Result<(), KernelError> {
        if self.has_feature(feature) {
            Ok(())
        } else {
            Err(KernelError::forbidden("Platform capability is required"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn operator_manage_respects_restricted_platform_features() {
        let full = PlatformPrincipal::new(UserId::new());
        assert!(full.authorize(PlatformFeature::OperatorManage).is_ok());

        let restricted: PlatformPrincipal = serde_json::from_value(serde_json::json!({
            "user_id": UserId::new(),
            "features": ["tenant_list"]
        }))
        .expect("deserialize restricted principal");
        assert!(
            restricted
                .authorize(PlatformFeature::OperatorManage)
                .is_err()
        );
        assert!(restricted.authorize(PlatformFeature::TenantList).is_ok());
    }
}

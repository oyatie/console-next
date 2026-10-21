use crate::*;

// ---------------------------------------------------------------------------
// Authorization floors (see the module doc for the Feature-enum handoff)
// ---------------------------------------------------------------------------

/// The org-change feature floor: the `permission_for` matrix row (the same one
/// `/api/v1/me/authz` projects) or a custom grant. A built-in role passes on its
/// matrix cell alone, independent of branch scope, as the pre-variant role
/// floors did.
pub(crate) fn feature_floor(
    p: &Principal,
    feature: Feature,
    denied: &'static str,
) -> Result<(), RestError> {
    let by_role = p
        .roles
        .iter()
        .any(|role| permission_for(*role, feature) == PermissionLevel::Allow);
    if by_role || authorize_capability(p, Action::new(feature)).is_ok() {
        Ok(())
    } else {
        Err(RestError::kernel(KernelError::forbidden(denied)))
    }
}

/// `org_change_read` (ADMIN, EXECUTIVE, SUPER_ADMIN).
pub(crate) fn allow_read(p: &Principal) -> Result<(), RestError> {
    feature_floor(
        p,
        Feature::OrgChangeRead,
        "role is not allowed to read org changes",
    )
}

/// `org_change_draft` (ADMIN, EXECUTIVE, SUPER_ADMIN).
pub(crate) fn allow_draft(p: &Principal) -> Result<(), RestError> {
    feature_floor(
        p,
        Feature::OrgChangeDraft,
        "role is not allowed to draft org changes",
    )
}

/// `org_change_approve` (EXECUTIVE, SUPER_ADMIN).
pub(crate) fn allow_approve(p: &Principal) -> Result<(), RestError> {
    feature_floor(
        p,
        Feature::OrgChangeApprove,
        "role is not allowed to approve org changes",
    )
}

/// `org_change_apply` (EXECUTIVE, SUPER_ADMIN).
pub(crate) fn allow_apply(p: &Principal) -> Result<(), RestError> {
    feature_floor(
        p,
        Feature::OrgChangeApply,
        "role is not allowed to apply org changes",
    )
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

pub(crate) fn respond<T: Serialize>(value: &T) -> Result<Json<serde_json::Value>, RestError> {
    serde_json::to_value(value)
        .map(Json)
        .map_err(|_| RestError::internal("response serialization failed"))
}

pub(crate) fn idem_header(h: &HeaderMap) -> Result<String, RestError> {
    h.get("Idempotency-Key")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
        .ok_or_else(|| {
            RestError::kernel(KernelError::validation(
                "Idempotency-Key header is required",
            ))
        })
}

pub(crate) async fn principal(
    s: &OrgChangeRestState,
    h: &HeaderMap,
) -> Result<Principal, RestError> {
    let verifier = s.jwt.as_ref().ok_or_else(|| {
        RestError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "unavailable",
            "JWT verification is not configured",
        )
    })?;
    console_platform_request_context::resolve_principal(verifier, s.store.pool(), h)
        .await
        .map_err(|e| match e {
            RequestContextError::MissingBearer
            | RequestContextError::InvalidToken
            | RequestContextError::InvalidClaim(_) => RestError::new(
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "missing, malformed, or invalid bearer token",
            ),
            RequestContextError::WrongTokenTier | RequestContextError::AccessScope(_) => {
                RestError::kernel(KernelError::forbidden(
                    "token is not authorized for org changes",
                ))
            }
            RequestContextError::VerifierUnavailable => RestError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "unavailable",
                "JWT verification is not configured",
            ),
            RequestContextError::BranchScope(m) | RequestContextError::EffectivePolicy(m) => {
                RestError::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", m)
            }
            RequestContextError::MissingOrg => RestError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                "no tenant context is bound",
            ),
        })
}

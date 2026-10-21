use crate::audit::auth_audit_event;
use crate::audit::record_anonymous_auth_audit;
use crate::context::grants::resolve_feature_grant_keys_for_user_in_tx;
use crate::context::load::load_user_auth_context_tx;
use crate::cookies::refresh_set_cookie;
use crate::cookies::wants_cookie_transport;
use crate::cookies::with_refresh_cookie;
use crate::dto::otp::OtpRedeemRequest;
use crate::dto::otp::OtpRedeemResponse;
use crate::error::RestError;
use crate::rate_limit::RateLimitEndpoint;
use crate::rate_limit::rate_limit;
use crate::state::AuthRestState;
use crate::token::issue::issue_token_pair_in_tx;
use axum::Json;
use axum::extract::Extension;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use axum::response::Response;
use console_kernel_core::BranchId;
use console_kernel_core::BranchScope;
use console_platform_db::DbError;
use console_platform_db::insert_audit_event;
use console_platform_request_context::TrustedClientIp;
use std::collections::BTreeSet;
use time::OffsetDateTime;

/// Redeem a one-time OTP as a FIRST SIGN-IN.
///
/// Unauthenticated and rate-limited. Legacy OTP verification and its newly
/// minted family are committed together for the OTP's pre-provisioned user;
/// `requires_passkey_setup` tells the frontend to force passkey enrollment in
/// initial settings. A wrong/expired/used OTP returns a single generic 401.
pub(crate) async fn redeem_otp(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
    trusted_client_ip: Option<Extension<TrustedClientIp>>,
    Json(body): Json<OtpRedeemRequest>,
) -> Result<Response, RestError> {
    let services = state.services()?;
    let now = OffsetDateTime::now_utc();
    rate_limit(
        &state.pool,
        &headers,
        trusted_client_ip.map(|Extension(ip)| ip),
        RateLimitEndpoint::OtpRedeem,
        now,
    )
    .await?;

    let mut tx = state.pool.begin().await.map_err(DbError::Sqlx)?;
    let redemption = match services
        .bootstrap_credentials
        .redeem_otp_in_tx(&mut tx, body.otp.trim(), now)
        .await
    {
        Ok(redemption) => redemption,
        Err(err) => {
            tx.rollback().await.map_err(DbError::Sqlx)?;
            // Audit the failed attempt WITHOUT the OTP value or any PII.
            record_anonymous_auth_audit(
                &state.pool,
                "auth.otp.redeem_failed",
                serde_json::json!({ "outcome": "rejected" }),
            )
            .await
            .ok();
            return Err(RestError::from_provisioning(err));
        }
    };
    // The live route has no admission receipt or release barrier for v1.
    if redemption.source.issuance_version != 0 {
        return Err(RestError::unauthorized("invalid or expired one-time code"));
    }
    // OTP resolution armed its Company's GUC and locked its exact source. Keep
    // that lock through family issue, JWT signing and the success audit.
    let mut user = load_user_auth_context_tx(&mut tx, redemption.user_id).await?;
    if user.org_id != redemption.org_id {
        return Err(RestError::unauthorized("invalid or expired one-time code"));
    }
    user.feature_grants = resolve_feature_grant_keys_for_user_in_tx(&mut tx, &user).await?;
    // The OTP-bound family is an enrollment session: its tokens reach only the
    // enrollment surface until a fresh passkey sign-in.
    let tokens = issue_token_pair_in_tx(&mut tx, services, &user, true).await?;
    let bound = sqlx::query(
        "INSERT INTO auth_legacy_otp_family_sources(family_id,source_id,user_id,org_id) \
         SELECT $1,id,user_id,org_id FROM auth_bootstrap_credentials \
         WHERE id=$2 AND user_id=$3 AND org_id=$4 AND issuance_version=0 \
           AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp()",
    )
    .bind(tokens.family_id)
    .bind(redemption.source.credential_id)
    .bind(redemption.user_id)
    .bind(*redemption.org_id.as_uuid())
    .execute(tx.as_mut())
    .await
    .map_err(DbError::Sqlx)?;
    if bound.rows_affected() != 1 {
        return Err(RestError::unauthorized("invalid or expired one-time code"));
    }
    let audit = auth_audit_event(
        redemption.org_id,
        redemption.user_id,
        "auth.otp.signin",
        serde_json::json!({
            "refresh_family_id": tokens.family_id,
            "requires_passkey_setup": redemption.requires_passkey_setup,
        }),
    )?;
    insert_audit_event(&mut tx, &audit).await?;
    tx.commit().await.map_err(DbError::Sqlx)?;

    // Dual transport: web (cookie) gets an HttpOnly Set-Cookie and a null body
    // refresh token; mobile (body) gets the refresh token in the JSON body. The
    // access token and passkey-setup flag are always in the body.
    if wants_cookie_transport(&headers) {
        let max_age = (tokens.refresh_expires_at - now).whole_seconds();
        let cookie = refresh_set_cookie(&tokens.refresh_token, max_age, services.cookie_secure);
        let response = Json(OtpRedeemResponse {
            access_token: tokens.access_token,
            refresh_token: None,
            token_type: "Bearer",
            refresh_expires_at: tokens.refresh_expires_at,
            requires_passkey_setup: redemption.requires_passkey_setup,
        })
        .into_response();
        Ok(with_refresh_cookie(response, cookie))
    } else {
        Ok(Json(OtpRedeemResponse {
            access_token: tokens.access_token,
            refresh_token: Some(tokens.refresh_token),
            token_type: "Bearer",
            refresh_expires_at: tokens.refresh_expires_at,
            requires_passkey_setup: redemption.requires_passkey_setup,
        })
        .into_response())
    }
}

/// Issue a one-time sign-in OTP for a pre-provisioned zero-credential user.
///
/// AUTHZ-gated: only ADMIN / SUPER_ADMIN (branch-scoped) may call it, via the
/// `SubordinateUserCreate` feature. The issuance is audited inside
/// `issue_for_zero_credential_user`. The returned OTP is shown once.
///
/// The branch set a privileged admin credential action (issue-OTP /
/// credential-reset) must authorize the caller against, given the TARGET user's
/// resolved branch scope.
///
/// * `Branches(non-empty)` → `Some(branches)`: a branch-scoped target. The caller
///   must be authorized for `SubordinateUserCreate` against EVERY one of them
///   (the per-branch IDOR check, done by the caller).
/// * `All` → `None`: an org-wide target (a `SUPER_ADMIN` / `EXECUTIVE`, for whom
///   [`resolve_branch_scope_in_org`] returns `All`). There is no concrete branch
///   to check. Such a target is always privileged, so by the privileged-target
///   guard only a `SUPER_ADMIN` — who is authorized org-wide for this feature —
///   can ever reach here; `caller_is_super_admin` is re-asserted as defense in
///   depth so a future refactor of that guard cannot open a hole.
/// * an empty branch set → `None` only for a roleless account (governance-01: no
///   title, no 지점; it carries no access of its own) when the caller manages
///   accounts (`caller_manages_roleless`); otherwise, and for any other scope,
///   403 (nothing issuable).
///
/// Shared by `issue_admin_otp` and `admin_credential_reset` so the two cannot
/// drift: both previously matched only `Branches(non-empty)` and so 403'd on an
/// `All`-scope (privileged) target — the "코드를 발급하지 못했습니다" OTP-issuance
/// failure from issue #18. An org-wide target now resolves to `None` (authorized,
/// no per-branch basis) instead of a hard 403.
pub(crate) fn authorizable_target_branches(
    target_scope: BranchScope,
    caller_is_super_admin: bool,
    caller_manages_roleless: bool,
) -> Result<Option<BTreeSet<BranchId>>, RestError> {
    match target_scope {
        BranchScope::Branches(branches) if !branches.is_empty() => Ok(Some(branches)),
        BranchScope::All if caller_is_super_admin => Ok(None),
        BranchScope::Branches(_) if caller_manages_roleless => Ok(None),
        _ => Err(RestError::forbidden(
            "target user has no issuable branch scope",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::authorizable_target_branches;
    use std::collections::BTreeSet;

    use console_kernel_core::BranchId;
    use console_kernel_core::BranchScope;

    use uuid::Uuid;

    #[test]
    fn authorizable_branches_all_scope_issuable_only_by_super_admin() {
        // The issue-#18 fix: an org-wide (SUPER_ADMIN / EXECUTIVE) target resolves
        // to `All`. A SUPER_ADMIN caller may issue/reset for it with no per-branch
        // basis (`None`); a non-SUPER_ADMIN caller can never reach a valid action
        // (the privileged-target guard already blocks them earlier, and this is the
        // defense-in-depth re-assertion).
        assert!(matches!(
            authorizable_target_branches(BranchScope::All, true, false),
            Ok(None)
        ));
        assert!(authorizable_target_branches(BranchScope::All, false, true).is_err());
    }

    #[test]
    fn authorizable_branches_branch_scoped_target() {
        // A branch-scoped target returns its concrete branches for the per-branch
        // authz loop (regardless of caller role — the loop enforces caller scope).
        let branch = BranchId::from_uuid(Uuid::nil());
        assert!(matches!(
            authorizable_target_branches(BranchScope::single(branch), false, true),
            Ok(Some(branches)) if branches == BTreeSet::from([branch])
        ));
        // An empty branch set is issuable only for a roleless account by an
        // account manager (governance-01, regression: 403 on 99dafebc).
        let none = || BranchScope::Branches(BTreeSet::new());
        assert!(authorizable_target_branches(none(), true, false).is_err());
        assert!(matches!(
            authorizable_target_branches(none(), false, true),
            Ok(None)
        ));
    }
}

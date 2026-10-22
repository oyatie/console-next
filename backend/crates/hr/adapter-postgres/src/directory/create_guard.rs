//! The write-boundary guards every directory registration runs first (moved
//! verbatim from `create_core.rs` so the BW-19 REHIRE path shares them): the
//! live directory-manager revalidation and the idempotency reservation.

use console_kernel_core::{KernelError, UserId};
use console_platform_authz::Role;
use sqlx::{Postgres, Row};
use uuid::Uuid;

use crate::HrError;
use crate::directory::create::employee_create_db_error;
use console_platform_db::idempotency::IDEMPOTENCY_KEY_REUSED;

/// Live actor revalidation (see the comment inside); the same predicate as the
/// migration-0183 `leave_api.assert_employee_directory_manager`.
///
/// # Errors
/// 403 when the actor is gone, deactivated, or lost the org-wide grant.
pub async fn revalidate_directory_manager(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    actor: UserId,
) -> Result<(), HrError> {
    // Live actor revalidation at the write boundary (defense-in-depth): the
    // request-context principal is built from token roles and a request-time
    // grant resolution, so a deactivated, role-revoked, or grant-revoked actor
    // with an unexpired token would otherwise pass the pre-flight
    // `authorize_hr_org_wide`. Restore the migration-0183
    // `leave_api.assert_employee_directory_manager` predicate — SUPER_ADMIN, or
    // (SUPER_ADMIN/EXECUTIVE AND a live, active, non-branch-narrowed
    // `employee_directory_manage` allow grant) — reading `users` and
    // `user_role_assignments`/`policy_roles`/`policy_role_permissions`/
    // `policy_role_conditions` under the SAME `FOR UPDATE` locks this
    // transaction holds, so a concurrent deactivation, role revocation, or
    // grant revocation cannot slip between this check and the insert. This
    // predicate is byte-for-byte the routing authority of
    // `leave_api.assert_employee_directory_manager` (see the 0221 migration),
    // so no actor who passes this recheck can be denied at the later
    // first-home-branch assignment on authority grounds.
    let actor_row = sqlx::query(
        "SELECT is_active, roles, team FROM users WHERE id = $1 AND org_id = $2 FOR UPDATE",
    )
    .bind(*actor.as_uuid())
    .bind(org_uuid)
    .fetch_optional(tx.as_mut())
    .await?
    .ok_or_else(|| {
        HrError::from_kernel(KernelError::forbidden(
            "employee create: actor not found in this organization",
        ))
    })?;
    let actor_is_active: bool = actor_row.try_get("is_active")?;
    if !actor_is_active {
        return Err(HrError::from_kernel(KernelError::forbidden(
            "employee create: actor account is deactivated",
        )));
    }
    let actor_roles: Vec<String> = actor_row.try_get("roles")?;
    let actor_team: Option<String> = actor_row.try_get("team")?;
    let is_super_admin = actor_roles
        .iter()
        .any(|role| role == Role::SuperAdmin.as_str());
    // AX-5: a pilot access grant that counts now with hr_basic edit (the
    // register door already decided the place over the grant set). Locked
    // FOR SHARE so a concurrent revoke cannot slip past this check; the same
    // predicate as migration 0330's `assert_employee_directory_manager`.
    if !is_super_admin && holds_access_hr_edit(tx, org_uuid, actor).await? {
        return Ok(());
    }
    if !is_super_admin {
        let has_directory_tier = actor_roles
            .iter()
            .any(|role| role == Role::SuperAdmin.as_str() || role == Role::Executive.as_str());
        if !has_directory_tier {
            return Err(HrError::from_kernel(KernelError::forbidden(
                "employee create: actor lacks an org-wide directory-manage role",
            )));
        }
        // Lock the matching grant rows (roles/permissions) FIRST, matching the
        // policy writer's role→condition lock order (`update_policy_role` locks
        // `policy_roles` before deleting that role's conditions), so the two
        // cannot form a lock-order deadlock.
        let role_ids: Vec<Uuid> = sqlx::query_scalar(
            "SELECT ura.role_id \
             FROM user_role_assignments ura \
             JOIN policy_roles pr ON pr.org_id = ura.org_id AND pr.id = ura.role_id \
             JOIN policy_role_permissions prp ON prp.org_id = pr.org_id AND prp.role_id = pr.id \
             WHERE ura.org_id = $1 AND ura.user_id = $2 \
               AND pr.status = 'ACTIVE' AND NOT pr.is_system \
               AND prp.feature_key = 'employee_directory_manage' \
               AND prp.permission_level = 'allow' \
             FOR UPDATE OF ura, pr, prp",
        )
        .bind(org_uuid)
        .bind(*actor.as_uuid())
        .fetch_all(tx.as_mut())
        .await?;
        // Lock the condition rows for those roles (same order as the policy
        // writer: roles first, then conditions).
        if !role_ids.is_empty() {
            sqlx::query(
                "SELECT 1 FROM policy_role_conditions prc \
                 WHERE prc.org_id = $1 AND prc.role_id = ANY($2) \
                 FOR UPDATE",
            )
            .bind(org_uuid)
            .bind(&role_ids)
            .execute(tx.as_mut())
            .await?;
        }
        // Live custom-grant revalidation (HIGH-2): a custom grant only widens an
        // EXECUTIVE/SUPER_ADMIN. The team condition mirrors 0183 exactly,
        // including the Korean-team → English-condition normalization. Evaluated
        // AFTER both the role and condition rows are locked.
        let live_org_wide_grant: Option<i32> = sqlx::query_scalar(
            r#"
            SELECT 1
            FROM user_role_assignments ura
            JOIN policy_roles pr ON pr.org_id = ura.org_id AND pr.id = ura.role_id
            JOIN policy_role_permissions prp
              ON prp.org_id = pr.org_id AND prp.role_id = pr.id
            WHERE ura.org_id = $1
              AND ura.user_id = $2
              AND pr.status = 'ACTIVE'
              AND NOT pr.is_system
              AND prp.feature_key = 'employee_directory_manage'
              AND prp.permission_level = 'allow'
              AND NOT EXISTS (
                  SELECT 1
                  FROM policy_role_conditions prc
                  WHERE prc.org_id = pr.org_id
                    AND prc.role_id = pr.id
                    AND (
                        prc.operator NOT IN ('equals', 'in')
                        OR prc.attribute = 'branch'
                        OR prc.attribute <> 'team'
                        OR $3::text IS NULL
                        OR NOT EXISTS (
                            SELECT 1
                            FROM unnest(prc.condition_values) AS cv
                            WHERE btrim(cv) = $3::text
                               OR upper(btrim(cv)) = CASE $3::text
                                    WHEN '정비' THEN 'MAINTENANCE'
                                    WHEN '예방' THEN 'PREVENTION'
                                    WHEN '관리' THEN 'MANAGEMENT'
                                    WHEN '접수' THEN 'RECEPTION'
                                    ELSE NULL
                                  END
                        )
                    )
              )
            LIMIT 1
            FOR UPDATE
            "#,
        )
        .bind(org_uuid)
        .bind(*actor.as_uuid())
        .bind(actor_team.as_deref())
        .fetch_optional(tx.as_mut())
        .await?;
        if live_org_wide_grant.is_none() {
            return Err(HrError::from_kernel(KernelError::forbidden(
                "employee create: actor's org-wide directory-manage grant was revoked",
            )));
        }
    }
    Ok(())
}

/// Reserves `idempotency_key` for this request hash. Returns the employee a
/// previous call with the same key and hash created (a replay), `None` for a
/// first call.
///
/// # Errors
/// 409 `conflict` (idempotency key reused) for the same key with another hash.
pub async fn reserve_create_key(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    idempotency_key: &str,
    request_hash: &str,
) -> Result<Option<Uuid>, HrError> {
    sqlx::query(
        "INSERT INTO employee_create_idempotency (org_id, idempotency_key, request_hash) VALUES ($1, $2, $3) ON CONFLICT (org_id, idempotency_key) DO NOTHING",
    )
    .bind(org_uuid)
    .bind(idempotency_key)
    .bind(request_hash)
    .execute(tx.as_mut())
    .await
    .map_err(employee_create_db_error)?;
    let reservation = sqlx::query(
        "SELECT request_hash, employee_id FROM employee_create_idempotency WHERE org_id = $1 AND idempotency_key = $2 FOR UPDATE",
    )
    .bind(org_uuid)
    .bind(idempotency_key)
    .fetch_one(tx.as_mut())
    .await?;
    let stored_hash: String = reservation.try_get("request_hash")?;
    if stored_hash != request_hash {
        return Err(registration_key_reused());
    }
    Ok(reservation.try_get::<Option<Uuid>, _>("employee_id")?)
}

/// BW-19 3: 409 `idempotency_key_reused` — the key already names another
/// registration (its own code, distinct from `employee_number_taken`; the
/// message is the shared one).
pub fn registration_key_reused() -> HrError {
    HrError {
        errors: None,
        status: http::StatusCode::CONFLICT,
        code: "idempotency_key_reused",
        message: IDEMPOTENCY_KEY_REUSED.to_owned(),
        refusals: None,
    }
}

/// Whether `actor` holds a pilot access grant that counts now whose role's
/// current version carries hr_basic edit (rows locked FOR SHARE).
async fn holds_access_hr_edit(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    actor: UserId,
) -> Result<bool, HrError> {
    let held: Option<Uuid> = sqlx::query_scalar(
        "SELECT g.id FROM access_grants g \
           JOIN access_roles r ON r.org_id = g.org_id AND r.id = g.role_id AND r.status = 'ACTIVE' \
           JOIN access_role_lines l ON l.org_id = r.org_id AND l.role_id = r.id AND l.version = r.version \
          WHERE g.org_id = $1 AND g.account_id = $2 AND g.status = 'ACTIVE' AND g.include_descendants \
            AND l.domain = 'hr_basic' AND l.levels @> ARRAY['edit']::text[] \
            AND g.valid_from <= now() AND (g.valid_to IS NULL OR now() < g.valid_to) \
            AND (g.effective_in_setup OR COALESCE( \
                 (SELECT p.phase FROM tenant_phase p WHERE p.org_id = $1), 'OPERATING') = 'OPERATING') \
          LIMIT 1 FOR SHARE OF g",
    )
    .bind(org_uuid)
    .bind(*actor.as_uuid())
    .fetch_optional(tx.as_mut())
    .await?;
    Ok(held.is_some())
}

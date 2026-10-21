use std::collections::BTreeSet;

use crate::ProvisioningError;
use console_kernel_core::{AuditAction, AuditEvent, BranchId, OrgId, TraceContext};
use console_platform_db::with_audit;
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// dev-auth: local role-switch principal provisioning.
//
// Reached ONLY from the `dev-auth` cargo feature in `console-platform-auth-rest`
// (never compiled into a default/release build — see that crate's
// `#[cfg(feature = "dev-auth")]` route). A dev persona needs a REAL `users` +
// `user_branches` row: `resolve_branch_scope_in_org` re-resolves branch
// membership from the DB, by user id, on every request, so a token-only
// identity with no backing row would see zero branch-scoped data for any
// non-admin role. This mirrors `apply_roster_tx`'s find-or-update-else-insert
// shape (same tables), scoped to one row per (org, role) instead of a whole
// roster — but atomically, via `INSERT ... ON CONFLICT`, since a `SELECT ...
// FOR UPDATE` finding zero rows locks nothing and cannot serialize two
// concurrent FIRST mints of the same persona.
// ---------------------------------------------------------------------------

/// One dev-auth role-switch request: the org/role/branches an engineer wants to
/// exercise locally. `role` is a canonical DB role string, already validated by
/// the caller (the REST boundary parses it through the authz `Role` enum before
/// this is built, exactly like every other role-accepting endpoint).
#[derive(Debug, Clone)]
pub struct DevPrincipalRequest {
    pub org_id: OrgId,
    pub display_name: String,
    pub role: String,
    pub branch_ids: Vec<BranchId>,
}

/// The backing user row for a dev-auth session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DevPrincipal {
    pub user_id: Uuid,
}

/// Idempotently create-or-update the ONE dev principal for a given (org, role):
/// calling this again with a different display name or branch set moves that
/// same persona rather than accumulating throwaway rows. Identified by a
/// synthetic `phone` value (`dev-auth:<org>:<role>`) — `phone` carries no format
/// CHECK, and this prefix can never collide with a real telephone number.
#[derive(Debug, Clone, Copy, Default)]
pub struct DevPrincipalProvisioner;

impl DevPrincipalProvisioner {
    pub async fn upsert(
        &self,
        pool: &PgPool,
        request: DevPrincipalRequest,
        now: OffsetDateTime,
    ) -> Result<DevPrincipal, ProvisioningError> {
        let org_uuid = *request.org_id.as_uuid();
        let dev_key = format!("dev-auth:{org_uuid}:{}", request.role);
        let branch_ids: Vec<Uuid> = request
            .branch_ids
            .iter()
            .map(|b| *b.as_uuid())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let roles = vec![request.role.clone()];

        let event = AuditEvent::new(
            None,
            AuditAction::new("dev_auth.principal.upsert")?,
            "users",
            dev_key.clone(),
            TraceContext::generate(),
            now,
        )
        .with_org(request.org_id)
        .with_snapshots(
            None,
            Some(serde_json::json!({
                "role": request.role,
                "branch_ids": branch_ids,
            })),
        );

        with_audit::<_, DevPrincipal, ProvisioningError>(pool, event, move |tx| {
            Box::pin(async move {
                // Fail closed on an unknown/inactive org with a clean 404 rather
                // than letting the `users_org_fk` FK violation surface as a raw
                // 500 from the INSERT below.
                let org_status: Option<String> =
                    sqlx::query_scalar("SELECT status FROM organizations WHERE id = $1")
                        .bind(org_uuid)
                        .fetch_optional(tx.as_mut())
                        .await?;
                if org_status.as_deref() != Some("ACTIVE") {
                    return Err(ProvisioningError::NotFound(
                        "no such active organization".to_owned(),
                    ));
                }

                if !branch_ids.is_empty() {
                    let found: Vec<Uuid> = sqlx::query_scalar(
                        "SELECT id FROM branches WHERE id = ANY($1) AND org_id = $2",
                    )
                    .bind(&branch_ids)
                    .bind(org_uuid)
                    .fetch_all(tx.as_mut())
                    .await?;
                    if found.len() != branch_ids.len() {
                        return Err(ProvisioningError::NotFound(
                            "one or more branch_ids do not belong to this org".to_owned(),
                        ));
                    }
                }

                // `ON CONFLICT (phone) WHERE phone IS NOT NULL` targets
                // `idx_users_phone_unique_present` (0006_create_provisioning.sql)
                // atomically: a `SELECT ... FOR UPDATE` on zero rows locks
                // nothing, so two concurrent FIRST mints for the same (org,
                // role) would both insert and 500 on the unique-index conflict.
                let user_id: Uuid = sqlx::query_scalar(
                    r#"
                    INSERT INTO users (display_name, phone, roles, is_active, org_id)
                    VALUES ($1, $2, $3, true, $4)
                    ON CONFLICT (phone) WHERE phone IS NOT NULL
                    DO UPDATE SET display_name = EXCLUDED.display_name,
                                  roles = EXCLUDED.roles,
                                  is_active = true
                    RETURNING id
                    "#,
                )
                .bind(&request.display_name)
                .bind(&dev_key)
                .bind(&roles)
                .bind(org_uuid)
                .fetch_one(tx.as_mut())
                .await?;

                let existing_branch_rows: Vec<Uuid> =
                    sqlx::query_scalar("SELECT branch_id FROM user_branches WHERE user_id = $1")
                        .bind(user_id)
                        .fetch_all(tx.as_mut())
                        .await?;
                let existing_branches: BTreeSet<Uuid> = existing_branch_rows.into_iter().collect();
                let desired_branches: BTreeSet<Uuid> = branch_ids.iter().copied().collect();

                for branch_id in desired_branches.difference(&existing_branches) {
                    sqlx::query(
                        "INSERT INTO user_branches (user_id, branch_id, org_id) VALUES ($1, $2, $3)",
                    )
                    .bind(user_id)
                    .bind(branch_id)
                    .bind(org_uuid)
                    .execute(tx.as_mut())
                    .await?;
                }
                for branch_id in existing_branches.difference(&desired_branches) {
                    sqlx::query("DELETE FROM user_branches WHERE user_id = $1 AND branch_id = $2")
                        .bind(user_id)
                        .bind(branch_id)
                        .execute(tx.as_mut())
                        .await?;
                }

                Ok(DevPrincipal { user_id })
            })
        })
        .await
    }
}

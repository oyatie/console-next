use crate::policy::preview_receipt::{
    AssignmentPreviewReceiptConsumption, stale_policy_assignment_preview_error,
};
use crate::policy::rows::fetch_policy_role_assignments_tx;
use crate::policy::validate::{
    normalize_policy_role_ids, normalize_system_roles, reject_new_ai_role_assignments_tx,
    validate_custom_policy_roles_tx,
};
use crate::policy::versions::{
    bump_policy_version_tx, bump_subject_version_tx, lock_policy_version_tx,
};
use crate::users::rows::fetch_user_branch_uuid_ids_tx;
use crate::{PgOrgError, PgOrgStore};
use console_identity_application::{
    PolicyRoleAssignmentSummary, ReplacePolicyRoleAssignmentsCommand,
    policy_role_assignment_audit_event,
};
use console_kernel_core::{KernelError, TraceContext, UserId};
use console_platform_db::{insert_audit_event, with_audit, with_org_conn};
use console_platform_request_context::current_org;
use sqlx::{Postgres, Row, Transaction};

impl PgOrgStore {
    /// List a user's custom-role assignments. ACTIVE assigned roles are
    /// resolved into runtime grants by console-platform-authz; DRAFT/RETIRED roles
    /// remain inert governance data.
    pub async fn list_policy_role_assignments(
        &self,
        user_id: UserId,
    ) -> Result<Vec<PolicyRoleAssignmentSummary>, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        with_org_conn::<_, _, PgOrgError>(&self.pool, org, move |tx| {
            Box::pin(async move { fetch_policy_role_assignments_tx(tx, user_id).await })
        })
        .await
    }

    /// Count assignments for one custom policy role. This is a read-only
    /// impact preview helper used to flag status changes that may alter
    /// runtime grants for already-assigned users.
    pub async fn count_policy_role_assignments(
        &self,
        role_id: uuid::Uuid,
    ) -> Result<i64, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        with_org_conn::<_, _, PgOrgError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                Ok(sqlx::query_scalar(
                    r#"
                    SELECT count(*)::bigint
                    FROM user_role_assignments
                    WHERE org_id = $1 AND role_id = $2
                    "#,
                )
                .bind(org_uuid)
                .bind(role_id)
                .fetch_one(tx.as_mut())
                .await?)
            })
        })
        .await
    }

    /// Replace a user's custom-role assignments atomically. This bumps
    /// policy_version for resolver/cache invalidation readiness while leaving
    /// `users.roles` system-role-only.
    pub async fn replace_policy_role_assignments(
        &self,
        command: ReplacePolicyRoleAssignmentsCommand,
    ) -> Result<Vec<PolicyRoleAssignmentSummary>, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        let user_id = command.user_id;
        let actor = command.actor;
        let occurred_at = command.occurred_at;
        let preview_receipt_id = command.preview_receipt_id;
        let role_ids = normalize_policy_role_ids(command.role_ids);

        let event = policy_role_assignment_audit_event(
            "policy.role_assignment.replace",
            Some(actor),
            user_id,
            command.trace,
            occurred_at,
        )?
        .with_org(org);

        with_audit::<_, Vec<PolicyRoleAssignmentSummary>, PgOrgError>(&self.pool, event, |tx| {
            Box::pin(async move {
                let row = sqlx::query("SELECT roles FROM users WHERE id = $1 FOR UPDATE")
                    .bind(*user_id.as_uuid())
                    .fetch_optional(tx.as_mut())
                    .await?;
                let Some(row) = row else {
                    return Err(PgOrgError::Domain(KernelError::not_found("user not found")));
                };
                let current_system_roles = normalize_system_roles(row.try_get("roles")?);

                let previous = fetch_policy_role_assignments_tx(tx, user_id).await?;
                let current_branch_ids = fetch_user_branch_uuid_ids_tx(tx, user_id).await?;
                let current_role_ids = normalize_policy_role_ids(
                    previous
                        .iter()
                        .map(|assignment| assignment.role_id)
                        .collect(),
                );
                let policy_version = lock_policy_version_tx(tx, org_uuid).await?;
                validate_custom_policy_roles_tx(tx, &role_ids).await?;
                reject_new_ai_role_assignments_tx(tx, &role_ids, &current_role_ids).await?;
                consume_policy_assignment_preview_receipt_tx(
                    tx,
                    AssignmentPreviewReceiptConsumption {
                        actor,
                        user_id,
                        current_branch_ids: &current_branch_ids,
                        current_system_roles: &current_system_roles,
                        current_role_ids: &current_role_ids,
                        branch_ids: &current_branch_ids,
                        system_roles: &current_system_roles,
                        role_ids: &role_ids,
                        policy_version,
                        receipt_id: preview_receipt_id,
                        occurred_at,
                        org_uuid,
                    },
                )
                .await?;

                sqlx::query(
                    "DELETE FROM user_role_assignments WHERE user_id = $1 AND NOT (role_id = ANY($2))",
                )
                    .bind(*user_id.as_uuid())
                    .bind(&role_ids)
                    .execute(tx.as_mut())
                    .await?;

                for role_id in &role_ids {
                    if current_role_ids.contains(role_id) {
                        continue;
                    }
                    sqlx::query(
                        r#"
                        INSERT INTO user_role_assignments (
                            org_id, user_id, role_id, assigned_by, created_at
                        ) VALUES ($1, $2, $3, $4, $5)
                        "#,
                    )
                    .bind(org_uuid)
                    .bind(*user_id.as_uuid())
                    .bind(role_id)
                    .bind(*actor.as_uuid())
                    .bind(occurred_at)
                    .execute(tx.as_mut())
                    .await?;
                }

                bump_policy_version_tx(tx, org_uuid, occurred_at).await?;
                // Custom-role assignments are authorization-relevant subject
                // material, so bump this subject's freshness version alongside the
                // per-org policy version.
                bump_subject_version_tx(tx, org_uuid, *user_id.as_uuid(), occurred_at).await?;
                let next = fetch_policy_role_assignments_tx(tx, user_id).await?;

                let snapshot_event = policy_role_assignment_audit_event(
                    "policy.role_assignment.replace.snapshot",
                    Some(actor),
                    user_id,
                    TraceContext::generate(),
                    occurred_at,
                )?
                .with_org(org)
                .with_snapshots(
                    Some(serde_json::json!({ "assignments": &previous })),
                    Some(serde_json::json!({ "assignments": &next })),
                );
                insert_audit_event(tx, &snapshot_event).await?;

                Ok(next)
            })
        })
        .await
    }
}

pub(crate) async fn consume_policy_assignment_preview_receipt_tx(
    tx: &mut Transaction<'_, Postgres>,
    expected: AssignmentPreviewReceiptConsumption<'_>,
) -> Result<(), PgOrgError> {
    let consumed: Option<uuid::Uuid> = sqlx::query_scalar(
        r#"
        UPDATE policy_assignment_preview_receipts
        SET consumed_at = $6
        WHERE id = $1
          AND org_id = $2
          AND actor_id = $3
          AND user_id = $4
          AND consumed_at IS NULL
          AND expires_at > $5
          AND role_ids = $7::uuid[]
          AND current_role_ids = $8::uuid[]
          AND current_branch_ids = $9::uuid[]
          AND current_system_roles = $10::text[]
          AND branch_ids = $11::uuid[]
          AND system_roles = $12::text[]
          AND policy_version = $13
        RETURNING id
        "#,
    )
    .bind(expected.receipt_id)
    .bind(expected.org_uuid)
    .bind(*expected.actor.as_uuid())
    .bind(*expected.user_id.as_uuid())
    .bind(expected.occurred_at)
    .bind(expected.occurred_at)
    .bind(expected.role_ids)
    .bind(expected.current_role_ids)
    .bind(expected.current_branch_ids)
    .bind(expected.current_system_roles)
    .bind(expected.branch_ids)
    .bind(expected.system_roles)
    .bind(expected.policy_version)
    .fetch_optional(tx.as_mut())
    .await?;
    if consumed.is_none() {
        return Err(stale_policy_assignment_preview_error());
    }
    Ok(())
}

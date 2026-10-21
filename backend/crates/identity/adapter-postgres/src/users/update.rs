use crate::policy::assignments::consume_policy_assignment_preview_receipt_tx;
use crate::policy::preview_receipt::{
    AssignmentPreviewReceiptConsumption, stale_policy_assignment_preview_error,
};
use crate::policy::rows::fetch_policy_role_assignments_tx;
use crate::policy::validate::{normalize_policy_role_ids, normalize_system_roles};
use crate::policy::versions::{bump_subject_version_tx, lock_policy_version_tx};
use crate::users::rows::{fetch_user_branch_uuid_ids_tx, fetch_user_tx};
use crate::users::scope::{replace_user_branches, resolve_actor_branch_scope_tx};
use crate::{PgOrgError, PgOrgStore};
use console_identity_application::{
    UpdateSelfProfileCommand, UpdateUserCommand, UserSummary, policy_account_audit_event,
    user_audit_event,
};
use console_identity_domain::{Team, normalize_optional_phone, validate_display_name};
use console_kernel_core::KernelError;
use console_platform_db::{insert_audit_event, with_audit};
use console_platform_request_context::current_org;
use sqlx::Row;

impl PgOrgStore {
    /// Partial update of a user's profile, roles, and/or memberships.
    pub async fn update_user(&self, command: UpdateUserCommand) -> Result<UserSummary, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        let actor = command.actor;
        let user_id = command.user_id;
        let trace = command.trace.clone();
        let occurred_at = command.occurred_at;
        let preview_receipt_id = command.preview_receipt_id;
        let display_name = command
            .display_name
            .as_deref()
            .map(validate_display_name)
            .transpose()?;
        let employee_id = command.employee_id;
        let phone = match &command.phone {
            None => None,
            Some(value) => Some(normalize_optional_phone(value.as_deref())?),
        };
        let team_db: Option<Option<&'static str>> = command
            .team
            .as_ref()
            .map(|inner| inner.map(Team::as_db_str));
        let roles = command.roles.clone();
        let branch_ids: Option<Vec<uuid::Uuid>> = command
            .branch_ids
            .as_ref()
            .map(|ids| ids.iter().map(|b| *b.as_uuid()).collect());

        let event = user_audit_event(
            "user.update",
            Some(actor),
            user_id,
            trace.clone(),
            occurred_at,
        )?
        .with_org(org);

        with_audit::<_, UserSummary, PgOrgError>(&self.pool, event, |tx| {
            Box::pin(async move {
                // Ensure the target exists (and lock it) before mutating. Locking
                // the row also freezes the mutable authorization baseline checked
                // by the preview receipt below.
                let row = sqlx::query("SELECT roles FROM users WHERE id = $1 FOR UPDATE")
                    .bind(*user_id.as_uuid())
                    .fetch_optional(tx.as_mut())
                    .await?;
                let Some(row) = row else {
                    return Err(PgOrgError::Domain(KernelError::not_found("user not found")));
                };
                let before = fetch_user_tx(tx, user_id).await?;
                let current_system_roles = normalize_system_roles(row.try_get("roles")?);
                let current_branch_ids = fetch_user_branch_uuid_ids_tx(tx, user_id).await?;
                let previous_assignments = fetch_policy_role_assignments_tx(tx, user_id).await?;
                let current_role_ids = normalize_policy_role_ids(
                    previous_assignments
                        .iter()
                        .map(|assignment| assignment.role_id)
                        .collect(),
                );

                // Delta-scope the receipt gate against the FOR UPDATE-locked row
                // (order-insensitive set-equality via normalize_*). Re-sending the
                // current roles/branches is a no-op and must not demand a receipt;
                // any real change — including one a concurrent writer made after the
                // client read — differs from the locked current set and still gates.
                let roles_changed = roles
                    .as_ref()
                    .is_some_and(|r| normalize_system_roles(r.clone()) != current_system_roles);
                let branches_changed = branch_ids.as_ref().is_some_and(|b| {
                    normalize_policy_role_ids(b.clone())
                        != normalize_policy_role_ids(current_branch_ids.clone())
                });
                let assignment_changed = roles_changed || branches_changed;

                if assignment_changed {
                    let preview_receipt_id =
                        preview_receipt_id.ok_or_else(stale_policy_assignment_preview_error)?;
                    let requested_system_roles = roles
                        .as_ref()
                        .map(|roles| normalize_system_roles(roles.clone()))
                        .unwrap_or_else(|| current_system_roles.clone());
                    let requested_branch_ids = branch_ids
                        .clone()
                        .map(normalize_policy_role_ids)
                        .unwrap_or_else(|| current_branch_ids.clone());
                    let policy_version = lock_policy_version_tx(tx, org_uuid).await?;
                    consume_policy_assignment_preview_receipt_tx(
                        tx,
                        AssignmentPreviewReceiptConsumption {
                            actor,
                            user_id,
                            current_branch_ids: &current_branch_ids,
                            current_system_roles: &current_system_roles,
                            current_role_ids: &current_role_ids,
                            branch_ids: &requested_branch_ids,
                            system_roles: &requested_system_roles,
                            role_ids: &current_role_ids,
                            policy_version,
                            receipt_id: preview_receipt_id,
                            occurred_at,
                            org_uuid,
                        },
                    )
                    .await?;
                }

                if let Some(display_name) = &display_name {
                    sqlx::query("UPDATE users SET display_name = $2 WHERE id = $1")
                        .bind(*user_id.as_uuid())
                        .bind(display_name)
                        .execute(tx.as_mut())
                        .await?;
                }
                if let Some(employee_id) = employee_id {
                    sqlx::query("UPDATE users SET employee_id = $2 WHERE id = $1")
                        .bind(*user_id.as_uuid())
                        .bind(employee_id)
                        .execute(tx.as_mut())
                        .await?;
                }
                if let Some(phone) = &phone {
                    sqlx::query("UPDATE users SET phone = $2 WHERE id = $1")
                        .bind(*user_id.as_uuid())
                        .bind(phone.as_deref())
                        .execute(tx.as_mut())
                        .await?;
                }
                if let Some(team_db) = team_db {
                    sqlx::query("UPDATE users SET team = $2 WHERE id = $1")
                        .bind(*user_id.as_uuid())
                        .bind(team_db)
                        .execute(tx.as_mut())
                        .await?;
                }
                if let Some(roles) = roles.as_ref().filter(|_| roles_changed) {
                    sqlx::query("UPDATE users SET roles = $2 WHERE id = $1")
                        .bind(*user_id.as_uuid())
                        .bind(roles)
                        .execute(tx.as_mut())
                        .await?;
                }
                if let Some(branch_ids) = branch_ids.as_ref().filter(|_| branches_changed) {
                    let actor_scope = resolve_actor_branch_scope_tx(tx, actor).await?;
                    replace_user_branches(tx, user_id, branch_ids, org_uuid, &actor_scope).await?;
                }
                if assignment_changed {
                    // System roles and branch memberships are authorization-relevant
                    // subject material; bump freshness once after a successful
                    // receipt-gated replacement (covers role AND/OR branch changes).
                    bump_subject_version_tx(tx, org_uuid, *user_id.as_uuid(), occurred_at).await?;
                }

                let after = fetch_user_tx(tx, user_id).await?;
                let policy_event = policy_account_audit_event(
                    "policy.account.update.snapshot",
                    Some(actor),
                    user_id,
                    trace,
                    occurred_at,
                )?
                .with_org(org)
                .with_snapshots(
                    Some(serde_json::json!({ "user": before })),
                    Some(serde_json::json!({ "user": &after })),
                );
                insert_audit_event(tx, &policy_event).await?;
                Ok(after)
            })
        })
        .await
    }

    /// Self-service profile edit (display name and/or phone only).
    pub async fn update_self_profile(
        &self,
        command: UpdateSelfProfileCommand,
    ) -> Result<UserSummary, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let display_name = command
            .display_name
            .as_deref()
            .map(validate_display_name)
            .transpose()?;
        let phone = match &command.phone {
            None => None,
            Some(value) => Some(normalize_optional_phone(value.as_deref())?),
        };
        let user_id = command.user_id;

        // Org-bind the audit row so it is tenant-attributable and the FORCE-RLS
        // `audit_events` write is armed via the same `with_audit` GUC.
        let event = user_audit_event(
            "user.update_self",
            Some(user_id),
            user_id,
            command.trace.clone(),
            command.occurred_at,
        )?
        .with_org(org);

        with_audit::<_, UserSummary, PgOrgError>(&self.pool, event, |tx| {
            Box::pin(async move {
                let exists: Option<uuid::Uuid> =
                    sqlx::query_scalar("SELECT id FROM users WHERE id = $1 FOR UPDATE")
                        .bind(*user_id.as_uuid())
                        .fetch_optional(tx.as_mut())
                        .await?;
                if exists.is_none() {
                    return Err(PgOrgError::Domain(KernelError::not_found("user not found")));
                }
                if let Some(display_name) = &display_name {
                    sqlx::query("UPDATE users SET display_name = $2 WHERE id = $1")
                        .bind(*user_id.as_uuid())
                        .bind(display_name)
                        .execute(tx.as_mut())
                        .await?;
                }
                if let Some(phone) = &phone {
                    sqlx::query("UPDATE users SET phone = $2 WHERE id = $1")
                        .bind(*user_id.as_uuid())
                        .bind(phone.as_deref())
                        .execute(tx.as_mut())
                        .await?;
                }
                fetch_user_tx(tx, user_id).await
            })
        })
        .await
    }
}

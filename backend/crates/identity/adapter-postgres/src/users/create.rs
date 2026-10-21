use crate::users::rows::fetch_user_tx;
use crate::users::scope::{replace_user_branches, resolve_actor_branch_scope_tx};
use crate::users::sign_in_id::{assign_default_login_tx, insert_invite_login_tx};
use crate::{IdempotentCreate, PgOrgError, PgOrgStore};
use console_identity_application::{CreateUserCommand, user_audit_event};
use console_identity_domain::{Team, normalize_optional_phone, validate_display_name};
use console_kernel_core::{KernelError, UserId};
use console_platform_db::{DbError, idempotency, with_audits};
use console_platform_request_context::current_org;

impl PgOrgStore {
    /// Create a user with role assignments and branch memberships. Roles are
    /// already validated against the authz matrix at the REST boundary; the DB
    /// CHECK constraint is the final backstop.
    ///
    /// Guarded by an `Idempotency-Key` reservation claimed and completed in the
    /// SAME transaction as the user insert: a crash can never commit the user
    /// without its stored response (or vice versa), so a retry either replays
    /// the committed user or creates it exactly once. A concurrent same-key
    /// request waits on the reservation row and then replays.
    pub async fn create_user(
        &self,
        command: CreateUserCommand,
        idempotency_key: String,
        request: serde_json::Value,
    ) -> Result<IdempotentCreate, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        let display_name = validate_display_name(&command.display_name)?;
        let phone = normalize_optional_phone(command.phone.as_deref())?;
        let team_db = command.team.map(Team::as_db_str);
        let employee_id = command.employee_id;
        let sign_in_id = command.sign_in_id.clone();
        let user_id = UserId::new();
        let branch_ids: Vec<uuid::Uuid> = command.branch_ids.iter().map(|b| *b.as_uuid()).collect();

        let event = user_audit_event(
            "user.create",
            Some(command.actor),
            user_id,
            command.trace.clone(),
            command.occurred_at,
        )?
        .with_snapshots(
            None,
            Some(serde_json::json!({
                "display_name": display_name,
                "employee_id": employee_id,
                "roles": command.roles,
                "team": team_db,
                "branch_ids": command.branch_ids.iter().map(ToString::to_string).collect::<Vec<_>>(),
                "is_active": true,
            })),
        )
        .with_org(org);

        let roles = command.roles.clone();
        let actor = command.actor;
        with_audits::<_, IdempotentCreate, PgOrgError>(&self.pool, org, |tx| {
            Box::pin(async move {
                const OPERATION: &str = "users.create";
                match idempotency::claim_idempotency_key(tx, OPERATION, &idempotency_key, &request)
                    .await?
                {
                    idempotency::IdempotencyClaim::Replay(response) => {
                        return Ok((IdempotentCreate::Replay(response), vec![]));
                    }
                    idempotency::IdempotencyClaim::Mismatch => {
                        return Err(KernelError::conflict(idempotency::IDEMPOTENCY_KEY_REUSED).into());
                    }
                    idempotency::IdempotencyClaim::Fresh => {}
                }
                sqlx::query(
                    r#"
                    INSERT INTO users (id, display_name, employee_id, phone, roles, team, is_active, created_at, org_id)
                    VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8)
                    "#,
                )
                .bind(*user_id.as_uuid())
                .bind(&display_name)
                .bind(employee_id)
                .bind(phone.as_deref())
                .bind(&roles)
                .bind(team_db)
                .bind(command.occurred_at)
                .bind(org_uuid)
                .execute(tx.as_mut())
                .await?;

                match &sign_in_id {
                    Some(login) => {
                        insert_invite_login_tx(tx, org_uuid, *user_id.as_uuid(), login, *actor.as_uuid())
                            .await?;
                    }
                    None => assign_default_login_tx(tx, org_uuid, *user_id.as_uuid()).await?,
                }
                let actor_scope = resolve_actor_branch_scope_tx(tx, actor).await?;
                replace_user_branches(tx, user_id, &branch_ids, org_uuid, &actor_scope).await?;
                let summary = fetch_user_tx(tx, user_id).await?;
                let response = serde_json::to_value(&summary).map_err(DbError::Serialize)?;
                idempotency::complete_idempotency_key(tx, OPERATION, &idempotency_key, &response)
                    .await?;
                Ok((IdempotentCreate::Created(response), vec![event]))
            })
        })
        .await
    }
}

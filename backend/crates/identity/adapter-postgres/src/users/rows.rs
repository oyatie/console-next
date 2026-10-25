use crate::PgOrgError;
use crate::policy::validate::normalize_policy_role_ids;
use console_identity_application::{EmployeeLinkStatus, UserSummary, account_status_for};
use console_identity_domain::Team;
use console_kernel_core::{BranchId, KernelError, UserId};
use console_platform_db::with_org_conn;
use console_platform_request_context::current_org;
use sqlx::{PgPool, Postgres, Row, Transaction};

/// The `users` projection for `get_user` / `list_users` and mutation returns.
/// The `has_passkey` flag is computed inline via an EXISTS over the FORCE-RLS
/// `auth_webauthn_credentials` table; those call sites run inside an org-armed
/// scope (`with_org_conn` or the audited tx), so the subquery only ever sees
/// THIS tenant's credentials and the account-setup state (활성 vs 설정 대기) is
/// derived correctly. Directory list uses `USER_SELECT_DIRECTORY` instead so it
/// never reads `users.phone`.
pub(crate) const USER_SELECT_WITH_PASSKEY: &str = r#"
    SELECT
           u.id, u.person_id, u.principal_kind,
           u.display_name,
           u.employee_id,
           COALESCE(console_employee_facts(e.org_id,e.id)->>'legal_name',e.name) AS employee_name,
           e.employee_number AS employee_number,
           e.company AS employee_company,
           e.org_unit AS employee_org_unit,
           e.position AS employee_position,
           e.identity_review_required AS employee_identity_review_required,
           e.identity_resolution_confidence AS employee_identity_resolution_confidence,
           account.phone,
           u.roles,
           u.team,
           u.is_active,
           u.is_tenant_ops,
           u.created_at,
           EXISTS (
               SELECT 1 FROM auth_webauthn_credentials c WHERE c.user_id = u.id
           ) AS has_passkey
           , (SELECT s.login || '@' || o.slug FROM user_sign_in_ids s
                JOIN organizations o ON o.id = s.org_id
               WHERE s.org_id = u.org_id AND s.user_id = u.id AND s.retired_at IS NULL
             ) AS sign_in_id
    FROM person_accounts_current u
    JOIN users account ON account.org_id = u.org_id AND account.id = u.id
    LEFT JOIN employees e
      ON e.id = u.employee_id
     AND e.org_id = u.org_id
    WHERE u.id = $1
"#;

/// Directory page projection. Keep the column list aligned with
/// `USER_SELECT_WITH_PASSKEY` except `users.phone`, which must not be selected
/// into a directory page. The SELECT text must not mention phone, salary, bank,
/// or rrn. `user_from_directory_row` maps `phone: None` without reading a phone
/// column.
pub(crate) const USER_SELECT_DIRECTORY: &str = r#"
    SELECT
           u.id, u.person_id, u.principal_kind,
           u.display_name,
           u.employee_id,
           COALESCE(console_employee_facts(e.org_id,e.id)->>'legal_name',e.name) AS employee_name,
           e.employee_number AS employee_number,
           e.company AS employee_company,
           e.org_unit AS employee_org_unit,
           e.position AS employee_position,
           e.identity_review_required AS employee_identity_review_required,
           e.identity_resolution_confidence AS employee_identity_resolution_confidence,
           u.roles,
           u.team,
           u.is_active,
           u.is_tenant_ops,
           u.created_at,
           EXISTS (
               SELECT 1 FROM auth_webauthn_credentials c WHERE c.user_id = u.id
           ) AS has_passkey
           , (SELECT s.login || '@' || o.slug FROM user_sign_in_ids s
                JOIN organizations o ON o.id = s.org_id
               WHERE s.org_id = u.org_id AND s.user_id = u.id AND s.retired_at IS NULL
             ) AS sign_in_id
    FROM person_accounts_current u
    LEFT JOIN employees e
      ON e.id = u.employee_id
     AND e.org_id = u.org_id
    WHERE u.id = $1
"#;

pub(crate) async fn fetch_user(pool: &PgPool, user_id: UserId) -> Result<UserSummary, PgOrgError> {
    let org = current_org().map_err(KernelError::from)?;
    let row = with_org_conn::<_, _, PgOrgError>(pool, org, move |tx| {
        Box::pin(async move {
            Ok(sqlx::query(USER_SELECT_WITH_PASSKEY)
                .bind(*user_id.as_uuid())
                .fetch_one(tx.as_mut())
                .await?)
        })
    })
    .await?;
    let branch_ids = fetch_user_branch_ids(pool, user_id).await?;
    user_from_row(&row, branch_ids)
}

pub(crate) async fn fetch_directory_user(
    pool: &PgPool,
    user_id: UserId,
) -> Result<UserSummary, PgOrgError> {
    let org = current_org().map_err(KernelError::from)?;
    let row = with_org_conn::<_, _, PgOrgError>(pool, org, move |tx| {
        Box::pin(async move {
            Ok(sqlx::query(USER_SELECT_DIRECTORY)
                .bind(*user_id.as_uuid())
                .fetch_one(tx.as_mut())
                .await?)
        })
    })
    .await?;
    let branch_ids = fetch_user_branch_ids(pool, user_id).await?;
    user_from_directory_row(&row, branch_ids)
}

pub(crate) async fn fetch_user_tx(
    tx: &mut Transaction<'_, Postgres>,
    user_id: UserId,
) -> Result<UserSummary, PgOrgError> {
    let row = sqlx::query(USER_SELECT_WITH_PASSKEY)
        .bind(*user_id.as_uuid())
        .fetch_one(tx.as_mut())
        .await?;
    let branch_rows: Vec<uuid::Uuid> = sqlx::query_scalar(
        "SELECT branch_id FROM user_branches WHERE user_id = $1 ORDER BY branch_id",
    )
    .bind(*user_id.as_uuid())
    .fetch_all(tx.as_mut())
    .await?;
    let branch_ids = branch_rows.into_iter().map(BranchId::from_uuid).collect();
    user_from_row(&row, branch_ids)
}

pub(crate) async fn fetch_user_branch_uuid_ids_tx(
    tx: &mut Transaction<'_, Postgres>,
    user_id: UserId,
) -> Result<Vec<uuid::Uuid>, PgOrgError> {
    let branch_ids: Vec<uuid::Uuid> = sqlx::query_scalar(
        "SELECT branch_id FROM user_branches WHERE user_id = $1 ORDER BY branch_id",
    )
    .bind(*user_id.as_uuid())
    .fetch_all(tx.as_mut())
    .await?;
    Ok(normalize_policy_role_ids(branch_ids))
}

async fn fetch_user_branch_ids(
    pool: &PgPool,
    user_id: UserId,
) -> Result<Vec<BranchId>, PgOrgError> {
    let org = current_org().map_err(KernelError::from)?;
    let rows: Vec<uuid::Uuid> = with_org_conn::<_, _, PgOrgError>(pool, org, move |tx| {
        Box::pin(async move {
            Ok(sqlx::query_scalar(
                "SELECT branch_id FROM user_branches WHERE user_id = $1 ORDER BY branch_id",
            )
            .bind(*user_id.as_uuid())
            .fetch_all(tx.as_mut())
            .await?)
        })
    })
    .await?;
    Ok(rows.into_iter().map(BranchId::from_uuid).collect())
}

fn user_from_row(
    row: &sqlx::postgres::PgRow,
    branch_ids: Vec<BranchId>,
) -> Result<UserSummary, PgOrgError> {
    user_from_row_with_phone(row, branch_ids, row.try_get("phone")?)
}

fn user_from_directory_row(
    row: &sqlx::postgres::PgRow,
    branch_ids: Vec<BranchId>,
) -> Result<UserSummary, PgOrgError> {
    user_from_row_with_phone(row, branch_ids, None)
}

fn user_from_row_with_phone(
    row: &sqlx::postgres::PgRow,
    branch_ids: Vec<BranchId>,
    phone: Option<String>,
) -> Result<UserSummary, PgOrgError> {
    let team: Option<String> = row.try_get("team")?;
    let team = team.as_deref().map(Team::from_db_str).transpose()?;
    let is_active: bool = row.try_get("is_active")?;
    let has_passkey: bool = row.try_get("has_passkey")?;
    let employee_id: Option<uuid::Uuid> = row.try_get("employee_id")?;
    let display_name = row
        .try_get::<Option<String>, _>("display_name")?
        .unwrap_or_default();
    Ok(UserSummary {
        id: UserId::from_uuid(row.try_get("id")?),
        person_id: row.try_get("person_id")?,
        principal_kind: row.try_get("principal_kind")?,
        name_unset: display_name.trim().is_empty().then_some(true),
        display_name,
        sign_in_id: row.try_get("sign_in_id")?,
        employee_id,
        employee_name: row.try_get("employee_name")?,
        employee_number: row.try_get("employee_number")?,
        employee_company: row.try_get("employee_company")?,
        employee_org_unit: row.try_get("employee_org_unit")?,
        employee_position: row.try_get("employee_position")?,
        employee_identity_review_required: row.try_get("employee_identity_review_required")?,
        employee_identity_resolution_confidence: row
            .try_get("employee_identity_resolution_confidence")?,
        employee_link_status: if employee_id.is_some() {
            EmployeeLinkStatus::Linked
        } else {
            EmployeeLinkStatus::Unlinked
        },
        phone,
        team,
        roles: row.try_get("roles")?,
        branch_ids,
        is_active,
        is_tenant_ops: row.try_get("is_tenant_ops")?,
        has_passkey,
        account_status: account_status_for(is_active, has_passkey),
        created_at: row.try_get("created_at")?,
    })
}

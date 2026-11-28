// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

pub(super) async fn seed_branch(
    pool: &PgPool,
    region_name: &str,
    branch_name: &str,
) -> Result<BranchId, sqlx::Error> {
    let region_id: uuid::Uuid =
        sqlx::query_scalar("INSERT INTO regions (name, org_id) VALUES ($1, $2) RETURNING id")
            .bind(region_name)
            .bind(*OrgId::one().as_uuid())
            .fetch_one(pool)
            .await?;
    let branch_id: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO branches (region_id, name, org_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(region_id)
    .bind(branch_name)
    .bind(*OrgId::one().as_uuid())
    .fetch_one(pool)
    .await?;
    Ok(BranchId::from_uuid(branch_id))
}

pub(super) async fn seed_user_with_branch(
    pool: &PgPool,
    user_id: UserId,
    role: &str,
    branch_id: BranchId,
) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, $2, $3, $4)")
        .bind(*user_id.as_uuid())
        .bind(format!("Console User {role}"))
        .bind(Vec::from([role]))
        .bind(*OrgId::one().as_uuid())
        .execute(pool)
        .await?;
    sqlx::query("INSERT INTO user_branches (user_id, branch_id, org_id) VALUES ($1, $2, $3)")
        .bind(*user_id.as_uuid())
        .bind(*branch_id.as_uuid())
        .bind(*OrgId::one().as_uuid())
        .execute(pool)
        .await?;
    Ok(())
}

pub(super) async fn seed_org_runtime_flag(
    pool: &PgPool,
    flag_key: &str,
    enabled: bool,
    actor: UserId,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO org_runtime_flags (org_id, flag_key, enabled, rollout_note, set_by)
        VALUES ($1, $2, $3, 'test rollout enabled', $4)
        "#,
    )
    .bind(*OrgId::one().as_uuid())
    .bind(flag_key)
    .bind(enabled)
    .bind(*actor.as_uuid())
    .execute(pool)
    .await?;
    Ok(())
}

pub(super) async fn seed_user_console_opt_in(
    pool: &PgPool,
    user_id: UserId,
    opt_in: bool,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO user_feature_preferences (
            org_id, user_id, feature_key, preferences_json, schema_version
        ) VALUES ($1, $2, 'console_rollout', $3, 1)
        "#,
    )
    .bind(*OrgId::one().as_uuid())
    .bind(*user_id.as_uuid())
    .bind(json!({ "opt_in": opt_in }))
    .execute(pool)
    .await?;
    Ok(())
}

// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

pub(super) async fn seed_branch_admin(pool: &PgPool, org: OrgId, branch: BranchId, user: UserId) {
    sqlx::query(
        "INSERT INTO users (id, display_name, roles, org_id) \
         VALUES ($1, 'Leave branch admin', ARRAY['ADMIN'], $2)",
    )
    .bind(*user.as_uuid())
    .bind(*org.as_uuid())
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO user_branches (user_id, branch_id, org_id) VALUES ($1, $2, $3)")
        .bind(*user.as_uuid())
        .bind(*branch.as_uuid())
        .bind(*org.as_uuid())
        .execute(pool)
        .await
        .unwrap();
}

pub(super) async fn seed_subject(
    pool: &PgPool,
    org: OrgId,
    branch: BranchId,
    user: UserId,
    employee: Uuid,
) {
    let region = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3)")
        .bind(*org.as_uuid())
        .bind(format!(
            "leave-http-{}",
            &org.as_uuid().simple().to_string()[..12]
        ))
        .bind("Leave HTTP proof")
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO regions (id, name, org_id) VALUES ($1, $2, $3)")
        .bind(region)
        .bind(format!("Leave HTTP region {region}"))
        .bind(*org.as_uuid())
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO branches (id, region_id, name, org_id) VALUES ($1, $2, $3, $4)")
        .bind(*branch.as_uuid())
        .bind(region)
        .bind("Leave HTTP branch")
        .bind(*org.as_uuid())
        .execute(pool)
        .await
        .unwrap();
    let definer_pool = leave_definer_role_pool(pool).await;
    sqlx::query("SELECT set_config('app.current_org', $1, false)")
        .bind(org.as_uuid().to_string())
        .execute(&definer_pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO employees (id, org_id, company, name, source_filename, source_sheet, \
         source_row, source_key, leave_accrued, leave_used, leave_remaining, home_branch_id) \
         VALUES ($1, $2, 'OYATIE', 'Member employee', 'test.xlsx', 'employees', 1, $3, 15, 2, 13, $4)",
    )
    .bind(employee)
    .bind(*org.as_uuid())
    .bind(format!("leave-http-{employee}"))
    .bind(*branch.as_uuid())
    .execute(&definer_pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO users (id, display_name, roles, org_id, employee_id) \
         VALUES ($1, 'Leave member', ARRAY['MEMBER'], $2, $3)",
    )
    .bind(*user.as_uuid())
    .bind(*org.as_uuid())
    .bind(employee)
    .execute(pool)
    .await
    .unwrap();
    person_fixtures::bind_user_to_distinct_person(pool, user).await;
    sqlx::query("INSERT INTO user_branches (user_id, branch_id, org_id) VALUES ($1, $2, $3)")
        .bind(*user.as_uuid())
        .bind(*branch.as_uuid())
        .bind(*org.as_uuid())
        .execute(pool)
        .await
        .unwrap();
}

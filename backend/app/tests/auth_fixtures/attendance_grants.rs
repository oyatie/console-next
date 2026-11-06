// SPDX-License-Identifier: LicenseRef-Proprietary
use console_kernel_core::{OrgId, UserId};
use sqlx::PgPool;
use uuid::Uuid;

pub async fn grant(pool: &PgPool, org: OrgId, actor: UserId, workplace: Option<Uuid>) -> Uuid {
    let maker = console_platform_test_support::seed_active_user(
        pool,
        *org.as_uuid(),
        "SUPER_ADMIN",
        &format!("attendance-grantor-{}", Uuid::new_v4()),
    )
    .await;
    let role = Uuid::new_v4();
    let name = format!("근태 편집 {role}");
    sqlx::query("INSERT INTO access_roles (org_id,id,name_ko,status,version,created_by) VALUES ($1,$2,$4,'ACTIVE',1,$3)")
        .bind(org.as_uuid()).bind(role).bind(maker.as_uuid()).bind(&name).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO access_role_versions (org_id,role_id,version,name_ko,status,change_mode,created_by) VALUES ($1,$2,1,$4,'ACTIVE','SETUP',$3)")
        .bind(org.as_uuid()).bind(role).bind(maker.as_uuid()).bind(&name).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO access_role_lines (org_id,role_id,version,domain,levels) VALUES ($1,$2,1,'attendance',ARRAY['edit'])")
        .bind(org.as_uuid()).bind(role).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO access_grants (org_id,account_id,role_id,scope_kind,workplace_id,valid_from,effective_in_setup,change_mode,reason_code,granted_by) VALUES ($1,$2,$3,$4,$5,now()-interval '1 day',true,'SETUP','TEST',$6)")
        .bind(org.as_uuid()).bind(actor.as_uuid()).bind(role)
        .bind(if workplace.is_some() { "WORKPLACE" } else { "TENANT" }).bind(workplace).bind(maker.as_uuid())
        .execute(pool).await.unwrap();
    role
}

// SPDX-License-Identifier: LicenseRef-Proprietary
use console_kernel_core::UserId;
use sqlx::PgPool;
use uuid::Uuid;

/// A real tenant-wide org approval grant; legacy EXECUTIVE alone is insufficient.
pub async fn grant_org_approve(pool: &PgPool, user: UserId) {
    let grantor: Option<(Uuid, Uuid)> = sqlx::query_as(
        "SELECT u.org_id, g.id FROM users u JOIN users g ON g.org_id=u.org_id AND g.id<>u.id WHERE u.id=$1 LIMIT 1",
    ).bind(user.as_uuid()).fetch_optional(pool).await.unwrap();
    let Some((org, grantor)) = grantor else {
        return;
    };
    let role = Uuid::new_v4();
    let name = format!("조직 결재 {role}");
    sqlx::query("INSERT INTO access_roles(org_id,id,name_ko,status,version,created_by) VALUES($1,$2,$3,'ACTIVE',1,$4)")
        .bind(org).bind(role).bind(&name).bind(grantor).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO access_role_versions(org_id,role_id,version,name_ko,status,change_mode,created_by) VALUES($1,$2,1,$3,'ACTIVE','SETUP',$4)")
        .bind(org).bind(role).bind(&name).bind(grantor).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO access_role_lines(org_id,role_id,version,domain,levels) VALUES($1,$2,1,'org',ARRAY['view','approve'])")
        .bind(org).bind(role).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO access_grants(org_id,account_id,role_id,scope_kind,valid_from,effective_in_setup,change_mode,reason_code,granted_by) VALUES($1,$2,$3,'TENANT',now()-interval '1 day',true,'SETUP','TEST',$4)")
        .bind(org).bind(user.as_uuid()).bind(role).bind(grantor).execute(pool).await.unwrap();
}

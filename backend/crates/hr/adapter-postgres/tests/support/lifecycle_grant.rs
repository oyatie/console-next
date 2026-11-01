// SPDX-License-Identifier: LicenseRef-Proprietary
//! A live appointment grant for lifecycle command fixtures, without changing their ops/SoD identity.
use sqlx::PgPool;
use uuid::Uuid;

pub async fn grant(pool: &PgPool, org: Uuid, actor: Uuid) {
    let role = Uuid::new_v4();
    let maker = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO users(id,org_id,display_name,roles) VALUES ($1,$2,'grant maker','{}')",
    )
    .bind(maker)
    .bind(org)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO access_roles(org_id,id,name_ko,status,version,created_by) VALUES ($1,$2,'인사','ACTIVE',1,$3)")
        .bind(org).bind(role).bind(actor).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO access_role_versions(org_id,role_id,version,name_ko,status,change_mode,created_by) VALUES ($1,$2,1,'인사','ACTIVE','SETUP',$3)")
        .bind(org).bind(role).bind(actor).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO access_role_lines(org_id,role_id,version,domain,levels) VALUES ($1,$2,1,'appointment',ARRAY['edit'])")
        .bind(org).bind(role).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO access_grants(org_id,account_id,role_id,scope_kind,valid_from,effective_in_setup,change_mode,reason_code,granted_by) VALUES ($1,$2,$3,'TENANT',now()-interval '1 day',true,'SETUP','TEST',$4)")
        .bind(org).bind(actor).bind(role).bind(maker).execute(pool).await.unwrap();
}

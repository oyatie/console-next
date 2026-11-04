// SPDX-License-Identifier: LicenseRef-Proprietary
//! A live appointment grant for lifecycle command fixtures, without changing their ops/SoD identity.
use sqlx::PgPool;
use uuid::Uuid;

pub async fn grant(pool: &PgPool, org: Uuid, actor: Uuid) {
    grant_for(pool, org, actor, "appointment", &["edit"]).await;
}

#[allow(dead_code)]
pub async fn grant_hr_basic(pool: &PgPool, org: Uuid, actor: Uuid, levels: &[&str]) {
    grant_domain(pool, org, actor, "hr_basic", levels).await;
}

#[allow(dead_code)]
pub async fn grant_domain(pool: &PgPool, org: Uuid, actor: Uuid, domain: &str, levels: &[&str]) {
    grant_for(pool, org, actor, domain, levels).await;
}

async fn grant_for(pool: &PgPool, org: Uuid, actor: Uuid, domain: &str, levels: &[&str]) {
    let role = Uuid::new_v4();
    let name = format!("인사 {role}");
    let maker = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO users(id,org_id,display_name,roles) VALUES ($1,$2,'grant maker','{}')",
    )
    .bind(maker)
    .bind(org)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO access_roles(org_id,id,name_ko,status,version,created_by) VALUES ($1,$2,$4,'ACTIVE',1,$3)")
        .bind(org).bind(role).bind(actor).bind(&name).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO access_role_versions(org_id,role_id,version,name_ko,status,change_mode,created_by) VALUES ($1,$2,1,$4,'ACTIVE','SETUP',$3)")
        .bind(org).bind(role).bind(actor).bind(&name).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO access_role_lines(org_id,role_id,version,domain,levels) VALUES ($1,$2,1,$3,$4)")
        .bind(org).bind(role).bind(domain).bind(levels).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO access_grants(org_id,account_id,role_id,scope_kind,valid_from,effective_in_setup,change_mode,reason_code,granted_by) VALUES ($1,$2,$3,'TENANT',now()-interval '1 day',true,'SETUP','TEST',$4)")
        .bind(org).bind(actor).bind(role).bind(maker).execute(pool).await.unwrap();
}

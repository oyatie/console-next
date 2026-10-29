// SPDX-License-Identifier: LicenseRef-Proprietary
use console_kernel_core::{OrgId, UserId};
use sqlx::PgPool;
use uuid::Uuid;

#[allow(dead_code)] // Shared fixture: some test binaries exercise commands only.
pub(crate) async fn grant_view(
    pool: &PgPool,
    org: OrgId,
    actor: UserId,
    entity: Option<Uuid>,
) -> Uuid {
    grant_level(pool, org, actor, entity, "view").await
}

#[allow(dead_code)] // Shared fixture: some test binaries exercise reads only.
pub(crate) async fn grant_manage(
    pool: &PgPool,
    org: OrgId,
    actor: UserId,
    entity: Option<Uuid>,
) -> Uuid {
    grant_level(pool, org, actor, entity, "edit").await
}

async fn grant_level(
    pool: &PgPool,
    org: OrgId,
    actor: UserId,
    entity: Option<Uuid>,
    level: &str,
) -> Uuid {
    let role = Uuid::new_v4();
    let name = format!("급여 조회 {role}");
    let maker = console_platform_test_support::seed_active_user(
        pool,
        *org.as_uuid(),
        "SUPER_ADMIN",
        "pay-view-maker",
    )
    .await;
    // rls-arming: ok owner creates access fixtures before requests use console_rt.
    sqlx::query("INSERT INTO access_roles (org_id,id,name_ko,status,version,created_by) VALUES ($1,$2,$4,'ACTIVE',1,$3)")
        .bind(org.as_uuid()).bind(role).bind(actor.as_uuid()).bind(&name).execute(pool).await.unwrap();
    // rls-arming: ok owner seeds immutable role history for the access fixture.
    sqlx::query("INSERT INTO access_role_versions (org_id,role_id,version,name_ko,status,change_mode,created_by) VALUES ($1,$2,1,$4,'ACTIVE','SETUP',$3)")
        .bind(org.as_uuid()).bind(role).bind(actor.as_uuid()).bind(&name).execute(pool).await.unwrap();
    // rls-arming: ok owner seeds the explicit pay:view line, without legacy permissions.
    sqlx::query("INSERT INTO access_role_lines (org_id,role_id,version,domain,levels) VALUES ($1,$2,1,'pay',$3::text[])")
        .bind(org.as_uuid()).bind(role).bind(if level == "edit" { vec!["view", "edit"] } else { vec!["view"] }).execute(pool).await.unwrap();
    // rls-arming: ok owner creates the explicit effective tenant grant for this fixture.
    sqlx::query_scalar("INSERT INTO access_grants (org_id,account_id,role_id,scope_kind,legal_entity_id,valid_from,effective_in_setup,change_mode,reason_code,granted_by) VALUES ($1,$2,$3,$4,$5,now()-interval '1 day',true,'SETUP','TEST',$6) RETURNING id")
        .bind(org.as_uuid()).bind(actor.as_uuid()).bind(role)
        .bind(if entity.is_some() { "LEGAL_ENTITY" } else { "TENANT" }).bind(entity)
        .bind(maker.as_uuid()).fetch_one(pool).await.unwrap()
}

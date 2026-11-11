// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use console_kernel_core::UserId;
mod access_log;
mod clock;

pub async fn hr_handler(pool: &PgPool, org: OrgId, subject: UserId) -> (UserId, Uuid) {
    let handler = seed_user(pool, *org.as_uuid(), "MEMBER").await;
    let grant = seed_role_and_grant(pool, *org.as_uuid(), subject, handler, "TENANT", None).await;
    sqlx::query("INSERT INTO access_role_versions (org_id,role_id,version,name_ko,status,change_mode,created_by) SELECT org_id,role_id,2,name_ko,status,change_mode,created_by FROM access_role_versions WHERE org_id=$1 AND version=1 AND role_id=(SELECT role_id FROM access_grants WHERE id=$2)")
        .bind(org.as_uuid()).bind(grant).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO access_role_lines (org_id,role_id,version,domain,levels) SELECT org_id,role_id,2,'hr_basic',ARRAY['edit'] FROM access_grants WHERE org_id=$1 AND id=$2")
        .bind(org.as_uuid()).bind(grant).execute(pool).await.unwrap();
    sqlx::query("UPDATE access_roles SET version=2 WHERE org_id=$1 AND id=(SELECT role_id FROM access_grants WHERE id=$2)")
        .bind(org.as_uuid()).bind(grant).execute(pool).await.unwrap();
    (handler, grant)
}

pub async fn placed_employee(pool: &PgPool, org: OrgId, subject: UserId, entity: Uuid) -> Uuid {
    let workplace: Uuid = sqlx::query_scalar("INSERT INTO workplaces(org_id,legal_entity_id,needs_confirmation,created_change_mode,created_by) VALUES($1,$2,true,'SETUP',$3) RETURNING id")
        .bind(org.as_uuid()).bind(entity).bind(subject.as_uuid()).fetch_one(pool).await.unwrap();
    let unit: Uuid = sqlx::query_scalar("INSERT INTO org_units(org_id) VALUES($1) RETURNING id")
        .bind(org.as_uuid())
        .fetch_one(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO org_unit_revisions(org_id,org_unit_id,version,command_id,actor_id,payload_digest,attributes,receipt) VALUES($1,$2,1,gen_random_uuid(),$3,$4,'{\"status\":\"active\"}','{}')")
        .bind(org.as_uuid()).bind(unit).bind(subject.as_uuid()).bind(vec![0u8;32]).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO org_unit_placements(org_id,org_unit_id,legal_entity_id,workplace_id,valid_from,change_mode,actor_id,command_id) VALUES($1,$2,$3,$4,current_date,'SETUP',$5,gen_random_uuid())")
        .bind(org.as_uuid()).bind(unit).bind(entity).bind(workplace).bind(subject.as_uuid()).execute(pool).await.unwrap();
    let employee: Uuid = sqlx::query_scalar("INSERT INTO employees(org_id,company,name,source_filename,source_sheet,source_row,source_key,org_unit_id) VALUES($1,'Privacy','Subject','privacy.xlsx','People',1,$2::uuid::text,$2) RETURNING id")
        .bind(org.as_uuid()).bind(unit).fetch_one(pool).await.unwrap();
    employee
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn operator_request_is_absent_from_tenant_intake(pool: PgPool) {
    let org = OrgId::new();
    let actor = console_platform_test_support::seed_org_and_super_admin(
        &pool,
        *org.as_uuid(),
        "privacy-isolation",
    )
    .await;
    let handler = seed_user(&pool, *org.as_uuid(), "MEMBER").await;
    let grant = seed_role_and_grant(&pool, *org.as_uuid(), actor, handler, "TENANT", None).await;
    sqlx::query("INSERT INTO access_role_versions (org_id,role_id,version,name_ko,status,change_mode,created_by) SELECT org_id,role_id,2,name_ko,status,change_mode,created_by FROM access_role_versions WHERE org_id=$1 AND version=1 AND role_id=(SELECT role_id FROM access_grants WHERE id=$2)")
        .bind(org.as_uuid()).bind(grant).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO access_role_lines (org_id,role_id,version,domain,levels) SELECT org_id,role_id,2,'hr_basic',ARRAY['edit'] FROM access_grants WHERE org_id=$1 AND id=$2")
        .bind(org.as_uuid()).bind(grant).execute(&pool).await.unwrap();
    sqlx::query("UPDATE access_roles SET version=2 WHERE org_id=$1 AND id=(SELECT role_id FROM access_grants WHERE id=$2)")
        .bind(org.as_uuid()).bind(grant).execute(&pool).await.unwrap();
    let rt = runtime_pool(&pool).await;
    let register = PgComplianceStore::new(rt.clone())
        .statutory_register()
        .await
        .unwrap();
    let mut tx = rights::begin(&rt, org).await.unwrap();
    let input = serde_json::from_value(
        json!({"controller":"OPERATOR","kinds":["ACCESS"],"detail":"Private account records"}),
    )
    .unwrap();
    rights::file(&mut tx, org, actor, None, &input, &register)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let keys = keys();
    let bearer = token(&pool, &keys, *org.as_uuid(), handler, "MEMBER").await;
    let service = build_router(app_state(rt, keys.1).unwrap());
    let (status, page) = send(
        &service,
        "GET",
        "/api/v1/me/action-inbox",
        Some(&bearer),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(page["unavailable"], json!([]), "{page}");
    assert!(
        !page["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["kind"] == "privacy_request"),
        "operator request leaked to tenant HR: {page}"
    );
}

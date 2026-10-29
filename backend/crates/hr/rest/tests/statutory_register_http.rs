// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#[path = "../../adapter-postgres/tests/support/mod.rs"]
mod support;

use axum::{
    Extension, Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use console_compliance_adapter_postgres::PgComplianceStore;
use console_hr_adapter_postgres::HrService;
use console_hr_domain::profile::mask;
use console_hr_rest::statutory::{REGISTER, router};
use console_platform_test_support::runtime_role_pool;
use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

async fn fixture(pool: &PgPool) -> (Router, Uuid, Uuid, Uuid) {
    let t = support::tenant(pool).await;
    let actor = support::user(pool, t.org, None).await;
    let employee = support::employee(pool, t.org, "김명부", "REG-1", "ACTIVE").await;
    let (entity, site) = (Uuid::new_v4(), Uuid::new_v4());
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query(
        "UPDATE employees SET birth_date='1990-01-01',hire_on='2020-01-01',job='HR' WHERE id=$1",
    )
    .bind(employee)
    .execute(tx.as_mut())
    .await
    .unwrap();
    sqlx::query("INSERT INTO legal_entities(org_id,id,needs_confirmation,created_change_mode) VALUES($1,$2,true,'MIGRATION')")
        .bind(t.org).bind(entity).execute(tx.as_mut()).await.unwrap();
    sqlx::query("INSERT INTO workplaces(org_id,id,legal_entity_id,needs_confirmation,created_change_mode) VALUES($1,$2,$3,true,'MIGRATION')")
        .bind(t.org).bind(site).bind(entity).execute(tx.as_mut()).await.unwrap();
    sqlx::query("INSERT INTO workplace_revisions(org_id,workplace_id,version,command_id,effective_from,name,status,change_mode,reason_code,payload_digest,settings_snapshot) VALUES($1,$2,1,gen_random_uuid(),'2020-01-01','본사','CONTINUING','MIGRATION','test',sha256('x'::bytea),'{}')")
        .bind(t.org).bind(site).execute(tx.as_mut()).await.unwrap();
    sqlx::query("INSERT INTO employment_assignments(org_id,employee_id,legal_entity_id,workplace_id,valid_from,cause,command_id) VALUES($1,$2,$3,$4,'2020-01-01','MIGRATION',gen_random_uuid())")
        .bind(t.org).bind(employee).bind(entity).bind(site).execute(tx.as_mut()).await.unwrap();
    sqlx::query("INSERT INTO employee_employment_profiles(employee_id,org_id,employment_type,phone_e164,base_pay,idempotency_key,request_hash,created_by) VALUES($1,$2,'REGULAR','+821012345821',0,'register-mask',repeat('a',64),$3)")
        .bind(employee).bind(t.org).bind(actor.as_uuid()).execute(tx.as_mut()).await.unwrap();
    tx.commit().await.unwrap();
    let rt = runtime_role_pool(pool).await;
    let app = router(HrService::new(rt.clone()), PgComplianceStore::new(rt))
        .layer(Extension(support::principal(t.org, actor)));
    (app, t.org, site, employee)
}

async fn get(app: &Router, uri: &str) -> (StatusCode, Vec<u8>) {
    use tower::ServiceExt;
    let response = app
        .clone()
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    (
        response.status(),
        to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec(),
    )
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn register_masks_screen_but_exports_clear_personal_fields_and_logs_subjects(pool: PgPool) {
    let (app, org, site, employee) = fixture(&pool).await;
    let query = format!("workplace_id={site}&as_of=2026-09-02");
    for (path, birth, phone) in [
        (
            format!("{REGISTER}?{query}"),
            mask::birth(),
            mask::phone("+821012345821"),
        ),
        (
            format!("{REGISTER}/export?{query}&format=pdf&export_purpose=AUDIT_RESPONSE"),
            "1990-01-01",
            "+821012345821".into(),
        ),
    ] {
        let (status, bytes) = get(&app, &path).await;
        assert_eq!(status, StatusCode::OK);
        let page: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(page["items"][0]["cells"][3], birth);
        assert_eq!(page["items"][0]["cells"][5], phone);
        assert_eq!(page["items"][0]["cells"][4], "", "missing stays missing");
        assert!(
            !page["items"][0]["missing"]
                .as_array()
                .unwrap()
                .contains(&Value::from("birth"))
        );
    }
    let (status, bytes) = get(
        &app,
        &format!("{REGISTER}/export?{query}&format=xlsx&export_purpose=AUDIT_RESPONSE"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    // Clear XLSX cells are exercised by the adapter export test; PDF shares its source.
    assert_eq!(&bytes[..2], b"PK");
    let reads: Vec<(String, Value)> = sqlx::query_as("SELECT action,after_snap FROM audit_events WHERE org_id=$1 AND after_snap->>'view'='worker_register'")
        .bind(org).fetch_all(&pool).await.unwrap();
    assert_eq!(reads.len(), 3);
    assert_eq!(
        reads
            .iter()
            .filter(|(action, _)| action == "employee.list_read")
            .count(),
        1
    );
    assert_eq!(
        reads
            .iter()
            .filter(|(action, _)| action == "employee.export")
            .count(),
        2
    );
    for (action, after) in reads {
        assert_eq!(after["subject_ids"], serde_json::json!([employee]));
        assert_eq!(after["row_count"], 1);
        if action == "employee.export" {
            assert_eq!(after["export_purpose"], "AUDIT_RESPONSE");
        }
        assert!(!after.to_string().contains("12345821"));
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn register_returns_nothing_when_its_access_record_cannot_commit(pool: PgPool) {
    let (app, _, site, _) = fixture(&pool).await;
    sqlx::raw_sql("CREATE FUNCTION refuse_register_read() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.after_snap->>'view'='worker_register' THEN RAISE EXCEPTION 'synthetic access-log failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER refuse_register_read BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION refuse_register_read();")
        .execute(&pool).await.unwrap();
    let (status, body) = get(
        &app,
        &format!("{REGISTER}?workplace_id={site}&as_of=2026-09-02"),
    )
    .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    let body = String::from_utf8(body).unwrap();
    assert!(!body.contains("김명부"));
    assert!(!body.contains("12345821"));
}

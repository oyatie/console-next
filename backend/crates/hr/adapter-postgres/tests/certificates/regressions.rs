// SPDX-License-Identifier: LicenseRef-Proprietary
use super::fixture::World;
use console_hr_adapter_postgres::certificates::CertificateListQuery;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn issuer_is_the_assignment_entity_and_each_entity_can_issue(pool: PgPool) {
    let w = World::new(pool).await;
    w.configure().await;
    sqlx::query("UPDATE employees SET company='display copy' WHERE id=$1")
        .bind(w.employee)
        .execute(&w.owner)
        .await
        .unwrap();
    let first = w.issue(&Uuid::new_v4().to_string()).await;
    assert_eq!(first["snapshot"]["issuer"], "Test employer");
    let second = World::entity(&w.owner, *w.actor.org_id.as_uuid(), "두 번째 법인").await;
    let mut settings = w.settings();
    settings.legal_entity_id = second;
    w.hr.set_certificate_settings(w.actor.clone(), settings)
        .await
        .unwrap();
    w.assign(second).await;
    let cert = w.issue(&Uuid::new_v4().to_string()).await;
    assert_eq!(cert["snapshot"]["issuer"], "두 번째 법인");
    assert!(cert["certificate_no"].as_str().unwrap().ends_with("000001"));
    let mut tx = w.owner.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("INSERT INTO legal_entity_revisions(org_id,legal_entity_id,version,command_id,effective_from,name,change_mode,reason_code,payload_digest,settings_snapshot) VALUES($1,$2,2,gen_random_uuid(),CURRENT_DATE,'바뀐 법인명','MIGRATION','TEST',sha256('x'::bytea),'{}')")
        .bind(w.actor.org_id.as_uuid()).bind(second).execute(tx.as_mut()).await.unwrap();
    tx.commit().await.unwrap();
    assert_eq!(
        w.issue(&Uuid::new_v4().to_string()).await["snapshot"]["issuer"],
        "바뀐 법인명"
    );
    let id = Uuid::parse_str(cert["id"].as_str().unwrap()).unwrap();
    assert_eq!(
        w.hr.certificate(w.actor.clone(), id)
            .await
            .unwrap()
            .snapshot["issuer"],
        "두 번째 법인"
    );
    sqlx::query("INSERT INTO hr_certificates(org_id,employee_id,certificate_year,seq,certificate_no,kind,items,purpose,snapshot,issued_by) SELECT org_id,employee_id,certificate_year,40,'LEGACY-40',kind,items,purpose,snapshot,issued_by FROM hr_certificates WHERE org_id=$1 AND id=$2")
        .bind(w.actor.org_id.as_uuid()).bind(id).execute(&w.owner).await.unwrap();
    assert!(
        w.issue(&Uuid::new_v4().to_string()).await["certificate_no"]
            .as_str()
            .unwrap()
            .ends_with("000041")
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn missing_assignment_and_foreign_settings_are_refused_without_writes(pool: PgPool) {
    let w = World::new(pool.clone()).await;
    let other = World::new(pool).await;
    let mut settings = w.settings();
    settings.legal_entity_id = other.entity;
    assert_eq!(
        w.hr.set_certificate_settings(w.actor.clone(), settings)
            .await
            .unwrap_err()
            .code,
        "not_found"
    );
    w.configure().await;
    sqlx::query("UPDATE employment_assignments SET superseded_at=now() WHERE employee_id=$1 AND superseded_at IS NULL").bind(w.employee).execute(&w.owner).await.unwrap();
    for status in ["ACTIVE", "EXITED"] {
        sqlx::query("UPDATE employees SET employment_status=$2,exit_date=CASE WHEN $2='EXITED' THEN '2021-02-01' END WHERE id=$1")
            .bind(w.employee).bind(status).execute(&w.owner).await.unwrap();
        let mut request = w.issue_body();
        request.kind = "CAREER".into();
        assert_eq!(
            w.hr.issue_certificate(w.actor.clone(), Some(Uuid::new_v4().to_string()), request)
                .await
                .unwrap_err()
                .code,
            "certificate_facts_missing"
        );
    }
    assert_eq!(w.count().await, 0);
    let reservations: i64 =
        sqlx::query_scalar("SELECT count(*) FROM api_idempotency_keys WHERE org_id=$1")
            .bind(w.actor.org_id.as_uuid())
            .fetch_one(&w.owner)
            .await
            .unwrap();
    assert_eq!(reservations, 0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn register_is_a_settings_sized_summary_and_seals_are_stored_once(pool: PgPool) {
    let w = World::new(pool).await;
    let png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHt8AAAAASUVORK5CYII=";
    let mut settings = w.settings();
    settings.seal_png = Some(png.into());
    w.hr.set_certificate_settings(w.actor.clone(), settings.clone())
        .await
        .unwrap();
    for _ in 0..3 {
        w.issue(&Uuid::new_v4().to_string()).await;
    }
    settings.expected_version = 1;
    w.hr.set_certificate_settings(w.actor.clone(), settings)
        .await
        .unwrap();
    sqlx::query("INSERT INTO tenant_setting_overrides(org_id,key,value,effective_from,reason_code,set_by) VALUES($1,'display.page_size','2',now(),'TEST',$2)")
        .bind(w.actor.org_id.as_uuid()).bind(w.actor.user_id.as_uuid()).execute(&w.owner).await.unwrap();
    let page =
        w.hr.certificates(w.actor.clone(), CertificateListQuery::default())
            .await
            .unwrap();
    assert_eq!(page.items.len(), 2);
    assert!(page.next_cursor.is_some());
    let value = serde_json::to_value(&page).unwrap();
    assert!(
        value["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|c| c.get("snapshot").is_none() && c["name"] == "정하늘")
    );
    assert!(!value.to_string().contains(png));
    let id = page.items[0].id;
    assert_eq!(
        w.hr.certificate(w.actor.clone(), id)
            .await
            .unwrap()
            .snapshot["seal_png"],
        png
    );
    let stored: Vec<Value> =
        sqlx::query_scalar("SELECT snapshot FROM hr_certificates WHERE org_id=$1")
            .bind(w.actor.org_id.as_uuid())
            .fetch_all(&w.owner)
            .await
            .unwrap();
    assert!(stored.iter().all(|s| s.get("seal_png").is_none()));
    let seals: i64 =
        sqlx::query_scalar("SELECT count(*) FROM hr_certificate_seals WHERE org_id=$1")
            .bind(w.actor.org_id.as_uuid())
            .fetch_one(&w.owner)
            .await
            .unwrap();
    assert_eq!(seals, 1);
    assert_eq!(value["items"][0]["purpose"], json!("제출용"));
}

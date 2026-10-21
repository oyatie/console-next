// SPDX-License-Identifier: LicenseRef-Proprietary
use super::fixture::World;
use console_hr_adapter_postgres::certificates::CertificateListQuery;
use sqlx::PgPool;
use std::collections::BTreeSet;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn issue_is_numbered_minimal_immutable_and_replay_safe(pool: PgPool) {
    let w = World::new(pool).await;
    w.configure().await;
    let key = Uuid::new_v4().to_string();
    let first = w.issue(&key).await;
    assert_eq!(w.issue(&key).await, first);
    assert_eq!(w.count().await, 1);
    assert!(first["certificate_no"].as_str().unwrap().starts_with("HR-"));
    assert_eq!(first["snapshot"]["name"], "정하늘");
    assert!(first["snapshot"].get("birth").is_none());
    assert!(first["snapshot"].get("wage").is_none());
    sqlx::query("UPDATE employees SET name='바뀐 이름' WHERE id=$1")
        .bind(w.employee)
        .execute(&w.owner)
        .await
        .unwrap();
    let id = Uuid::parse_str(first["id"].as_str().unwrap()).unwrap();
    assert_eq!(
        w.hr.certificate(w.actor.clone(), id)
            .await
            .unwrap()
            .snapshot["name"],
        "정하늘"
    );
    let mut different = w.issue_body();
    different.purpose = "다른 제출처".into();
    assert_eq!(
        w.hr.issue_certificate(w.actor.clone(), Some(key), different)
            .await
            .unwrap_err()
            .code,
        "conflict"
    );
    assert_eq!(w.count().await, 1);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn exhausted_number_width_refuses_without_a_gap_and_can_be_increased(pool: PgPool) {
    let w = World::new(pool).await;
    let mut settings = w.settings();
    settings.width = 1;
    w.hr.set_certificate_settings(w.actor.clone(), settings)
        .await
        .unwrap();
    for _ in 0..9 {
        w.issue(&Uuid::new_v4().to_string()).await;
    }
    assert_eq!(
        w.hr.issue_certificate(
            w.actor.clone(),
            Some(Uuid::new_v4().to_string()),
            w.issue_body()
        )
        .await
        .unwrap_err()
        .code,
        "certificate_numbers_exhausted"
    );
    assert_eq!(w.count().await, 9);
    let mut settings = w.settings();
    settings.expected_version = 1;
    settings.width = 2;
    w.hr.set_certificate_settings(w.actor.clone(), settings)
        .await
        .unwrap();
    assert!(
        w.issue(&Uuid::new_v4().to_string()).await["certificate_no"]
            .as_str()
            .unwrap()
            .ends_with("10")
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn concurrent_issuance_and_register_keysets_do_not_repeat_numbers(pool: PgPool) {
    let w = World::new(pool).await;
    w.configure().await;
    sqlx::query("INSERT INTO employees(org_id,company,name,hire_date,source_filename,source_sheet,source_row,source_key) SELECT $1,'Test employer','직원 '||n,'2020-01-02','test','test',n,'burst-'||n FROM generate_series(1,2000) n").bind(w.actor.org_id.as_uuid()).execute(&w.owner).await.unwrap();
    sqlx::query("INSERT INTO employment_assignments(org_id,employee_id,legal_entity_id,valid_from,cause,command_id) SELECT org_id,id,$2,'2020-01-02','MIGRATION',gen_random_uuid() FROM employees WHERE org_id=$1 AND source_key LIKE 'burst-%'").bind(w.actor.org_id.as_uuid()).bind(w.entity).execute(&w.owner).await.unwrap();
    let bodies: Vec<Uuid> =
        sqlx::query_scalar("SELECT id FROM employees WHERE org_id=$1 ORDER BY id LIMIT 32")
            .bind(w.actor.org_id.as_uuid())
            .fetch_all(&w.owner)
            .await
            .unwrap();
    let issued = futures::future::join_all(bodies.into_iter().map(|id| {
        let mut b = w.issue_body();
        b.employee_id = id;
        w.hr.issue_certificate(w.actor.clone(), Some(Uuid::new_v4().to_string()), b)
    }))
    .await;
    let numbers: BTreeSet<String> = issued
        .into_iter()
        .map(|r| r.unwrap()["certificate_no"].as_str().unwrap().into())
        .collect();
    assert_eq!(numbers.len(), 32);
    let mut cursor = None;
    let mut ids = BTreeSet::new();
    loop {
        let page =
            w.hr.certificates(
                w.actor.clone(),
                CertificateListQuery {
                    employee_id: None,
                    limit: Some(7),
                    cursor,
                },
            )
            .await
            .unwrap();
        for c in page.items {
            assert!(ids.insert(c.id));
        }
        cursor = page.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(ids.len(), 32);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn changing_or_clearing_the_seal_keeps_issued_snapshots_and_refuses_a_different_employer(
    pool: PgPool,
) {
    let w = World::new(pool).await;
    let mut settings = w.settings();
    settings.seal_png=Some("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHt8AAAAASUVORK5CYII=".into());
    let original = settings.seal_png.clone().unwrap();
    w.hr.set_certificate_settings(w.actor.clone(), settings)
        .await
        .unwrap();
    let cert = w.issue(&Uuid::new_v4().to_string()).await;
    assert!(cert["snapshot"].get("seal_png").is_none());
    let mut settings = w.settings();
    settings.expected_version = 1;
    w.hr.set_certificate_settings(w.actor.clone(), settings)
        .await
        .unwrap();
    let id = Uuid::parse_str(cert["id"].as_str().unwrap()).unwrap();
    assert_eq!(
        w.hr.certificate(w.actor.clone(), id)
            .await
            .unwrap()
            .snapshot["seal_png"],
        original
    );
    assert!(
        w.issue(&Uuid::new_v4().to_string()).await["snapshot"]
            .get("seal_png")
            .is_none()
    );
    let different = World::entity(&w.owner, *w.actor.org_id.as_uuid(), "Different employer").await;
    w.assign(different).await;
    assert_eq!(
        w.hr.issue_certificate(
            w.actor.clone(),
            Some(Uuid::new_v4().to_string()),
            w.issue_body()
        )
        .await
        .unwrap_err()
        .code,
        "certificate_settings_required"
    );
    assert_eq!(w.count().await, 2);
}

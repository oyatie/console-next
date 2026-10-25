// SPDX-License-Identifier: LicenseRef-Proprietary
//! Initial bulk placement shares import's foundation dates and commits atomically.
use super::*;
use console_hr_adapter_postgres::lifecycle::requests::BulkEmployeeLifecycleEventRequest;
use sqlx::Row;

async fn target(f: &Fixture, entity_open: &str, workplace_open: &str) -> (Uuid, Uuid) {
    let (entity, workplaces) = f.entity(1).await;
    let workplace = workplaces[0];
    seed(&f.owner, f.org, format!(
        "INSERT INTO legal_entity_revisions (org_id,legal_entity_id,version,command_id,effective_from,name,change_mode,reason_code,payload_digest,settings_snapshot) \
         VALUES ('{}','{entity}',1,gen_random_uuid(),'{entity_open}','Co','MIGRATION','TEST',sha256('x'::bytea),'{{}}'); \
         INSERT INTO workplace_revisions (org_id,workplace_id,version,command_id,effective_from,name,status,change_mode,reason_code,payload_digest,settings_snapshot) \
         VALUES ('{}','{workplace}',1,gen_random_uuid(),'{workplace_open}','본사','CONTINUING','MIGRATION','TEST',sha256('x'::bytea),'{{}}'); \
         UPDATE employees SET hire_date='2008-01-01' WHERE id='{}';",
        f.org, f.org, f.employee
    )).await;
    (workplace, f.unit_at(entity, workplace).await)
}

fn request(ids: &[Uuid], unit: Uuid, on: &str) -> BulkEmployeeLifecycleEventRequest {
    serde_json::from_value(json!({"event_type":"TRANSFER", "employee_ids":ids,
        "to_org_unit_id":unit, "effective_date":on, "comment":"미배치 처리"}))
    .unwrap()
}

async fn nothing_written(f: &Fixture) {
    for table in [
        "employee_lifecycle_events",
        "employment_assignments",
        "audit_events",
        "lifecycle_cases",
        "lifecycle_case_items",
    ] {
        let count: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "SELECT count(*) FROM {table} WHERE org_id=$1"
        )))
        .bind(f.org)
        .fetch_one(&f.owner)
        .await
        .unwrap();
        assert_eq!(count, 0, "{table}");
    }
    let bound: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM employees WHERE org_id=$1 AND org_unit_id IS NOT NULL",
    )
    .bind(f.org)
    .fetch_one(&f.owner)
    .await
    .unwrap();
    assert_eq!(bound, 0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn initial_placement_setup_uses_the_later_hire_or_foundation_opening(pool: PgPool) {
    for hire in ["2008-01-01", "2024-03-04"] {
        let f = fixture(pool.clone(), false).await;
        let (workplace, unit) = target(&f, "2020-03-02", "2021-05-01").await;
        seed(
            &f.owner,
            f.org,
            format!(
                "UPDATE employees SET hire_date='{hire}' WHERE id='{}'",
                f.employee
            ),
        )
        .await;
        let preview =
            f.hr.preview_bulk_lifecycle_events(
                f.principal.clone(),
                request(&[f.employee], unit, &day(0)),
            )
            .await
            .unwrap();
        assert!(preview.refusals.is_empty(), "{:?}", preview.refusals);
        let key = Uuid::new_v4().to_string();
        let first =
            f.hr.bulk_lifecycle_events(
                f.principal.clone(),
                key.clone(),
                request(&[f.employee], unit, &day(0)),
            )
            .await
            .unwrap();
        assert_eq!(
            f.live().await,
            [(
                hire.max("2021-05-01").into(),
                None,
                Some(workplace),
                "SETUP_BIND".into()
            )]
        );
        assert_eq!(
            f.hr.bulk_lifecycle_events(
                f.principal.clone(),
                key,
                request(&[f.employee], unit, &day(0))
            )
            .await
            .unwrap(),
            first
        );
        let stored_hire: String =
            sqlx::query_scalar("SELECT hire_date FROM person_employees_current WHERE id=$1")
                .bind(f.employee)
                .fetch_one(&f.owner)
                .await
                .unwrap();
        assert_eq!(stored_hire, hire);
        let event_id = Uuid::parse_str(first["items"][0]["id"].as_str().unwrap()).unwrap();
        let entity: Uuid = sqlx::query_scalar("SELECT legal_entity_id FROM workplaces WHERE id=$1")
            .bind(workplace)
            .fetch_one(&f.owner)
            .await
            .unwrap();
        let trails = sqlx::query(
            "SELECT a.command_id,c.trigger_id,c.legal_entity_id,c.workplace_id,c.kind \
             FROM employment_assignments a JOIN lifecycle_cases c \
               ON c.org_id=a.org_id AND c.employee_id=a.employee_id \
             WHERE a.org_id=$1 AND a.employee_id=$2 AND a.superseded_at IS NULL",
        )
        .bind(f.org)
        .bind(f.employee)
        .fetch_all(&f.owner)
        .await
        .unwrap();
        // Initial placement supplies the transfer's scope; it is not a second hire event.
        assert_eq!(trails.len(), 1);
        let trail = &trails[0];
        assert_eq!(trail.get::<Uuid, _>("command_id"), event_id);
        assert_eq!(trail.get::<Uuid, _>("trigger_id"), event_id);
        assert_eq!(
            trail.get::<Option<Uuid>, _>("legal_entity_id"),
            Some(entity)
        );
        assert_eq!(
            trail.get::<Option<Uuid>, _>("workplace_id"),
            Some(workplace)
        );
        assert_eq!(trail.get::<String, _>("kind"), "APPOINT");
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn initial_placement_uses_the_legal_entity_opening_when_it_is_later(pool: PgPool) {
    let f = fixture(pool, false).await;
    let (workplace, unit) = target(&f, "2022-03-02", "2020-05-01").await;
    f.hr.bulk_lifecycle_events(
        f.principal.clone(),
        Uuid::new_v4().to_string(),
        request(&[f.employee], unit, &day(0)),
    )
    .await
    .unwrap();
    assert_eq!(
        f.live().await,
        [(
            "2022-03-02".into(),
            None,
            Some(workplace),
            "SETUP_BIND".into()
        )]
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn initial_placement_operating_before_opening_refuses_before_any_write(pool: PgPool) {
    let f = fixture(pool, true).await;
    let (_, unit) = target(&f, "2020-03-02", "2021-05-01").await;
    let preview =
        f.hr.preview_bulk_lifecycle_events(
            f.principal.clone(),
            request(&[f.employee], unit, "2020-04-01"),
        )
        .await
        .unwrap();
    assert_eq!(preview.refusals[0]["code"], "workplace_not_open_on_date");
    let err =
        f.hr.bulk_lifecycle_events(
            f.principal.clone(),
            Uuid::new_v4().to_string(),
            request(&[f.employee], unit, "2020-04-01"),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, "bulk_lifecycle_refused");
    nothing_written(&f).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn initial_placement_binding_failure_rolls_back_the_transfer_and_audits(pool: PgPool) {
    let f = fixture(pool, false).await;
    let (_, unit) = target(&f, "2020-03-02", "2021-05-01").await;
    let good: Uuid = sqlx::query_scalar(
        "INSERT INTO employees (org_id,company,name,source_filename,source_sheet,source_row,source_key,hire_date) \
         VALUES ($1,'Co','먼저 배치','test','test',1,$2,'2024-03-04') RETURNING id",
    ).bind(f.org).bind(Uuid::new_v4().to_string()).fetch_one(&f.owner).await.unwrap();
    let ids = [good, f.employee];
    let preview =
        f.hr.preview_bulk_lifecycle_events(f.principal.clone(), request(&ids, unit, &day(0)))
            .await
            .unwrap();
    assert!(preview.refusals.is_empty());
    sqlx::query(sqlx::AssertSqlSafe(format!("ALTER TABLE employment_assignments ADD CONSTRAINT refuse_test_binding CHECK (employee_id <> '{}') NOT VALID", f.employee)))
        .execute(&f.owner).await.unwrap();
    assert!(
        f.hr.bulk_lifecycle_events(
            f.principal.clone(),
            Uuid::new_v4().to_string(),
            request(&ids, unit, &day(0))
        )
        .await
        .is_err()
    );
    nothing_written(&f).await;
}

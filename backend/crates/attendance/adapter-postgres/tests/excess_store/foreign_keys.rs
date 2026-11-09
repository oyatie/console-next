// SPDX-License-Identifier: LicenseRef-Proprietary
use super::invariants::resolution;
use super::store_support::{code, item, runtime};
use super::support::{World, world};
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

pub(super) async fn entry(w: &World) -> Uuid {
    let batch: Uuid = sqlx::query_scalar(
        "INSERT INTO attendance_batches \
        (org_id, source, evidence_kind, cells, created_by, idempotency_key, request_fingerprint) \
        VALUES ($1, 'MANUAL', 'PAPER_SHEET', 1, $2, $3, repeat('a', 64)) RETURNING id",
    )
    .bind(w.org)
    .bind(w.admin)
    .bind(Uuid::new_v4().to_string())
    .fetch_one(&w.owner)
    .await
    .unwrap();
    sqlx::query_scalar(
        "INSERT INTO attendance_entries \
        (org_id, batch_id, employee_id, work_date, kind, created_by) \
        VALUES ($1, $2, $3, DATE '2026-10-06', 'ABSENT', $4) RETURNING id",
    )
    .bind(w.org)
    .bind(batch)
    .bind(w.people[0])
    .bind(w.admin)
    .fetch_one(&w.owner)
    .await
    .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn scope_and_correction_links_cannot_cross_tenants_or_dangle(pool: PgPool) {
    let w = world(pool).await;
    let foreign_org = Uuid::new_v4();
    let foreign_user = Uuid::new_v4();
    let foreign_person = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $1::text, 'Other tenant')")
        .bind(foreign_org)
        .execute(&w.owner)
        .await
        .unwrap();
    sqlx::query("INSERT INTO users (id, org_id, display_name, roles) VALUES ($1, $2, 'Recorder', ARRAY['MECHANIC'])")
        .bind(foreign_user).bind(foreign_org).execute(&w.owner).await.unwrap();
    sqlx::query(
        "INSERT INTO employees \
        (id, org_id, company, name, source_filename, source_sheet, source_row, source_key) \
        VALUES ($1, $2, 'Company', 'Worker', 'console', 'people', 1, $1::text)",
    )
    .bind(foreign_person)
    .bind(foreign_org)
    .execute(&w.owner)
    .await
    .unwrap();
    let entity: Uuid = sqlx::query_scalar(
        "INSERT INTO legal_entities (org_id, needs_confirmation, created_change_mode) \
        VALUES ($1, true, 'MIGRATION') RETURNING id",
    )
    .bind(foreign_org)
    .fetch_one(&w.owner)
    .await
    .unwrap();
    let workplace: Uuid = sqlx::query_scalar(
        "INSERT INTO workplaces (org_id, legal_entity_id, needs_confirmation, created_change_mode) \
        VALUES ($1, $2, true, 'MIGRATION') RETURNING id",
    )
    .bind(foreign_org)
    .bind(entity)
    .fetch_one(&w.owner)
    .await
    .unwrap();
    let unit: Uuid = sqlx::query_scalar("INSERT INTO org_units (org_id) VALUES ($1) RETURNING id")
        .bind(foreign_org)
        .fetch_one(&w.owner)
        .await
        .unwrap();
    let foreign = World {
        org: foreign_org,
        admin: foreign_user,
        people: [foreign_person; 3],
        owner: w.owner.clone(),
        store: w.store.clone(),
        entity,
        workplaces: [workplace; 2],
        branches: w.branches,
        dept: unit,
        team: unit,
    };
    let other_entry = entry(&foreign).await;
    let own_entry = entry(&w).await;
    let id = item(&w, "UNAPPROVED_OVERTIME", 1080, 1200).await;
    for (place, team) in [
        (workplace, w.team),
        (Uuid::new_v4(), w.team),
        (w.workplaces[0], unit),
        (w.workplaces[0], Uuid::new_v4()),
    ] {
        let mut tx = runtime(&w).await;
        let error = sqlx::query("INSERT INTO attendance_exceptions \
            (org_id, code, kind, employee_id, work_date, detail, created_by, idempotency_key, \
             request_fingerprint, from_minutes, to_minutes, due_on, workplace_id, org_unit_id) \
            VALUES ($1, 'invalid-scope', 'UNAPPROVED_OVERTIME', $2, DATE '2026-10-06', '초과 기록', \
             $3, 'invalid-scope-item', repeat('a', 64), 420, 540, DATE '2026-10-09', $4, $5)")
            .bind(w.org).bind(w.people[0]).bind(w.admin).bind(place).bind(team)
            .execute(&mut *tx).await.unwrap_err();
        assert_eq!(code(error), "23503");
        tx.rollback().await.unwrap();
    }
    for target in [other_entry, Uuid::new_v4()] {
        let mut tx = runtime(&w).await;
        let error = resolution(
            &mut tx,
            &w,
            id,
            json!({"action": "RECORD_CORRECTION",
            "reason_code": "TIME_INPUT_ERROR", "superseding_entry_id": target}),
        )
        .await
        .unwrap_err();
        assert_eq!(code(error), "23503");
        tx.rollback().await.unwrap();
    }
    let mut tx = runtime(&w).await;
    resolution(
        &mut tx,
        &w,
        id,
        json!({"action": "RECORD_CORRECTION",
        "reason_code": "TIME_INPUT_ERROR", "superseding_entry_id": own_entry}),
    )
    .await
    .unwrap();
    tx.rollback().await.unwrap();
}

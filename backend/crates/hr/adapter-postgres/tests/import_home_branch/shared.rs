// SPDX-License-Identifier: LicenseRef-Proprietary
use console_hr_domain::import::detect::WorkbookMappingRequest;
use uuid::Uuid;

use crate::harness::{Importer, decisions, table};

/// A 법인 「한빛」 with one open 사업장 「본사」 backed by `default_branch`.
pub(super) async fn setup_headquarters(i: &Importer, default_branch: Uuid) -> (Uuid, Uuid) {
    let (o, entity, workplace) = (i.org(), Uuid::new_v4(), Uuid::new_v4());
    let sql = format!(
        "INSERT INTO legal_entities (org_id, id, needs_confirmation, created_change_mode) \
         VALUES ('{o}', '{entity}', true, 'MIGRATION'); \
         INSERT INTO legal_entity_revisions (org_id, legal_entity_id, version, command_id, \
           effective_from, name, display_name, change_mode, reason_code, payload_digest, \
           settings_snapshot) VALUES ('{o}', '{entity}', 1, gen_random_uuid(), '2020-01-01', \
           '주식회사 한빛', '한빛', 'MIGRATION', 'test', sha256('x'::bytea), '{{}}'); \
         INSERT INTO workplaces (org_id, id, legal_entity_id, needs_confirmation, created_change_mode, default_branch_id) \
         VALUES ('{o}', '{workplace}', '{entity}', true, 'MIGRATION', '{default_branch}'); \
         INSERT INTO workplace_revisions (org_id, workplace_id, version, command_id, effective_from, \
           name, status, change_mode, reason_code, payload_digest, settings_snapshot) VALUES ('{o}', \
           '{workplace}', 1, gen_random_uuid(), '2020-01-01', '본사', 'CONTINUING', 'MIGRATION', \
           'TEST', decode(repeat('00', 32), 'hex'), '{{}}')"
    );
    let mut tx = i.owner.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(o.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
        .execute(tx.as_mut())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    (entity, workplace)
}

pub(super) async fn stage_roster(i: &Importer, sheet: &str, rows: &[&[&str]]) -> (Uuid, String) {
    let header: &[&str] = &[
        "사번",
        "성명",
        "입사일",
        "고용형태",
        "사업장",
        "퇴사일",
        "직위",
    ];
    let all: Vec<&[&str]> = std::iter::once(header)
        .chain(rows.iter().copied())
        .collect();
    let run = i
        .preview(
            "명부.xlsx",
            &[table(sheet, 0, &all)],
            &WorkbookMappingRequest::default(),
        )
        .await
        .unwrap()
        .run_id;
    let plan = i.dry_run(run, decisions()).await;
    assert_eq!(plan.review.blocking, 0, "{:?}", plan.review.items);
    (run, plan.dry_run_digest)
}

/// An employee with NULL routing and one assignment relative to today (KST), written without triggers.
pub(super) async fn seed_placement(
    i: &Importer,
    (entity, workplace): (Uuid, Uuid),
    key: &str,
    (start, end): (i32, Option<i32>),
    superseded: bool,
) -> Uuid {
    let employee = Uuid::new_v4();
    let mut tx = i.owner.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO employees (id, org_id, company, name, employee_number, source_filename, \
         source_sheet, source_row, source_key, employment_status) \
         VALUES ($1, $2, '주식회사 한빛', $3, $3, 'legacy.xlsx', 'Sheet1', 1, $3, 'ACTIVE')",
    )
    .bind(employee)
    .bind(i.org())
    .bind(key)
    .execute(tx.as_mut())
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO employment_assignments (id, org_id, employee_id, legal_entity_id, workplace_id, \
         valid_from, valid_to, superseded_at, cause, command_id, actor_id) \
         VALUES (gen_random_uuid(), $1, $2, $3, $4, \
           (now() AT TIME ZONE 'Asia/Seoul')::date + $5::integer, \
           (now() AT TIME ZONE 'Asia/Seoul')::date + $6::integer, \
           CASE WHEN $7 THEN now() END, 'HIRE', gen_random_uuid(), $8)",
    )
    .bind(i.org())
    .bind(employee)
    .bind(entity)
    .bind(workplace)
    .bind(start)
    .bind(end)
    .bind(superseded)
    .bind(*i.f.principal.user_id.as_uuid())
    .execute(tx.as_mut())
    .await
    .unwrap();
    tx.commit().await.unwrap();
    employee
}

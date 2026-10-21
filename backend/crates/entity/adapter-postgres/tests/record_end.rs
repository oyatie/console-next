#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! CRUD: after 운영 시작 a 사업장 or 법인 nothing ever used is deleted (its
//! void), one with 부서 under it says so (erase them first), and one that was
//! used is refused with `record_has_history` (close it), writing nothing.

mod common;

use common::*;
use console_entity_application::VoidRecord;
use sqlx::PgPool;
use uuid::Uuid;

const ORG: Uuid = Uuid::from_u128(0xA000_0000_0000_0000_0000_0000_0C0D_0101);

fn mistake() -> VoidRecord {
    VoidRecord {
        reason_code: Some("MISTAKE".into()),
    }
}

async fn voided(owner: &PgPool, workplace: Uuid) -> bool {
    sqlx::query_scalar("SELECT voided_at IS NOT NULL FROM workplaces WHERE id = $1")
        .bind(workplace)
        .fetch_one(owner)
        .await
        .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn after_go_live_an_unused_workplace_is_deleted_and_a_used_one_is_refused(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG, "A").await;
    let (entity, [(hq, _), (plant, _)]) = two_workplaces(&store, &actor).await;
    let spare = store
        .apply_org_setup_batch(
            &cmd(&actor),
            vec![under_workplace("x", "임시부", plant)],
            port(),
        )
        .await
        .unwrap()
        .units[0]
        .org_unit_id;
    let dept = store
        .apply_org_setup_batch(
            &cmd(&actor),
            vec![under_workplace("y", "본사부", hq)],
            port(),
        )
        .await
        .unwrap()
        .units[0]
        .org_unit_id;
    person(&owner, &store, &actor, (entity, hq, dept), "kim").await;
    set_operating(&owner, ORG).await;

    // 공장 has only a never-used 부서: erase it first, then the 사업장 goes.
    let options = store
        .record_end_options(&actor, "workplace_id", plant)
        .await
        .unwrap();
    assert_eq!(options.delete.refusal, Some("record_has_units"));
    let (c, _, remedy) = code(
        store
            .void_workplace(&cmd(&actor), plant, mistake(), port())
            .await
            .unwrap_err(),
    );
    assert_eq!((c, remedy), ("record_has_units", Some("erase_units_first")));
    assert!(!voided(&owner, plant).await);
    store.erase_org_unit(&cmd(&actor), spare, 1).await.unwrap();
    let options = store
        .record_end_options(&actor, "workplace_id", plant)
        .await
        .unwrap();
    assert!(options.delete.allowed);
    assert_eq!(options.close.refusal, Some("record_never_used"));
    store
        .void_workplace(&cmd(&actor), plant, mistake(), port())
        .await
        .unwrap();
    assert!(voided(&owner, plant).await);
    let mode: String = sqlx::query_scalar(
        "SELECT after_snap->>'change_mode' FROM audit_events WHERE action = 'workplace.void' AND target_id = $1",
    )
    .bind(plant.to_string())
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(mode, "GOVERNED");

    // 본사 was used (someone was assigned there): refused, close instead.
    let options = store
        .record_end_options(&actor, "workplace_id", hq)
        .await
        .unwrap();
    assert_eq!(options.delete.refusal, Some("record_has_history"));
    assert!(options.close.allowed);
    let (c, _, remedy) = code(
        store
            .void_workplace(&cmd(&actor), hq, mistake(), port())
            .await
            .unwrap_err(),
    );
    assert_eq!(
        (c, remedy),
        ("record_has_history", Some("close_record_instead"))
    );
    assert!(!voided(&owner, hq).await);
    // The 법인 holds the used 본사: the same refusal.
    let options = store
        .record_end_options(&actor, "legal_entity_id", entity)
        .await
        .unwrap();
    assert_eq!(options.delete.refusal, Some("record_has_history"));
    let (c, _, _) = code(
        store
            .void_entity(&cmd(&actor), entity, mistake(), port())
            .await
            .unwrap_err(),
    );
    assert_eq!(c, "record_has_history");
}

/// UX-R2 ENDS (company-52), regression: a 법인's end options name every exit
/// case still open for someone placed there, with its date, so its close
/// sheet can show the 금품청산 clock instead of closing over it silently.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn regression_end_options_name_the_open_exit_cases(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG, "C").await;
    let (entity, [(hq, hq_unit), (plant, _)]) = two_workplaces(&store, &actor).await;
    let kim = person(&owner, &store, &actor, (entity, hq, hq_unit), "kim").await;
    set_operating(&owner, ORG).await;
    let none = store
        .record_end_options(&actor, "legal_entity_id", entity)
        .await
        .unwrap();
    assert!(none.open_exit_cases.is_empty());
    let case: Uuid = sqlx::query_scalar(
        "INSERT INTO employee_exit_cases (org_id, employee_id, effective_exit_date, site_manager_note, reported_by, status) \
         VALUES ($1, $2, '2026-09-30', '정리', $3, 'HQ_CONFIRMED') RETURNING id",
    )
    .bind(ORG)
    .bind(kim)
    .bind(*actor.user.as_uuid())
    .fetch_one(&owner)
    .await
    .unwrap();
    let open = store
        .record_end_options(&actor, "legal_entity_id", entity)
        .await
        .unwrap();
    assert_eq!(
        open.open_exit_cases
            .iter()
            .map(|c| (c.case_id, c.effective_exit_date.as_str(), c.status.as_str()))
            .collect::<Vec<_>>(),
        vec![(case, "2026-09-30", "HQ_CONFIRMED")]
    );
    // Another 사업장 of the 법인 nobody worked at has none.
    let plant = store
        .record_end_options(&actor, "workplace_id", plant)
        .await
        .unwrap();
    assert!(plant.open_exit_cases.is_empty());
}

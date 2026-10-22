#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! The go-live breakdown and the records under each preview line list 법인 and
//! their 사업장 in the stored order, never by id or name.
mod common;
use common::*;
use console_onboarding_adapter_postgres::{OnboardingActor, PgOnboardingStore};
use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

async fn entity(tx: &mut PgConnection, org: Uuid, name: &str, order: Option<i32>) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO legal_entities (org_id,id,sort_order,needs_confirmation,created_change_mode) VALUES ($1,$2,$3,true,'MIGRATION')")
        .bind(org).bind(id).bind(order).execute(&mut *tx).await.unwrap();
    sqlx::query("INSERT INTO legal_entity_revisions (org_id,legal_entity_id,version,command_id,effective_from,name,change_mode,reason_code,payload_digest,settings_snapshot) VALUES ($1,$2,1,gen_random_uuid(),'2020-01-01',$3,'MIGRATION','CREATE',sha256('x'::bytea),'{}')")
        .bind(org).bind(id).bind(name).execute(&mut *tx).await.unwrap();
    id
}

async fn site(
    tx: &mut PgConnection,
    org: Uuid,
    entity: Uuid,
    name: &str,
    order: Option<i32>,
) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO workplaces (org_id,id,legal_entity_id,sort_order,needs_confirmation,created_change_mode) VALUES ($1,$2,$3,$4,true,'MIGRATION')")
        .bind(org).bind(id).bind(entity).bind(order).execute(&mut *tx).await.unwrap();
    sqlx::query("INSERT INTO workplace_revisions (org_id,workplace_id,version,command_id,effective_from,name,status,change_mode,reason_code,payload_digest,settings_snapshot) VALUES ($1,$2,1,gen_random_uuid(),'2020-01-01',$3,'CONTINUING','MIGRATION','test',sha256('x'::bytea),'{}')")
        .bind(org).bind(id).bind(name).execute(&mut *tx).await.unwrap();
    id
}

/// Stored order runs against name order at both levels; the unpositioned
/// ones come after the ordered ones. Returns the store, its actor, the 법인 in
/// stored order and the 사업장 in stored order.
async fn seeded(owner: &PgPool) -> (PgOnboardingStore, OnboardingActor, [Uuid; 3], [Uuid; 4]) {
    let (store, a) = tenant(owner).await;
    let org = *a.org.as_uuid();
    let mut tx = owner.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    let last = entity(&mut tx, org, "가법인", None).await;
    let na = entity(&mut tx, org, "나법인", Some(0)).await;
    let ga = entity(&mut tx, org, "다법인", Some(1)).await;
    let da = site(&mut tx, org, na, "다사업장", Some(1)).await;
    let ra = site(&mut tx, org, na, "라사업장", Some(0)).await;
    let sa = site(&mut tx, org, ga, "가사업장", None).await;
    let aa = site(&mut tx, org, ga, "아사업장", Some(0)).await;
    tx.commit().await.unwrap();
    (store, a, [na, ga, last], [ra, da, aa, sa])
}

fn strings(ids: &[Uuid]) -> Vec<String> {
    ids.iter().map(Uuid::to_string).collect()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn go_live_breakdown_follows_the_stored_order(owner: PgPool) {
    let (store, a, [na, ga, last], [ra, da, aa, sa]) = seeded(&owner).await;
    let got: Vec<String> = store
        .preview(&a)
        .await
        .unwrap()
        .details
        .breakdown
        .into_iter()
        .map(|b| b.id)
        .collect();
    assert_eq!(got, strings(&[na, ra, da, ga, aa, sa, last]));
}

/// The records under each preview line (go-live-items) follow the same order
/// as the breakdown above them, never the name.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn go_live_line_records_follow_the_stored_order(owner: PgPool) {
    let (store, a, entities, workplaces) = seeded(&owner).await;
    let p = store.preview(&a).await.unwrap();
    let records = |code: &str| -> Vec<String> {
        p.blockers
            .iter()
            .chain(&p.warnings)
            .find(|i| i.code == code)
            .unwrap_or_else(|| panic!("no {code} line"))
            .records
            .iter()
            .map(|r| r.id.clone())
            .collect()
    };
    assert_eq!(records("entity_needs_confirmation"), strings(&entities));
    assert_eq!(records("workplace_incomplete"), strings(&workplaces));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn exempt_workplaces_are_finished_while_later_is_counted_with_support(owner: PgPool) {
    let (store, actor) = tenant(&owner).await;
    let org = *actor.org.as_uuid();
    let mut tx = owner.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    let entity = entity(&mut tx, org, "주식회사 가나", Some(0)).await;
    let exempt = site(&mut tx, org, entity, "하치장", Some(0)).await;
    let later = site(&mut tx, org, entity, "등록 답변 대기", Some(1)).await;
    sqlx::query(
        "UPDATE workplaces SET needs_confirmation = false, default_branch_id = gen_random_uuid(), \
           not_registered_reason_code = 'VAT_DEPOT', not_registered_reason_label = '하치장', \
           not_registered_reason_list_key = 'workplace_not_registered_reason', \
           not_registered_reason_version = '2026-10-22' WHERE id = $1",
    )
    .bind(exempt)
    .execute(tx.as_mut())
    .await
    .unwrap();
    sqlx::query("UPDATE workplaces SET needs_confirmation = false, default_branch_id = gen_random_uuid() WHERE id = $1")
        .bind(later)
        .execute(tx.as_mut())
        .await
        .unwrap();
    for (index, workplace) in [exempt, later].into_iter().enumerate() {
        let employee: Uuid = sqlx::query_scalar(
            "INSERT INTO employees (org_id, company, name, source_filename, source_sheet, source_row, source_key) \
             VALUES ($1, '주식회사 가나', $2, 'fixture.xlsx', 'Roster', $3, $2) RETURNING id",
        )
        .bind(org)
        .bind(format!("직원-{index}"))
        .bind(i32::try_from(index).unwrap() + 1)
        .fetch_one(tx.as_mut())
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO employment_assignments (org_id, employee_id, legal_entity_id, workplace_id, valid_from, cause, command_id) \
             VALUES ($1, $2, $3, $4, '2020-01-01', 'MIGRATION', gen_random_uuid())",
        )
        .bind(org)
        .bind(employee)
        .bind(entity)
        .bind(workplace)
        .execute(tx.as_mut())
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();

    let preview = store.preview(&actor).await.unwrap();
    assert_eq!(preview.facts.staffed_workplaces_without_registration, 1);
    assert_eq!(
        preview.facts.staffed_workplaces_without_registration
            + preview.facts.empty_workplaces_without_registration,
        1
    );
    assert!(
        !preview
            .blockers
            .iter()
            .chain(&preview.warnings)
            .any(|item| item.code.contains("without_registration"))
    );
    assert!(
        preview
            .blockers
            .iter()
            .chain(&preview.warnings)
            .flat_map(|item| &item.records)
            .all(|record| record.id != exempt.to_string())
    );
}

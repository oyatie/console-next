#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! UX-R1 PLACEMENT (regression: org-01, move-21, hire-26): a person's 사업장
//! follows their 부서, the counts agree at every level, and the one-time
//! correction (0319) finds and repairs what an older binary wrote.

mod common;
#[path = "placement_integrity/exits.rs"]
mod exits;
#[path = "placement_integrity/repair.rs"]
mod repair;

use common::*;
use console_entity_application::{BindAssignment, OrgStructureNode};
use sqlx::PgPool;
use uuid::Uuid;

const ORG: Uuid = Uuid::from_u128(0xA000_0000_0000_0000_0000_0000_0000_0C52);

/// 본사 and 공장 of one 법인, with 공장 › 생산팀 › 조립파트:
/// `(entity, 본사, 공장, 생산팀, 조립파트)`.
async fn chart(
    store: &console_entity_adapter_postgres::PgEntityStore,
    actor: &console_entity_application::Actor,
) -> (Uuid, Uuid, Uuid, Uuid, Uuid) {
    let (entity, [(hq, _), (plant, _)]) = two_workplaces(store, actor).await;
    let receipt = store
        .apply_org_setup_batch(
            &cmd(actor),
            vec![
                under_workplace("a", "생산팀", plant),
                under_ref("b", "조립파트", "a"),
            ],
            port(),
        )
        .await
        .unwrap();
    let [dept, team] = [0, 1].map(|i| receipt.units[i].org_unit_id);
    (entity, hq, plant, dept, team)
}

fn bind(employee: Uuid, entity: Uuid, workplace: Uuid, from: &str) -> BindAssignment {
    BindAssignment {
        employee_id: employee,
        legal_entity_id: Some(entity),
        workplace_id: Some(workplace),
        valid_from: Some(from.into()),
    }
}

/// Owner-side writes with triggers off (the shapes an older binary left).
async fn raw(owner: &PgPool, sql: String) {
    let mut tx = owner.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
        .execute(tx.as_mut())
        .await
        .unwrap();
    tx.commit().await.unwrap();
}

async fn scalar(owner: &PgPool, sql: &str, id: Uuid) -> i64 {
    sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .fetch_one(owner)
        .await
        .unwrap()
}

/// Live rows of an employee, oldest first: `(from, to, workplace, cause)`.
async fn live(owner: &PgPool, employee: Uuid) -> Vec<(String, Option<String>, Uuid, String)> {
    sqlx::query_as(
        "SELECT valid_from::text, valid_to::text, workplace_id, cause FROM employment_assignments \
         WHERE employee_id = $1 AND superseded_at IS NULL ORDER BY valid_from",
    )
    .bind(employee)
    .fetch_all(owner)
    .await
    .unwrap()
}

fn find(nodes: &[OrgStructureNode], id: Uuid) -> Option<&OrgStructureNode> {
    nodes.iter().find_map(|n| {
        if n.id == id {
            Some(n)
        } else {
            find(&n.children, id)
        }
    })
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn regression_a_binding_that_contradicts_the_department_is_refused(owner: PgPool) {
    // org-01: 생산팀 sits under 공장, the person was bound at 본사 the same day.
    let (store, actor) = tenant(&owner, ORG, "A").await;
    let (entity, hq, plant, _, team) = chart(&store, &actor).await;
    let p = person(&owner, &store, &actor, (entity, plant, team), "p1").await;
    let rows = "SELECT count(*) FROM employment_assignments WHERE employee_id = $1";
    let audits = "SELECT count(*) FROM audit_events WHERE target_id = $1::text AND action = 'employment_assignment.bind'";
    let before = (
        live(&owner, p).await,
        scalar(&owner, rows, p).await,
        scalar(&owner, audits, p).await,
    );
    for from in ["2026-01-02", "2026-03-01", "2025-12-01"] {
        let refused = store
            .bind_assignment(&cmd(&actor), bind(p, entity, hq, from))
            .await
            .unwrap_err();
        assert_eq!(
            code(refused),
            (
                "org_unit_at_other_workplace",
                vec![("workplace_id".into(), "org_unit_at_other_workplace")],
                Some("transfer_instead")
            )
        );
    }
    // Another 법인's 사업장 still reads as a 전적 first (its own refusal).
    let (other, far) = (Uuid::new_v4(), Uuid::new_v4());
    raw(
        &owner,
        format!(
            "INSERT INTO legal_entities (org_id, id, needs_confirmation, created_change_mode) \
             VALUES ('{ORG}', '{other}', true, 'MIGRATION'); \
             INSERT INTO workplaces (org_id, id, legal_entity_id, needs_confirmation, created_change_mode) \
             VALUES ('{ORG}', '{far}', '{other}', true, 'MIGRATION');"
        ),
    )
    .await;
    let crossed = store
        .bind_assignment(&cmd(&actor), bind(p, other, far, "2026-03-01"))
        .await
        .unwrap_err();
    assert_eq!(code(crossed).0, "entity_change_needs_group_transfer");
    // Nothing written: the same rows, no new row, no audit.
    assert_eq!(
        (
            live(&owner, p).await,
            scalar(&owner, rows, p).await,
            scalar(&owner, audits, p).await
        ),
        before
    );
    // The 부서's own 사업장 still binds (an identical re-bind is a no-op), and a
    // person in no 부서 binds anywhere.
    store
        .bind_assignment(&cmd(&actor), bind(p, entity, plant, "2026-01-02"))
        .await
        .unwrap();
    let loose: Uuid = sqlx::query_scalar(
        "INSERT INTO employees (org_id, company, name, source_filename, source_sheet, source_row, source_key) \
         VALUES ($1, '주식회사 가나', '박미정', 'x', 'x', 1, 'p2') RETURNING id",
    )
    .bind(ORG)
    .fetch_one(&owner)
    .await
    .unwrap();
    store
        .bind_assignment(&cmd(&actor), bind(loose, entity, hq, "2026-01-02"))
        .await
        .unwrap();
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn regression_counts_agree_and_leave_out_who_is_not_on_the_roll(owner: PgPool) {
    // move-21 / hire-26: 입사 예정, a cancelled registration and a 퇴직자 whose
    // assignment nobody closed were counted at one level and not another.
    let (store, actor) = tenant(&owner, ORG, "A").await;
    let (entity, _, plant, dept, team) = chart(&store, &actor).await;
    let mut ids = Vec::new();
    for key in ["on", "pre", "void", "exit", "leave"] {
        ids.push(person(&owner, &store, &actor, (entity, plant, team), key).await);
    }
    let status = |id: Uuid, s: &str| {
        format!("UPDATE employees SET employment_status = '{s}' WHERE id = '{id}';")
    };
    let user = *actor.user.as_uuid();
    raw(
        &owner,
        [
            status(ids[1], "PRE_HIRE"),
            format!(
                "UPDATE employees SET employment_status = 'VOIDED', voided_at = now(), voided_by = '{user}', \
                 void_reason_code = 'MISTAKE', void_mode = 'SETUP' WHERE id = '{}';",
                ids[2]
            ),
            status(ids[3], "EXITED"),
            status(ids[4], "ON_LEAVE"),
        ]
        .concat(),
    )
    .await;
    let tree = store.org_structure(&actor).await.unwrap();
    let e = &tree.entities[0];
    let counts = |id: Uuid| find(&e.children, id).map(|n| n.headcount);
    // 재직 and 휴직 count; 입사 예정, 등록 취소 and 퇴직 do not, at any level.
    assert_eq!(
        (counts(team), counts(dept), counts(plant), e.headcount),
        (Some(2), Some(2), Some(2), 2)
    );
    assert_eq!(tree.entity_unknown_headcount, Some(0));
    let w = store.get_entity(&actor, entity, false).await.unwrap();
    let at_plant = w.workplaces.iter().find(|x| x.id == plant).unwrap();
    assert_eq!(
        at_plant.headcount, 2,
        "the 사업장 record agrees with the chart"
    );
}

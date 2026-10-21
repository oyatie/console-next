//! MR-22: one registration call records the person and their 법인 · 사업장,
//! all or nothing. A new tenant is in SETUP, so the cause is SETUP_BIND.

use sqlx::PgPool;
use uuid::Uuid;

use crate::fixture::{Fixture, fixture};
use crate::register;

/// A 법인 with two open 사업장; the first has its SITE unit and a 부서 under
/// it (the 부서 has no placement of its own).
struct Org {
    entity: Uuid,
    first: Uuid,
    second: Uuid,
    department: Uuid,
}

async fn org(pool: &PgPool, f: &Fixture) -> Org {
    let o = *f.principal.org_id.as_uuid();
    let user = *f.principal.user_id.as_uuid();
    let (entity, first, second, site, department) = (
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
    );
    let unit = |id: Uuid, attributes: String| {
        format!(
            "INSERT INTO org_units (org_id, id) VALUES ('{o}', '{id}'); \
             INSERT INTO org_unit_revisions (org_id, org_unit_id, version, command_id, actor_id, \
             payload_digest, attributes, receipt) VALUES ('{o}', '{id}', 1, gen_random_uuid(), \
             '{user}', decode(repeat('ab', 32), 'hex'), '{attributes}', '{{}}');"
        )
    };
    let mut sql = format!(
        "INSERT INTO legal_entities (org_id, id, needs_confirmation, created_change_mode) \
         VALUES ('{o}', '{entity}', true, 'MIGRATION'); \
         INSERT INTO workplaces (org_id, id, legal_entity_id, needs_confirmation, created_change_mode) \
         VALUES ('{o}', '{first}', '{entity}', true, 'MIGRATION'), \
                ('{o}', '{second}', '{entity}', true, 'MIGRATION');"
    );
    sql.push_str(&unit(site, r#"{"kind": "site", "name": "본사"}"#.into()));
    sql.push_str(&unit(
        department,
        format!(r#"{{"kind": "department", "name": "인사팀", "parent_id": "{site}"}}"#),
    ));
    sql.push_str(&format!(
        "INSERT INTO org_unit_placements (org_id, org_unit_id, legal_entity_id, workplace_id, \
         represents_workplace, valid_from, change_mode, command_id) VALUES ('{o}', '{site}', \
         '{entity}', '{first}', true, '2026-01-01', 'MIGRATION', gen_random_uuid())"
    ));
    let mut tx = pool.begin().await.unwrap();
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
    Org {
        entity,
        first,
        second,
        department,
    }
}

async fn placements(pool: &PgPool, employee: Uuid) -> Vec<(Uuid, Uuid, String, String)> {
    sqlx::query_as(
        "SELECT legal_entity_id, workplace_id, valid_from::TEXT, cause FROM employment_assignments \
         WHERE employee_id = $1 AND superseded_at IS NULL",
    )
    .bind(employee)
    .fetch_all(pool)
    .await
    .unwrap()
}

async fn people(pool: &PgPool) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM employees")
        .fetch_one(pool)
        .await
        .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_unit_places_the_person_at_its_workplace_in_the_same_call(pool: PgPool) {
    let f = fixture(pool.clone()).await;
    let o = org(&pool, &f).await;
    let mut body = f.body("place-1", "REGULAR");
    body.org_unit_id = Some(o.department);
    let (made, _) = register(&f, body).await.unwrap();
    assert_eq!(
        placements(&pool, made.employee.id).await,
        vec![(o.entity, o.first, "2026-09-01".into(), "SETUP_BIND".into())]
    );

    // The asked 사업장 and the unit's disagree: nothing is written at all.
    let before = people(&pool).await;
    let mut body = f.body("place-2", "REGULAR");
    body.name = "박배치".into();
    body.phone = "010-2222-3333".into();
    body.org_unit_id = Some(o.department);
    body.workplace_id = Some(o.second);
    let refused = register(&f, body).await.unwrap_err();
    assert_eq!(
        (refused.status.as_u16(), refused.code),
        (422, "org_unit_at_other_workplace")
    );
    assert_eq!(people(&pool).await, before);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_asked_workplace_places_the_person_and_no_workplace_is_unplaced(pool: PgPool) {
    let f = fixture(pool.clone()).await;
    let o = org(&pool, &f).await;
    let mut body = f.body("ask-1", "REGULAR");
    body.legal_entity_id = Some(o.entity);
    body.workplace_id = Some(o.second);
    let (made, _) = register(&f, body).await.unwrap();
    assert_eq!(
        placements(&pool, made.employee.id).await,
        vec![(o.entity, o.second, "2026-09-01".into(), "SETUP_BIND".into())]
    );

    // The fixture's bare unit sits nowhere: the person is 미배치.
    let mut body = f.body("ask-2", "REGULAR");
    body.name = "이미배치".into();
    body.phone = "010-4444-5555".into();
    let (unplaced, _) = register(&f, body).await.unwrap();
    assert!(placements(&pool, unplaced.employee.id).await.is_empty());

    let mut body = f.body("ask-3", "REGULAR");
    body.name = "최법인".into();
    body.phone = "010-6666-7777".into();
    body.legal_entity_id = Some(o.entity);
    assert_eq!(
        register(&f, body).await.unwrap_err().code,
        "workplace_required"
    );
    let mut body = f.body("ask-4", "REGULAR");
    body.name = "정타법인".into();
    body.phone = "010-8888-9999".into();
    body.legal_entity_id = Some(Uuid::new_v4());
    body.workplace_id = Some(o.first);
    assert_eq!(
        register(&f, body).await.unwrap_err().code,
        "workplace_of_other_entity"
    );
}

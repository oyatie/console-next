#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! decisions #14.1, as `console_rt` (FORCE RLS) with the canonical OrgUnit
//! owner behind the port: a 사업장 brings its own SITE unit, so a person can be
//! placed there with no 부서, and voiding the 사업장 (or its 법인) during setup
//! dissolves that unit and the empty 부서 under it — refused while people
//! still sit in it or under it.

mod common;

use common::*;
use console_entity_application::{CreateSetupOrgUnit, Revision, VoidRecord};
use console_entity_domain::workplace::WorkplaceInput;
use sqlx::PgPool;
use uuid::Uuid;

const ORG: Uuid = Uuid::from_u128(0xA000_0000_0000_0000_0000_0000_0000_0E14);

fn void() -> VoidRecord {
    VoidRecord {
        reason_code: Some("MISTAKE".into()),
    }
}

/// (status, open placement) of a SITE unit, read as the owner.
async fn site_state(owner: &PgPool, unit: Uuid) -> (String, bool) {
    sqlx::query_as(
        "SELECT (SELECT attributes->>'status' FROM org_unit_revisions WHERE org_unit_id = $1 ORDER BY version DESC LIMIT 1), \
                EXISTS (SELECT 1 FROM org_unit_placements WHERE org_unit_id = $1 AND valid_to IS NULL)",
    )
    .bind(unit)
    .fetch_one(owner)
    .await
    .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_workplace_brings_its_own_unit_and_takes_it_when_voided(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG, "A").await;
    let entity = store
        .create_entity(&cmd(&actor), corporation("주식회사 가나", "000211-0006241"))
        .await
        .unwrap()
        .record
        .id;
    let reg = store
        .create_registration(&cmd(&actor), entity, certificate("000-81-00009"))
        .await
        .unwrap()
        .record
        .id;
    let hq = store
        .create_workplace(&cmd(&actor), entity, workplace_from(reg, "본사"), port())
        .await
        .unwrap()
        .record;
    let site = hq.org_unit_id.expect("the 사업장 has its own unit");
    assert_eq!(site_state(&owner, site).await, ("active".into(), true));
    let kind: String = sqlx::query_scalar(
        "SELECT attributes->>'kind' FROM org_unit_revisions WHERE org_unit_id = $1 ORDER BY version DESC LIMIT 1",
    )
    .bind(site)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(kind, "site");

    // Renaming the 사업장 renames its unit (people placed there see it).
    let rename = Revision {
        expected_version: Some(1),
        effective_from: Some("2026-01-01".into()),
        reason_code: Some("RENAME".into()),
        input: WorkplaceInput {
            registration_id: None,
            status: Some("CONTINUING".into()),
            ..workplace_from(reg, "서울 본사").input
        },
    };
    store
        .revise_workplace(&cmd(&actor), hq.id, rename, port())
        .await
        .unwrap();
    let name: String = sqlx::query_scalar(
        "SELECT attributes->>'name' FROM org_unit_revisions WHERE org_unit_id = $1 ORDER BY version DESC LIMIT 1",
    )
    .bind(site)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(name, "서울 본사");

    // A person registered straight at the 사업장 (no 부서) holds it.
    sqlx::query(
        "INSERT INTO employees (org_id, company, name, source_filename, source_sheet, source_row, source_key, org_unit_id) \
         VALUES ($1, '주식회사 가나', '김직원', 'x', 'x', 1, 'k1', $2)",
    )
    .bind(ORG)
    .bind(site)
    .execute(&owner)
    .await
    .unwrap();
    let (code_, _, remedy) = code(
        store
            .void_workplace(&cmd(&actor), hq.id, void(), port())
            .await
            .unwrap_err(),
    );
    assert_eq!(
        (code_, remedy),
        ("record_in_use", Some("reassign_people_first"))
    );

    // A second 사업장 with a 부서: the 부서 reuses the 사업장's unit, and holds it.
    let branch = store
        .create_workplace(
            &cmd(&actor),
            entity,
            workplace_from(reg, "부산지점"),
            port(),
        )
        .await
        .unwrap()
        .record;
    let branch_site = branch.org_unit_id.unwrap();
    let dept = store
        .create_setup_org_unit(
            &cmd(&actor),
            CreateSetupOrgUnit {
                name: Some("영업부".into()),
                kind: None,
                workplace_id: Some(branch.id),
                parent_org_unit_id: None,
            },
            port(),
        )
        .await
        .unwrap()
        .units[0]
        .org_unit_id;
    let team = store
        .create_setup_org_unit(
            &cmd(&actor),
            CreateSetupOrgUnit {
                name: Some("영업1팀".into()),
                kind: None,
                workplace_id: None,
                parent_org_unit_id: Some(dept),
            },
            port(),
        )
        .await
        .unwrap()
        .units[0]
        .org_unit_id;
    let parent: String = sqlx::query_scalar(
        "SELECT attributes->>'parent_id' FROM org_unit_revisions WHERE org_unit_id = $1 ORDER BY version DESC LIMIT 1",
    )
    .bind(dept)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(parent, branch_site.to_string(), "no second SITE unit");
    // Someone in a 부서 under the 사업장 holds it …
    let lee: Uuid = sqlx::query_scalar(
        "INSERT INTO employees (org_id, company, name, source_filename, source_sheet, source_row, source_key, org_unit_id) \
         VALUES ($1, '주식회사 가나', '이직원', 'x', 'x', 2, 'k2', $2) RETURNING id",
    )
    .bind(ORG)
    .bind(team)
    .fetch_one(&owner)
    .await
    .unwrap();
    let (code_, _, remedy) = code(
        store
            .void_workplace(&cmd(&actor), branch.id, void(), port())
            .await
            .unwrap_err(),
    );
    assert_eq!(
        (code_, remedy),
        ("record_in_use", Some("reassign_people_first"))
    );
    // … but empty 부서 do not (MR-12: no more remove_org_units_first dead
    // end); they are dissolved with the 사업장's own unit.
    sqlx::query("UPDATE employees SET employment_status = 'EXITED' WHERE id = $1")
        .bind(lee)
        .execute(&owner)
        .await
        .unwrap();
    store
        .void_workplace(&cmd(&actor), branch.id, void(), port())
        .await
        .unwrap();
    for unit in [team, dept] {
        assert_eq!(site_state(&owner, unit).await.0, "dissolved");
    }
    assert_eq!(
        site_state(&owner, branch_site).await,
        ("dissolved".into(), false)
    );

    // An empty 사업장 voids, and its unit goes with it.
    let spare = store
        .create_workplace(
            &cmd(&actor),
            entity,
            workplace_from(reg, "대전지점"),
            port(),
        )
        .await
        .unwrap()
        .record;
    let spare_site = spare.org_unit_id.unwrap();
    store
        .void_workplace(&cmd(&actor), spare.id, void(), port())
        .await
        .unwrap();
    assert_eq!(
        site_state(&owner, spare_site).await,
        ("dissolved".into(), false)
    );
    let tree = store.org_structure(&actor).await.unwrap();
    let names: Vec<&str> = tree.entities[0]
        .children
        .iter()
        .map(|w| w.name.as_str())
        .collect();
    assert_eq!(names, vec!["서울 본사"]);
    assert!(
        tree.unplaced.is_empty(),
        "a dissolved unit is never left over"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn voiding_an_entity_dissolves_the_units_of_its_workplaces(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG, "A").await;
    let entity = store
        .create_entity(&cmd(&actor), corporation("주식회사 가나", "000211-0006241"))
        .await
        .unwrap()
        .record
        .id;
    let reg = store
        .create_registration(&cmd(&actor), entity, certificate("000-81-00009"))
        .await
        .unwrap()
        .record
        .id;
    let site = store
        .create_workplace(&cmd(&actor), entity, workplace_from(reg, "본사"), port())
        .await
        .unwrap()
        .record
        .org_unit_id
        .unwrap();
    store
        .void_entity(&cmd(&actor), entity, void(), port())
        .await
        .unwrap();
    assert_eq!(site_state(&owner, site).await, ("dissolved".into(), false));
    let units: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM (SELECT DISTINCT ON (org_unit_id) attributes FROM org_unit_revisions \
           WHERE org_id = $1 ORDER BY org_unit_id, version DESC) h WHERE attributes->>'status' = 'active'",
    )
    .bind(ORG)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(units, 0);
}

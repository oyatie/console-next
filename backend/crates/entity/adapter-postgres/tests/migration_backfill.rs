#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! The employment-assignment data migration, re-run over seeded legacy data (sqlx::test
//! migrates an empty database, so the block is replayed here verbatim):
//! company text and SITE units become records needing confirmation, people
//! map by id where nothing is ambiguous, the rest surface for 「회사 이름 정리」,
//! and a second run changes nothing.

mod common;

use common::*;
use console_entity_application::MapCompanyText;
use sqlx::PgPool;
use uuid::Uuid;

const ORG_X: Uuid = Uuid::from_u128(0xC000_0000_0000_0000_0000_0000_0000_0E02);
const ORG_Y: Uuid = Uuid::from_u128(0xD000_0000_0000_0000_0000_0000_0000_0E02);
const MIGRATION: &str =
    include_str!("../../../platform/db/migrations/0259_employment_assignments_and_placements.sql");

fn backfill_block() -> String {
    let start = MIGRATION.find("DO $$").unwrap();
    let end = MIGRATION[start..].find("END\n$$;").unwrap() + start + "END\n$$;".len();
    MIGRATION[start..end].to_owned()
}

async fn employee(
    owner: &PgPool,
    org: Uuid,
    company: &str,
    key: &str,
    hire: &str,
    unit: Option<Uuid>,
) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO employees (org_id, company, name, source_filename, source_sheet, source_row, source_key, hire_date, org_unit_id) \
         VALUES ($1, $2, '직원', 'f', 's', 1, $3, $4, $5) RETURNING id",
    )
    .bind(org).bind(company).bind(key).bind(hire).bind(unit)
    .fetch_one(owner).await.unwrap()
}

async fn unit(
    owner: &PgPool,
    org: Uuid,
    actor: Uuid,
    name: &str,
    kind: &str,
    parent: Option<Uuid>,
) -> Uuid {
    let id: Uuid = sqlx::query_scalar("INSERT INTO org_units (org_id) VALUES ($1) RETURNING id")
        .bind(org)
        .fetch_one(owner)
        .await
        .unwrap();
    let mut attrs = serde_json::json!({ "name": name, "kind": kind, "status": "active" });
    if let Some(p) = parent {
        attrs["parent_id"] = serde_json::json!(p.to_string());
    }
    sqlx::query(
        "INSERT INTO org_unit_revisions (org_id, org_unit_id, version, command_id, actor_id, payload_digest, attributes, receipt) \
         VALUES ($1, $2, 1, gen_random_uuid(), $3, sha256('x'), $4, '{}'::jsonb)",
    )
    .bind(org).bind(id).bind(actor).bind(attrs)
    .execute(owner).await.unwrap();
    id
}

async fn count(owner: &PgPool, sql: &'static str, org: Uuid) -> i64 {
    sqlx::query_scalar(sql)
        .bind(org)
        .fetch_one(owner)
        .await
        .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn legacy_company_text_and_sites_become_records(owner: PgPool) {
    let (store_x, actor_x) = tenant(&owner, ORG_X, "X").await;
    let (store_y, actor_y) = tenant(&owner, ORG_Y, "Y").await;
    let site = unit(
        &owner,
        ORG_X,
        *actor_x.user.as_uuid(),
        "서울사업장",
        "site",
        None,
    )
    .await;
    let dept = unit(
        &owner,
        ORG_X,
        *actor_x.user.as_uuid(),
        "영업팀",
        "department",
        Some(site),
    )
    .await;
    let e1 = employee(&owner, ORG_X, "가나", "x1", "2021-05-01", Some(dept)).await;
    employee(&owner, ORG_X, "가나", "x2", "2021-02-30", None).await;
    employee(&owner, ORG_Y, "가나", "y1", "2020-01-01", None).await;
    employee(&owner, ORG_Y, "다라", "y2", "2020-01-01", None).await;

    let block = backfill_block();
    sqlx::raw_sql(sqlx::AssertSqlSafe(block.clone()))
        .execute(&owner)
        .await
        .unwrap();

    // X: one entity + the SITE as a 사업장, both people mapped by id.
    assert_eq!(
        count(
            &owner,
            "SELECT count(*) FROM legal_entities WHERE org_id = $1 AND needs_confirmation",
            ORG_X
        )
        .await,
        1
    );
    let x = store_x.list_entities(&actor_x, false).await.unwrap();
    assert_eq!(
        x[0].workplaces[0].current.as_ref().unwrap().name,
        "서울사업장"
    );
    let (from, workplace): (time::Date, Option<Uuid>) = sqlx::query_as(
        "SELECT valid_from, workplace_id FROM employment_assignments WHERE employee_id = $1",
    )
    .bind(e1)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(from.to_string(), "2021-05-01");
    assert_eq!(workplace, Some(x[0].workplaces[0].id));
    // INTEG-3: the migrated records start at the earliest employment, so no
    // live assignment predates its 법인 or 사업장.
    let first = x[0].current.as_ref().unwrap();
    assert_eq!(
        (
            first.effective_from.to_string().as_str(),
            first.before_first_record
        ),
        ("2021-05-01", false)
    );
    assert_eq!(
        count(
            &owner,
            "SELECT count(*) FROM employment_assignments a \
             JOIN workplace_revisions r ON r.workplace_id = a.workplace_id AND r.version = 1 \
             WHERE a.org_id = $1 AND a.superseded_at IS NULL AND a.valid_from < r.effective_from",
            ORG_X
        )
        .await,
        0
    );
    assert_eq!(
        count(
            &owner,
            "SELECT count(*) FROM employment_assignments WHERE org_id = $1 AND cause = 'MIGRATION'",
            ORG_X
        )
        .await,
        2
    );
    let tree = store_x.org_structure(&actor_x).await.unwrap();
    assert_eq!(
        tree.entities[0].children[0].children[0].name, "영업팀",
        "the SITE is drawn as its 사업장"
    );
    assert!(tree.unplaced.is_empty());

    // Y: two company texts → nothing guessed; cleanup maps per text.
    let unmapped = store_y.unmapped_companies(&actor_y).await.unwrap();
    assert_eq!(unmapped.len(), 2);
    let y = store_y.list_entities(&actor_y, false).await.unwrap();
    let mapped = store_y
        .map_company_text(
            &cmd(&actor_y),
            MapCompanyText {
                company_text: Some("가나".into()),
                legal_entity_id: Some(y[0].id),
                workplace_id: Some(y[0].workplaces[0].id),
            },
        )
        .await;
    // The migrated 사업장 has no default branch yet, which is fine for mapping.
    assert_eq!(mapped.unwrap(), 1);
    assert_eq!(store_y.unmapped_companies(&actor_y).await.unwrap().len(), 1);

    // Idempotent: a second run inserts nothing.
    let before = count(
        &owner,
        "SELECT count(*) FROM employment_assignments WHERE org_id = $1",
        ORG_Y,
    )
    .await;
    sqlx::raw_sql(sqlx::AssertSqlSafe(block))
        .execute(&owner)
        .await
        .unwrap();
    assert_eq!(
        count(
            &owner,
            "SELECT count(*) FROM employment_assignments WHERE org_id = $1",
            ORG_Y
        )
        .await,
        before
    );
    assert_eq!(
        count(
            &owner,
            "SELECT count(*) FROM legal_entities WHERE org_id = $1",
            ORG_Y
        )
        .await,
        1
    );
}

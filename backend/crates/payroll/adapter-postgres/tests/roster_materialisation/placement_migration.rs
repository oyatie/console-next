// SPDX-License-Identifier: LicenseRef-Proprietary
//! Upgrading a populated database records the placement of lines written before
//! the placement columns existed, and the previous binary's line insert, which
//! names none of them, keeps working afterwards.
use super::places::*;
use super::seed::*;
use console_platform_test_support::MIGRATOR;
use sqlx::{PgPool, migrate::Migrator};
use std::borrow::Cow;
use uuid::Uuid;

/// The first placement migration; move it with that file if it is renamed.
const PLACEMENT_MIGRATION: i64 = 20261124010000000;

/// The line insert of a binary that predates the placement columns.
async fn previous_writer(pool: &PgPool, f: &Fixture, employee: Uuid, key: &str) {
    sqlx::query("INSERT INTO payroll_draft_lines (org_id,run_id,employee_id,employee_source_key,employee_display_name,employee_company) VALUES ($1,$2,$3,$4,$4,'UNKNOWN_COMPANY')")
        .bind(f.org).bind(f.run).bind(employee).bind(key).execute(pool).await.unwrap();
}

#[sqlx::test(migrations = false)]
async fn existing_lines_gain_their_placement_and_the_previous_writer_still_inserts(pool: PgPool) {
    let before = Migrator {
        migrations: Cow::Owned(
            MIGRATOR
                .iter()
                .filter(|m| m.version < PLACEMENT_MIGRATION)
                .cloned()
                .collect(),
        ),
        ..Migrator::DEFAULT
    };
    before.run(&pool).await.unwrap();
    let f = seed_org_and_run(&pool).await;
    let (le, team) = (entity(&pool, f.org).await, unit(&pool, f.org).await);
    let site = workplace(&pool, f.org, le).await;
    let [existing, later] = [
        active(&pool, f.org, "existing", Some(team)).await,
        active(&pool, f.org, "later", Some(team)).await,
    ];
    for id in [existing, later] {
        assign(&pool, f.org, id, Some((le, site)), (LONG_AGO, None)).await;
    }
    previous_writer(&pool, &f, existing, "existing").await;
    MIGRATOR.run(&pool).await.unwrap();
    previous_writer(&pool, &f, later, "later").await;
    assert_eq!(
        placements(&pool, f.run).await,
        [
            placed("existing", le, site, Some(team)),
            ("later".to_owned(), None, None, None)
        ]
    );
}

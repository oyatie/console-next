// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]

use sqlx::PgPool;
use time::{Duration, macros::date};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn employed_on_counts_the_last_working_day_and_excludes_retirement_day(owner: PgPool) {
    let runtime = console_platform_test_support::runtime_role_pool(&owner).await;
    let day = date!(2026 - 10 - 22);
    let before = day - Duration::days(1);
    let after = day + Duration::days(1);
    let cases = [
        (Some(day), None, Some("ACTIVE"), Some(before), false),
        (Some(day), None, Some("ACTIVE"), Some(day), true),
        (Some(day), None, Some("ACTIVE"), Some(after), true),
        (Some(before), Some(day), Some("EXITED"), Some(before), true),
        (Some(before), Some(day), Some("EXITED"), Some(day), true),
        (Some(before), Some(day), Some("EXITED"), Some(after), false),
        (Some(before), Some(day), Some("ACTIVE"), Some(after), false),
        (Some(day), Some(day), Some("EXITED"), Some(day), true),
        (Some(after), Some(day), Some("EXITED"), Some(day), false),
        (Some(day), None, Some("ON_LEAVE"), Some(day), true),
        (Some(day), None, Some("UNKNOWN"), Some(day), true),
        (None, None, Some("ACTIVE"), Some(day), true),
        (None, None, Some("ON_LEAVE"), Some(day), true),
        (None, None, Some("UNKNOWN"), Some(day), true),
        (Some(day), None, Some("EXITED"), Some(day), false),
        (None, None, Some("EXITED"), Some(day), false),
        (Some(day), None, Some("PRE_HIRE"), Some(before), false),
        (Some(day), None, Some("PRE_HIRE"), Some(day), true),
        (Some(day), None, Some("PRE_HIRE"), Some(after), true),
        (None, None, Some("PRE_HIRE"), Some(day), false),
        (Some(day), None, Some("VOIDED"), Some(day), false),
        (Some(day), Some(day), Some("VOIDED"), Some(day), false),
        (Some(day), None, None, Some(day), false),
        (Some(day), None, Some("ACTIVE"), None, false),
    ];
    for (hire, last_working_day, status, on, expected) in cases {
        let actual: bool = sqlx::query_scalar("SELECT entity_employed_on($1, $2, $3, $4)")
            .bind(on)
            .bind(hire)
            .bind(last_working_day)
            .bind(status)
            .fetch_one(&runtime)
            .await
            .unwrap();
        assert_eq!(
            actual, expected,
            "hire={hire:?}, last_working_day={last_working_day:?}, status={status:?}, on={on:?}"
        );
    }
    for (last_working_day, retirement) in [
        (Some(day), Some(after)),
        (Some(date!(2024 - 02 - 28)), Some(date!(2024 - 02 - 29))),
        (Some(date!(2024 - 02 - 29)), Some(date!(2024 - 03 - 01))),
        (Some(date!(2026 - 12 - 31)), Some(date!(2027 - 01 - 01))),
        (None, None),
    ] {
        let actual: Option<time::Date> = sqlx::query_scalar("SELECT entity_retirement_on($1)")
            .bind(last_working_day)
            .fetch_one(&runtime)
            .await
            .unwrap();
        assert_eq!(actual, retirement);
    }
}

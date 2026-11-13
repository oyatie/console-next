// SPDX-License-Identifier: LicenseRef-Proprietary
//! The picker's search, page size and order, over more colleagues than one
//! page holds.

use http::StatusCode;
use sqlx::PgPool;
use uuid::Uuid;

use crate::support::Ctx;
use crate::{ASSIGNEES, office};

/// The picker's items for `query`, as (account, name) in the order served.
async fn listed(ctx: &Ctx, query: &str) -> Vec<(Uuid, String)> {
    let (status, page) = ctx.call("GET", &format!("{ASSIGNEES}{query}"), None).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    page["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| {
            (
                item["account_id"].as_str().unwrap().parse().unwrap(),
                item["display_name"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_picker_searches_pages_and_orders_by_name(pool: PgPool) {
    let office = office(pool).await;
    // Fifty-six more colleagues, two of them sharing a name.
    sqlx::query(
        "INSERT INTO users (id, display_name, roles, org_id, is_active)
         SELECT gen_random_uuid(), 'Peer ' || lpad(CASE g WHEN 56 THEN '7' ELSE g::text END, 2, '0'),
                '{}', $1, true
         FROM generate_series(1, 56) g",
    )
    .bind(office.org)
    .execute(&office.pool)
    .await
    .unwrap();
    let mut everyone: Vec<(Uuid, String)> =
        sqlx::query_as("SELECT id, display_name FROM users WHERE org_id = $1 AND id <> $2")
            .bind(office.org)
            .bind(office.admin.user.as_uuid())
            .fetch_all(&office.pool)
            .await
            .unwrap();
    everyone.sort_by(|a, b| (&a.1, a.0).cmp(&(&b.1, b.0)));
    assert_eq!(everyone.len(), 57);

    let admin = &office.admin;
    assert_eq!(listed(admin, "").await, everyone[..20], "default page");
    assert_eq!(listed(admin, "?limit=500").await, everyone[..50], "cap");
    assert_eq!(listed(admin, "?limit=0").await, everyone[..1], "floor");
    assert_eq!(listed(admin, "?limit=-3").await, everyone[..1], "floor");
    let twins: Vec<_> = everyone
        .iter()
        .filter(|(_, name)| name == "Peer 07")
        .cloned()
        .collect();
    assert_eq!(twins.len(), 2);
    assert_eq!(
        listed(admin, "?search=%20%20pEER%2007%20").await,
        twins,
        "trimmed, case-insensitive, then by id"
    );
}
